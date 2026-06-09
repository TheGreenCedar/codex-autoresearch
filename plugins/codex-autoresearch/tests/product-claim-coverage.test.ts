import assert from "node:assert/strict";
import test from "node:test";

import { buildProductClaimCoverage } from "../lib/product-claim-coverage.js";

test("shippable retrieval goal requires accuracy, lazy behavior, and docs proof", () => {
  const coverage = buildProductClaimCoverage({
    goal: "Deliver a shippable large-codebase semantic performance improvement with lazy retrieval and accuracy validation.",
    acceptedEvidence: [
      "foreground embedding work can be bounded",
      "lazy query-triggered backfill passed",
    ],
  });

  assert.equal(coverage.productGradeReady, false);
  assert.equal(coverage.maturity, "development");
  assert.deepEqual(
    coverage.missingRequiredProof.map((proof) => proof.id),
    ["retrieval_accuracy", "ranking_quality", "docs_tests"],
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

test("negated evidence does not satisfy product-grade proof requirements", () => {
  const coverage = buildProductClaimCoverage({
    goal: "Deliver a shippable lazy semantic retrieval improvement.",
    acceptedEvidence: [
      "accuracy was NOT tested",
      "lazy backfill still pending",
      "ranking quality unknown",
      "tests and docs TODO",
    ],
  });

  assert.equal(coverage.productGradeReady, false);
  assert.equal(coverage.claimDetected, true);
  assert.ok(coverage.missingRequiredProof.length > 0);
});

test("contracted negations like didn't do not satisfy proof requirements", () => {
  const coverage = buildProductClaimCoverage({
    goal: "Deliver a shippable lazy semantic retrieval improvement.",
    acceptedEvidence: [
      "we didn't test accuracy",
      "lazy backfill doesn't work yet",
      "ranking quality hasn't been validated",
      "tests and docs haven't been written",
    ],
  });

  assert.equal(coverage.productGradeReady, false);
  assert.equal(coverage.claimDetected, true);
  assert.ok(coverage.missingRequiredProof.length > 0);
});

test("non product goal stays informational without blockers", () => {
  const coverage = buildProductClaimCoverage({
    goal: "Run a baseline measurement.",
    acceptedEvidence: [],
  });

  assert.equal(coverage.claimDetected, false);
  assert.equal(coverage.productGradeReady, true);
  assert.equal(coverage.maturity, "experimental");
  assert.deepEqual(coverage.requirements, []);
  assert.deepEqual(coverage.blockers, []);
});

test("generic shippable goal requires correctness and docs proof", () => {
  const coverage = buildProductClaimCoverage({
    goal: "Make the importer shippable.",
    acceptedEvidence: [],
  });

  assert.equal(coverage.claimDetected, true);
  assert.equal(coverage.productGradeReady, false);
  assert.deepEqual(
    coverage.missingRequiredProof.map((proof) => proof.id),
    ["correctness_checks", "docs_tests"],
  );
});

test("plain performance goal without product claim does not impose retrieval requirements", () => {
  const coverage = buildProductClaimCoverage({
    goal: "Improve JSON parser performance.",
    acceptedEvidence: ["parser is faster"],
  });

  assert.equal(coverage.claimDetected, false);
  assert.equal(coverage.productGradeReady, true);
  assert.deepEqual(coverage.requirements, []);
});
