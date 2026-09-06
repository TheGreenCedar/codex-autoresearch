import assert from "node:assert/strict";
import test from "node:test";
import { buildProductClaimCoverage } from "../lib/product-claim-coverage.js";

test("prose cannot authorize a broad product claim", () => {
  for (const evidence of [
    "Correctness would be nice. Tests updated someday.",
    "retrieval accuracy validation passed; lazy backfill passed; ranking quality holds; tests and docs updated",
  ]) {
    const coverage = buildProductClaimCoverage({
      goal: "Deliver a shippable product",
      acceptedEvidence: [evidence],
    });
    assert.equal(coverage.claimDetected, false);
    assert.deepEqual(coverage.requirements, []);
    assert.notEqual(coverage.maturity, "product_grade");
    assert.deepEqual(coverage.coveredProof, []);
  }
});

test("ordinary goals do not invent domain or finalization requirements", () => {
  for (const goal of [
    "Improve classifier accuracy",
    "Improve semantic retrieval",
    "Run final timing comparison",
    "Improve JSON parser performance",
  ]) {
    const coverage = buildProductClaimCoverage({ goal });
    assert.equal(coverage.claimDetected, false);
    assert.equal(coverage.productGradeReady, true);
    assert.deepEqual(coverage.requirements, []);
    assert.deepEqual(coverage.blockers, []);
  }
});

test("explicit requirements remain unmet by narrative benchmark evidence", () => {
  const coverage = buildProductClaimCoverage({
    requirements: [
      { id: "independent-review", label: "Independent review", requiredForProductGrade: true },
    ],
    acceptedEvidence: ["Independent review passed"],
  });
  assert.equal(coverage.productGradeReady, false);
  assert.equal(coverage.missingRequiredProof[0].id, "independent-review");
});
