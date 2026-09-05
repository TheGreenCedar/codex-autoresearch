import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  compileDecisionPlan,
  decisionDiagnostic,
  failureLayerPreconditions,
  type DecisionDiagnostic,
} from "../lib/decision-compiler.js";
import type { CoherentSessionSnapshot } from "../lib/coherent-session-snapshot.js";
import { finalizationDecisionDiagnostics } from "../lib/session-decision.js";
import { buildFinalizationEvidenceState } from "../lib/finalization-plan.js";
import {
  buildFinalizationProductClaimCoverageFromLedger,
  productClaimCoverageFingerprintMaterial,
} from "../lib/product-claim-coverage.js";

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

test("decision identity includes typed command semantics and rejects conflicting duplicates", () => {
  const snapshot = snapshotFixture();
  const next = compileDecisionPlan(snapshot, [
    decisionDiagnostic("packet-diagnostic", {
      command: "node scripts/autoresearch.mjs partial-results --from-last --cwd /tmp/project",
      semantic: { stage: "benchmark" },
    }),
  ]);
  const doctor = compileDecisionPlan(snapshot, [
    decisionDiagnostic("packet-diagnostic", {
      command: "node scripts/autoresearch.mjs ledger-doctor --json --cwd /tmp/project",
      semantic: { stage: "benchmark" },
    }),
  ]);
  assert.notEqual(next.action.commandSemanticId, doctor.action.commandSemanticId);
  assert.notEqual(next.decisionId, doctor.decisionId);

  for (const diagnostics of [
    [
      decisionDiagnostic("packet-diagnostic", {
        command: "node scripts/autoresearch.mjs partial-results --from-last",
        semantic: { stage: "benchmark" },
      }),
      decisionDiagnostic("packet-diagnostic", {
        command: "node scripts/autoresearch.mjs ledger-doctor --json",
        semantic: { stage: "benchmark" },
      }),
    ],
    [
      decisionDiagnostic("packet-diagnostic", {
        command: "node scripts/autoresearch.mjs ledger-doctor --json",
        semantic: { stage: "benchmark" },
      }),
      decisionDiagnostic("packet-diagnostic", {
        command: "node scripts/autoresearch.mjs partial-results --from-last",
        semantic: { stage: "benchmark" },
      }),
    ],
  ]) {
    assert.throws(
      () => compileDecisionPlan(snapshot, diagnostics),
      /conflicting action semantics/i,
    );
  }
});

test(
  "decision command identity handles hostile unmatched quoting in linear time",
  { timeout: 1_000 },
  () => {
    const snapshot = snapshotFixture();
    const hostile = `node scripts/autoresearch.mjs partial-results --from-last --description "${"\\!".repeat(50_000)}`;
    const plan = compileDecisionPlan(snapshot, [
      decisionDiagnostic("packet-diagnostic", {
        command: hostile,
        semantic: { stage: "hostile-command" },
      }),
    ]);

    assert.equal(plan.action.kind, "inspect-packet");
    assert.notEqual(plan.action.commandSemanticId, "");
  },
);

test("decision identity retains normalized value-bearing action parameters", () => {
  const snapshot = snapshotFixture();
  const keep = decisionDiagnostic("packet-diagnostic", {
    command: "node scripts/autoresearch.mjs log --cwd /tmp/project --status keep --from-last",
    semantic: { stage: "packet-log" },
  });
  const discard = decisionDiagnostic("packet-diagnostic", {
    command:
      'node scripts/autoresearch.mjs log --working-dir "C:\\tmp\\project" --status discard --from-last',
    semantic: { stage: "packet-log" },
  });
  const keepPlan = compileDecisionPlan(snapshot, [keep]);
  const discardPlan = compileDecisionPlan(snapshot, [discard]);

  assert.notEqual(keepPlan.action.commandSemanticId, discardPlan.action.commandSemanticId);
  assert.notEqual(keepPlan.decisionId, discardPlan.decisionId);
  assert.throws(
    () => compileDecisionPlan(snapshot, [keep, discard]),
    /conflicting action semantics/i,
  );
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
        changedBelief: "The controlled variable, rather than packet order, explains the change.",
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
      failure: {
        layer: "external-infrastructure",
        code: "network",
        preconditions: {
          externalDependencyIdentity: "benchmark-api",
          externalObservation: "connection reset by peer",
        },
      },
    }),
    candidateRecord({ run: 6, preconditionEpoch: "other-epoch" }),
  ];
  const plan = compileDecisionPlan(snapshotFixture({ records }), []);

  assert.equal(plan.learning.consecutiveNoLearningCandidates, 1);
  assert.equal(plan.capabilities["run-packet"], "allowed");
});

test("accepted crash and checks failures without proven external metadata stay conservative", () => {
  const records = [
    candidateRecord({ run: 1, status: "crash" }),
    candidateRecord({
      run: 2,
      status: "checks_failed",
      metric: 1,
      failure: { layer: "external-infrastructure", code: "network" },
    }),
  ];
  const plan = compileDecisionPlan(snapshotFixture({ records }), []);

  assert.equal(plan.learning.consecutiveNoLearningCandidates, 2);
  assert.equal(plan.outcome.kind, "invalid");
  assert.equal(plan.failures.consecutive, 0);
  assert.equal(plan.primaryBlockerCode, "no-learning-pause");
  assert.equal(plan.capabilities["run-packet"], "blocked");
});

test("causal or discriminating learning requires evidence and an explicitly changed belief", () => {
  const cases = [
    [{ kind: "none" }, "none"],
    [{ kind: "causal", changedBelief: "the cache key controls the miss", evidence: [] }, "none"],
    [{ kind: "causal", evidence: ["trace"], changedBelief: true }, "none"],
    [{ kind: "causal", evidence: ["trace"], changedBelief: "   " }, "none"],
    [
      {
        kind: "causal",
        evidence: ["trace"],
        changedBelief: "The cache key, rather than request order, controls the miss.",
      },
      "causal",
    ],
    [
      {
        kind: "discriminating",
        evidence: ["holdout"],
        changedBelief: "The holdout separates parser cost from network cost.",
      },
      "discriminating",
    ],
  ] as const;
  for (const [learning, expected] of cases) {
    const plan = compileDecisionPlan(
      snapshotFixture({ records: [candidateRecord({ run: 1, learning })] }),
      [],
    );
    assert.equal(plan.learning.latest.kind, expected);
    assert.deepEqual(plan.learning.latest.evidence, expected === "none" ? [] : learning.evidence);
  }

  const first = compileDecisionPlan(
    snapshotFixture({
      records: [
        candidateRecord({
          run: 1,
          learning: {
            kind: "causal",
            evidence: ["trace"],
            changedBelief: "The cache key controls the miss.",
          },
        }),
      ],
    }),
    [],
  );
  const second = compileDecisionPlan(
    snapshotFixture({
      records: [
        candidateRecord({
          run: 1,
          learning: {
            kind: "causal",
            evidence: ["trace"],
            changedBelief: "Request order controls the miss.",
          },
        }),
      ],
    }),
    [],
  );
  assert.equal(
    (first.learning.latest as { changedBelief?: unknown }).changedBelief,
    "The cache key controls the miss.",
  );
  assert.deepEqual(first.learning.latest.evidence, ["trace"]);
  assert.notEqual(second.decisionId, first.decisionId);

  const differentEvidence = compileDecisionPlan(
    snapshotFixture({
      records: [
        candidateRecord({
          run: 1,
          learning: {
            kind: "causal",
            evidence: ["holdout"],
            changedBelief: "The cache key controls the miss.",
          },
        }),
      ],
    }),
    [],
  );
  assert.notEqual(differentEvidence.decisionId, first.decisionId);
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
  assert.equal(threshold.outcome.kind, "improved");

  const neutral = compileDecisionPlan(
    snapshotFixture({
      records: [
        minimizeContract,
        candidateRecord({ run: 1, metric: 10, status: "measure" }),
        candidateRecord({ run: 2, metric: 10, status: "discard" }),
      ],
    }),
    [],
  );
  assert.equal(neutral.outcome.kind as string, "neutral");

  const unavailable = compileDecisionPlan(snapshotFixture({ records: [] }), []);
  assert.equal(unavailable.outcome.kind as string, "invalid");
});

test("the first candidate compares with its accepted baseline without counting baseline learning", () => {
  const baseline = candidateRecord({
    run: 1,
    runPurpose: "baseline",
    metric: 10,
    status: "measure",
    learning: {
      kind: "causal",
      changedBelief: "The baseline establishes the accepted reference domain.",
      evidence: ["baseline established"],
    },
  });
  const candidate = candidateRecord({ run: 2, metric: 8, status: "keep" });
  const plan = compileDecisionPlan(
    snapshotFixture({ records: [acceptedContractRecord(), baseline, candidate] }),
    [],
  );

  assert.equal(plan.outcome.kind, "improved");
  assert.equal(plan.learning.latest.kind, "none");
  assert.equal(plan.learning.consecutiveNoLearningCandidates, 1);
});

test("validated post-finalization evidence is the only completion authority", () => {
  const preApply = compileDecisionPlan(snapshotFixture(), [
    decisionDiagnostic("finalization-ready"),
  ]);
  assert.equal(preApply.parentDisposition.mayClaimCompletion, false);

  const evidence = [
    `review-summary-sha256:${"a".repeat(64)}`,
    "verified-final-tree:head",
    `review-branch:review/value@${"b".repeat(40)}`,
  ];
  const productClaimCoverage = buildFinalizationProductClaimCoverageFromLedger([]);
  const acceptedEvidenceBase = "base";
  const acceptedEvidenceCommitDomain: string[] = [];
  const acceptedEvidenceFingerprint = buildFinalizationEvidenceState(
    acceptedEvidenceCommitDomain,
    [],
  ).fingerprint;
  const completionIdentity = {
    sourceHead: "head",
    sourceIndexTree: "index",
    sourceStatusHash: "status",
    contractDigest: "contract-a",
    preconditionEpoch: "epoch-a",
    acceptedEvidenceBase,
    acceptedEvidenceCommitDomain,
    acceptedEvidenceFingerprint,
    productClaimCoverageHash: createHash("sha256")
      .update(JSON.stringify(productClaimCoverageFingerprintMaterial(productClaimCoverage)))
      .digest("hex"),
    productGradeReady: true,
    reviewSummary: "verified-summary.md",
    evidence,
  };
  const completed = compileDecisionPlan(
    snapshotFixture({
      completionAudit: {
        branchHeads: { "review/value": "b".repeat(40) },
        summaryHash: "a".repeat(64),
        acceptedEvidenceBase,
        acceptedEvidenceCommitDomain,
        acceptedEvidenceFingerprint,
      } as CoherentSessionSnapshot["completionAudit"],
      records: [
        {
          type: "finalization-completed",
          schemaVersion: 1,
          ...completionIdentity,
          eventId: `finalization-completed:${createHash("sha256")
            .update(JSON.stringify(completionIdentity))
            .digest("hex")}`,
        },
      ],
    }),
    [decisionDiagnostic("completion-ready")],
  );
  assert.equal(completed.phase, "complete");
  assert.equal(completed.loopDisposition.kind, "complete");
  assert.equal(completed.parentDisposition.mayClaimCompletion, true);

  for (const invalidIdentity of [
    { ...completionIdentity, acceptedEvidenceFingerprint: undefined },
    {
      ...completionIdentity,
      acceptedEvidenceFingerprint: {
        ...acceptedEvidenceFingerprint,
        fingerprint: "f".repeat(64),
      },
    },
  ]) {
    const eventId = `finalization-completed:${createHash("sha256")
      .update(JSON.stringify(invalidIdentity))
      .digest("hex")}`;
    const invalid = compileDecisionPlan(
      snapshotFixture({
        completionAudit: {
          branchHeads: { "review/value": "b".repeat(40) },
          summaryHash: "a".repeat(64),
          acceptedEvidenceBase,
          acceptedEvidenceCommitDomain,
          acceptedEvidenceFingerprint,
        } as CoherentSessionSnapshot["completionAudit"],
        records: [
          {
            type: "finalization-completed",
            schemaVersion: 1,
            ...invalidIdentity,
            eventId,
          },
        ],
      }),
      [],
    );
    assert.equal(invalid.parentDisposition.mayClaimCompletion, false);
    assert.equal(invalid.requiredEvidence.diagnosticCodes.includes("completion-ready"), false);
  }
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
  const [typedReady] = finalizationDecisionDiagnostics({
    finalization: { ready: false },
    finalizationDecisionFact: { code: "finalization-ready" },
  });

  assert.deepEqual(blocked, decisionDiagnostic("finalization-blocked"));
  assert.deepEqual(ready, decisionDiagnostic("finalization-blocked"));
  assert.deepEqual(typedReady, decisionDiagnostic("finalization-ready"));
});

test("current-tree finalization is typed recovery authority, not general finalize permission", () => {
  const [projectionOnly] = finalizationDecisionDiagnostics(
    {
      finalization: {
        ready: false,
        actionCode: "current-tree-finalization",
        groups: [{ commit: "accepted-current" }],
      },
    },
    "/repo",
  );
  const [diagnostic] = finalizationDecisionDiagnostics(
    {
      finalization: {
        ready: false,
        actionCode: "current-tree-finalization",
        groups: [{ commit: "accepted-current" }],
        nextAction: "untrusted projected current-tree prose",
        suggestedCommand: "untrusted projected command",
      },
      finalizationDecisionFact: {
        code: "current-tree-finalization",
        acceptedEvidenceCount: 1,
      },
    },
    "/repo",
  );
  assert.deepEqual(projectionOnly, decisionDiagnostic("finalization-blocked"));
  assert.equal(diagnostic.code, "current-tree-finalization");
  assert.match(String(diagnostic.command), /finalize-current-tree/);
  assert.doesNotMatch(String(diagnostic.message), /untrusted projected/i);

  const plan = compileDecisionPlan(snapshotFixture(), [diagnostic]);
  assert.equal(plan.primaryBlockerCode, "current-tree-finalization");
  assert.equal(plan.capabilities.finalize, "recovery-only");
  assert.equal(plan.capabilities["run-packet"], "allowed");
  assert.equal(plan.capabilities["parent-final-answer"], "allowed");
  assert.ok(
    plan.requiredEvidence.capabilityEffectCodes.includes(
      "current-tree-finalization:finalize:recovery-only",
    ),
  );

  const [missingAcceptedEvidence] = finalizationDecisionDiagnostics(
    {
      finalization: {
        ready: false,
        actionCode: "current-tree-finalization",
      },
    },
    "/repo",
  );
  assert.deepEqual(missingAcceptedEvidence, decisionDiagnostic("finalization-blocked"));
});

function snapshotFixture(
  overrides: {
    completionAudit?: CoherentSessionSnapshot["completionAudit"];
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
    completionAudit: overrides.completionAudit || null,
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

function qualifiedMeasure(run: number, fingerprint: string, purpose = "candidate") {
  return candidateRecord({
    run,
    status: "measure",
    runPurpose: purpose,
    metric: 10,
    contractEvaluationEvidence: {
      contractDigest: "contract-a",
      candidateFingerprint: fingerprint,
      acceptedEvaluation: true,
      checksPassed: true,
      metric: 10,
    },
  });
}
test("noise qualification repeats do not masquerade as independent no-learning candidates", () => {
  const contract = acceptedContractRecord({ noise: { kind: "unknown", qualificationRepeats: 2 } });
  const reference = [
    qualifiedMeasure(1, "reference", "baseline"),
    qualifiedMeasure(2, "reference"),
  ];
  const first = qualifiedMeasure(3, "candidate");
  for (const candidates of [
    [first],
    [first, qualifiedMeasure(4, "candidate")],
    [first, { ...qualifiedMeasure(4, "candidate"), status: "keep" }],
    [first, { ...qualifiedMeasure(4, "candidate"), status: "discard", evidenceStatus: "rejected" }],
  ]) {
    const plan = compileDecisionPlan(
      snapshotFixture({ records: [contract, ...reference, ...candidates] }),
      [],
    );
    assert.equal(plan.capabilities["run-packet"], "allowed");
    assert.ok(plan.learning.consecutiveNoLearningCandidates <= 1);
  }
  const distinct = compileDecisionPlan(
    snapshotFixture({
      records: [
        contract,
        ...reference,
        first,
        qualifiedMeasure(4, "other"),
        qualifiedMeasure(5, "other"),
      ],
    }),
    [],
  );
  assert.equal(distinct.primaryBlockerCode, "no-learning-pause");
});
test("surplus repeats and malformed qualification evidence retain no-learning limits", () => {
  const contract = acceptedContractRecord({ noise: { kind: "bounded", repeats: 2, tolerance: 1 } });
  const cases = [
    [
      qualifiedMeasure(1, "candidate"),
      { ...qualifiedMeasure(2, "candidate"), status: "keep", evidenceStatus: "rejected" },
    ],
    [
      qualifiedMeasure(1, "candidate"),
      {
        ...qualifiedMeasure(2, "candidate"),
        status: "discard",
        evidenceStatus: "rejected",
        quarantined: true,
      },
    ],
    [
      qualifiedMeasure(1, "candidate"),
      qualifiedMeasure(2, "candidate"),
      qualifiedMeasure(3, "candidate"),
    ],
    [
      qualifiedMeasure(1, "candidate"),
      { ...qualifiedMeasure(2, "candidate"), contractEvaluationEvidence: {} },
    ],
    [
      { ...qualifiedMeasure(1, "candidate"), status: "checks_failed" },
      { ...qualifiedMeasure(2, "candidate"), status: "checks_failed" },
    ],
  ];
  for (const records of cases)
    assert.equal(
      compileDecisionPlan(snapshotFixture({ records: [contract, ...records] }), [])
        .primaryBlockerCode,
      "no-learning-pause",
    );
});
