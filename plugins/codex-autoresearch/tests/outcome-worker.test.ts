import { createHash } from "node:crypto";
import { metricReference, readOutcomeDependencyManifest } from "../lib/outcome-evidence.js";
import { nextOutcomeAction } from "../lib/commands/outcome.js";
import { inspectProcessIdentity } from "../lib/runner.js";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startOutcome, readOutcome, withOutcomeMutation } from "../lib/outcome-store.js";
import { nominateOutcomeAction, logOutcomeObservation } from "../lib/investigation-workflow.js";
import {
  launchOutcomeWorker,
  reconcileOutcomeWorker,
  requestOutcomeCancellation,
} from "../lib/outcome-worker.js";
import { outcomeUsage } from "../lib/outcome-contract.js";
import { buildOutcomeEvidenceRegistry } from "../lib/evidence-registry.js";
import { captureOutcomeInputs } from "../lib/outcome-inputs.js";
import type { ExecutionReceipt } from "../lib/investigation-records.js";
import { governedFixture, actionFixture } from "./helpers/outcome-fixtures.js";
import { withTempDir } from "./helpers/process.js";

async function fixture(cwd: string, program: string) {
  await fsp.mkdir(path.join(cwd, "src"));
  await fsp.mkdir(path.join(cwd, "checks"));
  await fsp.writeFile(path.join(cwd, "checks", "evaluate.cjs"), program);
  const contract = governedFixture(cwd);
  await startOutcome(cwd, { ...contract, budget: { actions: 5, executionSeconds: 180 } });
  const action = actionFixture("A1");
  return {
    ...action,
    mode: "process",
    effects: ["execute", "edit"],
    paths: ["src"],
    seconds: 30,
    evaluator: {
      ...action.evaluator,
      argv: [process.execPath, "checks/evaluate.cjs"],
      checkArgv: [process.execPath, "-e", "process.exit(0)"],
    },
  };
}
async function waitFor(cwd: string, accept: (receipt: ExecutionReceipt) => boolean, id = "A1") {
  const until = Date.now() + 40_000;
  while (Date.now() < until) {
    const receipt = (await readOutcome(cwd))!.executions.find((entry) => entry.id === id)!;
    if (accept(receipt)) return receipt;
    await delay(100);
  }
  throw new Error(
    `Worker did not converge: ${JSON.stringify((await readOutcome(cwd))!.executions[0])}`,
  );
}

test("a durable worker finishes after launch observation ends and repeated resume never executes twice", async () => {
  await withTempDir("worker", "durable", async (cwd) => {
    const action = await fixture(
      cwd,
      `const fs = require('node:fs'); fs.appendFileSync('src/count.txt', 'one\\n'); setTimeout(() => console.log('AUTORESEARCH_OBSERVATION {"kind":"predicate","observed":"counterexample"}'), 700);`,
    );
    await nominateOutcomeAction(cwd, action);
    await launchOutcomeWorker(cwd, "A1");
    const running = await waitFor(cwd, (receipt) => receipt.status.kind === "running");
    assert.notEqual(running.worker?.pid, process.pid);
    await reconcileOutcomeWorker(cwd, "A1");
    const completed = await waitFor(cwd, (receipt) => receipt.status.kind === "completed");
    assert.equal(completed.result?.validity, "valid");
    assert.equal(completed.result?.conclusion, "refuted");
    assert.equal(completed.checksPassed, true);
    await launchOutcomeWorker(cwd, "A1");
    await reconcileOutcomeWorker(cwd, "A1");
    assert.equal(await fsp.readFile(path.join(cwd, "src", "count.txt"), "utf8"), "one\n");
    const evidence = await logOutcomeObservation(cwd, {
      id: "E1",
      executionId: "A1",
      criterionId: "compatibility",
      text: "Actual compatibility counterexample",
      resolution: "refuted",
    });
    assert.equal(evidence.provenance, "worker");
    assert.equal(evidence.historicalValidity, "valid");
    const state = (await readOutcome(cwd))!;
    assert.ok(outcomeUsage(state).measuredSeconds > 0);
    assert.equal(
      buildOutcomeEvidenceRegistry({ state, input: await captureOutcomeInputs(cwd, "local") })
        .criteria[0].status,
      "unsatisfied",
    );
  });
});

test("ambiguous launch retains exposure without creating a replacement", async () => {
  await withTempDir("worker", "ambiguous", async (cwd) => {
    const action = await fixture(cwd, "console.log('unused');");
    await nominateOutcomeAction(cwd, action);
    await withOutcomeMutation(cwd, async (state) => {
      state.executions[0].worker = {
        launchId: "ambiguous",
        observerPid: 2_000_000_000,
        observerIdentity: "missing",
        attemptedAt: new Date().toISOString(),
        pid: null,
        identity: null,
        child: null,
        cancelRequestedAt: null,
      };
    });
    const resumed = await launchOutcomeWorker(cwd, "A1");
    assert.equal(resumed.status.kind, "unknown");
    const state = (await readOutcome(cwd))!;
    assert.equal(outcomeUsage(state).unknownExecutions, 1);
    assert.equal(outcomeUsage(state).reservedSeconds, 30);
    await assert.rejects(nominateOutcomeAction(cwd, { ...action, id: "A2" }), /existing action/);
    assert.equal(state.executions.length, 1);
  });
});

test("cancellation reaches the worker and proves native process-tree termination", async () => {
  await withTempDir("worker", "cancel", async (cwd) => {
    const action = await fixture(
      cwd,
      `const fs = require('node:fs'); fs.writeFileSync('src/started.txt', String(process.pid)); setInterval(() => {}, 100);`,
    );
    await nominateOutcomeAction(cwd, action);
    await launchOutcomeWorker(cwd, "A1");
    await waitFor(cwd, (receipt) => receipt.worker?.child != null);
    await requestOutcomeCancellation(cwd, "A1");
    const cancelled = await waitFor(cwd, (receipt) => receipt.status.kind === "cancelled");
    assert.equal(cancelled.result?.validity, "invalid");
    assert.equal(outcomeUsage((await readOutcome(cwd))!).unknownExecutions, 0);
    assert.ok(cancelled.outputs.length);
  });
});

test("worker refuses changed prepared inputs and records actual invalid output separately", async () => {
  await withTempDir("worker", "changed-input", async (cwd) => {
    const action = await fixture(cwd, "console.log('not an observation');");
    await nominateOutcomeAction(cwd, action);
    await fsp.writeFile(path.join(cwd, "src", "drift.txt"), "changed after reservation");
    await launchOutcomeWorker(cwd, "A1");
    const failed = await waitFor(cwd, (receipt) => receipt.status.kind === "failed");
    assert.equal(failed.result?.validity, "invalid");
    assert.deepEqual(failed.outputs, []);
  });
  await withTempDir("worker", "invalid-output", async (cwd) => {
    const action = await fixture(cwd, "console.log('not an observation');");
    await nominateOutcomeAction(cwd, action);
    await launchOutcomeWorker(cwd, "A1");
    const invalid = await waitFor(cwd, (receipt) => receipt.status.kind === "completed");
    assert.equal(invalid.result?.validity, "invalid");
    assert.equal(invalid.result?.attainment, "unknown");
  });
});

test("a successful parent cannot release exposure while an unrefed descendant is alive", async () => {
  await withTempDir("worker", "orphan-descendant", async (cwd) => {
    // Windows needs detached=true for the orphan to survive its Node parent.
    const action = await fixture(
      cwd,
      `const fs = require('node:fs'); const child = require('node:child_process').spawn(process.execPath, ['-e', "setInterval(() => { if (require('node:fs').existsSync('src/stop-descendant.txt')) process.exit(0); }, 100)"], { stdio: 'ignore', detached: process.platform === 'win32' }); child.unref(); fs.writeFileSync('src/descendant.txt', String(child.pid)); console.log('AUTORESEARCH_OBSERVATION {"kind":"predicate","observed":"satisfied"}');`,
    );
    await nominateOutcomeAction(cwd, action);
    await launchOutcomeWorker(cwd, "A1");
    let descendantPid: number | undefined;
    try {
      const receipt = await waitFor(cwd, (entry) =>
        ["failed", "unknown"].includes(entry.status.kind),
      );
      assert.notEqual(receipt.result?.validity, "valid");
      descendantPid = Number(await fsp.readFile(path.join(cwd, "src", "descendant.txt"), "utf8"));
      const child = await inspectProcessIdentity(descendantPid);
      const state = (await readOutcome(cwd))!;
      if (receipt.status.kind === "unknown") {
        // Failed ownership queries cannot promise cleanup or release the reservation.
        assert.equal(outcomeUsage(state).unknownExecutions, 1);
        assert.equal(outcomeUsage(state).reservedSeconds, action.seconds);
        await assert.rejects(
          nominateOutcomeAction(cwd, { ...action, id: "A2" }),
          /existing action/,
        );
        const resumed = await launchOutcomeWorker(cwd, "A1");
        assert.equal(resumed.worker?.launchId, receipt.worker?.launchId);
        assert.equal((await readOutcome(cwd))!.executions.length, 1);
        assert.equal(outcomeUsage((await readOutcome(cwd))!).unknownExecutions, 1);
      } else {
        assert.equal(child.proven, true);
        assert.equal(child.identity, null);
        assert.equal(outcomeUsage(state).reservedSeconds, 0);
      }
    } finally {
      // The fixture asks its own child to exit, without targeting a possibly reused PID.
      await fsp.writeFile(path.join(cwd, "src", "stop-descendant.txt"), "stop");
      if (descendantPid !== undefined) {
        for (let attempt = 0; attempt < 20; attempt++) {
          const child = await inspectProcessIdentity(descendantPid);
          if (child.proven && child.identity === null) break;
          await delay(100);
        }
      }
    }
  });
});

test("cancellation saved before worker claim prevents even a fast evaluator from starting", async () => {
  await withTempDir("worker", "cancel-before-claim", async (cwd) => {
    const action = await fixture(
      cwd,
      `require('node:fs').writeFileSync('src/ran.txt', 'ran'); console.log('AUTORESEARCH_OBSERVATION {"kind":"predicate","observed":"satisfied"}');`,
    );
    await nominateOutcomeAction(cwd, action);
    await launchOutcomeWorker(cwd, "A1");
    await requestOutcomeCancellation(cwd, "A1");
    const receipt = await waitFor(cwd, (entry) =>
      ["cancelled", "completed"].includes(entry.status.kind),
    );
    assert.equal(receipt.status.kind, "cancelled");
    assert.equal(
      await fsp.access(path.join(cwd, "src", "ran.txt")).then(
        () => true,
        () => false,
      ),
      false,
    );
  });
});

test("malformed predicate values finish invalid and remain resumable", async () => {
  await withTempDir("worker", "invalid-shape", async (cwd) => {
    const action = await fixture(
      cwd,
      `console.log('AUTORESEARCH_OBSERVATION {"kind":"predicate","observed":["satisfied"]}');`,
    );
    await nominateOutcomeAction(cwd, action);
    await launchOutcomeWorker(cwd, "A1");
    const receipt = await waitFor(cwd, (entry) => entry.status.kind === "completed");
    assert.equal(receipt.result?.validity, "invalid");
    assert.equal((await reconcileOutcomeWorker(cwd, "A1")).status.kind, "completed");
  });
});

test("fractional remaining allowance cannot turn a late result into a valid observation", async () => {
  await withTempDir("worker", "fractional-deadline", async (cwd) => {
    const action = await fixture(
      cwd,
      `setTimeout(() => console.log('AUTORESEARCH_OBSERVATION {"kind":"predicate","observed":"satisfied"}'), 650);`,
    );
    await nominateOutcomeAction(cwd, {
      ...action,
      seconds: 0.4,
      evaluator: { ...action.evaluator, checkArgv: [] },
    });
    await launchOutcomeWorker(cwd, "A1");
    const receipt = await waitFor(cwd, (entry) =>
      ["cancelled", "failed"].includes(entry.status.kind),
    );
    assert.notEqual(receipt.result?.validity, "valid");
  });
});

test("resume can perform the first durable launch after a crash before launch nomination", async () => {
  await withTempDir("worker", "before-launch", async (cwd) => {
    const action = await fixture(
      cwd,
      `require('node:fs').writeFileSync('src/ran.txt', 'once'); console.log('AUTORESEARCH_OBSERVATION {"kind":"predicate","observed":"satisfied"}');`,
    );
    const nominated = await nominateOutcomeAction(cwd, action);
    assert.equal(nominated.worker, null);
    await nextOutcomeAction({ cwd, resume: "A1" });
    const receipt = await waitFor(cwd, (entry) => entry.status.kind === "completed");
    assert.ok(receipt.worker?.launchId);
    assert.equal(await fsp.readFile(path.join(cwd, "src", "ran.txt"), "utf8"), "once");
  });
});

test("lost-worker cancellation reconciles process exposure conservatively without inventing a measurement", async () => {
  await withTempDir("worker", "lost-owner", async (cwd) => {
    const action = await fixture(
      cwd,
      `require('node:fs').writeFileSync('src/running.txt', String(process.pid)); setInterval(() => {}, 100);`,
    );
    await nominateOutcomeAction(cwd, action);
    await launchOutcomeWorker(cwd, "A1");
    const running = await waitFor(cwd, (entry) => entry.worker?.child?.identity != null);
    process.kill(running.worker!.pid!, "SIGKILL");
    for (let attempts = 0; attempts < 30; attempts++) {
      if ((await inspectProcessIdentity(running.worker!.pid!)).identity === null) break;
      await delay(100);
    }
    await reconcileOutcomeWorker(cwd, "A1");
    assert.equal(outcomeUsage((await readOutcome(cwd))!).unknownExecutions, 1);
    await requestOutcomeCancellation(cwd, "A1");
    const reconciled = await reconcileOutcomeWorker(cwd, "A1");
    assert.equal(reconciled.status.kind, "cancelled");
    assert.equal(reconciled.result?.validity, "unknown");
    const usage = outcomeUsage((await readOutcome(cwd))!);
    assert.ok(usage.estimatedSeconds >= action.seconds);
    assert.equal(usage.measuredSeconds, 0);
    assert.equal(usage.unknownExecutions, 0);
    assert.equal((await inspectProcessIdentity(running.worker!.child!.pid)).identity, null);
  });
});

test("an unattempted nomination can be cancelled without launching work", async () => {
  await withTempDir("worker", "unattempted-cancel", async (cwd) => {
    const action = await fixture(
      cwd,
      `require('node:fs').writeFileSync('src/ran.txt', 'unexpected');`,
    );
    await nominateOutcomeAction(cwd, action);
    await nextOutcomeAction({ cwd, resume: "A1", cancel: true });
    const state = (await readOutcome(cwd))!;
    assert.equal(state.executions[0].status.kind, "cancelled");
    assert.equal(state.executions[0].worker, null);
    assert.equal(outcomeUsage(state).reservedSeconds, 0);
    assert.ok(outcomeUsage(state).measuredSeconds > 0);
    assert.equal(
      await fsp.access(path.join(cwd, "src", "ran.txt")).then(
        () => true,
        () => false,
      ),
      false,
    );
  });
});

test("metric movement uses qualified actual references independently of target attainment", async () => {
  await withTempDir("worker", "metric-reference", async (cwd) => {
    await fsp.mkdir(path.join(cwd, "src"));
    await fsp.mkdir(path.join(cwd, "checks"));
    await fsp.writeFile(path.join(cwd, "src/value.txt"), "10");
    await fsp.writeFile(
      path.join(cwd, "checks/evaluate.cjs"),
      `console.log('METRIC loss=' + require('node:fs').readFileSync('src/value.txt', 'utf8'));`,
    );
    const manifestBytes = JSON.stringify({
      schemaVersion: 1,
      criteria: {
        compatibility: {
          subject: ["src"],
          evaluator: ["checks"],
          fixtures: [],
          checks: ["checks"],
        },
      },
    });
    await fsp.writeFile(path.join(cwd, "checks/dependencies.json"), manifestBytes);
    await startOutcome(cwd, {
      ...governedFixture(cwd),
      budget: { actions: 5, executionSeconds: 180 },
      dependencySource: {
        path: "checks/dependencies.json",
        digest: createHash("sha256").update(manifestBytes).digest("hex"),
        authorityReference: "accepted fixture dependency closure",
      },
    });
    const base = actionFixture("A1");
    const action = {
      ...base,
      mode: "process",
      effects: ["execute"],
      seconds: 30,
      evaluator: {
        ...base.evaluator,
        repeats: 2,
        method: {
          kind: "metric",
          name: "loss",
          direction: "lower",
          minimumImprovement: 0,
          tolerance: 0,
          target: { comparator: "<=", value: 5 },
        },
        argv: [process.execPath, "checks/evaluate.cjs"],
        checkArgv: [process.execPath, "-e", "process.exit(0)"],
      },
    };
    for (const id of ["A1", "A2"]) {
      await nominateOutcomeAction(cwd, { ...action, id });
      await launchOutcomeWorker(cwd, id);
      const receipt = await waitFor(cwd, (entry) => entry.status.kind === "completed", id);
      assert.equal(receipt.result?.validity, "valid");
      await logOutcomeObservation(cwd, {
        id: `E${id.slice(1)}`,
        executionId: id,
        criterionId: "compatibility",
        text: "Actual baseline measurement",
      });
    }
    await fsp.writeFile(path.join(cwd, "src/value.txt"), "7");
    await nominateOutcomeAction(cwd, { ...action, id: "A3", referenceEvidenceIds: ["E1", "E2"] });
    await launchOutcomeWorker(cwd, "A3");
    const candidate = await waitFor(cwd, (entry) => entry.status.kind === "completed", "A3");
    assert.equal(candidate.result?.movement, "improved");
    assert.equal(candidate.result?.attainment, "unsatisfied");
    const state = (await readOutcome(cwd))!;
    const manifest = await readOutcomeDependencyManifest(state, cwd);
    assert.equal(metricReference(state, candidate, manifest), 10);
    const forged = structuredClone(state);
    forged.evidence[1] = { ...forged.evidence[0], id: "E2", measurementId: "forged-repeat" };
    assert.equal(metricReference(forged, candidate, manifest), null);
    const mixedSubjects = structuredClone(state);
    mixedSubjects.executions[1].completedInput!.files["src/value.txt"] = "f".repeat(64);
    assert.equal(metricReference(mixedSubjects, candidate, manifest), null);
    assert.equal(
      metricReference(
        state,
        { ...candidate, action: { ...candidate.action, referenceEvidenceIds: ["E1", "E1"] } },
        manifest,
      ),
      null,
    );
    await logOutcomeObservation(cwd, {
      id: "E3",
      executionId: "A3",
      criterionId: "compatibility",
      text: "Improvement still misses target",
    });
    const registry = buildOutcomeEvidenceRegistry({
      state: (await readOutcome(cwd))!,
      input: await captureOutcomeInputs(cwd, "local"),
      manifest,
    });
    assert.equal(
      registry.entries.find((entry) => entry.evidence.id === "E3")?.applicability,
      "applicable",
    );
  });
});
