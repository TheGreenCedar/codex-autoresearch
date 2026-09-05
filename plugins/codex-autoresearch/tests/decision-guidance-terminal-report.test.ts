import assert from "node:assert/strict";
import test from "node:test";

import type { CoherentSessionSnapshot } from "../lib/coherent-session-snapshot.js";
import {
  compileDecisionPlan,
  decisionDiagnostic,
  type DecisionDiagnostic,
  type DecisionPlan,
} from "../lib/decision-compiler.js";
import {
  projectCompactDecisionPlan,
  type CompactDecisionPlanProjection,
} from "../lib/decision-projection.js";
import {
  projectionBudget,
  TERMINAL_REPORT_MAX_BYTES,
  TERMINAL_REPORT_MAX_LINES,
  TERMINAL_REPORT_MAX_TOKENS,
} from "../lib/session-read-model.js";
import { buildTerminalReport } from "../lib/terminal-report.js";

test("terminal report projects the canonical plan ahead of advisory state", () => {
  const plan = planFixture([
    decisionDiagnostic("quality-evidence-required", {
      message: "Collect accepted quality evidence before claiming completion.",
      command: "node scripts/autoresearch.mjs next --cwd C:/work/project --compact",
    }),
  ]);
  const report = buildTerminalReport({
    ok: true,
    workDir: "C:/work/project",
    decisionPlan: plan,
    blockers: [{ message: "Advisory dirty state must not own the headline." }],
    preflight: {
      status: "ready",
      blockers: [],
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

  assert.equal(plan.capabilities["run-packet"], "allowed");
  assert.equal(plan.capabilities["parent-final-answer"], "blocked");
  assert.equal(report.json.status, "blocked");
  assert.equal(report.json.blocker, "quality-evidence-required");
  assert.equal(report.json.nextAction, plan.action.reason);
  assert.equal(report.json.nextCommand, plan.action.command);
  assert.match(report.text, /Gate: missing/);
  assert.match(report.text, /Runtime: installed fresh, build available/);
  assert.match(report.text, /Dashboard: not checked/);
  assert.equal(report.json.dashboard.command, "");
  assert.doesNotMatch(report.text, /Status: blocked - Advisory dirty/);
  assert.doesNotMatch(report.text, /\[object Object\]/);
});

test("terminal report consumes the compact DecisionPlan projection without rederiving policy", () => {
  const plan = planFixture([
    decisionDiagnostic("needs-baseline", {
      message: "Run the accepted baseline.",
      command: "node scripts/autoresearch.mjs next --cwd C:/work/project --baseline --compact",
    }),
  ]);
  const projection = projectCompactDecisionPlan(plan);
  const report = buildTerminalReport({
    workDir: "C:/work/project",
    decisionPlanProjection: projection,
    nextAction: plan.action.reason,
    canonicalNextAction: {
      kind: "legacy-action",
      reason: "Legacy prose must not replace the plan.",
      command: "node legacy.mjs",
    },
    commands: {
      next: "node scripts/autoresearch.mjs next --cwd C:/work/project --compact",
    },
  });

  assert.equal(projection.capabilities["run-packet"], "allowed");
  assert.equal(projection.parentDisposition.kind, "hand-back");
  assert.equal(report.json.status, "ready");
  assert.equal(report.json.nextAction, "Run the accepted baseline.");
  assert.equal(report.json.nextCommand, plan.action.command);
  assert.equal(
    (report.json.decisionPlanProjection as CompactDecisionPlanProjection).decisionId,
    plan.decisionId,
  );
  assert.doesNotMatch(report.text, /Legacy prose/);
});

test("terminal report refuses legacy authority and command inference when no plan exists", () => {
  const report = buildTerminalReport({
    ok: false,
    workDir: "C:/work/project",
    blockers: ["Legacy blocker"],
    commands: {
      next: "node scripts/autoresearch.mjs next --cwd C:/work/project --compact",
      state: "node scripts/autoresearch.mjs state --cwd C:/work/project --compact",
    },
    decisionEnvelope: {
      canonicalNextAction: {
        kind: "next-packet",
        reason: "Run the legacy packet.",
        command: "node scripts/autoresearch.mjs next --cwd C:/work/project --compact",
      },
      loopContract: {
        blockers: [{ reason: "Legacy loop blocker" }],
      },
    },
    resolvedDecision: {
      status: "blocked",
      nextAction: "Legacy resolved action.",
      command: "node resolved.mjs",
    },
  });

  assert.equal(report.json.status, "unknown");
  assert.equal(report.json.blocker, "");
  assert.equal(report.json.nextAction, "Canonical decision unavailable; refresh state.");
  assert.equal(report.json.nextCommand, "");
  assert.doesNotMatch(report.text, /Run the legacy packet|Legacy loop blocker|resolved\.mjs/);
});

test("packet diagnostics stay factual and never become terminal decision authority", () => {
  const report = buildTerminalReport({
    ok: true,
    workDir: "C:/work/project",
    packetDiagnostics: {
      unresolved: true,
      primaryStage: "missing_quality_score",
      recommendation:
        "Inspect packet diagnostic stage missing_quality_score before another packet.",
      command: "node scripts/autoresearch.mjs partial-results --cwd C:/work/project --from-last",
    },
  });

  assert.equal(report.json.status, "unknown");
  assert.equal(report.json.nextCommand, "");
  assert.equal(report.json.packet.status, "missing_quality_score");
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
      decisionPlan: planFixture(),
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

test("finalization-only blockers leave packet and parent dispositions ready", () => {
  const plan = planFixture([
    decisionDiagnostic("finalization-blocked", {
      message: "Finalization needs a clean branch.",
      command: "node scripts/autoresearch.mjs next --cwd C:/work/project --compact",
    }),
  ]);
  const report = buildTerminalReport({
    workDir: "C:/work/project",
    decisionPlan: plan,
  });

  assert.equal(plan.capabilities.finalize, "blocked");
  assert.equal(plan.capabilities["run-packet"], "allowed");
  assert.equal(plan.capabilities["parent-final-answer"], "allowed");
  assert.equal(plan.loopDisposition.kind, "continue");
  assert.equal(plan.parentDisposition.kind, "hand-back");
  assert.equal(report.json.status, "ready");
  assert.equal(report.json.blocker, "");
  assert.equal(report.json.nextCommand, plan.action.command);
});

test("packet pauses are reported as blocked on full and compact surfaces", () => {
  const plan = planFixture([decisionDiagnostic("no-learning-pause")]);
  assert.equal(plan.loopDisposition.kind, "pause");
  for (const state of [
    { decisionPlan: plan },
    { decisionPlanProjection: projectCompactDecisionPlan(plan) },
  ]) {
    const report = buildTerminalReport(state);
    assert.equal(report.json.status, "blocked");
    assert.equal(report.json.blocker, "no-learning-pause");
  }
});

test("parent final-claim blockers own blocked terminal status", () => {
  const plan = planFixture([
    decisionDiagnostic("finalization-claim-blocked", {
      message: "Completion evidence is not ready.",
      command: "node scripts/autoresearch.mjs finalize-preview --cwd C:/work/project",
    }),
  ]);
  const report = buildTerminalReport({
    workDir: "C:/work/project",
    decisionPlan: plan,
  });

  assert.equal(plan.capabilities.finalize, "blocked");
  assert.equal(plan.capabilities["parent-final-answer"], "blocked");
  assert.equal(plan.capabilities["run-packet"], "allowed");
  assert.equal(plan.parentDisposition.kind, "block-final-answer");
  assert.equal(report.json.status, "blocked");
  assert.equal(report.json.blocker, "finalization-claim-blocked");
  assert.equal(report.json.nextCommand, plan.action.command);
});

test("stale packet recovery stays recovery-only and uses the compiled replacement command", () => {
  const plan = planFixture([
    decisionDiagnostic("stale-packet", {
      message: "Replace the stale packet before continuing.",
      command: "node scripts/autoresearch.mjs next --cwd C:/work/project --replace-last --compact",
    }),
  ]);
  const report = buildTerminalReport({
    workDir: "C:/work/project",
    decisionPlanProjection: projectCompactDecisionPlan(plan),
    nextAction: plan.action.reason,
    commands: {
      next: "node scripts/autoresearch.mjs next --cwd C:/work/project --compact",
    },
  });

  assert.equal(plan.capabilities["run-packet"], "recovery-only");
  assert.equal(plan.parentDisposition.kind, "hand-back");
  assert.equal(report.json.status, "blocked");
  assert.equal(report.json.blocker, "stale-packet");
  assert.equal(report.json.nextCommand, plan.action.command);
  assert.match(report.json.nextCommand, /--replace-last/);
});

test("a blocked plan with no command does not fall back to command metadata", () => {
  const plan = planFixture([
    decisionDiagnostic("context-distillation", {
      message: "Distill context before more packets.",
    }),
  ]);
  const report = buildTerminalReport({
    workDir: "C:/work/project",
    decisionPlan: plan,
    commands: {
      next: "node scripts/autoresearch.mjs next --cwd C:/work/project --compact",
      state: "node scripts/autoresearch.mjs state --cwd C:/work/project --compact",
      partialResults:
        "node scripts/autoresearch.mjs partial-results --cwd C:/work/project --from-last",
    },
  });

  assert.equal(report.json.status, "blocked");
  assert.equal(report.json.nextAction, "Distill context before more packets.");
  assert.equal(report.json.nextCommand, "");
  assert.match(report.text, /Next command: unavailable/);
  assert.doesNotMatch(report.text, /partial-results|state --cwd|next --cwd/);
});

test("terminal report projects ready and complete dispositions from typed projections", () => {
  const ready = projectCompactDecisionPlan(planFixture());
  const complete: CompactDecisionPlanProjection = {
    ...ready,
    phase: "complete",
    loopDisposition: {
      kind: "complete",
      canRunPacket: false,
      shouldContinue: false,
    },
    parentDisposition: {
      kind: "complete",
      mayAnswer: true,
      mayClaimCompletion: true,
    },
  };

  assert.equal(buildTerminalReport({ decisionPlanProjection: ready }).json.status, "ready");
  assert.equal(buildTerminalReport({ decisionPlanProjection: complete }).json.status, "complete");
});

test("terminal report distinguishes session-artifact dirtiness from source drift", () => {
  const report = buildTerminalReport({
    ok: true,
    workDir: "C:/work/project",
    decisionPlan: planFixture(),
    sourceCleanliness: {
      status: "session-artifacts-dirty",
      sourceDirty: false,
      sessionArtifactDirty: true,
      message:
        "Only Autoresearch session artifacts are dirty; source drift is clean, but branch-changing finalization still needs a clean worktree.",
      cleanupCommand:
        'git stash push --include-untracked -- "autoresearch.jsonl" "autoresearch.research/study/quality-gaps.md"',
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
    decisionPlan: planFixture(),
    config: { metricName: "seconds" },
    activeSegment: {
      best: null,
      developmentBest: "",
    },
  });

  assert.equal(report.json.metric.name, "seconds");
  assert.equal(report.json.metric.best, null);
  assert.equal(report.json.metric.developmentBest, null);
});

test("terminal report shows source-checkout runtime authority as advisory", () => {
  const report = buildTerminalReport({
    workDir: "C:/work/project",
    decisionPlan: planFixture(),
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
  });
  const authority = report.json.runtimeAuthority;

  assert.equal(report.json.status, "ready");
  assert.equal(report.json.blocker, "");
  assert.ok(authority);
  assert.equal(authority.trustScope, "source-checkout");
  assert.equal(authority.blocking, false);
  assert.match(authority.warning || "", /stale installed plugin runtime/i);
  assert.match(report.text, /Runtime authority: source-checkout advisory/);
  assert.match(report.text, /stale installed plugin runtime/i);
});

test("terminal report renders metric freshness lane ASI and dashboard facts", () => {
  const report = buildTerminalReport({
    ok: true,
    workDir: "C:/work/project",
    decisionPlan: planFixture(),
    metric: "quality",
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
    asi: {
      risk: "missing-rollback-reason",
    },
    commands: {
      serve: "node scripts/autoresearch.mjs serve --cwd C:/work/project",
    },
    dashboardHealth: {
      liveness: "dead",
      stale: true,
      healthUrl: "http://127.0.0.1:61234/health",
    },
  });

  assert.equal(report.json.metric.name, "quality");
  assert.equal(report.json.metric.best, 3.5);
  assert.equal(report.json.metric.developmentBest, 4.2);
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
  assert.match(report.text, /Dashboard: dead \(stale\); serve a fresh dashboard/);
  assert.equal(
    report.json.dashboard.command,
    "node scripts/autoresearch.mjs serve --cwd C:/work/project",
  );
  assert.doesNotMatch(report.json.dashboard.command, /curl/);
});

test("terminal report constructs the factual dashboard serve command when metadata is absent", () => {
  const report = buildTerminalReport({
    workDir: "C:/repo",
    decisionPlanProjection: projectCompactDecisionPlan(planFixture()),
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

test("terminal report names historical best when the active segment has no metric", () => {
  const report = buildTerminalReport({
    workDir: "C:/repo",
    decisionPlan: planFixture(),
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
  });

  assert.match(report.text, /active segment best unknown/i);
  assert.match(report.text, /historical best #20 = 14/i);
});

test("terminal report stays within the reviewed projection budget with canonical plan semantics", () => {
  const plan = planFixture([
    decisionDiagnostic("finalization-claim-blocked", {
      message: "Completion evidence is not ready.",
      command: "node scripts/autoresearch.mjs finalize-preview --cwd C:/work/project",
    }),
    decisionDiagnostic("packet-diagnostic", {
      message: "Inspect unresolved packet evidence.",
    }),
  ]);
  const report = buildTerminalReport({
    workDir: "C:/work/project",
    decisionPlan: plan,
    gateQuality: {
      posture: "correctness",
      warnings: ["Independent checks are configured and advisory detail is present."],
    },
    runtimeDriftSummary: {
      installedRuntime: "fresh",
      builtRuntime: "available",
      nextActionHint: "Runtime surfaces agree.",
    },
    runtimeAuthority: {
      trustScope: "source-checkout",
      blocking: false,
      warning: "Installed runtime proof remains outside this source-checkout claim.",
    },
    sourceCleanliness: {
      status: "clean",
      message: "Source and session artifacts are clean.",
    },
    packetDiagnostics: {
      unresolved: true,
      primaryStage: "missing_quality_score",
      recommendation: "Inspect unresolved packet evidence.",
    },
    dashboardHealth: {
      liveness: "alive",
      stale: false,
      healthUrl: "http://127.0.0.1:61234/health",
    },
    metric: "quality",
    activeSegment: { best: 3.5, developmentBest: 4.2 },
    historicalBest: { run: 7, metric: 5.1 },
    latestPacketFreshness: { fresh: true, reason: "Packet matches current source." },
    laneLifecycle: { plannedLanes: [{ id: "lane-a" }], staleLanes: [] },
    asi: { risk: "low" },
    portfolioRecommendation: {
      kind: "continue",
      confidence: "high",
      reason: "The accepted evidence still supports the current lane.",
    },
  });
  const budget = projectionBudget(report);

  assert.ok(budget.bytes <= TERMINAL_REPORT_MAX_BYTES, JSON.stringify(budget));
  assert.ok(budget.lines <= TERMINAL_REPORT_MAX_LINES, JSON.stringify(budget));
  assert.ok(budget.tokens <= TERMINAL_REPORT_MAX_TOKENS, JSON.stringify(budget));
  assert.equal(
    (report.json.decisionPlanProjection as CompactDecisionPlanProjection).decisionId,
    plan.decisionId,
  );
});

function planFixture(diagnostics: DecisionDiagnostic[] = []): DecisionPlan {
  return compileDecisionPlan(snapshotFixture(), diagnostics);
}

function snapshotFixture(): CoherentSessionSnapshot {
  return {
    kind: "coherent-session-snapshot",
    schemaVersion: 1,
    generationId: "generation-terminal-report",
    sessionCwd: "C:/work/project",
    workDir: "C:/work/project",
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
    sourceDiagnostics: { ledgerIssues: [] },
    semanticFacts: {
      contractDigest: "contract-terminal-report",
      evaluatorIdentity: "evaluator-terminal-report",
      acceptedCheckIdentities: ["check-terminal@digest"],
      preconditionEpoch: "epoch-terminal-report",
    },
  };
}
