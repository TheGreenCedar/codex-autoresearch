import assert from "node:assert/strict";
import test from "node:test";

import {
  actionSafeActionForKind,
  fallbackCommandForKind,
  resolveActionCommand,
} from "../lib/action-metadata.js";
import type { CoherentSessionSnapshot } from "../lib/coherent-session-snapshot.js";
import { compileDecisionPlan, decisionDiagnostic } from "../lib/decision-compiler.js";
import { buildGoalFrame } from "../lib/goal-frame.js";
import { buildLaneLifecycle } from "../lib/lane-lifecycle.js";
import { buildBudgetStatus } from "../lib/benchmark/budget-contract.js";
import { buildOperatorChecklist } from "../lib/operator-checklist.js";
import { firstSafeCommand, resolveCommandByKeys } from "../lib/safe-command-resolver.js";
import { iterationLimitInfo } from "../lib/session-core.js";
import {
  buildSessionDecisionCapsule,
  matchDecisionRules,
} from "../lib/session-decision-capsule.js";

test("budget exhaustion pauses packets without blocking a segment transition or handback", () => {
  const budget = buildBudgetStatus({
    state: {
      current: [
        {
          run: 1,
          runPurpose: "candidate",
          evaluationAuthority: "accepted-contract",
          candidateOrigin: { kind: "working-tree" },
        },
      ],
    },
    runtimeConfig: {
      packetBudget: 1,
      budgetStartedAt: "2026-04-24T00:00:00.000Z",
      budgetNote: "one packet only",
    },
  });
  const plan = compileDecisionPlan(snapshotFixture(), [
    decisionDiagnostic("packet-budget-exhausted", {
      message: budget.stopReason,
    }),
  ]);

  assert.equal(budget.exhausted, true);
  assert.equal(budget.packetsRemaining, 0);
  assert.equal(plan.primaryBlockerCode, "packet-budget-exhausted");
  assert.equal(plan.action.kind, "pause-packets");
  assert.equal(plan.capabilities["run-packet"], "blocked");
  assert.equal(plan.capabilities["transition-segment"], "allowed");
  assert.equal(plan.capabilities["parent-final-answer"], "allowed");
  assert.equal(plan.parentDisposition.mayClaimCompletion, false);
});

test("packet budget counts baseline and candidate packets but excludes manual, diagnostic, and holdout rows", () => {
  const budget = buildBudgetStatus({
    state: {
      current: [
        {
          run: 1,
          runPurpose: "diagnostic",
          evaluationAuthority: "manual",
          candidateOrigin: { kind: "none" },
        },
        {
          run: 2,
          runPurpose: "baseline",
          evaluationAuthority: "accepted-contract",
          candidateOrigin: { kind: "working-tree" },
        },
        {
          run: 3,
          runPurpose: "candidate",
          evaluationAuthority: "accepted-contract",
          candidateOrigin: { kind: "commit", oid: "b".repeat(40) },
        },
        {
          run: 4,
          runPurpose: "diagnostic",
          evaluationAuthority: "accepted-contract",
          candidateOrigin: { kind: "working-tree" },
        },
        {
          run: 5,
          runPurpose: "holdout",
          evaluationAuthority: "external",
          candidateOrigin: { kind: "commit", oid: "c".repeat(40) },
        },
        {
          run: 6,
          runPurpose: "baseline",
          evaluationAuthority: "manual",
          candidateOrigin: { kind: "none" },
        },
      ],
    },
    runtimeConfig: { packetBudget: 3 },
  });

  assert.equal(budget.packetsUsed, 2);
  assert.equal(budget.packetsRemaining, 1);
  assert.equal(budget.exhausted, false);
});

test("packet budget conservatively counts malformed and legacy evidence axes", () => {
  const budget = buildBudgetStatus({
    state: {
      current: [
        {
          run: 1,
          runPurpose: "candidate",
          evaluationAuthority: "typo",
          candidateOrigin: { kind: "working-tree" },
        },
        {
          run: 2,
          runPurpose: "typo",
          evaluationAuthority: "accepted-contract",
          candidateOrigin: { kind: "working-tree" },
        },
        { run: 3, status: "measure" },
      ],
    },
    runtimeConfig: { packetBudget: 4 },
  });

  assert.equal(budget.packetsUsed, 3);
  assert.equal(budget.packetsRemaining, 1);
});

test("iteration limits use packet-purpose rows instead of manual observations", () => {
  const limit = iterationLimitInfo(
    {
      current: [
        {
          run: 1,
          status: "measure",
          runPurpose: "baseline",
          evaluationAuthority: "manual",
          candidateOrigin: { kind: "none" },
        },
        {
          run: 2,
          status: "measure",
          runPurpose: "baseline",
          evaluationAuthority: "accepted-contract",
          candidateOrigin: { kind: "working-tree" },
        },
      ],
    } as any,
    { maxIterations: 2 },
  );

  assert.equal(limit.remainingIterations, 1);
  assert.equal(limit.limitReached, false);
});

test("an unconfigured packet budget remains available", () => {
  const budget = buildBudgetStatus({
    state: { current: [{ run: 1, status: "measure", metric: 10 }] },
    runtimeConfig: {},
  });
  const plan = compileDecisionPlan(snapshotFixture(), []);

  assert.equal(budget.configured, false);
  assert.equal(budget.exhausted, false);
  assert.equal(budget.packetBudget, null);
  assert.equal(budget.packetsRemaining, null);
  assert.equal(plan.primaryBlockerCode, null);
  assert.equal(plan.capabilities["run-packet"], "allowed");
  assert.equal(plan.loopDisposition.canRunPacket, true);
});

test("readout action fallback skips process-starting fallback commands", () => {
  const commands = {
    doctorExplain: "node scripts/autoresearch.mjs doctor --cwd C:/repo --check-benchmark --explain",
    benchmarkLint: "node scripts/autoresearch.mjs benchmark-lint --cwd C:/repo",
    state: "node scripts/autoresearch.mjs state --cwd C:/repo --compact --report",
  };

  assert.equal(
    resolveActionCommand("gate-quality", commands),
    "node scripts/autoresearch.mjs state --cwd C:/repo --compact --report",
  );
  assert.equal(
    resolveActionCommand("decision-capsule", commands),
    "node scripts/autoresearch.mjs state --cwd C:/repo --compact --report",
  );
});

test("shared safe command resolver preserves operational commands but filters readouts", () => {
  const processStarting = "node scripts/autoresearch.mjs benchmark-lint --cwd C:/repo";
  const inspectOnly = "node scripts/autoresearch.mjs state --cwd C:/repo --compact";
  const lookup = new Map([
    ["benchmarkLint", processStarting],
    ["placeholder", "node scripts/autoresearch.mjs state --cwd <project>"],
    ["stateCompact", inspectOnly],
  ]);

  assert.equal(firstSafeCommand([processStarting, inspectOnly], "operational"), processStarting);
  assert.equal(firstSafeCommand([processStarting, inspectOnly], "readout"), inspectOnly);
  assert.equal(
    resolveCommandByKeys((key) => lookup.get(key), ["placeholder", "stateCompact"], {
      mode: "readout",
    }),
    inspectOnly,
  );
});

test("runtime authority action metadata routes to read-only doctor", () => {
  const commands = {
    doctorExplain: "node scripts/autoresearch.mjs doctor --cwd C:/repo --explain",
    doctor: "node scripts/autoresearch.mjs doctor --cwd C:/repo",
    state: "node scripts/autoresearch.mjs state --cwd C:/repo --compact --report",
  };

  assert.equal(actionSafeActionForKind("runtime-authority"), "doctor");
  assert.equal(
    resolveActionCommand("runtime-authority", commands),
    "node scripts/autoresearch.mjs doctor --cwd C:/repo --explain",
  );
});

test("readout action fallback filters explicit process-starting canonical commands", () => {
  const commands = {
    doctorExplain: "node scripts/autoresearch.mjs doctor --cwd C:/repo --check-benchmark --explain",
    benchmarkLint: "node scripts/autoresearch.mjs benchmark-lint --cwd C:/repo",
    state: "node scripts/autoresearch.mjs state --cwd C:/repo --compact --report",
  };

  assert.equal(
    resolveActionCommand("preflight", commands, {
      explicitCommand:
        "node scripts/autoresearch.mjs doctor --cwd C:/repo --check-benchmark --explain",
    }),
    "node scripts/autoresearch.mjs state --cwd C:/repo --compact --report",
  );
  assert.equal(
    resolveActionCommand("next-packet", commands, {
      explicitCommand: "node scripts/autoresearch.mjs next --cwd C:/repo --compact",
    }),
    "node scripts/autoresearch.mjs next --cwd C:/repo --compact",
  );
});

test("dashboard-style metadata fallback skips unsafe dry-run command payloads", () => {
  const commands = new Map([
    [
      "new segment dry run",
      'node scripts/autoresearch.mjs new-segment --cwd C:/repo --dry-run --benchmark-command "node evil.js"',
    ],
    ["gap candidates", "node scripts/autoresearch.mjs gap-candidates --cwd C:/repo"],
    ["state", "node scripts/autoresearch.mjs state --cwd C:/repo --compact"],
  ]);

  assert.equal(
    fallbackCommandForKind("segment-transition", (key) => commands.get(key)),
    "node scripts/autoresearch.mjs gap-candidates --cwd C:/repo",
  );
});

test("operator checklist returns exactly the compact handoff keys", () => {
  const plan = compileDecisionPlan(snapshotFixture(), [
    decisionDiagnostic("packet-diagnostic", {
      message: "Citation carry failed.",
      command: "node scripts/autoresearch.mjs partial-results --cwd C:/repo --from-last",
    }),
  ]);
  const checklist = buildOperatorChecklist(plan, {
    actionReason: "Inspect diagnostics.",
  });

  assert.deepEqual(Object.keys(checklist), [
    "command",
    "safetyReason",
    "blocker",
    "evidenceRole",
    "source",
  ]);
  assert.match(checklist.command, /partial-results/);
  assert.equal(checklist.blocker, "packet-diagnostic");
  assert.equal(checklist.evidenceRole, "accepted-checks");
  assert.equal(checklist.source, "packet-diagnostic");
});

test("goal frame keeps the durable Autoresearch goal authoritative", () => {
  const frame = buildGoalFrame({
    autoresearchGoal:
      "Use a cheap local agent-value gap to steer CodeStory grounding improvements before spending live A/B or broad-suite budget.",
    codexGoalObjective:
      "Please continue with the autoresearch. Start by stating and starting the goal of the research.",
  });

  assert.equal(
    frame.authoritativeGoal,
    "Use a cheap local agent-value gap to steer CodeStory grounding improvements before spending live A/B or broad-suite budget.",
  );
  assert.equal(frame.codexObjectiveRole, "operator_instruction");
  assert.equal(frame.mismatch, true);
  assert.match(frame.warning, /Codex prompt is not the research goal/);
});

test("goal frame stays quiet when Codex and Autoresearch goals match", () => {
  const frame = buildGoalFrame({
    autoresearchGoal: "Reduce packet latency while preserving quality.",
    codexGoalObjective: "Reduce packet latency while preserving quality.",
  });

  assert.equal(frame.authoritativeGoal, "Reduce packet latency while preserving quality.");
  assert.equal(frame.codexObjectiveRole, "matching_research_goal");
  assert.equal(frame.mismatch, false);
  assert.equal(frame.warning, "");
});

test("session decision rules capture Codex prompt versus research goal corrections", () => {
  const text =
    "That's not the goal of the autoresearch, that's my prompt. The research goal is still the cheap local agent-value gap.";
  const matches = matchDecisionRules(text, "message");

  assert.equal(
    matches.some((match) => match.kind === "goal_frame_mismatch"),
    true,
  );

  const capsule = buildSessionDecisionCapsule({
    compactions: 0,
    first: "2026-06-01T13:00:00.000Z",
    last: "2026-06-01T13:05:00.000Z",
    productSignals: matches,
    workflowWaste: [],
    blockers: [],
    userCorrections: [],
    toolCounts: {},
    commandClasses: {},
    thresholds: {
      functionCalls: 30,
      outputSegmentTokenBudget: 20_000,
      repeatedCommandHeadCount: 3,
      shellPolls: 12,
    },
  });

  assert.equal(capsule.enforcement.mode, "bounded-next");
  assert.equal(capsule.enforcement.canRunNextPacket, false);
  assert.equal(capsule.enforcement.allowBoundedNext, true);
  assert.match(capsule.bottleneck, /goal-frame drift/i);
  assert.match(capsule.nextExperiment, /durable Autoresearch goal/i);
  assert.match(capsule.evidence.join("\n"), /Codex prompt was mistaken/);
});

test("session decision rules hard-block benchmark-specific overfit steering", () => {
  const text = [
    "The harness work is mostly generalizable, but the targeted row wins are substantially overfit.",
    "This is benchmark-specific retrieval steering with task-family detectors, protected probes, and static citations.",
  ].join(" ");
  const matches = matchDecisionRules(text, "message");

  assert.equal(
    matches.some((match) => match.kind === "benchmark_overfit_steering"),
    true,
  );

  const capsule = buildSessionDecisionCapsule({
    compactions: 0,
    first: "2026-06-11T20:24:14.000Z",
    last: "2026-06-12T22:40:00.000Z",
    productSignals: matches,
    workflowWaste: [],
    blockers: [],
    userCorrections: [],
    toolCounts: {},
    commandClasses: {},
    thresholds: {
      functionCalls: 30,
      outputSegmentTokenBudget: 20_000,
      repeatedCommandHeadCount: 3,
      shellPolls: 12,
    },
  });

  assert.equal(capsule.enforcement.mode, "hard-block");
  assert.equal(capsule.enforcement.canRunNextPacket, false);
  assert.equal(capsule.enforcement.blocksFinalization, true);
  assert.deepEqual(capsule.enforcement.triggeredBy, ["sessionDecisionCapsule", "benchmarkOverfit"]);
  assert.match(capsule.bottleneck, /epistemic trust/i);
  assert.match(capsule.nextExperiment, /diagnostic\/provisional/i);
  assert.match(capsule.wrongNextActions.join("\n"), /task-family detectors/i);
});

test("session decision rules do not flag negated overfit feedback without steering evidence", () => {
  const text = "This was not overfit, and no benchmark-specific steering was added to the harness.";
  const matches = matchDecisionRules(text, "message");

  assert.equal(
    matches.some((match) => match.kind === "benchmark_overfit_steering"),
    false,
  );
});

test("session decision rules do not flag benign benchmark-specific test planning", () => {
  const text = "Add benchmark-specific regression tests around command rendering.";
  const matches = matchDecisionRules(text, "message");

  assert.equal(
    matches.some((match) => match.kind === "benchmark_overfit_steering"),
    false,
  );
});

test("session decision rules flag bare benchmark-specific steering", () => {
  const text = "This was benchmark-specific steering.";
  const matches = matchDecisionRules(text, "message");

  assert.equal(
    matches.some((match) => match.kind === "benchmark_overfit_steering"),
    true,
  );
});

test("session decision rules do not flag negated steering vocabulary", () => {
  const cases = [
    "This is not benchmark-specific retrieval steering; no protected probes were added.",
    "The patch used no static citations and no task-family detectors.",
    "We repaired the parser without row-specific steering or answer key logic.",
    "We repaired the parser without answer key logic.",
    "The session had not learned the test, and no static citations were added.",
    "The session never learned the test, and no static citations were added.",
    "No evidence the session learned the test; no static citations were added.",
    "No evidence of answer key logic was found.",
    "The patch avoided answer key logic.",
    "The audit ruled out answer key logic.",
    "This is not test-specific retrieval steering.",
    "This used no row-specific retrieval steering.",
    "No evidence of overfitting was found.",
    "The audit ruled out overfitting.",
    "The patch avoided overfitting.",
    "This is not an overfit.",
    "Do not add benchmark-specific retrieval steering.",
    "Do not use answer key logic.",
    "Do not add benchmark-specific exact files.",
    "This was benchmark-specific with no exact files.",
    "This was row-specific with no exact symbols.",
  ];

  for (const text of cases) {
    const matches = matchDecisionRules(text, "message");
    assert.equal(
      matches.some((match) => match.kind === "benchmark_overfit_steering"),
      false,
      text,
    );
  }
});

test("session decision rules flag learned-test claims despite negated mechanisms", () => {
  const text = "The session learned the test, but no static citations were added.";
  const matches = matchDecisionRules(text, "message");

  assert.equal(
    matches.some((match) => match.kind === "benchmark_overfit_steering"),
    true,
  );
});

test("session decision rules flag positive steering despite negated secondary mechanisms", () => {
  const text =
    "This is benchmark-specific retrieval steering with task-family detectors and no static citations.";
  const matches = matchDecisionRules(text, "message");

  assert.equal(
    matches.some((match) => match.kind === "benchmark_overfit_steering"),
    true,
  );
});

test("session decision rules flag positive overfit evidence after earlier negated segments", () => {
  const cases = [
    "Earlier notes said this was not benchmark-specific retrieval steering. The current packet added benchmark-specific retrieval steering with task-family detectors.",
    "Earlier notes said this was not benchmark-specific retrieval steering and the current packet added benchmark-specific retrieval steering with task-family detectors.",
    "The parser was repaired without answer key logic. The new row fix added answer key logic for benchmark wins.",
    "The baseline was not overfit. The latest targeted row wins are overfit.",
  ];

  for (const text of cases) {
    const matches = matchDecisionRules(text, "message");
    assert.equal(
      matches.some((match) => match.kind === "benchmark_overfit_steering"),
      true,
      text,
    );
  }
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

test("lane lifecycle ignores completed lane results from older segments", () => {
  const lifecycle = buildLaneLifecycle({
    state: { segment: 1 },
    fanoutPlan: {
      segment: 1,
      lanes: [{ id: "benchmark-contract", status: "planned" }],
    },
    records: [
      {
        type: "lane_result",
        segment: 0,
        timestamp: Date.parse("2026-05-31T01:00:00.000Z"),
        lane: { id: "benchmark-contract" },
        result: { status: "completed", recommendation: "Old segment result." },
      },
    ],
    nowMs: Date.parse("2026-05-31T01:30:00.000Z"),
  });

  assert.deepEqual(
    lifecycle.plannedLanes.map((lane) => lane.id),
    ["benchmark-contract"],
  );
  assert.equal(lifecycle.resultLanes.length, 0);
  assert.equal(lifecycle.latestResults.length, 0);
});

test("lane lifecycle ignores direct laneResults from older segments", () => {
  const lifecycle = buildLaneLifecycle({
    state: { segment: 1 },
    fanoutPlan: {
      segment: 1,
      lanes: [{ id: "benchmark-contract", status: "planned" }],
    },
    laneResults: [
      {
        type: "lane_result",
        segment: 0,
        timestamp: Date.parse("2026-05-31T01:00:00.000Z"),
        lane: { id: "benchmark-contract" },
        result: { status: "completed", recommendation: "Old direct lane result." },
      },
    ],
    nowMs: Date.parse("2026-05-31T01:30:00.000Z"),
  });

  assert.deepEqual(
    lifecycle.plannedLanes.map((lane) => lane.id),
    ["benchmark-contract"],
  );
  assert.equal(lifecycle.resultLanes.length, 0);
  assert.equal(lifecycle.latestResults.length, 0);
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
    sourceDiagnostics: { ledgerIssues: [] },
    semanticFacts: {
      contractDigest: "contract-a",
      evaluatorIdentity: "eval-a",
      acceptedCheckIdentities: ["check-a@digest-a"],
      preconditionEpoch: "epoch-a",
    },
  } as CoherentSessionSnapshot;
}
