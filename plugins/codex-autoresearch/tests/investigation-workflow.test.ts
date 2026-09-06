import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { startOutcome, readOutcome, amendOutcome } from "../lib/outcome-store.js";
import {
  nominateOutcomeAction,
  resumeOutcomeAction,
  logOutcomeObservation,
} from "../lib/investigation-workflow.js";
import { loadCanonicalSessionDecision } from "../lib/session-decision.js";
import { compileDecisionPlan } from "../lib/decision-compiler.js";
import { outcomeUsage } from "../lib/outcome-contract.js";
import { runGit, withTempDir } from "./helpers/process.js";

import { governedFixture, actionFixture } from "./helpers/outcome-fixtures.js";

async function setup(cwd: string) {
  await fsp.mkdir(path.join(cwd, "src"));
  await fsp.writeFile(path.join(cwd, "src", "fixture.txt"), "incompatible");
  await startOutcome(cwd, governedFixture(cwd));
}

test("missing budgets and fabricated evidence cannot create governed execution", async () => {
  await withTempDir("workflow", "missing-budget", async (cwd) => {
    await assert.rejects(nominateOutcomeAction(cwd, actionFixture("A1")), /explicit budget/);
    await setup(cwd);
    await assert.rejects(
      nominateOutcomeAction(cwd, { ...actionFixture("A1"), evidenceRefs: ["invented"] }),
      /no terminal execution/,
    );
    assert.equal(outcomeUsage((await readOutcome(cwd))!).actions, 0);
  });
});

test("tickets resume exactly and valid counterexamples close the hypothesis, not the outcome", async () => {
  await withTempDir("workflow", "predicate", async (cwd) => {
    await setup(cwd);
    const receipt = await nominateOutcomeAction(cwd, actionFixture("A1"));
    assert.equal(receipt.status.kind, "ticket");
    assert.equal((await resumeOutcomeAction(cwd, "A1")).token, receipt.token);
    assert.equal((await nominateOutcomeAction(cwd, actionFixture("A1"))).token, receipt.token);
    await assert.rejects(nominateOutcomeAction(cwd, actionFixture("A2")), /existing action/);
    const evidence = await logOutcomeObservation(cwd, {
      id: "E1",
      executionId: "A1",
      criterionId: "compatibility",
      text: "The example is a counterexample",
      completed: true,
      observation: { observed: "counterexample" },
      resolution: "refuted",
    });
    assert.equal(evidence.result.validity, "valid");
    assert.equal(evidence.result.conclusion, "refuted");
    assert.equal(evidence.result.codeAcceptance, "unassessed");
    const state = (await readOutcome(cwd))!;
    assert.equal(state.investigations[0].resolution, "refuted");
    assert.equal(state.lifecycle.kind, "active");
    assert.equal(outcomeUsage(state).actions, 1);
    const decision = await loadCanonicalSessionDecision({ requestedCwd: cwd });
    assert.ok(decision.ok);
    assert.equal(decision.plan.investigation?.status, "active");
    assert.deepEqual(decision.plan.investigation?.unresolvedCriteria, ["compatibility"]);
    await assert.rejects(nominateOutcomeAction(cwd, actionFixture("A2")), /closed/);
    const next = actionFixture("A2");
    await nominateOutcomeAction(cwd, {
      ...next,
      purpose: "preparation",
      evaluator: null,
      effects: ["edit"],
      paths: ["src"],
      investigation: {
        ...next.investigation,
        id: "H2",
        question: "Can a revised fixture fix the counterexample?",
        evidenceRefs: ["E1"],
      },
    });
    assert.equal(outcomeUsage((await readOutcome(cwd))!).actions, 2);
  });
});

test("exact duplicate measurements cannot become fresh by changing execution identity", async () => {
  await withTempDir("workflow", "duplicate", async (cwd) => {
    await setup(cwd);
    await nominateOutcomeAction(cwd, actionFixture("A1"));
    await logOutcomeObservation(cwd, {
      id: "E1",
      executionId: "A1",
      criterionId: "compatibility",
      text: "Observed fixture",
      completed: true,
      observation: { observed: "inconclusive" },
    });
    await assert.rejects(nominateOutcomeAction(cwd, actionFixture("A2")), /Exact duplicate/);
    const state = (await readOutcome(cwd))!;
    assert.equal(state.executions[1].status.kind, "failed");
    assert.equal(
      outcomeUsage(state).actions,
      2,
      "preparation used the reserved action even when admission found a duplicate",
    );
  });
});

test("outcome scope and immutable evaluator versions contain each child action", async () => {
  await withTempDir("workflow", "containment", async (cwd) => {
    await setup(cwd);
    for (const delta of [
      { effects: ["publish"] },
      { environment: "remote" },
      { effects: ["edit"], paths: ["checks"] },
      { effects: ["edit"], paths: ["other"] },
    ])
      await assert.rejects(
        nominateOutcomeAction(cwd, { ...actionFixture("A1"), ...delta }),
        /scope|protected|authorization/,
      );
    const action = actionFixture("A1");
    await nominateOutcomeAction(cwd, action);
    await logOutcomeObservation(cwd, {
      id: "E1",
      executionId: "A1",
      criterionId: "compatibility",
      text: "Observed fixture",
      completed: true,
      observation: { observed: "counterexample" },
    });
    await assert.rejects(
      nominateOutcomeAction(cwd, {
        ...action,
        id: "A2",
        evaluator: { ...action.evaluator, repeats: 2 },
      }),
      /immutable/,
    );
    await amendOutcome(
      cwd,
      { ...governedFixture(cwd), budget: { actions: 6, executionSeconds: 150 } },
      "user-additional-budget",
      "Continue with additional allowance",
    );
    assert.equal(outcomeUsage((await readOutcome(cwd))!).actions, 1);
  });
});

test("managed observations cannot conceal out-of-scope edits or unknown input coverage", async () => {
  await withTempDir("workflow", "scope-drift", async (cwd) => {
    await setup(cwd);
    await nominateOutcomeAction(cwd, actionFixture("A1"));
    await fsp.writeFile(path.join(cwd, "outside.txt"), "changed");
    await assert.rejects(
      logOutcomeObservation(cwd, {
        id: "E1",
        executionId: "A1",
        criterionId: "compatibility",
        text: "Claimed completion",
        completed: true,
        observation: { observed: "satisfied" },
      }),
      /outside.*ticket/,
    );
    assert.equal((await readOutcome(cwd))!.executions[0].status.kind, "ticket");
    assert.equal(outcomeUsage((await readOutcome(cwd))!).reservedSeconds, 10);
  });
});

test("observation replay cannot change the recorded result or close a different hypothesis", async () => {
  await withTempDir("workflow", "observation-replay", async (cwd) => {
    await setup(cwd);
    await nominateOutcomeAction(cwd, actionFixture("A1"));
    const observation = {
      id: "E1",
      executionId: "A1",
      criterionId: "compatibility",
      text: "Observed fixture",
      completed: true,
      observation: { observed: "counterexample" },
    };
    const evidence = await logOutcomeObservation(cwd, observation);
    assert.deepEqual(await logOutcomeObservation(cwd, observation), evidence);
    await assert.rejects(
      logOutcomeObservation(cwd, { ...observation, observation: { observed: "satisfied" } }),
      /different observation/,
    );
    await assert.rejects(
      logOutcomeObservation(cwd, { ...observation, resolution: "refuted" }),
      /different observation/,
    );
    assert.equal((await readOutcome(cwd))!.evidence.length, 1);
  });
});

test("every preparation, failed duplicate, and evaluator revision consumes the same allowance", async () => {
  await withTempDir("workflow", "cumulative", async (cwd) => {
    await setup(cwd);
    const action = actionFixture("A1");
    for (let index = 1; index <= 5; index++) {
      const id = `A${index}`;
      await nominateOutcomeAction(cwd, {
        ...action,
        id,
        evaluator: { ...action.evaluator, id: `predicate-v${index}` },
      });
      await logOutcomeObservation(cwd, {
        id: `E${index}`,
        executionId: id,
        criterionId: "compatibility",
        text: "Inconclusive observation",
        completed: true,
        observation: { observed: "inconclusive" },
      });
    }
    await assert.rejects(
      nominateOutcomeAction(cwd, {
        ...action,
        id: "A6",
        evaluator: { ...action.evaluator, id: "predicate-v6" },
      }),
      /budget exhausted/,
    );
    const plan = await loadCanonicalSessionDecision({ requestedCwd: cwd });
    assert.ok(plan.ok);
    assert.equal(plan.plan.investigation?.status, "stopped-unmet");
    assert.equal(plan.plan.investigation?.remaining.actions, 0);
    assert.equal(plan.plan.parentDisposition.mayClaimCompletion, false);
  });
});

test("a rejected admission is not a repairable execution and cannot renew completed repeats", async () => {
  await withTempDir("workflow", "rejected-repair", async (cwd) => {
    await setup(cwd);
    await nominateOutcomeAction(cwd, actionFixture("A1"));
    await logOutcomeObservation(cwd, {
      id: "E1",
      executionId: "A1",
      criterionId: "compatibility",
      text: "Observed fixture",
      completed: true,
      observation: { observed: "inconclusive" },
    });
    await assert.rejects(nominateOutcomeAction(cwd, actionFixture("A2")), /Exact duplicate/);
    const rejected = (await readOutcome(cwd))!.executions[1];
    assert.ok(rejected.input);
    assert.equal(rejected.status.kind === "failed" && rejected.status.failureStage, "preparation");
    await assert.rejects(
      nominateOutcomeAction(cwd, { ...actionFixture("A3"), purpose: "repair", repairOf: "A2" }),
      /actual failed execution/,
    );
    assert.equal(outcomeUsage((await readOutcome(cwd))!).actions, 2);
  });
});

test("execution operations reject a different authorized worktree", async () => {
  await withTempDir("workflow", "execution-owner", async (root) => {
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    await fsp.mkdir(first);
    await runGit(first, ["init"]);
    await runGit(first, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "base",
    ]);
    await runGit(first, ["worktree", "add", "-b", "second", second]);
    const contract = governedFixture(first);
    await startOutcome(first, {
      ...contract,
      authorization: { ...contract.authorization, worktrees: [first, second] },
    });
    await nominateOutcomeAction(first, actionFixture("A1"));
    await assert.rejects(
      nominateOutcomeAction(second, actionFixture("A1")),
      /different authorized worktree/,
    );
    await assert.rejects(resumeOutcomeAction(second, "A1"), /different authorized worktree/);
    await assert.rejects(
      logOutcomeObservation(second, {
        id: "E1",
        executionId: "A1",
        criterionId: "compatibility",
        text: "Wrong worktree",
        completed: true,
        observation: { observed: "satisfied" },
      }),
      /different authorized worktree/,
    );
    assert.equal((await readOutcome(first))!.executions[0].status.kind, "ticket");
  });
});

test("visible inputs cannot alias excluded private authority files", async () => {
  await withTempDir("workflow", "private-input-link", async (cwd) => {
    await setup(cwd);
    await fsp.mkdir(path.join(cwd, ".autoresearch"), { recursive: true });
    await fsp.writeFile(path.join(cwd, ".autoresearch", "payload.txt"), "baseline");
    await fsp.symlink("../.autoresearch/payload.txt", path.join(cwd, "src", "input.txt"));
    await assert.rejects(nominateOutcomeAction(cwd, actionFixture("A1")), /link escapes/);
    const receipt = (await readOutcome(cwd))!.executions[0];
    assert.equal(receipt.status.kind, "failed");
    assert.equal(receipt.input, null);
  });
});

test("outcome projections cannot inherit legacy evaluator or check authority", async () => {
  await withTempDir("workflow", "legacy-projection", async (cwd) => {
    await setup(cwd);
    const loaded = await loadCanonicalSessionDecision({ requestedCwd: cwd });
    assert.ok(loaded.ok);
    const plan = compileDecisionPlan(
      {
        ...loaded.snapshot,
        outcomeFacts: loaded.factCollection?.outcomeFacts,
        semanticFacts: {
          contractDigest: "legacy",
          evaluatorIdentity: "legacy-evaluator",
          acceptedCheckIdentities: ["legacy-check"],
          preconditionEpoch: "legacy-epoch",
        },
      },
      [],
    );
    assert.equal(plan.contractDigest, loaded.snapshot.outcome!.contract.digest);
    assert.equal(plan.evaluatorIdentity, "");
    assert.deepEqual(plan.requiredEvidence.acceptedCheckIdentities, []);
    assert.notEqual(plan.requiredEvidence.preconditionEpoch, "legacy-epoch");
    assert.equal(plan.outcome.validity, "unknown");
    assert.equal(plan.parentDisposition.mayClaimCompletion, false);
  });
});
