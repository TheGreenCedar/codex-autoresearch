import assert from "node:assert/strict";
import test from "node:test";
import { buildExperimentMemory, detectRepeatedHypothesis } from "../lib/experiment-memory.js";
import { buildPreflightAudit } from "../lib/preflight-audit.js";
import { recommendPortfolioDirection } from "../lib/portfolio-advisor.js";

test("portfolio advisor treats built runtime failures as trust blockers", () => {
  const recommendation = recommendPortfolioDirection({
    runtimeDrift: {
      installedRuntime: "fresh",
      builtRuntime: "missing",
      nextActionHint: "Build the local runtime.",
    },
    gateQuality: { posture: "correctness" },
    laneResults: [],
    packetDiagnostics: null,
    experimentMemory: null,
  });

  assert.equal(recommendation.kind, "trust-blocker");
  assert.equal(recommendation.confidence, "high");
  assert.match(recommendation.nextActionHint, /trust blocker|measured packet/i);
});

test("stale installed runtime alone stays advisory across portfolio and preflight", () => {
  const recommendation = recommendPortfolioDirection({
    runtimeDrift: {
      installedRuntime: "stale",
      builtRuntime: "available",
      nextActionHint: "Installed cache is stale.",
    },
    gateQuality: { posture: "correctness" },
    preflight: { status: "ready" },
    laneLifecycle: { plannedLanes: [] },
    experimentMemory: null,
    current: [{ run: 1, status: "measure", metric: 1 }],
  });

  assert.notEqual(recommendation.kind, "trust-blocker");

  const preflight = buildPreflightAudit({
    metricName: "seconds",
    benchmarkCommand: "node bench.mjs",
    gateQuality: { posture: "correctness", blockers: [], warnings: [] },
    runtimeDrift: {
      installedRuntime: "stale",
      builtRuntime: "available",
      nextActionHint: "Installed cache is stale.",
    },
    runs: 1,
  });

  assert.equal(preflight.status, "ready");
  assert.deepEqual(preflight.blockers, []);
  assert.match(preflight.warnings.join("\n"), /Installed cache is stale/);
});

test("missing built runtime blocks preflight runtime trust", () => {
  const preflight = buildPreflightAudit({
    metricName: "seconds",
    benchmarkCommand: "node bench.mjs",
    gateQuality: { posture: "correctness", blockers: [], warnings: [] },
    runtimeDrift: {
      installedRuntime: "fresh",
      builtRuntime: "missing",
      nextActionHint: "Build the local runtime.",
    },
    runs: 1,
  });

  assert.equal(preflight.status, "blocked");
  assert.match(preflight.blockers.join("\n"), /Build the local runtime/);
});

test("portfolio advisor reports low confidence for insufficient evidence", () => {
  const recommendation = recommendPortfolioDirection({
    runtimeDrift: { installedRuntime: "fresh" },
    gateQuality: { posture: "correctness" },
    preflight: { status: "ready" },
    laneLifecycle: { plannedLanes: [] },
    experimentMemory: null,
    current: [],
  });

  assert.equal(recommendation.kind, "insufficient-evidence");
  assert.equal(recommendation.confidence, "low");
  assert.match(recommendation.reason, /low confidence|No measured packet/i);
});

test("experiment memory groups repeated setting families and detects plateau risk", () => {
  const runs = [
    kept(1, 100, "Baseline BGE b512 r1", { hypothesis: "BGE base b512 repeat 1" }),
    rejected(2, 99, "Q8 b512 r1 regression", { hypothesis: "Q8 b512 r1" }),
    rejected(3, 99.2, "Q8 b512 r2 regression", { hypothesis: "Q8 b512 r2" }),
    rejected(4, 99.1, "Q8 b512 r3 regression", { hypothesis: "Q8 b512 r3" }),
    rejected(5, 99.3, "Q8 b512 r4 regression", { hypothesis: "Q8 b512 r4" }),
  ];

  const memory = buildExperimentMemory({ runs, direction: "higher" });
  const q8Family = memory.families.find((family) => /q8 b512 r/.test(family.key));

  assert.ok(q8Family, JSON.stringify(memory.families, null, 2));
  assert.equal(q8Family.runs, 4);
  assert.equal(q8Family.exhausted, true);
  assert.equal(memory.plateau.detected, true);
  assert.match(memory.plateau.recommendation, /distant scout/i);
  assert.equal(memory.lanePortfolio[0].id, "distant-scout");
  assert.equal(memory.novelty.uniqueFamilies < memory.novelty.recentWindow, true);
});

test("experiment memory uses structured settings while ignoring repeat-only fields", () => {
  const runs = [
    kept(1, 10, "settings baseline", {
      settings: { model: "nomic", dim: 512, repeat: 1 },
      hypothesis: "Nomic 512 repeat 1",
    }),
    rejected(2, 12, "settings repeat", {
      settings: { model: "nomic", dim: 512, repeat: 2 },
      hypothesis: "Nomic 512 repeat 2",
    }),
  ];

  const memory = buildExperimentMemory({ runs, direction: "lower" });
  assert.equal(memory.families.length, 1);
  assert.equal(memory.families[0].runs, 2);
});

test("repeated hypothesis detection catches near-family repeats", () => {
  const memory = buildExperimentMemory({
    direction: "higher",
    runs: [rejected(1, 90, "Q8 b512 r3 regression", { hypothesis: "Q8 b512 r3" })],
  });

  const repeat = detectRepeatedHypothesis({ proposed: "Try Q8 b512 r5", memory });
  assert.equal(repeat.matchedRun, 1);
  assert.match(repeat.reason, /already logged/);
});

test("experiment memory exposes exhausted families, shelves, and sparse ASI risk", () => {
  const memory = buildExperimentMemory({
    direction: "lower",
    runs: [
      kept(1, 10, "stable baseline", {
        family: "cache-size",
        hypothesis: "baseline cache size",
        evidence: "seconds=10",
      }),
      rejected(2, 11, "cache size r1", { family: "cache-size" }),
      rejected(3, 11.0001, "cache size r2", { family: "cache-size" }),
      {
        run: 4,
        metric: 11.0002,
        description: "cache size r3",
        status: "crash",
        asi: { family: "cache-size" },
      },
    ],
    settings: {
      decisionThresholds: {
        rejectedOrRegressedRunsInFamily: 3,
        shelfRelativeEpsilon: 0.001,
      },
    },
  });

  assert.equal(memory.exhaustedFamilies.length, 1);
  assert.equal(memory.exhaustedFamilies[0].family, "cache-size");
  assert.deepEqual(memory.exhaustedFamilies[0].runs, [2, 3, 4]);
  assert.equal(memory.metricShelves.length > 0, true);
  assert.equal(
    memory.missingAsiDetails.some((item) => item.run === 2),
    true,
  );

  const repeat = detectRepeatedHypothesis({
    proposed: "cache-size retry with same precondition",
    memory,
  });
  assert.equal(repeat.status, "exhausted");
  assert.match(repeat.requiredPrecondition, /Change a precondition/);
});

test("incumbent guidance prefers kept families over latest rejected families", () => {
  const memory = buildExperimentMemory({
    direction: "lower",
    runs: [
      kept(1, 10, "Good family wins", {
        family: "good",
        next_action_hint: "stress the good path",
      }),
      rejected(2, 12, "Bad family regresses", {
        family: "bad",
        rollback_reason: "regressed",
        next_action_hint: "avoid bad path",
      }),
    ],
  });

  assert.equal(memory.diversityGuidance.id, "incumbent-confirmation");
  assert.match(memory.diversityGuidance.reason, /good/);
  assert.equal(memory.diversityGuidance.nextActionHint, "stress the good path");
});

test("experiment memory keeps rejected and superseded keeps out of current accepted lanes", () => {
  const memory = buildExperimentMemory({
    direction: "lower",
    runs: [
      kept(
        1,
        1,
        "Rejected keep",
        {
          family: "rejected",
          hypothesis: "rejected path",
          evidence: "metric=1",
        },
        "rejected",
      ),
      kept(
        2,
        2,
        "Superseded keep",
        {
          family: "superseded",
          hypothesis: "superseded path",
          evidence: "metric=2",
        },
        "superseded",
      ),
      kept(3, 3, "Accepted keep", {
        family: "accepted",
        hypothesis: "accepted path",
        evidence: "metric=3",
        next_action_hint: "stress accepted",
      }),
    ],
  });

  assert.deepEqual(
    memory.kept.map((run) => run.run),
    [3],
  );
  assert.equal(memory.summary.kept, 1);
  assert.equal(memory.families.find((family) => family.label === "rejected")?.kept, 0);
  assert.equal(memory.families.find((family) => family.label === "superseded")?.kept, 0);
  assert.equal(memory.diversityGuidance.id, "incumbent-confirmation");
  assert.match(memory.diversityGuidance.reason, /accepted/);

  const repeat = detectRepeatedHypothesis({ proposed: "rejected path retry", memory });
  assert.equal(repeat, null);
});

test("experiment memory has no incumbent lane when every keep is non-current evidence", () => {
  const memory = buildExperimentMemory({
    direction: "lower",
    runs: [
      kept(
        1,
        1,
        "Rejected keep",
        {
          family: "rejected",
          hypothesis: "rejected path",
          evidence: "metric=1",
          rollback_reason: "invalidated",
        },
        "rejected",
      ),
      kept(
        2,
        2,
        "Superseded keep",
        {
          family: "superseded",
          hypothesis: "superseded path",
          evidence: "metric=2",
          rollback_reason: "superseded",
        },
        "superseded",
      ),
    ],
  });

  assert.deepEqual(memory.kept, []);
  assert.equal(memory.summary.kept, 0);
  assert.equal(memory.diversityGuidance, null);
  assert.equal(
    memory.lanePortfolio.some((lane) => lane.id === "incumbent-confirmation"),
    false,
  );
  assert.equal(
    memory.lanePortfolio.some((lane) => lane.id === "promote"),
    false,
  );
});

test("incumbent guidance omits placeholder lanes when there are no kept families", () => {
  const memory = buildExperimentMemory({
    direction: "lower",
    runs: [
      rejected(1, 12, "Bad family regresses", {
        family: "bad",
        hypothesis: "bad family",
        evidence: "seconds=12",
        rollback_reason: "regressed",
        next_action_hint: "avoid bad path",
      }),
    ],
  });
  const incumbent = memory.lanePortfolio.find((lane) => lane.id === "incumbent-confirmation");

  assert.equal(incumbent, undefined);
  assert.equal(memory.diversityGuidance.id, "avoid");
  assert.match(memory.diversityGuidance.reason, /regressed/);
});

test("best kept incumbent is preserved when active families are trimmed", () => {
  const runs = [
    kept(1, 1, "Best early family", {
      family: "best",
      next_action_hint: "stress the best path",
    }),
  ];
  for (let run = 2; run <= 10; run += 1) {
    const suffix = String.fromCharCode(96 + run);
    runs.push(
      kept(run, 10 + run, `Later worse family ${suffix}`, {
        family: `worse-${suffix}`,
        next_action_hint: `worse path ${suffix}`,
      }),
    );
  }

  const memory = buildExperimentMemory({ runs, direction: "lower" });

  assert.ok(memory.families.some((family) => family.label === "best"));
  assert.equal(memory.diversityGuidance.id, "incumbent-confirmation");
  assert.match(memory.diversityGuidance.reason, /best/);
  assert.equal(memory.diversityGuidance.nextActionHint, "stress the best path");
});

test("experiment memory handles large repeated families without losing summaries", () => {
  const runs = [kept(1, 100, "Baseline family", { family: "baseline", evidence: "seconds=100" })];
  for (let run = 2; run <= 1001; run += 1) {
    runs.push(
      rejected(run, 100 + (run % 7), `large family retry ${run}`, {
        family: "large-family",
        hypothesis: `large family retry ${run}`,
        rollback_reason: "regressed",
      }),
    );
  }

  const memory = buildExperimentMemory({ runs, direction: "lower" });
  const largeFamily = memory.families.find((family) => family.label === "large-family");

  assert.equal(memory.summary.families, 2);
  assert.equal(largeFamily?.runs, 1000);
  assert.equal(largeFamily?.failedRuns.length, 1000);
  assert.equal(largeFamily?.exhausted, true);
  assert.equal(memory.exhaustedFamilies[0].family, "large-family");
});

function kept(run, metric, description, asi = {}, evidenceStatus = "accepted") {
  return { run, metric, description, status: "keep", evidenceStatus, asi };
}

function rejected(run, metric, description, asi = {}) {
  return { run, metric, description, status: "discard", asi };
}
