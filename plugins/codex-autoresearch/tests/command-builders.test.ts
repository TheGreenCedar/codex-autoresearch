import assert from "node:assert/strict";
import test from "node:test";

import { buildRecommendNextResponse } from "../lib/commands/recommend-next.js";
import { buildCompactStateResponse } from "../lib/commands/state.js";

test("recommend-next response preserves stable fields and optional governance fields", () => {
  const response = buildRecommendNextResponse({
    workDir: "/tmp/project",
    action: { kind: "runtime-provenance" },
    nextAction: "Inspect runtime drift.",
    commands: { primary: "node scripts/autoresearch.mjs doctor --cwd ." },
    operatorChecklist: { command: "node scripts/autoresearch.mjs doctor --cwd ." },
    runtimeProvenance: { drifted: true },
    loopContract: { nextActionKind: "runtime-provenance" },
  });

  assert.equal(response.ok, true);
  assert.equal(response.workDir, "/tmp/project");
  assert.deepEqual(response.blockers, []);
  assert.equal(response.nextAction, "Inspect runtime drift.");
  assert.deepEqual(response.operatorChecklist, {
    command: "node scripts/autoresearch.mjs doctor --cwd .",
  });
  assert.deepEqual(response.runtimeProvenance, { drifted: true });
  assert.deepEqual(response.loopContract, { nextActionKind: "runtime-provenance" });
});

test("compact state response preserves stable compact fields and optional loop fields", () => {
  const response = buildCompactStateResponse({
    workDir: "/tmp/project",
    runs: 3,
    kept: 1,
    discarded: 1,
    measured: 1,
    nextAction: "Clean up stale lanes.",
    runtimeProvenance: { status: "fresh" },
    loopContract: { mayRunPacket: false },
    laneLifecycle: { staleLanes: ["scout"] },
    packetDiagnostics: { unresolved: true },
    watchdogSummary: { stale: true },
  });

  assert.equal(response.ok, true);
  assert.equal(response.runs, 3);
  assert.equal(response.kept, 1);
  assert.equal(response.nextAction, "Clean up stale lanes.");
  assert.deepEqual(response.runtimeProvenance, { status: "fresh" });
  assert.deepEqual(response.loopContract, { mayRunPacket: false });
  assert.deepEqual(response.laneLifecycle, { staleLanes: ["scout"] });
  assert.deepEqual(response.packetDiagnostics, { unresolved: true });
  assert.deepEqual(response.watchdogSummary, { stale: true });
});
