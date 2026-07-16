import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildLoopContractStatus } from "../../lib/loop-governance.js";
import {
  QUALITY_GAP_DECISIONS_FILE,
  qualityGapId,
  recordQualityGapDecision,
  summarizeQualityGaps,
} from "../../lib/research-gaps.js";
import { resolveSessionDecision } from "../../lib/session-read-model.js";
import { buildResearchIntegrity } from "../../lib/truth-signals.js";
import { analyzeWorkflowFriction } from "../../lib/workflow-friction.js";

const READINESS = [
  "Project essence is accurate and source-backed.",
  "Sources are logged with dates, claims, and confidence.",
  "Synthesis separates high-impact changes from small QoL fixes.",
  "Each high-impact recommendation is implemented or rejected with evidence.",
  "Correctness checks pass after kept changes.",
  "Final handoff includes dashboard or state evidence.",
];

test("research readiness and raw checked gaps cannot close a qualitative round", () => {
  const readinessOnly = summarizeQualityGaps(READINESS.map((item) => `- [x] ${item}`).join("\n"));
  assert.equal(readinessOnly.open, null);
  assert.equal(readinessOnly.total, 0);
  assert.equal(readinessOnly.researchReadiness.closed, 6);
  assert.equal(readinessOnly.roundDecision.status, "needs-candidates");
  assert.equal(readinessOnly.roundDecision.accepted, false);

  const rawChecked = summarizeQualityGaps("- [x] Repair finalization evidence\n");
  assert.equal(rawChecked.open, 1);
  assert.equal(rawChecked.closed, 0);
  assert.deepEqual(rawChecked.legacyProvisionalClosed, ["Repair finalization evidence"]);
  assert.equal(rawChecked.roundDecision.status, "needs-evidence");
});

test("an evidence-bearing decision closes only its stable gap id", () => {
  const text = "- [x] Repair finalization evidence\n";
  const gapId = qualityGapId("Repair finalization evidence");
  const decision = JSON.stringify({
    gapId,
    decision: "implemented",
    evidence: "commit:abc123",
    validation: "focused finalizer test passed",
  });
  const summary = summarizeQualityGaps(text, `${decision}\n`);

  assert.equal(summary.open, 0);
  assert.equal(summary.closed, 1);
  assert.equal(summary.roundDecision.accepted, true);
  assert.equal(summary.gaps[0].decision?.evidence, "commit:abc123");

  const invalid = summarizeQualityGaps(
    text,
    `${JSON.stringify({ gapId, decision: "implemented", evidence: "commit:abc123" })}\n`,
  );
  assert.equal(invalid.open, 1);
  assert.equal(invalid.decisionIssues.length, 1);
});

test("recordQualityGapDecision validates existence and durably appends the decision", async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "autoresearch-gap-decision-"));
  try {
    const researchDir = path.join(workDir, "autoresearch.research", "study");
    await mkdir(researchDir, { recursive: true });
    const gapId = qualityGapId("Preserve decision truth");
    await writeFile(
      path.join(researchDir, "quality-gaps.md"),
      `## Candidate Gaps\n\n- [x] Preserve decision truth <!-- codex-autoresearch:gap-id=${gapId} -->\n`,
      "utf8",
    );

    const result = await recordQualityGapDecision({
      cwd: workDir,
      researchSlug: "study",
      gapId,
      decision: "rejected",
      evidence: "docs/decision.md",
      validationHint: "Review the recorded tradeoff",
    });
    assert.equal(result.qualityGap.roundDecision.accepted, true);
    const recorded = (await readFile(path.join(researchDir, QUALITY_GAP_DECISIONS_FILE), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].gapId, gapId);
    assert.equal(recorded[0].decision, "rejected");

    await assert.rejects(
      recordQualityGapDecision({
        cwd: workDir,
        researchSlug: "study",
        gapId: qualityGapId("unknown gap"),
        decision: "implemented",
        evidence: "commit:def456",
        validation: "tests passed",
      }),
      (error: Error & { code?: string }) => error.code === "unknown_quality_gap",
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("nonzero quality_gap is not classified as a perfect quality score", () => {
  const nonzero = buildResearchIntegrity({
    state: { current: [] },
    parsedMetrics: { quality_gap: 6 },
    metricName: "quality_gap",
  });
  assert.deepEqual(nonzero.suspiciousPerfectMetrics, []);

  const zero = buildResearchIntegrity({
    state: { current: [] },
    parsedMetrics: { quality_gap: 0 },
    metricName: "quality_gap",
  });
  assert.deepEqual(zero.suspiciousPerfectMetrics, ["quality_gap=0"]);
});

test("saturation requires accepted run evidence and an accepted qualitative round", () => {
  const provisionalGap = summarizeQualityGaps("- [x] Preserve decision truth\n");
  const provisionalSignals = analyzeWorkflowFriction({
    state: {
      best: 0,
      config: { metricName: "quality_gap", bestDirection: "lower" },
      current: [{ run: 1, status: "keep", metric: 0 }],
      qualityGap: provisionalGap,
      promotion: { kept: 0 },
    },
  });
  assert.equal(
    provisionalSignals.some((signal) => signal.kind === "quality_round_evidence_required"),
    true,
  );
  assert.equal(
    provisionalSignals.some((signal) => signal.kind === "metric_saturated_not_promotable"),
    false,
  );

  const gapId = qualityGapId("Preserve decision truth");
  const acceptedGap = summarizeQualityGaps(
    "- [x] Preserve decision truth\n",
    `${JSON.stringify({
      gapId,
      decision: "implemented",
      evidence: "commit:abc123",
      validation: "tests passed",
    })}\n`,
  );
  const acceptedSignals = analyzeWorkflowFriction({
    state: {
      best: 0,
      config: { metricName: "quality_gap", bestDirection: "lower" },
      current: [{ run: 1, status: "keep", metric: 0 }],
      qualityGap: acceptedGap,
      promotion: { kept: 0 },
    },
  });
  assert.equal(
    acceptedSignals.some((signal) => signal.kind === "metric_saturated_not_promotable"),
    true,
  );
});

test("baseline and round evidence outrank finalization projections", () => {
  const noRuns = buildLoopContractStatus({
    activeSegment: { runs: 0 },
    finalizationReadiness: { ready: true, nextAction: "Finalize now." },
  });
  assert.equal(noRuns.strongestAction?.kind, "needs-baseline");
  assert.equal(noRuns.blockers.length, 0);
  assert.equal(noRuns.canRunNextPacket, true);
  assert.equal(
    noRuns.warnings.some((warning) => warning.kind === "finalization"),
    false,
  );

  const pendingPacket = buildLoopContractStatus({
    activeSegment: { runs: 0 },
    latestPacketFreshness: { fresh: true, reason: "Log the pending packet." },
    finalizationReadiness: { ready: true },
  });
  assert.equal(pendingPacket.strongestAction?.kind, "log-decision");

  const needsEvidence = buildLoopContractStatus({
    activeSegment: { runs: 1 },
    workflowFriction: [
      {
        kind: "quality_round_evidence_required",
        reason: "Raw checkbox is provisional.",
        suggestedAction: { reason: "Record the structured decision." },
      },
    ],
    finalizationReadiness: { ready: true },
  });
  assert.equal(needsEvidence.strongestAction?.kind, "needs-evidence");
  assert.equal(
    needsEvidence.warnings.some((warning) => warning.kind === "finalization"),
    false,
  );
});

test("resolved decisions cannot preserve stale complete or ready state without a run", () => {
  const decision = resolveSessionDecision({
    state: {
      current: [],
      resolvedDecision: { status: "complete" },
      finalizationPressure: { ready: true },
    },
  });
  assert.equal(decision.status, "ready");
  assert.equal(decision.strongestBlocker, null);
  assert.equal(decision.canonicalNextAction?.kind, "needs-baseline");
  assert.equal(decision.finalizationPressure?.ready, false);
  assert.equal(decision.finalizationPressure?.blockedBy, "needs-baseline");
});

test("projected run counts and pending packet actions outrank a synthetic zero-run default", () => {
  const currentTree = resolveSessionDecision({
    state: {
      current: [],
      resolvedDecision: {
        status: "blocked",
        canonicalNextAction: {
          kind: "current-tree-finalization",
          reason: "Review the current tree.",
        },
      },
    },
    decisionEnvelope: {
      activeSegment: { runs: 1 },
      canonicalNextAction: {
        kind: "current-tree-finalization",
        reason: "Review the current tree.",
      },
    },
  });
  assert.equal(currentTree.canonicalNextAction?.kind, "current-tree-finalization");

  const pendingLog = resolveSessionDecision({
    state: {
      current: [],
      resolvedDecision: {
        status: "ready",
        canonicalNextAction: {
          kind: "log-decision",
          reason: "Log the pending packet.",
        },
      },
    },
  });
  assert.equal(pendingLog.canonicalNextAction?.kind, "log-decision");
  assert.notEqual(pendingLog.finalizationPressure?.blockedBy, "needs-baseline");
});
