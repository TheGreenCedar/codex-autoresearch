import assert from "node:assert/strict";
import test from "node:test";
import { buildExperimentMemory, detectRepeatedHypothesis } from "../lib/experiment-memory.js";

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

test("incumbent guidance waits when there are no kept families", () => {
  const memory = buildExperimentMemory({
    direction: "lower",
    runs: [
      rejected(1, 12, "Bad family regresses", {
        family: "bad",
        rollback_reason: "regressed",
        next_action_hint: "avoid bad path",
      }),
    ],
  });
  const incumbent = memory.lanePortfolio.find((lane) => lane.id === "incumbent-confirmation");

  assert.equal(incumbent.status, "waiting");
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

function kept(run, metric, description, asi = {}) {
  return { run, metric, description, status: "keep", asi };
}

function rejected(run, metric, description, asi = {}) {
  return { run, metric, description, status: "discard", asi };
}
