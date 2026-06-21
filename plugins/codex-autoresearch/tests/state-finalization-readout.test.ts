import assert from "node:assert/strict";
import test from "node:test";

import { compactFinalizationReadiness } from "../lib/state-finalization-readout.js";

test("compacts missing finalization readiness with state defaults", () => {
  assert.deepEqual(compactFinalizationReadiness(null), {
    available: true,
    ready: false,
    productGradeReady: true,
    productGradeIssue: null,
    nextAction: "",
    warnings: [],
  });
});

test("compacts finalization readiness without changing readout semantics", () => {
  assert.deepEqual(
    compactFinalizationReadiness({
      available: false,
      ready: null,
      productGradeReady: false,
      productGradeIssue: "Missing evidence",
      recommendation: "Run finalize-preview.",
      warnings: ["one", "two", "three", "four"],
    }),
    {
      available: false,
      ready: null,
      productGradeReady: false,
      productGradeIssue: "Missing evidence",
      nextAction: "Run finalize-preview.",
      warnings: ["one", "two", "three"],
    },
  );
});
