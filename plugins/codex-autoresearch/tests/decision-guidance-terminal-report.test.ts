import assert from "node:assert/strict";
import test from "node:test";

import { buildCompactStateResponse } from "../lib/commands/state.js";
import { buildTerminalReport } from "../lib/terminal-report.js";

test("terminal report prioritizes blockers before packet recommendations", () => {
  const report = buildTerminalReport({
    ok: true,
    workDir: "C:/work/project",
    blockers: [{ message: "Working tree has uncommitted source changes." }],
    commands: {
      liveDashboard: "node scripts/autoresearch.mjs serve --cwd C:/work/project",
      next: "node scripts/autoresearch.mjs next --cwd C:/work/project --compact",
      partialResults:
        "node scripts/autoresearch.mjs partial-results --cwd C:/work/project --from-last",
    },
    preflight: {
      status: "blocked",
      blockers: ["No independent checks gate is configured."],
      nextCommand: "node scripts/autoresearch.mjs doctor --cwd C:/work/project --explain",
    },
    gateQuality: {
      posture: "missing",
      blockers: [{ message: "No checks command is configured." }],
    },
    runtimeDriftSummary: {
      installedRuntime: "fresh",
      builtRuntime: "available",
      nextActionHint: "Runtime surfaces look fresh.",
    },
    packetDiagnostics: {
      unresolved: true,
      primaryStage: "retrieved_but_not_cited",
      recommendation: "Inspect packet diagnostic stage before another packet.",
      command: "node scripts/autoresearch.mjs partial-results --cwd C:/work/project --from-last",
    },
  });

  assert.equal(report.json.status, "blocked");
  assert.equal(report.json.blocker, "Working tree has uncommitted source changes.");
  assert.equal(
    report.json.nextCommand,
    "node scripts/autoresearch.mjs doctor --cwd C:/work/project --explain",
  );
  assert.match(report.text, /Next command:/);
  assert.match(report.text, /Gate: missing/);
  assert.match(report.text, /Runtime: installed fresh, build available/);
  assert.match(report.text, /Dashboard: not checked/);
  assert.equal(report.json.dashboard.command, "");
  assert.doesNotMatch(report.text, /\bserve\b/);
  assert.doesNotMatch(report.text, /\[object Object\]/);
});

test("terminal report falls back to packet diagnostics when canonical action is absent", () => {
  const report = buildTerminalReport({
    ok: true,
    workDir: "C:/work/project",
    commands: {
      next: "node scripts/autoresearch.mjs next --cwd C:/work/project --compact",
      partialResults:
        "node scripts/autoresearch.mjs partial-results --cwd C:/work/project --from-last",
    },
    preflight: {
      status: "ready",
      blockers: [],
      nextCommand: "node scripts/autoresearch.mjs benchmark-lint --cwd C:/work/project",
    },
    gateQuality: {
      posture: "correctness",
      warnings: [],
    },
    runtimeDriftSummary: {
      installedRuntime: "fresh",
      builtRuntime: "available",
    },
    packetDiagnostics: {
      unresolved: true,
      primaryStage: "missing_quality_score",
      recommendation:
        "Inspect packet diagnostic stage missing_quality_score before another packet.",
      command: "node scripts/autoresearch.mjs partial-results --cwd C:/work/project --from-last",
    },
  });

  assert.equal(report.json.status, "ready");
  assert.equal(report.json.blocker, "");
  assert.match(report.json.nextAction, /missing_quality_score/);
  assert.equal(
    report.json.nextCommand,
    "node scripts/autoresearch.mjs partial-results --cwd C:/work/project --from-last",
  );
  assert.equal(
    report.json.packet.command,
    "node scripts/autoresearch.mjs partial-results --cwd C:/work/project --from-last",
  );
  assert.match(report.text, /Packet: missing_quality_score/);
});

test("terminal report filters unsafe packet diagnostic command fields", () => {
  for (const command of [
    "git stash push --include-untracked -- autoresearch.jsonl",
    "node scripts/autoresearch.mjs doctor --cwd C:/work/project --check-benchmark --explain",
  ]) {
    const report = buildTerminalReport({
      ok: true,
      workDir: "C:/work/project",
      commands: {
        state: "node scripts/autoresearch.mjs state --cwd C:/work/project --compact",
      },
      packetDiagnostics: {
        unresolved: true,
        primaryStage: "unsafe-command",
        recommendation: "Inspect packet diagnostics without running cleanup.",
        command,
      },
    });

    assert.equal(report.json.packet.command, "", command);
    assert.doesNotMatch(JSON.stringify(report.json.packet), /git stash|--check-benchmark/);
  }
});

test("terminal report uses canonical gate-quality action ahead of packet fallback", () => {
  const report = buildTerminalReport({
    ok: true,
    workDir: "C:/work/project",
    commands: {
      next: "node scripts/autoresearch.mjs next --cwd C:/work/project --compact",
      partialResults:
        "node scripts/autoresearch.mjs partial-results --cwd C:/work/project --from-last",
    },
    preflight: {
      status: "ready",
      blockers: [],
    },
    gateQuality: {
      posture: "missing",
      warnings: [],
    },
    packetDiagnostics: {
      unresolved: true,
      primaryStage: "partial-results",
      recommendation: "Inspect partial results before another packet.",
      command: "node scripts/autoresearch.mjs partial-results --cwd C:/work/project --from-last",
    },
    canonicalNextAction: {
      kind: "gate-quality",
      reason: "Run doctor to configure an independent checks command.",
      command: "node scripts/autoresearch.mjs doctor --cwd C:/work/project --explain",
    },
  });

  assert.equal(report.json.nextAction, "Run doctor to configure an independent checks command.");
  assert.equal(
    report.json.nextCommand,
    "node scripts/autoresearch.mjs doctor --cwd C:/work/project --explain",
  );
  assert.doesNotMatch(report.json.nextCommand, /partial-results/);
});

test("terminal report plateau pivot uses a non-packet recovery command", () => {
  const report = buildTerminalReport({
    workDir: "C:/repo",
    commands: {
      next: "node scripts/autoresearch.mjs next --cwd C:/repo --compact",
      laneRunner:
        "node scripts/autoresearch.mjs lane-runner --cwd C:/repo --lane-id constraint-removal --dry-run",
      newSegmentDryRun: "node scripts/autoresearch.mjs new-segment --cwd C:/repo --dry-run",
      state: "node scripts/autoresearch.mjs state --cwd C:/repo --report",
    },
    decisionEnvelope: {
      canonicalNextAction: {
        kind: "plateau-pivot",
        reason:
          "Change a precondition, input corpus, benchmark contract, or implementation lane before retrying this family.",
        command: "node scripts/autoresearch.mjs next --cwd C:/repo --compact",
      },
      loopContract: {
        ok: true,
        canRunNextPacket: true,
        blockers: [],
        warnings: [],
      },
    },
  });

  assert.match(report.json.nextAction, /Change a precondition/);
  assert.doesNotMatch(report.json.nextCommand, /\bnext\b/);
  assert.match(report.json.nextCommand, /lane-runner|new-segment/);
});

test("terminal report prefers loop-contract blockers over advisory state blockers", () => {
  const report = buildTerminalReport({
    ok: false,
    workDir: "C:/work/project",
    blockers: ["Advisory dirty state should not own the headline."],
    commands: {
      doctorExplain: "node scripts/autoresearch.mjs doctor --cwd C:/work/project --explain",
      state: "node scripts/autoresearch.mjs state --cwd C:/work/project --compact",
    },
    gateQuality: {
      posture: "missing",
      warnings: ["No independent checks gate is configured."],
    },
    decisionEnvelope: {
      loopContract: {
        ok: false,
        canRunNextPacket: false,
        blockers: [
          {
            kind: "decision-capsule",
            reason: "Repair the active decision capsule before another packet.",
          },
        ],
        strongestAction: {
          kind: "decision-capsule",
          reason: "Repair the active decision capsule before another packet.",
        },
      },
      canonicalNextAction: {
        kind: "decision-capsule",
        reason: "Run benchmark-lint to clear the active decision capsule.",
        command: "node scripts/autoresearch.mjs benchmark-lint --cwd C:/work/project",
      },
    },
  });

  assert.equal(report.json.status, "blocked");
  assert.equal(report.json.blocker, "Repair the active decision capsule before another packet.");
  assert.equal(report.json.nextAction, "Run benchmark-lint to clear the active decision capsule.");
  assert.equal(
    report.json.nextCommand,
    "node scripts/autoresearch.mjs state --cwd C:/work/project --compact",
  );
  assert.doesNotMatch(report.json.nextCommand, /benchmark-lint/);
  assert.match(report.json.gate.detail, /No independent checks gate/);
  assert.doesNotMatch(report.text, /Status: blocked - Advisory dirty/);
});

test("blocked terminal report prefers canonical action commands", () => {
  const report = buildTerminalReport({
    ok: false,
    workDir: "C:/work/project",
    commands: {
      doctorExplain: "node scripts/autoresearch.mjs doctor --cwd C:/work/project --explain",
      state: "node scripts/autoresearch.mjs state --cwd C:/work/project --compact",
    },
    preflight: {
      status: "blocked",
      blockers: [],
      nextCommand: "node scripts/autoresearch.mjs doctor --cwd C:/work/project --explain",
    },
    loopContract: {
      blockers: [
        {
          kind: "context-distillation",
          reason: "Refresh a context capsule before more packets.",
        },
      ],
    },
    decisionEnvelope: {
      loopContract: {
        blockers: [
          {
            kind: "context-distillation",
            reason: "Refresh a context capsule before more packets.",
          },
        ],
      },
      canonicalNextAction: {
        kind: "context-distillation",
        reason: "Refresh a context capsule before more packets.",
        command: "node scripts/autoresearch.mjs session-forensics --cwd C:/work/project --dry-run",
      },
    },
  });

  assert.equal(report.json.status, "blocked");
  assert.equal(report.json.blocker, "Refresh a context capsule before more packets.");
  assert.equal(report.json.nextAction, "Refresh a context capsule before more packets.");
  assert.equal(
    report.json.nextCommand,
    "node scripts/autoresearch.mjs session-forensics --cwd C:/work/project --dry-run",
  );
});

test("terminal report uses blocker metadata fallback when canonical command is absent", () => {
  const report = buildTerminalReport({
    ok: false,
    workDir: "C:/work/project",
    commands: {
      state: "node scripts/autoresearch.mjs state --cwd C:/work/project --compact",
      next: "node scripts/autoresearch.mjs next --cwd C:/work/project --compact",
      finalizePreview: "node scripts/autoresearch.mjs finalize-preview --cwd C:/work/project",
    },
    decisionEnvelope: {
      loopContract: {
        ok: false,
        canRunNextPacket: false,
        blockers: [
          {
            kind: "current-tree-finalization",
            reason: "Preview current tree finalization before review work continues.",
          },
        ],
      },
      canonicalNextAction: {
        kind: "current-tree-finalization",
        reason: "Preview current tree finalization before review work continues.",
        command: "",
      },
    },
  });

  assert.equal(report.json.status, "blocked");
  assert.equal(
    report.json.nextCommand,
    "node scripts/autoresearch.mjs finalize-preview --cwd C:/work/project",
  );
  assert.doesNotMatch(report.json.nextCommand, /\bnext\b/);
});

test("terminal report blocked fallbacks skip process-starting commands", () => {
  const report = buildTerminalReport({
    ok: false,
    workDir: "C:/work/project",
    commands: {
      doctorExplain:
        "node scripts/autoresearch.mjs doctor --cwd C:/work/project --check-benchmark --explain",
      benchmarkLint: "node scripts/autoresearch.mjs benchmark-lint --cwd C:/work/project",
      state: "node scripts/autoresearch.mjs state --cwd C:/work/project --compact --report",
    },
    preflight: {
      status: "blocked",
      blockers: ["No benchmark command is available for future packets."],
      nextCommand:
        "node scripts/autoresearch.mjs doctor --cwd C:/work/project --check-benchmark --explain",
    },
    decisionEnvelope: {
      loopContract: {
        ok: false,
        canRunNextPacket: false,
        blockers: [
          {
            kind: "preflight",
            reason: "No benchmark command is available for future packets.",
          },
        ],
      },
      canonicalNextAction: {
        kind: "preflight",
        reason: "Resolve preflight blockers before another packet.",
        command:
          "node scripts/autoresearch.mjs doctor --cwd C:/work/project --check-benchmark --explain",
      },
    },
  });

  assert.equal(
    report.json.nextCommand,
    "node scripts/autoresearch.mjs state --cwd C:/work/project --compact --report",
  );
  assert.doesNotMatch(report.json.nextCommand, /--check-benchmark|benchmark-lint/);
});

test("terminal report distinguishes ready-with-warnings from blocked next", () => {
  const report = buildTerminalReport({
    ok: true,
    workDir: "C:/work/project",
    blockers: [],
    commands: {
      next: "node scripts/autoresearch.mjs next --cwd C:/work/project --compact",
      state: "node scripts/autoresearch.mjs state --cwd C:/work/project --compact",
    },
    gateQuality: {
      posture: "advisory-missing",
      warnings: [
        "No checks command is configured; checksPolicy is manual, so the independent gate is advisory.",
      ],
    },
    decisionEnvelope: {
      loopContract: {
        ok: true,
        canRunNextPacket: true,
        blockers: [],
        warnings: [],
      },
      canonicalNextAction: {
        kind: "next-packet",
        reason: "Run the next measured packet.",
        command: "",
      },
    },
  });

  assert.equal(report.json.status, "ready-with-warnings");
  assert.equal(report.json.blocker, "");
  assert.equal(
    report.json.nextCommand,
    "node scripts/autoresearch.mjs next --cwd C:/work/project --compact",
  );
  assert.match(report.text, /Status: ready-with-warnings/);
});

test("hard terminal blockers do not fall back to next", () => {
  const report = buildTerminalReport({
    ok: false,
    workDir: "C:/work/project",
    commands: {
      next: "node scripts/autoresearch.mjs next --cwd C:/work/project --compact",
      state: "node scripts/autoresearch.mjs state --cwd C:/work/project --compact",
      partialResults:
        "node scripts/autoresearch.mjs partial-results --cwd C:/work/project --from-last",
    },
    decisionEnvelope: {
      loopContract: {
        ok: false,
        canRunNextPacket: false,
        blockers: [
          {
            kind: "packet-diagnostic",
            reason: "Inspect unresolved packet diagnostics before another packet.",
          },
        ],
      },
      canonicalNextAction: {
        kind: "packet-diagnostic",
        reason: "Inspect unresolved packet diagnostics before another packet.",
        command: "",
      },
    },
  });

  assert.equal(report.json.status, "blocked");
  assert.equal(
    report.json.nextCommand,
    "node scripts/autoresearch.mjs partial-results --cwd C:/work/project --from-last",
  );
  assert.doesNotMatch(report.json.nextCommand, /\bnext\b/);
});

test("terminal report distinguishes session-artifact dirtiness from source drift", () => {
  const report = buildTerminalReport({
    ok: true,
    workDir: "C:/work/project",
    sourceCleanliness: {
      status: "session-artifacts-dirty",
      sourceDirty: false,
      sessionArtifactDirty: true,
      message:
        "Only Autoresearch session artifacts are dirty; source drift is clean, but branch-changing finalization still needs a clean worktree.",
      cleanupCommand:
        'git stash push --include-untracked -- "autoresearch.jsonl" "autoresearch.research/study/quality-gaps.md"',
    },
    commands: {
      next: "node scripts/autoresearch.mjs next --cwd C:/work/project --compact",
    },
    canonicalNextAction: {
      kind: "next-packet",
      reason: "Run the next measured packet.",
      command: "node scripts/autoresearch.mjs next --cwd C:/work/project --compact",
    },
  });

  assert.equal(report.json.cleanliness.status, "session-artifacts-dirty");
  assert.equal(report.json.cleanliness.cleanupCommand, "");
  assert.match(report.text, /Cleanliness: Only Autoresearch session artifacts are dirty/);
  assert.match(report.text, /explicit Git action outside report command fields/);
  assert.doesNotMatch(report.text, /git stash push --include-untracked/);
});

test("terminal report does not coerce missing metrics to zero", () => {
  const report = buildTerminalReport({
    ok: true,
    config: { metricName: "seconds" },
    commands: {
      next: "node scripts/autoresearch.mjs next --cwd C:/work/project --compact",
    },
    decisionEnvelope: {
      activeSegment: {
        best: null,
        developmentBest: "",
      },
      canonicalNextAction: {
        reason: "Run the next packet.",
        command: "node scripts/autoresearch.mjs next --cwd C:/work/project --compact",
      },
      latestPacketFreshness: {
        fresh: null,
        reason: "No packet is pending.",
      },
    },
  });

  assert.equal(report.json.metric.name, "seconds");
  assert.equal(report.json.metric.best, null);
  assert.equal(report.json.metric.developmentBest, null);
});

test("terminal report shows source-checkout runtime authority as advisory", () => {
  const compactState = buildCompactStateResponse({
    workDir: "C:/work/project",
    runtimeDriftSummary: {
      installedRuntime: "stale",
      builtRuntime: "available",
      nextActionHint: "Installed runtime is stale for source 2.0.2.",
    },
    runtimeAuthority: {
      sourceRuntime: { status: "fresh", version: "2.0.2" },
      installedRuntime: { status: "stale", version: "2.0.1" },
      trustScope: "source-checkout",
      blocking: false,
      blocker: "",
      warning:
        "Stale installed plugin runtime is advisory for source-checkout work; verify installed runtime before claiming live installed behavior.",
    },
    commands: {
      next: "node scripts/autoresearch.mjs next --cwd C:/work/project --compact",
    },
  });
  const report = buildTerminalReport(compactState);
  const compactAuthority = compactState.runtimeAuthority as { trustScope?: string } | null;

  assert.equal(compactAuthority?.trustScope, "source-checkout");
  assert.equal(report.json.status, "ready-with-warnings");
  assert.equal(report.json.blocker, "");
  assert.equal(report.json.runtimeAuthority.trustScope, "source-checkout");
  assert.equal(report.json.runtimeAuthority.blocking, false);
  assert.match(report.json.runtimeAuthority.warning, /stale installed plugin runtime/i);
  assert.match(report.text, /Runtime authority: source-checkout advisory/);
  assert.match(report.text, /stale installed plugin runtime/i);
});

test("terminal report renders compact metric freshness lane and ASI contract fields", () => {
  const report = buildTerminalReport({
    ok: true,
    metric: "quality",
    commands: {
      serve: "node scripts/autoresearch.mjs serve --cwd C:/work/project",
      next: "node scripts/autoresearch.mjs next --cwd C:/work/project --compact",
    },
    dashboardHealth: {
      liveness: "dead",
      stale: true,
      healthUrl: "http://127.0.0.1:61234/health",
    },
    decisionEnvelope: {
      activeSegment: {
        best: 3.5,
        developmentBest: 4.2,
      },
      latestPacketFreshness: {
        fresh: false,
        reason: "Last packet belongs to an older source fingerprint.",
      },
      laneLifecycle: {
        plannedLanes: [{ id: "scout-a" }, { id: "scout-b" }],
        staleLanes: [{ id: "stale-a" }],
      },
      canonicalNextAction: {
        reason: "Inspect the stale packet before another run.",
        command: "node scripts/autoresearch.mjs partial-results --cwd C:/work/project --from-last",
      },
    },
    asi: {
      risk: "missing-rollback-reason",
    },
  });

  assert.equal(report.json.metric.name, "quality");
  assert.equal(report.json.freshness.fresh, false);
  assert.equal(report.json.lanes.planned, 2);
  assert.equal(report.json.lanes.stale, 1);
  assert.equal(report.json.asi.risk, "missing-rollback-reason");
  assert.match(
    report.text,
    /Metric: quality, active segment best 3.5, development best 4.2, historical best unknown/,
  );
  assert.match(report.text, /Freshness: stale - Last packet belongs/);
  assert.match(report.text, /Lanes: planned 2, stale 1/);
  assert.match(report.text, /ASI: risk missing-rollback-reason/);
  assert.match(
    report.text,
    /Dashboard: dead \(stale\); serve a fresh dashboard before using dashboard evidence Command: node scripts\/autoresearch\.mjs serve --cwd C:\/work\/project/,
  );
  assert.equal(
    report.json.dashboard.command,
    "node scripts/autoresearch.mjs serve --cwd C:/work/project",
  );
  assert.doesNotMatch(report.json.dashboard.command, /curl/);
});

test("terminal report recommends serve for dead stale dashboard", () => {
  const report = buildTerminalReport({
    workDir: "C:/repo",
    commands: {
      liveDashboard: "node scripts/autoresearch.mjs serve --cwd C:/repo",
      state: "node scripts/autoresearch.mjs state --cwd C:/repo --report",
    },
    dashboardHealth: {
      liveness: "dead",
      stale: true,
      healthUrl: "http://127.0.0.1:51280/health",
    },
  });

  assert.equal(report.json.dashboard.status, "dead");
  assert.match(report.json.dashboard.command, /serve --cwd C:\/repo/);
  assert.doesNotMatch(report.json.dashboard.command, /curl/);
});

test("terminal report constructs serve fallback for dead stale dashboard without commands", () => {
  const report = buildTerminalReport({
    workDir: "C:/repo",
    dashboardHealth: {
      liveness: "dead",
      stale: true,
      healthUrl: "http://127.0.0.1:51280/health",
    },
  });

  assert.equal(report.json.dashboard.status, "dead");
  assert.match(report.json.dashboard.command, /serve --cwd C:\/repo/);
  assert.doesNotMatch(report.json.dashboard.command, /curl/);
});

test("terminal report names historical best when active segment has no metric", () => {
  const report = buildTerminalReport({
    workDir: "C:/repo",
    config: { metricName: "simplification_candidates" },
    best: null,
    development: { best: null },
    historicalBest: {
      run: 20,
      metric: 14,
      status: "keep",
      segment: 0,
      description: "Unify CLI test process helpers",
    },
    decisionEnvelope: {
      activeSegment: { segment: 1, runs: 0, baseline: null, best: null, developmentBest: null },
      historicalBest: { run: 20, metric: 14, status: "keep", segment: 0 },
    },
  });

  assert.match(report.text, /active segment best unknown/i);
  assert.match(report.text, /historical best #20 = 14/i);
});
