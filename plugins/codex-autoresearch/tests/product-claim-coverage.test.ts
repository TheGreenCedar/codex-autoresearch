import assert from "node:assert/strict";
import test from "node:test";

import { buildProductClaimCoverage } from "../lib/product-claim-coverage.js";

test("shippable retrieval goal requires accuracy, lazy behavior, sidecar safety, and docs proof", () => {
  const coverage = buildProductClaimCoverage({
    goal: "Deliver a shippable large-codebase semantic performance improvement with lazy retrieval and accuracy validation.",
    acceptedEvidence: ["foreground embedding work can be bounded", "sidecar safety fails closed"],
  });

  assert.equal(coverage.productGradeReady, false);
  assert.equal(coverage.maturity, "development");
  assert.deepEqual(
    coverage.missingRequiredProof.map((proof) => proof.id),
    ["retrieval_accuracy", "lazy_behavior", "ranking_quality", "docs_tests"],
  );
});

test("explicit accepted proof can make a product-grade claim ready", () => {
  const coverage = buildProductClaimCoverage({
    goal: "Deliver a shippable lazy semantic retrieval improvement.",
    acceptedEvidence: [
      "retrieval accuracy validation passed",
      "lazy query-triggered backfill passed",
      "sidecar safety fails closed",
      "ranking quality holds",
      "tests and docs updated",
    ],
  });

  assert.equal(coverage.productGradeReady, true);
  assert.equal(coverage.maturity, "product_grade");
  assert.deepEqual(coverage.blockers, []);
});

test("non product goal stays informational without blockers", () => {
  const coverage = buildProductClaimCoverage({
    goal: "Run a baseline measurement.",
    acceptedEvidence: [],
  });

  assert.equal(coverage.productGradeReady, true);
  assert.equal(coverage.maturity, "product_grade");
  assert.deepEqual(coverage.requirements, []);
  assert.deepEqual(coverage.blockers, []);
});
