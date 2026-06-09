import assert from "node:assert/strict";
import test from "node:test";

import { evaluateGateQuality } from "../lib/gate-quality.js";

test("gate quality keeps an empty checks command advisory by default", () => {
  const summary = evaluateGateQuality({
    benchmarkCommand: "node bench.js",
    checksCommand: "",
  });

  assert.equal(summary.posture, "advisory-missing");
  assert.match(summary.nextActionHint, /checks|gate/i);
  assert.equal(summary.blockers.length, 0);
  assert.match(summary.warnings.join("\n"), /checks/i);
});

test("gate quality treats manual missing checks as advisory instead of blocking", () => {
  const summary = evaluateGateQuality({
    benchmarkCommand: "node bench.js",
    checksCommand: "",
    checksPolicy: "manual",
  });

  assert.equal(summary.posture, "advisory-missing");
  assert.deepEqual(summary.blockers, []);
  assert.match(summary.warnings.join("\n"), /checks/i);
});

test("gate quality blocks missing checks when checks are required", () => {
  const summary = evaluateGateQuality({
    benchmarkCommand: "node bench.js",
    checksCommand: "",
    checksPolicy: "always",
    checksRequired: true,
  });

  assert.equal(summary.posture, "missing");
  assert.match(summary.blockers.join("\n"), /checks command/i);
});

test("gate quality treats benchmark-as-checks as smoke coverage", () => {
  const summary = evaluateGateQuality({
    benchmarkCommand: "node bench.js",
    checksCommand: "node bench.js",
  });

  assert.equal(summary.posture, "smoke");
  assert.match(summary.warnings.join("\n"), /weak protection|pass\/fail/i);
});

test("gate quality promotes explicit promotion metadata above checks posture", () => {
  const summary = evaluateGateQuality({
    benchmarkCommand: "node bench.js",
    checksCommand: "npm test",
    promotion: { suite: "held-out repo matrix" },
  });

  assert.equal(summary.posture, "promotion");
  assert.match(summary.evidence.join("\n"), /holdout|promotion/i);
});

test("gate quality does not promote benchmark-as-checks even with promotion metadata", () => {
  const summary = evaluateGateQuality({
    benchmarkCommand: "node bench.js",
    checksCommand: "node bench.js",
    promotion: { suite: "held-out repo matrix" },
  });

  assert.equal(summary.posture, "smoke");
  assert.match(summary.warnings.join("\n"), /weak protection|pass\/fail/i);
});

test("gate quality ignores empty promotion evidence tracks", () => {
  const summary = evaluateGateQuality({
    benchmarkCommand: "node bench.js",
    checksCommand: "node verify-gate.js",
    promotion: {
      count: 0,
      kept: 0,
      baseline: null,
      best: null,
      bestRun: null,
      latest: null,
    },
  });

  assert.equal(summary.posture, "unknown");
  assert.doesNotMatch(summary.evidence.join("\n"), /Promotion metadata is present/);
});

test("gate quality recognizes correctness gates from common verification verbs", () => {
  for (const checksCommand of ["npm test", "npm run typecheck", "npm run lint", "npm run build"]) {
    const summary = evaluateGateQuality({
      benchmarkCommand: "node bench.js",
      checksCommand,
    });

    assert.equal(summary.posture, "correctness", checksCommand);
    assert.match(summary.evidence.join("\n"), /checks command/i);
  }
});

test("gate quality recognizes domain quality checks as correctness gates", () => {
  for (const checksCommand of [
    "node scripts/check-recall.mjs",
    "node scripts/mrr-ranking-gate.mjs",
    "npm run accessibility",
    "npm run axe",
    "npm run wcag",
    "npm run security",
  ]) {
    const summary = evaluateGateQuality({
      benchmarkCommand: "node bench.js",
      checksCommand,
    });

    assert.equal(summary.posture, "correctness", checksCommand);
    assert.match(summary.evidence.join("\n"), /quality|correctness|security|accessibility/i);
  }
});

test("npm run check is classified as correctness gate", () => {
  const summary = evaluateGateQuality({
    benchmarkCommand: "node ./bench.mjs",
    checksCommand: "npm run check",
  });

  assert.equal(summary.posture, "correctness");
  assert.match(summary.evidence.join("\n"), /check/i);
});

test("gate quality recognizes holdout metadata without promotion metadata", () => {
  const summary = evaluateGateQuality({
    benchmarkCommand: "node bench.js",
    checksCommand: "node verify.js",
    holdout: { dataset: "fixtures/holdout.json" },
  });

  assert.equal(summary.posture, "holdout");
  assert.match(summary.evidence.join("\n"), /holdout/i);
});

test("gate quality marks non-string command fields as malformed", () => {
  const inputs: unknown[] = [
    { benchmarkCommand: 42, checksCommand: "npm test" },
    { benchmarkCommand: "node bench.js", checksCommand: ["npm", "test"] },
  ];

  for (const input of inputs) {
    const summary = evaluateGateQuality(input as GateQualityInput);

    assert.equal(summary.posture, "malformed");
    assert.match(summary.blockers.join("\n"), /command/i);
  }
});

test("gate quality uses unknown when checks exist without recognizable evidence", () => {
  const summary = evaluateGateQuality({
    benchmarkCommand: "node bench.js",
    checksCommand: "node verify-gate.js",
  });

  assert.equal(summary.posture, "unknown");
  assert.match(summary.nextActionHint, /explain|classify|document|checks/i);
});
