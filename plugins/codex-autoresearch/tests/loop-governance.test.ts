import assert from "node:assert/strict";
import test from "node:test";

import { buildLaneLifecycle } from "../lib/lane-lifecycle.js";
import { buildLoopContractStatus, canonicalNextActionForLoop } from "../lib/loop-governance.js";
import { buildOperatorChecklist } from "../lib/operator-checklist.js";

test("context distillation outranks next packet", () => {
  const action = canonicalNextActionForLoop({
    contextDistillation: {
      required: true,
      reason: "Compactions reached 89; refresh a context capsule before more packets.",
      command: "node scripts/autoresearch.mjs session-forensics --cwd . --dry-run",
    },
  });

  assert.equal(action.kind, "context-distillation");
  assert.match(action.reason, /Compactions reached 89/);
  assert.match(action.command, /session-forensics/);
});

test("stale lanes and runtime drift block before finalization pressure", () => {
  const action = canonicalNextActionForLoop({
    laneLifecycle: {
      staleLanes: [{ id: "scout-retrieval", status: "stale" }],
      recommendation: "Close or refresh stale lane scout-retrieval before another packet.",
    },
    runtimeProvenance: {
      drifted: true,
      reason: "Source version 2.0.0 differs from installed version 1.5.1.",
    },
    finalizationReadiness: { ready: true, nextAction: "Finalize reviewable kept work." },
  });

  assert.equal(action.kind, "lane-cleanup");
  assert.match(action.reason, /scout-retrieval/);
});

test("probe-failed runtime provenance remains non-blocking", () => {
  const status = buildLoopContractStatus({
    runtimeProvenance: {
      status: "probe-failed",
      drifted: false,
      reason: "Runtime drift probe failed before source/runtime comparison.",
    },
  });

  assert.equal(status.ok, true);
  assert.equal(status.canRunNextPacket, true);
  assert.equal(status.blockers.length, 0);
});

test("checked runtime provenance without drift remains non-blocking", () => {
  const status = buildLoopContractStatus({
    runtimeProvenance: {
      status: "checked",
      drifted: false,
      driftConfidence: "checked",
    },
  });

  assert.equal(status.ok, true);
  assert.equal(status.canRunNextPacket, true);
  assert.equal(status.blockers.length, 0);
});

test("loop contract summarizes blockers and warnings", () => {
  const status = buildLoopContractStatus({
    contextDistillation: { required: true, reason: "Session is too large." },
    laneLifecycle: { staleLanes: [{ id: "a" }] },
    finalizationReadiness: { ready: true },
  });

  assert.equal(status.ok, false);
  assert.equal(status.canRunNextPacket, false);
  assert.deepEqual(
    status.blockers.map((item) => item.kind),
    ["context-distillation", "lane-cleanup"],
  );
  assert.equal(status.warnings[0].kind, "finalization");
});

test("operator checklist returns exactly the compact handoff keys", () => {
  const checklist = buildOperatorChecklist(
    { kind: "packet-diagnostic", reason: "Inspect diagnostics.", command: "" },
    {
      workDir: "C:/repo",
      pluginRoot: "C:/repo/plugins/codex-autoresearch",
      loopContract: {
        blockers: [{ kind: "packet-diagnostic", reason: "Citation carry failed." }],
      },
    },
  );

  assert.deepEqual(Object.keys(checklist), [
    "command",
    "safetyReason",
    "blocker",
    "evidenceRole",
    "source",
  ]);
  assert.match(checklist.command, /partial-results/);
  assert.equal(checklist.blocker, "Citation carry failed.");
  assert.equal(checklist.evidenceRole, "diagnostic-measure");
});

test("lane lifecycle marks stale planned lanes and records latest results", () => {
  const createdAt = "2026-05-31T00:00:00.000Z";
  const lifecycle = buildLaneLifecycle({
    fanoutPlan: {
      createdAt,
      lanes: [
        { id: "scout", status: "planned" },
        { id: "benchmark", status: "planned" },
      ],
    },
    laneResults: [
      {
        type: "lane_result",
        timestamp: Date.parse("2026-05-31T00:30:00.000Z"),
        lane: { id: "benchmark" },
        result: { status: "completed" },
      },
    ],
    nowMs: Date.parse("2026-05-31T03:00:00.000Z"),
    staleAfterMs: 60 * 60 * 1000,
    workDir: "C:/repo",
  });

  assert.deepEqual(
    lifecycle.staleLanes.map((lane) => lane.id),
    ["scout"],
  );
  assert.deepEqual(
    lifecycle.resultLanes.map((lane) => lane.id),
    ["benchmark"],
  );
  assert.match(lifecycle.recommendation, /scout/);
  assert.match(lifecycle.command, /lane-runner/);
});

test("lane lifecycle summarizes result-only records from current state", () => {
  const lifecycle = buildLaneLifecycle({
    state: {
      current: [
        {
          type: "lane_result",
          timestamp: Date.parse("2026-05-31T01:00:00.000Z"),
          lane: { id: "only-result", title: "Only result" },
          result: { status: "completed" },
        },
      ],
    },
    nowMs: Date.parse("2026-05-31T01:30:00.000Z"),
  });

  assert.deepEqual(
    lifecycle.resultLanes.map((lane) => lane.id),
    ["only-result"],
  );
  assert.equal(lifecycle.staleLanes.length, 0);
});
