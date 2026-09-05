import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import {
  hashOutcomeValue,
  outcomeEnum,
  outcomeId,
  outcomeObject,
  outcomeString,
  outcomeStrings,
  type OutcomeState,
} from "./outcome-contract.js";
import {
  parseActionSpecification,
  finiteMetric,
  type ExecutionReceipt,
  type InvestigationEvidence,
  type ActionSpecification,
  type InputFingerprint,
} from "./investigation-records.js";
import { captureOutcomeInputs, changedOutcomePaths, pathInsideScope } from "./outcome-inputs.js";
import {
  readOutcome,
  reserveInOutcome,
  settleInOutcome,
  withOutcomeMutation,
} from "./outcome-store.js";
import { classifyResult } from "./result-semantics.js";

export function terminalExecution(receipt: ExecutionReceipt): boolean {
  return ["completed", "failed", "cancelled"].includes(receipt.status.kind);
}

export async function nominateOutcomeAction(
  cwd: string,
  input: unknown,
): Promise<ExecutionReceipt> {
  const worktree = await fsp.realpath(cwd);
  const nominated = await withOutcomeMutation(cwd, async (state) => {
    const action = parseActionSpecification(input, state.contract);
    const existing = state.executions.find((receipt) => receipt.id === action.id);
    if (existing) {
      await assertExecutionWorktree(existing, worktree);
      if (existing.action.digest !== action.digest)
        throw new Error("Execution identity already belongs to different action content.");
      return existing;
    }
    if (state.executions.some((receipt) => !terminalExecution(receipt)))
      throw new Error("Resume or reconcile the existing action before nominating another.");
    assertEvidenceReferences(state, [...action.evidenceRefs, ...action.investigation.evidenceRefs]);
    const investigation = state.investigations.find((item) => item.id === action.investigation.id);
    if (investigation) {
      const { resolution, resolutionEvidence: _evidence, ...proposal } = investigation;
      if (resolution !== "active")
        throw new Error(
          "This investigation is closed. A new question needs a new investigation identity within the same outcome.",
        );
      if (hashOutcomeValue(proposal) !== hashOutcomeValue(action.investigation))
        throw new Error(
          "An investigation's question and retry allowance are immutable; use a new investigation identity.",
        );
    }
    if (
      action.repairOf &&
      !state.executions.some(
        (receipt) =>
          receipt.id === action.repairOf &&
          receipt.status.kind === "failed" &&
          receipt.status.failureStage === "execution",
      )
    )
      throw new Error("A repair must reference an actual failed execution receipt.");
    if (action.evaluator) {
      const prior = state.evaluators.find((item) => item.id === action.evaluator?.id);
      if (prior && prior.digest !== action.evaluator.digest)
        throw new Error("Evaluator versions are immutable; use a new evaluator identity.");
    }
    reserveInOutcome(
      state,
      {
        id: action.id,
        investigationId: action.investigation.id,
        specificationDigest: action.digest,
        seconds: action.seconds,
      },
      worktree,
    );
    if (!investigation)
      state.investigations.push({
        ...action.investigation,
        resolution: "active",
        resolutionEvidence: [],
      });
    if (action.evaluator && !state.evaluators.some((item) => item.id === action.evaluator?.id))
      state.evaluators.push(action.evaluator);
    const receipt: ExecutionReceipt = {
      id: action.id,
      authorizationDigest: state.contract.digest,
      action,
      worktree,
      input: null,
      reservationId: action.id,
      token: randomUUID(),
      status: { kind: "preparing", startedAt: new Date().toISOString() },
      outputs: [],
      result: null,
      observation: null,
      checksPassed: null,
      consumptionSource: "reserved",
      completedInput: null,
    };
    state.executions.push(receipt);
    return receipt;
  });
  if (nominated.status.kind !== "preparing") return nominated;
  return await prepareOutcomeAction(worktree, nominated.id);
}

async function prepareOutcomeAction(cwd: string, id: string): Promise<ExecutionReceipt> {
  const state = await readOutcome(cwd);
  const pending = state?.executions.find((receipt) => receipt.id === id);
  if (!pending || pending.status.kind !== "preparing")
    throw new Error("Preparation receipt is unavailable.");
  await assertExecutionWorktree(pending, cwd);
  let attemptedInput: InputFingerprint | null = null;
  try {
    const fingerprint = await captureOutcomeInputs(pending.worktree, pending.action.environment);
    attemptedInput = fingerprint;
    return await withOutcomeMutation(cwd, async (current) => {
      const receipt = requiredExecution(current, id);
      if (receipt.status.kind !== "preparing") return receipt;
      if (receipt.authorizationDigest !== current.contract.digest)
        throw new Error("Action authorization changed during preparation.");
      const reservation = current.reservations.find((item) => item.id === id)!;
      if (Date.now() - Date.parse(reservation.reservedAt) >= receipt.action.seconds * 1000)
        throw new Error("Action reservation expired during input preparation.");
      receipt.input = fingerprint;
      assertBoundedRetry(current, receipt);
      receipt.status =
        receipt.action.mode === "managed"
          ? { kind: "ticket", issuedAt: new Date().toISOString() }
          : { kind: "launching", nominatedAt: new Date().toISOString() };
      return receipt;
    });
  } catch (error) {
    await withOutcomeMutation(cwd, async (current) => {
      const receipt = requiredExecution(current, id);
      if (receipt.status.kind !== "preparing") return;
      receipt.input = attemptedInput;
      receipt.status = {
        kind: "failed",
        failureStage: "preparation",
        completedAt: new Date().toISOString(),
        exitCode: null,
        failureId: hashOutcomeValue({
          stage: "preparation",
          action: actionExecutionIdentity(receipt.action),
          reason: String(error),
        }),
      };
      receipt.result = classifyResult({ kind: "invalid", execution: "failed" });
      receipt.consumptionSource = "worker-wall-clock";
      settleElapsed(current, receipt);
    });
    throw error;
  }
}

export async function resumeOutcomeAction(cwd: string, id: string): Promise<ExecutionReceipt> {
  const state = await readOutcome(cwd);
  if (!state) throw new Error("No outcome exists.");
  const receipt = requiredExecution(state, outcomeId(id, "execution ID"));
  await assertExecutionWorktree(receipt, cwd);
  // A preparing receipt proves no execution ticket or launch authority was issued.
  // Every later state reconnects only; it never silently launches a replacement.
  return receipt.status.kind === "preparing"
    ? await prepareOutcomeAction(cwd, receipt.id)
    : receipt;
}

function actionExecutionIdentity(action: ActionSpecification): string {
  return hashOutcomeValue({
    mode: action.mode,
    argv: action.argv,
    evaluator: action.evaluator?.digest ?? null,
    effects: action.effects,
    paths: action.paths,
    environment: action.environment,
  });
}

function assertBoundedRetry(state: OutcomeState, receipt: ExecutionReceipt): void {
  const previous = state.executions.filter(
    (item) =>
      item.id !== receipt.id &&
      item.input?.digest === receipt.input?.digest &&
      actionExecutionIdentity(item.action) === actionExecutionIdentity(receipt.action),
  );
  const failed = previous.filter((item) => item.status.kind === "failed");
  if (failed.length && !receipt.action.repairOf)
    throw new Error(
      "Repeating failed conditions requires an explicit bounded repair referencing the failed receipt.",
    );
  if (receipt.action.repairOf) {
    const source = requiredExecution(state, receipt.action.repairOf);
    if (
      source.status.kind !== "failed" ||
      source.status.failureStage !== "execution" ||
      !source.input ||
      !receipt.input
    )
      throw new Error("Repair source is not a failed execution.");
    const relevantConditionsChanged =
      source.input?.digest !== receipt.input?.digest ||
      actionExecutionIdentity(source.action) !== actionExecutionIdentity(receipt.action);
    const repairCount = state.executions.filter(
      (item) =>
        item.id !== receipt.id &&
        item.action.repairOf !== null &&
        item.input?.digest === receipt.input?.digest &&
        actionExecutionIdentity(item.action) === actionExecutionIdentity(receipt.action),
    ).length;
    if (!relevantConditionsChanged && repairCount >= receipt.action.investigation.retryAllowance)
      throw new Error(
        "The accepted repair allowance for unchanged relevant conditions is exhausted.",
      );
  } else {
    const completed = previous.filter((item) => item.status.kind === "completed");
    const repeats = receipt.action.evaluator?.repeats ?? 1;
    if (completed.length >= repeats)
      throw new Error(
        "Exact duplicate action, evaluator, and inputs cannot create another independent measurement beyond accepted repeats.",
      );
  }
}

export function assertEvidenceReferences(state: OutcomeState, refs: readonly string[]): void {
  for (const id of refs) {
    const evidence = state.evidence.find((item) => item.id === id);
    if (
      !evidence ||
      !state.executions.some(
        (receipt) => receipt.id === evidence.executionId && terminalExecution(receipt),
      )
    )
      throw new Error(`Evidence reference has no terminal execution and observation: ${id}`);
  }
}

export function requiredExecution(state: OutcomeState, id: string): ExecutionReceipt {
  const receipt = state.executions.find((item) => item.id === id);
  if (!receipt) throw new Error("Unknown execution identity.");
  return receipt;
}

export function settleElapsed(state: OutcomeState, receipt: ExecutionReceipt): void {
  const reservation = state.reservations.find((item) => item.id === receipt.reservationId);
  if (!reservation) throw new Error("Missing execution reservation.");
  const seconds = Math.max(0, (Date.now() - Date.parse(reservation.reservedAt)) / 1000);
  settleInOutcome(state, receipt.id, { kind: "measured", seconds });
}

export async function logOutcomeObservation(
  cwd: string,
  value: unknown,
): Promise<InvestigationEvidence> {
  const input = outcomeObject(value, "observation record");
  const id = outcomeId(input.id, "evidence ID");
  const executionId = outcomeId(input.executionId, "execution ID");
  const priorState = await readOutcome(cwd);
  if (!priorState) throw new Error("No outcome exists.");
  const receiptBefore = requiredExecution(priorState, executionId);
  await assertExecutionWorktree(receiptBefore, cwd);
  const existing = priorState.evidence.find((item) => item.id === id);
  if (existing) {
    if (existing.specificationDigest !== hashOutcomeValue(input))
      throw new Error("Evidence identity already belongs to different observation content.");
    return existing;
  }
  const fingerprint = await captureOutcomeInputs(cwd, receiptBefore.action.environment);
  return await withOutcomeMutation(cwd, async (state) => {
    const receipt = requiredExecution(state, executionId);
    if (!receipt.input) throw new Error("Action input provenance is missing.");
    const criterionId = outcomeId(input.criterionId, "criterion ID");
    const criterion = state.contract.criteria.find((item) => item.id === criterionId);
    if (!criterion) throw new Error("Observation criterion is outside the accepted outcome.");
    const evaluator = receipt.action.evaluator;
    if (evaluator && !evaluator.criterionIds.includes(criterionId))
      throw new Error("Evaluator does not assess this criterion.");
    const evidenceRefs = outcomeStrings(
      input.evidenceRefs ?? [],
      "observation evidence references",
      true,
    );
    assertEvidenceReferences(state, evidenceRefs);
    if (receipt.status.kind === "ticket") {
      if (input.completed !== true)
        throw new Error(
          "Codex-managed work requires an explicit completed observation; otherwise resume its ticket.",
        );
      const changed = changedOutcomePaths(receipt.input, fingerprint);
      for (const file of changed) {
        const within = pathInsideScope(file, receipt.action.paths);
        const authorizedParent =
          receipt.action.paths.some((scope) => scope.startsWith(`${file}/`)) &&
          (await fsp.lstat(`${cwd}/${file}`).catch(() => null))?.isDirectory();
        if ((!within && !authorizedParent) || !receipt.action.effects.includes("edit"))
          throw new Error(`Managed work changed a path outside its accepted edit ticket: ${file}`);
      }
      receipt.completedInput = fingerprint;
      receipt.consumptionSource = "ticket-wall-clock";
      receipt.status = {
        kind: "completed",
        completedAt: new Date().toISOString(),
        exitCode: 0,
        failureId: null,
        failureStage: null,
      };
      if (evaluator) {
        const observation = outcomeObject(input.observation, "evaluator observation");
        if (evaluator.method.kind === "predicate") {
          receipt.observation = {
            kind: "predicate",
            observed: outcomeEnum(
              observation.observed,
              ["satisfied", "counterexample", "inconclusive"],
              "predicate observation",
            ),
          };
          receipt.result = classifyResult(receipt.observation);
        } else {
          receipt.observation = { kind: "metric", value: finiteMetric(observation.value) };
          receipt.result = classifyResult({
            kind: "metric",
            value: receipt.observation.value,
            reference: null,
            direction: evaluator.method.direction,
            minimumImprovement: evaluator.method.minimumImprovement,
            tolerance: evaluator.method.tolerance,
            target: evaluator.method.target,
          });
        }
        // Managed observations are internal claims. A separate checks execution is
        // required before code can be accepted for delivery.
        receipt.checksPassed = null;
      } else receipt.result = classifyResult({ kind: "predicate", observed: "inconclusive" });
      settleElapsed(state, receipt);
    }
    if (!terminalExecution(receipt) || !receipt.result)
      throw new Error(
        "Execution is not terminal with an observed result. Resume it without relaunching.",
      );
    if (!receipt.completedInput || receipt.completedInput.digest !== fingerprint.digest)
      throw new Error(
        "Inputs changed after execution; this receipt cannot establish a current observation.",
      );
    if (state.evidence.some((item) => item.id === id))
      throw new Error("Observation identity was concurrently committed; read it before retrying.");
    const relation =
      receipt.result.attainment === "satisfied"
        ? "supports"
        : receipt.result.attainment === "unsatisfied"
          ? "contradicts"
          : "inconclusive";
    const evidence: InvestigationEvidence = {
      id,
      specificationDigest: hashOutcomeValue(input),
      executionId,
      criterionId,
      text: outcomeString(input.text, "observation text"),
      relation,
      result: receipt.result,
      dependencies: {
        subject: fingerprint.digest,
        evaluator: evaluator?.digest ?? hashOutcomeValue(null),
        fixtures: fingerprint.digest,
        environment: fingerprint.environment,
        checks: hashOutcomeValue(evaluator?.checkArgv ?? []),
        criterion: hashOutcomeValue(criterion),
        evidence: evidenceRefs,
      },
      historicalValidity: receipt.result.validity,
      limitations:
        receipt.action.mode === "managed"
          ? [
              "Operator observation; execution and checks are not independently verified.",
              "Consumption measures the ticket wall-clock interval; model and provider consumption remain unknown.",
            ]
          : [],
      provenance:
        receipt.action.mode === "managed"
          ? "operator-observation"
          : receipt.action.mode === "github-actions"
            ? "github-actions"
            : "worker",
      measurementId: receipt.id,
      independent: false,
      createdAt: new Date().toISOString(),
    };
    state.evidence.push(evidence);
    const resolution =
      input.resolution == null
        ? "active"
        : outcomeEnum(
            input.resolution,
            ["active", "supported", "refuted", "inconclusive", "exhausted"],
            "investigation resolution",
          );
    if (resolution !== "active") {
      const investigation = state.investigations.find(
        (item) => item.id === receipt.action.investigation.id,
      )!;
      if (
        (resolution === "supported" && relation !== "supports") ||
        (resolution === "refuted" && relation !== "contradicts")
      )
        throw new Error("Investigation resolution contradicts the recorded observation.");
      investigation.resolution = resolution;
      investigation.resolutionEvidence = [id];
    }
    return evidence;
  });
}

async function assertExecutionWorktree(receipt: ExecutionReceipt, cwd: string): Promise<void> {
  if ((await fsp.realpath(cwd)) !== receipt.worktree)
    throw new Error(
      `Execution belongs to a different authorized worktree. Resume or log it from ${receipt.worktree}.`,
    );
}
