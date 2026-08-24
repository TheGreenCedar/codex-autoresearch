import assert from "node:assert/strict";
import test from "node:test";

import {
  compileDecisionPlan,
  decisionDiagnostic,
  failureLayerPreconditions,
  type DecisionDiagnostic,
} from "../lib/decision-compiler.js";
import type { CoherentSessionSnapshot } from "../lib/coherent-session-snapshot.js";
import { finalizationDecisionDiagnostics } from "../lib/session-decision.js";

test("decision identity excludes prose, timestamps, and diagnostic order", () => {
  const snapshot = snapshotFixture();
  const first = compileDecisionPlan(snapshot, [
    decisionDiagnostic("packet-budget-exhausted", {
      message: "old prose",
      observedAt: "2026-01-01T00:00:00.000Z",
    }),
    decisionDiagnostic("finalization-blocked", { message: "branch is local" }),
  ]);
  const second = compileDecisionPlan(snapshot, [
    decisionDiagnostic("finalization-blocked", {
      message: "rewritten finalization prose",
    }),
    decisionDiagnostic("packet-budget-exhausted", {
      message: "new prose",
      observedAt: "2026-08-24T00:00:00.000Z",
    }),
  ]);

  assert.equal(second.decisionId, first.decisionId);
  assert.notEqual(second.generationId, "");

  const sameCodeFirst = compileDecisionPlan(snapshot, [
    decisionDiagnostic("packet-diagnostic", { semantic: { stage: "checks" } }),
    decisionDiagnostic("packet-diagnostic", { semantic: { stage: "benchmark" } }),
  ]);
  const sameCodeSecond = compileDecisionPlan(snapshot, [
    decisionDiagnostic("packet-diagnostic", { semantic: { stage: "benchmark" } }),
    decisionDiagnostic("packet-diagnostic", { semantic: { stage: "checks" } }),
  ]);
  assert.equal(sameCodeSecond.decisionId, sameCodeFirst.decisionId);
});

test("decision identity includes blocker, contract, evaluator, action, capability, and disposition semantics", () => {
  const snapshot = snapshotFixture();
  const base = compileDecisionPlan(snapshot, []);
  const cases: Array<[string, CoherentSessionSnapshot, DecisionDiagnostic[]]> = [
    ["blocker", snapshot, [decisionDiagnostic("pending-packet")]],
    ["capability", snapshot, [decisionDiagnostic("evaluator-drift")]],
    ["contract", snapshotFixture({ contractDigest: "contract-b" }), []],
    ["evaluator", snapshotFixture({ evaluatorIdentity: "eval-b" }), []],
    [
      "action",
      snapshot,
      [
        decisionDiagnostic("stale-packet", {
          semantic: { replacementFingerprint: "replacement-b" },
        }),
      ],
    ],
    ["loop disposition", snapshot, [decisionDiagnostic("no-learning-pause")]],
    ["parent disposition", snapshot, [decisionDiagnostic("pending-log-transaction-inconsistent")]],
  ];

  for (const [name, candidateSnapshot, diagnostics] of cases) {
    assert.notEqual(
      compileDecisionPlan(candidateSnapshot, diagnostics).decisionId,
      base.decisionId,
      name,
    );
  }
});

test("decision identity normalizes rendered commands while retaining typed action semantics", () => {
  const snapshot = snapshotFixture();
  const posix = compileDecisionPlan(snapshot, [
    decisionDiagnostic("stale-packet", {
      command: "node scripts/autoresearch.mjs next --cwd '/tmp/project' --replace-last",
      semantic: { replacementFingerprint: "replacement-a" },
    }),
  ]);
  const powershell = compileDecisionPlan(snapshot, [
    decisionDiagnostic("stale-packet", {
      command: 'node scripts/autoresearch.mjs next --cwd "C:\\tmp\\project" --replace-last',
      semantic: { replacementFingerprint: "replacement-a" },
    }),
  ]);
  const changed = compileDecisionPlan(snapshot, [
    decisionDiagnostic("stale-packet", {
      command: "node scripts/autoresearch.mjs next --replace-last",
      semantic: { replacementFingerprint: "replacement-b" },
    }),
  ]);

  assert.equal(powershell.decisionId, posix.decisionId);
  assert.notEqual(powershell.action.commandDigest, posix.action.commandDigest);
  assert.notEqual(changed.decisionId, posix.decisionId);
});

test("capability diagnostics remain scoped instead of becoming global packet brakes", () => {
  const cases = [
    {
      code: "pending-log-transaction-inconsistent",
      blocked: [
        "run-packet",
        "authorize-keep",
        "transition-segment",
        "finalize",
        "parent-final-answer",
      ],
      recoveryOnly: ["mutate-session"],
    },
    {
      code: "packet-budget-exhausted",
      blocked: ["run-packet"],
      allowed: [
        "mutate-session",
        "authorize-keep",
        "transition-segment",
        "finalize",
        "parent-final-answer",
      ],
    },
    {
      code: "no-learning-pause",
      blocked: ["run-packet"],
      allowed: [
        "mutate-session",
        "authorize-keep",
        "transition-segment",
        "finalize",
        "parent-final-answer",
      ],
    },
    {
      code: "finalization-blocked",
      blocked: ["finalize"],
      allowed: [
        "mutate-session",
        "run-packet",
        "authorize-keep",
        "transition-segment",
        "parent-final-answer",
      ],
    },
    {
      code: "evaluator-drift",
      blocked: ["run-packet", "authorize-keep"],
      allowed: ["mutate-session", "transition-segment", "finalize", "parent-final-answer"],
    },
    {
      code: "dirty-source",
      blocked: ["authorize-keep"],
      allowed: [
        "mutate-session",
        "run-packet",
        "transition-segment",
        "finalize",
        "parent-final-answer",
      ],
    },
    {
      code: "pending-packet",
      blocked: ["run-packet"],
      allowed: [
        "mutate-session",
        "authorize-keep",
        "transition-segment",
        "finalize",
        "parent-final-answer",
      ],
    },
    {
      code: "stale-packet",
      blocked: [],
      recoveryOnly: ["run-packet"],
      allowed: [
        "mutate-session",
        "authorize-keep",
        "transition-segment",
        "finalize",
        "parent-final-answer",
      ],
    },
    {
      code: "ledger-integrity",
      blocked: [
        "run-packet",
        "authorize-keep",
        "transition-segment",
        "finalize",
        "parent-final-answer",
      ],
      recoveryOnly: ["mutate-session"],
    },
  ] as const;

  for (const item of cases) {
    const plan = compileDecisionPlan(snapshotFixture(), [decisionDiagnostic(item.code)]);
    for (const capability of item.blocked || []) {
      assert.equal(plan.capabilities[capability], "blocked", `${item.code}:${capability}`);
    }
    for (const capability of item.recoveryOnly || []) {
      assert.equal(plan.capabilities[capability], "recovery-only", `${item.code}:${capability}`);
    }
    for (const capability of item.allowed || []) {
      assert.equal(plan.capabilities[capability], "allowed", `${item.code}:${capability}`);
    }
  }
});

test("two consecutive eligible no-learning candidates pause packets without changing segment", () => {
  const records = [
    candidateRecord({
      run: 1,
      learning: {
        kind: "causal",
        evidence: ["controlled comparison"],
        changedBelief: true,
      },
    }),
    candidateRecord({ run: 2 }),
    { type: "operator-note", message: "unrelated state change" },
    candidateRecord({ run: 3 }),
  ];
  const plan = compileDecisionPlan(snapshotFixture({ records }), []);

  assert.equal(plan.learning.consecutiveNoLearningCandidates, 2);
  assert.equal(plan.capabilities["run-packet"], "blocked");
  assert.equal(plan.primaryBlockerCode, "no-learning-pause");
  assert.equal(plan.action.kind, "pause-packets");
  assert.equal(plan.action.kind === "segment-transition", false);
  assert.equal(plan.loopDisposition.kind, "pause");
  assert.equal(plan.capabilities["transition-segment"], "allowed");
});

test("packet pauses override baseline guidance without inventing a runnable packet action", () => {
  for (const code of ["packet-budget-exhausted", "no-learning-pause"] as const) {
    const plan = compileDecisionPlan(snapshotFixture(), [
      decisionDiagnostic("needs-baseline"),
      decisionDiagnostic(code),
    ]);
    assert.equal(plan.primaryBlockerCode, code);
    assert.equal(plan.action.kind, "pause-packets");
    assert.equal(plan.capabilities["run-packet"], "blocked");
    assert.equal(plan.loopDisposition.kind, "pause");
    assert.equal(plan.loopDisposition.shouldContinue, false);
  }
});

test("ineligible purposes and external-infrastructure-invalid outcomes never count as no-learning", () => {
  const records = [
    candidateRecord({ run: 1 }),
    candidateRecord({ run: 2, runPurpose: "baseline" }),
    candidateRecord({ run: 3, runPurpose: "holdout" }),
    candidateRecord({ run: 4, evaluationAuthority: "manual" }),
    candidateRecord({
      run: 5,
      failure: { layer: "external-infrastructure", code: "network" },
    }),
    candidateRecord({ run: 6, preconditionEpoch: "other-epoch" }),
  ];
  const plan = compileDecisionPlan(snapshotFixture({ records }), []);

  assert.equal(plan.learning.consecutiveNoLearningCandidates, 1);
  assert.equal(plan.capabilities["run-packet"], "allowed");
});

test("causal or discriminating learning requires evidence and an explicitly changed belief", () => {
  const cases = [
    [{ kind: "none" }, "none"],
    [{ kind: "causal", changedBelief: true }, "none"],
    [{ kind: "causal", evidence: ["trace"], changedBelief: false }, "none"],
    [{ kind: "causal", evidence: ["trace"], changedBelief: true }, "causal"],
    [{ kind: "discriminating", evidence: ["holdout"], changedBelief: true }, "discriminating"],
  ] as const;
  for (const [learning, expected] of cases) {
    const plan = compileDecisionPlan(
      snapshotFixture({ records: [candidateRecord({ run: 1, learning })] }),
      [],
    );
    assert.equal(plan.learning.latest.kind, expected);
  }
});

test("outcome is calculated from accepted metric semantics instead of an operator label", () => {
  const minimizeContract = acceptedContractRecord({
    metric: {
      kind: "minimize",
      metricName: "seconds",
      unit: "s",
      minimumImprovement: 1,
    },
  });
  const improved = compileDecisionPlan(
    snapshotFixture({
      records: [
        minimizeContract,
        candidateRecord({ run: 1, metric: 10, status: "measure" }),
        candidateRecord({
          run: 2,
          metric: 8,
          status: "discard",
          outcome: { kind: "regressed" },
        }),
      ],
    }),
    [],
  );
  assert.equal(improved.outcome.kind, "improved");

  const threshold = compileDecisionPlan(
    snapshotFixture({
      records: [
        acceptedContractRecord({
          metric: {
            kind: "threshold",
            metricName: "score",
            unit: "points",
            comparator: ">=",
            target: 90,
          },
        }),
        candidateRecord({ run: 1, metric: 93, outcome: { kind: "invalid" } }),
      ],
    }),
    [],
  );
  assert.equal(threshold.outcome.kind, "threshold-met");
});

test("invalid accepted checks remain invalid even when a metric would otherwise improve", () => {
  const plan = compileDecisionPlan(
    snapshotFixture({
      records: [
        acceptedContractRecord(),
        candidateRecord({ run: 1, metric: 10 }),
        candidateRecord({
          run: 2,
          metric: 5,
          failure: { layer: "accepted-check", code: "unit-test" },
          outcome: { kind: "improved" },
        }),
      ],
    }),
    [],
  );
  assert.equal(plan.outcome.kind, "invalid");
});

test("same-layer failure counting validates exhaustive precondition identities and pauses", () => {
  assert.deepEqual(Object.keys(failureLayerPreconditions).sort(), [
    "accepted-check",
    "contract",
    "evaluator",
    "external-infrastructure",
    "process",
    "repository",
  ]);
  for (const [layer, preconditions] of Object.entries(failureLayerPreconditions)) {
    assert.ok(preconditions.length > 0, layer);
  }

  const evaluatorPreconditions = {
    acceptedEvaluatorIdentity: "eval-a",
    acceptedEvaluatorExecutionDigest: "digest-a",
    preconditionEpoch: "epoch-a",
  };
  const records = [
    candidateRecord({
      run: 1,
      failure: {
        layer: "evaluator",
        code: "exit",
        preconditions: evaluatorPreconditions,
      },
    }),
    { type: "approval", timestamp: 7 },
    candidateRecord({
      run: 2,
      failure: {
        layer: "evaluator",
        code: "metric",
        preconditions: evaluatorPreconditions,
      },
    }),
  ];
  const plan = compileDecisionPlan(
    snapshotFixture({ records, evaluatorIdentity: "eval-a@digest-a" }),
    [],
  );
  assert.equal(plan.failures.layer, "evaluator");
  assert.equal(plan.failures.consecutive, 2);
  assert.equal(plan.primaryBlockerCode, "same-layer-failure-pause");
  assert.equal(plan.capabilities["run-packet"], "blocked");
  assert.equal(plan.loopDisposition.kind, "pause");

  const missingIdentity = compileDecisionPlan(
    snapshotFixture({
      evaluatorIdentity: "eval-a@digest-a",
      records: [candidateRecord({ run: 1, failure: { layer: "evaluator", code: "exit" } })],
    }),
    [],
  );
  assert.equal(missingIdentity.failures.consecutive, 0);

  const changedIdentity = compileDecisionPlan(
    snapshotFixture({
      evaluatorIdentity: "eval-a@digest-a",
      records: [
        records[0],
        candidateRecord({
          run: 2,
          failure: {
            layer: "evaluator",
            code: "metric",
            preconditions: {
              ...evaluatorPreconditions,
              acceptedEvaluatorExecutionDigest: "digest-b",
            },
          },
        }),
      ],
    }),
    [],
  );
  assert.equal(changedIdentity.failures.consecutive, 0);
});

test("finalization-only blockers permit direct parent handback unless the final claim depends on finalization", () => {
  const direct = compileDecisionPlan(snapshotFixture(), [
    decisionDiagnostic("finalization-blocked"),
  ]);
  assert.equal(direct.parentDisposition.kind, "hand-back");
  assert.equal(direct.capabilities["parent-final-answer"], "allowed");

  const claimed = compileDecisionPlan(snapshotFixture(), [
    decisionDiagnostic("finalization-claim-blocked"),
  ]);
  assert.equal(claimed.parentDisposition.kind, "block-final-answer");
  assert.equal(claimed.capabilities["parent-final-answer"], "blocked");
});

test("finalization projections cannot supply canonical action prose or commands", () => {
  const [blocked] = finalizationDecisionDiagnostics({
    finalization: {
      ready: false,
      blockers: [],
      warnings: [],
      nextAction: "legacy next-action projection",
      suggestedCommand: "legacy projected command",
    },
  });
  const [ready] = finalizationDecisionDiagnostics({
    finalization: {
      ready: true,
      nextAction: "legacy ready projection",
      suggestedCommand: "legacy ready command",
    },
  });

  assert.deepEqual(blocked, decisionDiagnostic("finalization-blocked"));
  assert.deepEqual(ready, decisionDiagnostic("finalization-ready"));
});

function snapshotFixture(
  overrides: {
    contractDigest?: string;
    evaluatorIdentity?: string;
    records?: Record<string, unknown>[];
  } = {},
): CoherentSessionSnapshot {
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
    records: overrides.records || [],
    config: {},
    lastRunPacket: null,
    pendingTransaction: null,
    processProgress: null,
    git: { head: "head", indexTree: "index", statusHash: "status" },
    semanticFacts: {
      contractDigest: overrides.contractDigest || "contract-a",
      evaluatorIdentity: overrides.evaluatorIdentity || "eval-a",
      acceptedCheckIdentities: ["check-a@digest-a"],
      preconditionEpoch: "epoch-a",
    },
  } as CoherentSessionSnapshot;
}

function candidateRecord(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "run",
    run: 1,
    runPurpose: "candidate",
    evaluationAuthority: "accepted-contract",
    candidateOrigin: { kind: "working-tree" },
    experimentContractDigest: "contract-a",
    preconditionEpoch: "epoch-a",
    learning: { kind: "none" },
    ...overrides,
  };
}

function acceptedContractRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "experiment-contract-accepted",
    schemaVersion: 1,
    eventId: "experiment-contract-accepted:0:contract-a",
    segment: 0,
    contract: {
      contractDigest: "contract-a",
      metric: {
        kind: "minimize",
        metricName: "seconds",
        unit: "s",
        minimumImprovement: 0,
      },
      noise: { kind: "deterministic" },
      ...overrides,
    },
  };
}
