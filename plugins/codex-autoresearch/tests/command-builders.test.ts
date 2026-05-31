import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRecommendNextResponse,
  selectRecommendNextRuntimeAuthority,
} from "../lib/commands/recommend-next.js";
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
    laneLifecycle: { staleLanes: ["scout"] },
    packetDiagnostics: { unresolved: true },
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
  assert.deepEqual(response.laneLifecycle, { staleLanes: ["scout"] });
  assert.deepEqual(response.packetDiagnostics, { unresolved: true });
});

test("recommend-next authority prefers dashboard runtime drift over compact source-only state", () => {
  const authority = selectRecommendNextRuntimeAuthority({
    viewModel: {
      decisionEnvelope: {
        canonicalNextAction: {
          kind: "runtime-provenance",
          reason: "Inspect installed runtime drift before continuing.",
        },
        loopContract: {
          ok: false,
          blockers: [{ kind: "runtime-provenance" }],
        },
        runtimeProvenance: {
          status: "drift-detected",
          drifted: true,
        },
      },
      processHygiene: {
        runtimeDrift: {
          status: "checked",
          drifted: false,
        },
      },
    },
    compact: {
      canonicalNextAction: {
        kind: "next-packet",
        reason: "Run the next packet.",
      },
      runtimeProvenance: {
        status: "unavailable",
        driftConfidence: "source-only",
        drifted: false,
      },
      loopContract: {
        ok: true,
      },
    },
  });

  assert.equal((authority.canonicalNextAction as any).kind, "runtime-provenance");
  assert.deepEqual(authority.runtimeProvenance, {
    status: "drift-detected",
    drifted: true,
  });
  assert.deepEqual(authority.loopContract, {
    ok: false,
    blockers: [{ kind: "runtime-provenance" }],
  });
});

test("recommend-next authority keeps unavailable runtime probes non-blocking", () => {
  const authority = selectRecommendNextRuntimeAuthority({
    viewModel: {
      decisionEnvelope: {
        canonicalNextAction: {
          kind: "next-packet",
          reason: "Run the next packet.",
        },
        loopContract: {
          ok: true,
          blockers: [],
        },
        runtimeProvenance: {
          status: "unavailable",
          driftConfidence: "unavailable",
          drifted: false,
        },
      },
    },
    compact: {
      canonicalNextAction: {
        kind: "runtime-provenance",
        reason: "Inspect runtime drift.",
      },
    },
  });

  assert.equal((authority.canonicalNextAction as any).kind, "next-packet");
  assert.deepEqual(authority.loopContract, {
    ok: true,
    blockers: [],
  });
  assert.deepEqual(authority.runtimeProvenance, {
    status: "unavailable",
    driftConfidence: "unavailable",
    drifted: false,
  });
});

test("recommend-next authority preserves compact state when checked runtime is clean", () => {
  const authority = selectRecommendNextRuntimeAuthority({
    viewModel: {
      decisionEnvelope: {
        canonicalNextAction: {
          kind: "benchmark-command",
          reason: "Configure a benchmark command.",
        },
        loopContract: {
          ok: true,
          blockers: [],
        },
        runtimeProvenance: {
          status: "checked",
          drifted: false,
        },
      },
    },
    compact: {
      decisionEnvelope: {
        canonicalNextAction: {
          kind: "watchdog",
          reason: "Intervene after stale progress.",
        },
        loopContract: {
          ok: true,
          blockers: [],
        },
      },
    },
  });

  assert.equal((authority.canonicalNextAction as any).kind, "watchdog");
  assert.deepEqual(authority.runtimeProvenance, {
    status: "checked",
    drifted: false,
  });
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
