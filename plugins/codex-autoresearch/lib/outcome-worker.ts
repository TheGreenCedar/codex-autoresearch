import { metricReference, readOutcomeDependencyManifest } from "./outcome-evidence.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertSafeWriteTarget, checkedAtomicWriteFile } from "./checked-write.js";
import { resolvePackageRoot } from "./runtime-paths.js";
import {
  outcomeStateLocation,
  readOutcome,
  withOutcomeMutation,
  settleInOutcome,
  assertLegacyUnchanged,
} from "./outcome-store.js";
import {
  hashOutcomeValue,
  outcomeId,
  outcomeObject,
  type OutcomeState,
} from "./outcome-contract.js";
import { parseExecutionReceipt, type ExecutionReceipt } from "./investigation-records.js";
import { captureOutcomeInputs, changedOutcomePaths, pathInsideScope } from "./outcome-inputs.js";
import { requiredExecution, terminalExecution } from "./investigation-workflow.js";
import { storeOutcomeObject } from "./outcome-artifacts.js";
import { classifyResult } from "./result-semantics.js";
import {
  inspectProcessIdentity,
  inspectProcessTree,
  runProcess,
  terminateAfterTimeout,
  type ProcessRunResult,
} from "./runner.js";

/** Only records an existing execution. It cannot nominate work or amend authority. */
async function mutateReceipt<T>(
  cwd: string,
  operation: (state: OutcomeState) => Promise<T>,
): Promise<T> {
  const until = Date.now() + 30_000;
  for (;;) {
    try {
      return await withOutcomeMutation(cwd, operation, [], true);
    } catch (error) {
      if (!String(error).includes("mutation is already running") || Date.now() >= until)
        throw error;
      await delay(100);
    }
  }
}

async function completionLocation(cwd: string, id: string) {
  outcomeId(id, "execution ID");
  const owner = await outcomeStateLocation(cwd);
  return {
    root: owner.root,
    path: path.join(path.dirname(owner.path), "executions", id, "completion.json"),
  };
}

export async function launchOutcomeWorker(cwd: string, id: string): Promise<ExecutionReceipt> {
  const observer = await inspectProcessIdentity(process.pid);
  const admitted = await withOutcomeMutation(cwd, async (state) => {
    const receipt = requiredExecution(state, id);
    if (receipt.action.mode !== "process")
      throw new Error("Only process actions use the local worker.");
    if (receipt.worker || receipt.status.kind !== "launching") return { receipt, launch: false };
    receipt.worker = {
      launchId: randomUUID(),
      observerPid: process.pid,
      observerIdentity: observer.identity,
      attemptedAt: new Date().toISOString(),
      pid: null,
      identity: null,
      child: null,
      cancelRequestedAt: null,
    };
    return { receipt, launch: true };
  });
  if (!admitted.launch) return await reconcileOutcomeWorker(cwd, id);
  // This attempt is durable before spawn. A second caller never repeats it.
  const script = path.join(
    resolvePackageRoot(import.meta.url),
    "dist",
    "scripts",
    "outcome-worker.mjs",
  );
  const child = spawn(
    process.execPath,
    [script, "--cwd", admitted.receipt.worktree, "--execution", id],
    {
      cwd: admitted.receipt.worktree,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: process.env,
    },
  );
  await new Promise<void>((resolve) => {
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", () => {
      resolve();
    });
  });
  if (!child.pid) {
    return await mutateReceipt(cwd, async (state) => {
      const receipt = requiredExecution(state, id);
      if (receipt.worker?.pid || terminalExecution(receipt)) return receipt;
      receipt.status = {
        kind: "failed",
        completedAt: new Date().toISOString(),
        exitCode: null,
        failureStage: "preparation",
        failureId: hashOutcomeValue({ stage: "worker-spawn", launchId: receipt.worker?.launchId }),
      };
      receipt.result = classifyResult({ kind: "invalid", execution: "failed" });
      settleInOutcome(state, id, { kind: "measured", seconds: elapsedSeconds(state, receipt) });
      receipt.consumptionSource = "worker-wall-clock";
      return receipt;
    });
  }
  return admitted.receipt;
}

export async function requestOutcomeCancellation(
  cwd: string,
  id: string,
): Promise<ExecutionReceipt> {
  return await mutateReceipt(cwd, async (state) => {
    const receipt = requiredExecution(state, id);
    if (terminalExecution(receipt)) return receipt;
    if (!receipt.worker) {
      if (receipt.action.mode !== "process" || receipt.status.kind !== "launching")
        throw new Error("This action has no unattempted process nomination to cancel.");
      receipt.status = {
        kind: "cancelled",
        completedAt: new Date().toISOString(),
        exitCode: null,
        failureId: null,
        failureStage: null,
      };
      receipt.result = classifyResult({ kind: "invalid", execution: "failed" });
      settleInOutcome(state, id, { kind: "measured", seconds: elapsedSeconds(state, receipt) });
      receipt.consumptionSource = "worker-wall-clock";
      return receipt;
    }
    receipt.worker.cancelRequestedAt ??= new Date().toISOString();
    return receipt;
  });
}

export async function reconcileOutcomeWorker(cwd: string, id: string): Promise<ExecutionReceipt> {
  const state = await readOutcome(cwd);
  if (!state) throw new Error("No outcome exists.");
  const receipt = requiredExecution(state, id);
  if (terminalExecution(receipt)) return receipt;
  const completion = await loadWorkerCompletion(cwd, receipt, state);
  if (completion) return await applyWorkerCompletion(cwd, completion);
  if (!receipt.worker)
    return receipt.status.kind === "launching" && receipt.action.mode === "process"
      ? await launchOutcomeWorker(cwd, id)
      : receipt;
  const worker = receipt.worker;
  if (worker.pid !== null) {
    const observed = await inspectProcessIdentity(worker.pid);
    if (observed.proven && observed.identity !== null && observed.identity === worker.identity)
      return receipt;
    if (!observed.proven || observed.identity !== null)
      return await markUnknown(
        cwd,
        id,
        "Worker identity is unavailable or changed; retain exposure until its existing process and outputs are reconciled.",
      );
    // A dead worker can leave its separately governed process group alive.
    if (worker.child && worker.cancelRequestedAt) {
      const child = await inspectProcessIdentity(worker.child.pid);
      const tree = await inspectProcessTree(worker.child.pid);
      if (
        !child.proven ||
        !tree.proven ||
        (child.identity !== null && child.identity !== worker.child.identity)
      )
        return await markUnknown(
          cwd,
          id,
          "Orphaned child identity is unverified or changed; cancellation cannot target a reused PID.",
        );
      const termination = tree.livePids.length
        ? await terminateAfterTimeout(worker.child.pid)
        : null;
      if (termination && !termination.proven)
        return await markUnknown(
          cwd,
          id,
          "Cancellation did not prove termination of the orphaned process tree.",
        );
      const proof = await storeOutcomeObject(
        cwd,
        Buffer.from(
          JSON.stringify({
            workerPid: worker.pid,
            workerIdentity: worker.identity,
            child: worker.child,
            termination,
            tree,
            reconciledAt: new Date().toISOString(),
          }),
        ),
      );
      return await mutateReceipt(cwd, async (current) => {
        const execution = requiredExecution(current, id);
        if (terminalExecution(execution)) return execution;
        const reservation = current.reservations.find((entry) => entry.id === id)!;
        settleInOutcome(current, id, {
          kind: "estimated",
          seconds: Math.max(reservation.seconds, elapsedSeconds(current, execution)),
          reason:
            "Worker was lost. Charge the larger of reserved exposure and the elapsed upper bound through proven process-tree termination; actual execution duration remains unknown.",
        });
        execution.status = {
          kind: "cancelled",
          completedAt: new Date().toISOString(),
          exitCode: null,
          failureId: null,
          failureStage: null,
        };
        execution.result = classifyResult({ kind: "invalid", execution: "unknown" });
        execution.consumptionSource = "estimated";
        execution.outputs.push({ path: proof.path, digest: proof.digest });
        return execution;
      });
    }
    return await markUnknown(
      cwd,
      id,
      "Worker observation was lost. Reconcile the original process and completion receipt; do not launch replacement work.",
    );
  }
  const observer = await inspectProcessIdentity(worker.observerPid);
  if (
    observer.proven &&
    observer.identity === worker.observerIdentity &&
    observer.identity !== null
  )
    return receipt;
  // Absence of a claim does not prove absence of a delayed process launch.
  return await markUnknown(
    cwd,
    id,
    "Launch response is uncertain and no worker claim is available. Preserve the attempted identity and reservation; do not dispatch again.",
  );
}

async function markUnknown(cwd: string, id: string, reason: string) {
  return await mutateReceipt(cwd, async (state) => {
    const receipt = requiredExecution(state, id);
    if (terminalExecution(receipt)) return receipt;
    receipt.status = { kind: "unknown", reason, lastKnownPid: receipt.worker?.pid ?? null };
    receipt.consumptionSource = "unknown";
    settleInOutcome(state, id, { kind: "unknown", reason });
    return receipt;
  });
}

export async function runOutcomeWorker(cwd: string, id: string): Promise<void> {
  cwd = await fsp.realpath(cwd);
  const identity = await inspectProcessIdentity(process.pid);
  const claimed = await mutateReceipt(cwd, async (state) => {
    const receipt = requiredExecution(state, id);
    if (receipt.worktree !== cwd || receipt.action.mode !== "process" || !receipt.worker)
      throw new Error("Worker has no matching durable nomination.");
    if (receipt.worker.pid !== null || terminalExecution(receipt)) return null;
    if (!identity.proven || !identity.identity)
      throw new Error("Worker creation identity could not be established.");
    receipt.worker.pid = process.pid;
    receipt.worker.identity = identity.identity;
    receipt.status = {
      kind: "running",
      pid: process.pid,
      identity: identity.identity,
      startedAt: new Date().toISOString(),
      progressAt: new Date().toISOString(),
    };
    return structuredClone(receipt);
  });
  if (!claimed) return;
  const stateAtClaim = (await readOutcome(cwd))!;
  const reservation = stateAtClaim.reservations.find(
    (entry) => entry.id === claimed.reservationId,
  )!;
  const expiresAt = Math.min(
    Date.parse(reservation.reservedAt) + claimed.action.seconds * 1000,
    stateAtClaim.contract.budget.deadline
      ? Date.parse(stateAtClaim.contract.budget.deadline)
      : Infinity,
  );
  const controller = new AbortController();
  if (claimed.worker?.cancelRequestedAt) controller.abort();
  let observedProcess: ProcessRunResult | null = null;
  let queue = Promise.resolve();
  let heartbeatFailure: unknown = null;
  const update = (operation: (state: OutcomeState, receipt: ExecutionReceipt) => Promise<void>) => {
    queue = queue
      .then(async () => {
        await mutateReceipt(cwd, async (state) => {
          const receipt = requiredExecution(state, id);
          if (receipt.worker?.launchId !== claimed.worker?.launchId || terminalExecution(receipt))
            return;
          await operation(state, receipt);
        });
      })
      .catch((error: unknown) => {
        heartbeatFailure = error;
        controller.abort();
      });
  };
  const heartbeat = setInterval(() => {
    update(async (_state, receipt) => {
      if (receipt.worker?.cancelRequestedAt) controller.abort();
      if (receipt.status.kind === "running") receipt.status.progressAt = new Date().toISOString();
    });
  }, 1000);
  const interrupted = () => controller.abort();
  process.once("SIGTERM", interrupted);
  process.once("SIGINT", interrupted);
  const result = structuredClone(claimed);
  try {
    await assertLegacyUnchanged(stateAtClaim);
    const actualInput = await captureOutcomeInputs(cwd, claimed.action.environment);
    if (!claimed.input || actualInput.digest !== claimed.input.digest)
      throw new Error("Inputs changed between preparation and worker execution.");
    if (expiresAt <= Date.now()) throw new Error("Reserved time expired before worker execution.");
    const argv = claimed.action.evaluator?.argv.length
      ? claimed.action.evaluator.argv
      : claimed.action.argv;
    const execute = async (argv: string[]) => {
      let spawnedPid: number | null = null;
      let spawnedIdentity: string | null = null;
      const admitted = await mutateReceipt(cwd, async (current) => {
        const receipt = requiredExecution(current, id);
        await assertLegacyUnchanged(current);
        if (receipt.worker?.cancelRequestedAt) controller.abort();
        if (controller.signal.aborted || expiresAt <= Date.now())
          throw new Error("Execution allowance or cancellation ended process admission.");
        const process = runProcess(argv[0], argv.slice(1), {
          cwd,
          envMode: "minimal",
          signal: controller.signal,
          timeoutSeconds: (expiresAt - Date.now()) / 1000,
          maxOutputBytes: 1024 * 1024,
          onSpawn: (pid) => {
            spawnedPid = pid;
            update(async (_state, receipt) => {
              const observed = await inspectProcessIdentity(pid);
              spawnedIdentity = observed.identity;
              if (receipt.worker) receipt.worker.child = { pid, identity: observed.identity };
            });
          },
        });
        return { process };
      });
      const output = await admitted.process;
      await queue;
      if (spawnedPid !== null && !output.termination?.proven) {
        const current = await inspectProcessIdentity(spawnedPid);
        const tree = await inspectProcessTree(spawnedPid);
        if (
          !current.proven ||
          !tree.proven ||
          (current.identity !== null && current.identity !== spawnedIdentity)
        ) {
          output.terminationFailed = true;
        } else if (tree.livePids.length) {
          const termination = await terminateAfterTimeout(spawnedPid);
          output.termination = termination;
          output.terminationFailed = !termination.proven;
          // Cleanup proves quiescence within the observed native boundary.
          output.exitCode = null;
          output.code = null;
          output.spawnError = "Descendant processes outlived the evaluator parent.";
        }
      }
      return output;
    };
    observedProcess = await execute(argv);
    await queue;
    const processOutput = await storeOutcomeObject(
      cwd,
      Buffer.from(
        JSON.stringify({
          executionBoundary:
            process.platform === "win32" ? "observed-native-process-tree" : "native-process-group",
          escapedDescendants: "not-contained-or-accounted",
          process: observedProcess,
        }),
      ),
    );
    result.outputs.push({ path: processOutput.path, digest: processOutput.digest });
    if (observedProcess.terminationFailed || heartbeatFailure) {
      result.status = {
        kind: "unknown",
        reason: "Process termination or durable observation is unproven.",
        lastKnownPid: process.pid,
      };
      result.result = classifyResult({ kind: "invalid", execution: "unknown" });
    } else if (
      controller.signal.aborted ||
      observedProcess.timedOut ||
      Date.parse(observedProcess.finishedAt) > expiresAt
    ) {
      result.status = {
        kind: "cancelled",
        completedAt: new Date().toISOString(),
        exitCode: observedProcess.exitCode,
        failureId: null,
        failureStage: null,
      };
      result.result = classifyResult({ kind: "invalid", execution: "failed" });
    } else if (observedProcess.exitCode !== 0) {
      result.status = failedStatus(
        claimed,
        observedProcess.spawnError ?? `exit:${observedProcess.exitCode}`,
        observedProcess.exitCode,
      );
      result.result = classifyResult({ kind: "invalid", execution: "failed" });
    } else {
      result.status = {
        kind: "completed",
        completedAt: new Date().toISOString(),
        exitCode: 0,
        failureId: null,
        failureStage: null,
      };
      result.observation = parseWorkerObservation(claimed, observedProcess);
      result.result =
        result.observation === null
          ? classifyResult({ kind: "invalid", execution: "completed" })
          : result.observation.kind === "predicate"
            ? classifyResult(result.observation)
            : classifyResult({
                kind: "metric",
                value: result.observation.value,
                reference: metricReference(
                  stateAtClaim,
                  result,
                  await readOutcomeDependencyManifest(stateAtClaim, cwd),
                ),
                direction:
                  claimed.action.evaluator!.method.kind === "metric"
                    ? claimed.action.evaluator!.method.direction
                    : "none",
                minimumImprovement:
                  claimed.action.evaluator!.method.kind === "metric"
                    ? claimed.action.evaluator!.method.minimumImprovement
                    : 0,
                tolerance:
                  claimed.action.evaluator!.method.kind === "metric"
                    ? claimed.action.evaluator!.method.tolerance
                    : 0,
                target:
                  claimed.action.evaluator!.method.kind === "metric"
                    ? claimed.action.evaluator!.method.target
                    : null,
              });
      if (claimed.action.evaluator?.checkArgv.length) {
        const checks = await execute(claimed.action.evaluator.checkArgv);
        await queue;
        const checkOutput = await storeOutcomeObject(
          cwd,
          Buffer.from(
            JSON.stringify({
              executionBoundary:
                process.platform === "win32"
                  ? "observed-native-process-tree"
                  : "native-process-group",
              escapedDescendants: "not-contained-or-accounted",
              process: checks,
            }),
          ),
        );
        result.outputs.push({ path: checkOutput.path, digest: checkOutput.digest });
        result.checksPassed =
          checks.exitCode === 0 &&
          !checks.timedOut &&
          !checks.terminationFailed &&
          !checks.outputTruncated;
        if (checks.terminationFailed)
          result.status = {
            kind: "unknown",
            reason: "Correctness-check process termination is unproven.",
            lastKnownPid: process.pid,
          };
        if (!result.checksPassed)
          result.result = classifyResult({
            kind: "invalid",
            execution: result.status.kind === "unknown" ? "unknown" : "completed",
          });
      }
    }
    result.completedInput = await captureOutcomeInputs(cwd, claimed.action.environment);
    for (const file of changedOutcomePaths(claimed.input, result.completedInput)) {
      const within = pathInsideScope(file, claimed.action.paths);
      const directoryParent =
        claimed.action.paths.some((scope) => scope.startsWith(`${file}/`)) &&
        (await fsp.lstat(path.join(cwd, file)).catch(() => null))?.isDirectory();
      if ((!within && !directoryParent) || !claimed.action.effects.includes("edit"))
        throw new Error(`Worker process changed a path outside the accepted edit scope: ${file}`);
    }
  } catch (error) {
    if (observedProcess?.terminationFailed) {
      result.status = { kind: "unknown", reason: String(error), lastKnownPid: process.pid };
      result.result = classifyResult({ kind: "invalid", execution: "unknown" });
    } else {
      result.status = controller.signal.aborted
        ? {
            kind: "cancelled",
            completedAt: new Date().toISOString(),
            exitCode: null,
            failureId: null,
            failureStage: null,
          }
        : failedStatus(claimed, String(error), null);
      result.result = classifyResult({ kind: "invalid", execution: "failed" });
    }
  } finally {
    clearInterval(heartbeat);
    process.removeListener("SIGTERM", interrupted);
    process.removeListener("SIGINT", interrupted);
    await queue;
  }
  const latest = (await readOutcome(cwd))!;
  result.worker = requiredExecution(latest, id).worker;
  result.consumptionSource = result.status.kind === "unknown" ? "unknown" : "worker-wall-clock";
  const completion = {
    schemaVersion: 1,
    launchId: claimed.worker!.launchId,
    receipt: parseExecutionReceipt(
      result,
      latest.history.map((entry) => entry.contract),
    ),
    seconds: Math.max(0, (Date.now() - Date.parse(reservation.reservedAt)) / 1000),
  };
  const location = await completionLocation(cwd, id);
  const serialized = JSON.stringify(completion) + "\n";
  await assertSafeWriteTarget(location.root, location.path);
  const prior = await fsp.readFile(location.path, "utf8").catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  });
  if (prior !== null && prior !== serialized) throw new Error("Worker completion is immutable.");
  if (prior === null)
    await checkedAtomicWriteFile(location.root, location.path, serialized, { mode: 0o600 });
  await applyWorkerCompletion(cwd, completion);
}

function parseWorkerObservation(
  receipt: ExecutionReceipt,
  result: ProcessRunResult,
): ExecutionReceipt["observation"] {
  const method = receipt.action.evaluator?.method;
  if (!method || result.outputTruncated) return null;
  if (method.kind === "metric") {
    const value = result.parsedMetrics[method.name];
    return Number.isFinite(value) ? { kind: "metric", value } : null;
  }
  const lines = result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("AUTORESEARCH_OBSERVATION "));
  if (lines.length !== 1) return null;
  try {
    const value = outcomeObject(
      JSON.parse(lines[0].slice("AUTORESEARCH_OBSERVATION ".length)),
      "predicate output",
    );
    if (
      value.kind !== "predicate" ||
      typeof value.observed !== "string" ||
      !["satisfied", "counterexample", "inconclusive"].includes(value.observed)
    )
      return null;
    return {
      kind: "predicate",
      observed: value.observed as "satisfied" | "counterexample" | "inconclusive",
    };
  } catch {
    return null;
  }
}

function failedStatus(
  receipt: ExecutionReceipt,
  reason: string,
  exitCode: number | null,
): ExecutionReceipt["status"] {
  return {
    kind: "failed",
    failureStage: "execution",
    completedAt: new Date().toISOString(),
    exitCode,
    failureId: hashOutcomeValue({
      argv: receipt.action.argv,
      evaluator: receipt.action.evaluator?.digest,
      input: receipt.input?.digest,
      reason,
    }),
  };
}

function elapsedSeconds(state: OutcomeState, receipt: ExecutionReceipt) {
  return Math.max(
    0,
    (Date.now() -
      Date.parse(
        state.reservations.find((item) => item.id === receipt.reservationId)!.reservedAt,
      )) /
      1000,
  );
}

type WorkerCompletion = {
  schemaVersion: number;
  launchId: string;
  receipt: ExecutionReceipt;
  seconds: number;
};
async function loadWorkerCompletion(
  cwd: string,
  receipt: ExecutionReceipt,
  state: OutcomeState,
): Promise<WorkerCompletion | null> {
  const location = await completionLocation(cwd, receipt.id);
  await assertSafeWriteTarget(location.root, location.path);
  let bytes: string;
  try {
    bytes = await fsp.readFile(location.path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
  const value = outcomeObject(JSON.parse(bytes), "worker completion");
  if (
    value.schemaVersion !== 1 ||
    value.launchId !== receipt.worker?.launchId ||
    typeof value.seconds !== "number" ||
    !Number.isFinite(value.seconds) ||
    value.seconds < 0
  )
    throw new Error("Worker completion has no matching launch and consumption identity.");
  const completed = parseExecutionReceipt(
    value.receipt,
    state.history.map((entry) => entry.contract),
  );
  if (
    completed.id !== receipt.id ||
    completed.token !== receipt.token ||
    completed.action.digest !== receipt.action.digest ||
    completed.authorizationDigest !== receipt.authorizationDigest ||
    completed.worktree !== receipt.worktree ||
    completed.input?.digest !== receipt.input?.digest ||
    (!terminalExecution(completed) && completed.status.kind !== "unknown")
  )
    throw new Error("Worker completion does not match its authorized execution.");
  return {
    schemaVersion: 1,
    launchId: String(value.launchId),
    receipt: completed,
    seconds: value.seconds,
  };
}

async function applyWorkerCompletion(
  cwd: string,
  completion: WorkerCompletion,
): Promise<ExecutionReceipt> {
  return await mutateReceipt(cwd, async (state) => {
    const current = requiredExecution(state, completion.receipt.id);
    if (
      current.worker?.launchId !== completion.launchId ||
      current.token !== completion.receipt.token
    )
      throw new Error("Completion launch identity changed.");
    if (terminalExecution(current)) return current;
    if (completion.receipt.status.kind === "unknown")
      settleInOutcome(state, current.id, {
        kind: "unknown",
        reason: completion.receipt.status.reason,
      });
    else settleInOutcome(state, current.id, { kind: "measured", seconds: completion.seconds });
    Object.assign(current, completion.receipt);
    return current;
  });
}
