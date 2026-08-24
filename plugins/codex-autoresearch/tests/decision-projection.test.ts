import assert from "node:assert/strict";
import test from "node:test";

import { compileDecisionPlan, decisionDiagnostic } from "../lib/decision-compiler.js";
import {
  projectDecisionPlan,
  projectCompactDecisionPlan,
  projectDashboardDecisionPlan,
  projectLoopContinuation,
  projectResolvedDecision,
} from "../lib/decision-projection.js";
import type { CoherentSessionSnapshot } from "../lib/coherent-session-snapshot.js";

test("terminal and dashboard projections preserve one semantic plan while dashboard redacts command text", () => {
  const plan = compileDecisionPlan(snapshotFixture(), [
    decisionDiagnostic("stale-packet", {
      message: "Replace the stale packet.",
      command: "node scripts/autoresearch.mjs next --cwd /private/project --compact",
    }),
  ]);
  const terminal = projectDecisionPlan(plan, "terminal");
  const dashboard = projectDecisionPlan(plan, "dashboard");

  for (const field of [
    "decisionId",
    "generationId",
    "phase",
    "actionKind",
    "primaryBlockerCode",
    "parentDisposition",
    "contractDigest",
    "evaluatorIdentity",
    "commandDigest",
  ] as const) {
    assert.deepEqual(dashboard[field], terminal[field], field);
  }
  assert.match(terminal.command, /autoresearch\.mjs next/);
  assert.equal(dashboard.command, "");
  assert.equal(dashboard.commandRedacted, true);

  const dashboardPlan = projectDashboardDecisionPlan(plan);
  assert.equal(dashboardPlan.action.command, "");
  assert.equal(dashboardPlan.action.commandDigest, plan.action.commandDigest);
  assert.equal(dashboardPlan.display.actionReason, plan.action.reason);
  assert.equal(dashboardPlan.decisionId, plan.decisionId);
});

test("resolved-decision compatibility is a one-way projection from DecisionPlan", () => {
  const plan = compileDecisionPlan(snapshotFixture(), [
    decisionDiagnostic("no-learning-pause", { message: "Pause packets." }),
  ]);
  const resolved = projectResolvedDecision(plan);

  assert.equal(resolved.decisionId, plan.decisionId);
  assert.equal(resolved.canonicalNextAction?.kind, "pause-packets");
  assert.equal(resolved.loopContract?.canRunNextPacket, false);
  assert.equal(resolved.parentDisposition, "hand-back");
  assert.equal(Object.hasOwn(resolved, "decisionEnvelope"), false);
  assert.equal(Object.hasOwn(resolved, "resumeAudit"), false);
});

test("plan summary preserves capability, disposition, and learning semantics", () => {
  const snapshot = snapshotFixture();
  snapshot.records = [
    {
      type: "run",
      run: 1,
      runPurpose: "candidate",
      evaluationAuthority: "accepted-contract",
      candidateOrigin: { kind: "working-tree" },
      experimentContractDigest: "contract-a",
      preconditionEpoch: "epoch-a",
      learning: {
        kind: "causal",
        changedBelief: "The captured trace identifies the causal boundary.",
        evidence: ["trace:accepted-candidate"],
      },
    },
  ];
  const plan = compileDecisionPlan(snapshot, [
    decisionDiagnostic("finalization-blocked", { message: "Finalization only." }),
  ]);
  const summary = projectCompactDecisionPlan(plan);
  const dashboard = projectDashboardDecisionPlan(plan);

  assert.equal(summary.kind, "decision-plan-projection");
  assert.equal(summary.capabilities.finalize, "blocked");
  assert.deepEqual(summary.requiredEvidence.capabilityEffectCodes, [
    "finalization-blocked:finalize:blocked",
  ]);
  assert.deepEqual(summary.requiredEvidence.acceptedCheckIdentities, ["check-a@digest-a"]);
  assert.deepEqual(summary.loopDisposition, plan.loopDisposition);
  assert.deepEqual(summary.parentDisposition, plan.parentDisposition);
  assert.equal(summary.learning.kind, plan.learning.latest.kind);
  assert.equal(
    summary.learning.changedBelief,
    "The captured trace identifies the causal boundary.",
  );
  assert.deepEqual(summary.learning.evidence, ["trace:accepted-candidate"]);
  assert.deepEqual(dashboard.learning, summary.learning);
});

test("continuation projects loop and parent dispositions without reinterpreting prose", () => {
  const recoveryPlan = compileDecisionPlan(snapshotFixture(), [
    decisionDiagnostic("pending-log-transaction-inconsistent", {
      message: "arbitrary prose that does not mention blocking",
    }),
  ]);
  const continuation = projectLoopContinuation(recoveryPlan);

  assert.equal(continuation.shouldContinue, false);
  assert.equal(continuation.canRunNextPacket, false);
  assert.equal(continuation.forbidFinalAnswer, true);
  assert.equal(continuation.parentDisposition, "block-final-answer");
});

function snapshotFixture(): CoherentSessionSnapshot {
  return {
    kind: "coherent-session-snapshot",
    schemaVersion: 1,
    generationId: "generation-a",
    sessionCwd: "/session",
    workDir: "/worktree",
    vector: {
      ledger: { size: 0, mtimeNs: "0", tailHash: "missing" },
      config: { storage: "session", hash: "config" },
      packet: { storage: "git-private", hash: "missing" },
      receipt: { storage: "git-private", hash: "missing" },
      process: { storage: "git-private", hash: "missing" },
      git: { head: "head", indexTree: "index", statusHash: "status" },
    },
    records: [],
    config: {},
    lastRunPacket: null,
    pendingTransaction: null,
    processProgress: null,
    git: { head: "head", indexTree: "index", statusHash: "status" },
    semanticFacts: {
      contractDigest: "contract-a",
      evaluatorIdentity: "evaluator-a",
      acceptedCheckIdentities: ["check-a@digest-a"],
      preconditionEpoch: "epoch-a",
    },
  };
}
