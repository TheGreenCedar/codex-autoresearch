# Autoresearch Claim Coverage Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a small, testable claim-coverage model that distinguishes experimental progress from product-grade evidence.

**Architecture:** Keep the first slice pure and CLI/dashboard-agnostic. The model reads goal text, session evidence, and optional explicit claim records, then returns maturity, blockers, and missing proof that later stories can consume.

**Tech Stack:** TypeScript, Node.js 24+, node:test, package-local build/test commands.

---

## File Structure

- Create: `plugins/codex-autoresearch/lib/product-claim-coverage.ts`
- Modify: `plugins/codex-autoresearch/lib/session-core.ts`
- Modify: `plugins/codex-autoresearch/lib/dashboard-view-model.ts`
- Test: `plugins/codex-autoresearch/tests/product-claim-coverage.test.ts`
- Test: `plugins/codex-autoresearch/tests/autoresearch-cli.test.ts`

---

### Task 1: Model Claim Coverage

- [ ] **Step 1: Write the pure model test**

Create `plugins/codex-autoresearch/tests/product-claim-coverage.test.ts` with tests covering:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildProductClaimCoverage } from "../lib/product-claim-coverage.js";

test("shippable retrieval goal requires accuracy, lazy behavior, sidecar safety, and docs proof", () => {
  const coverage = buildProductClaimCoverage({
    goal:
      "Deliver a shippable large-codebase semantic performance improvement with lazy retrieval and accuracy validation.",
    acceptedEvidence: [
      "foreground embedding work can be bounded",
      "sidecar safety fails closed",
    ],
  });

  assert.equal(coverage.productGradeReady, false);
  assert.equal(coverage.maturity, "experimental");
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
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```powershell
cd C:\Users\alber\source\repos\autoresearch\plugins\codex-autoresearch
npm run build:node
node --test dist/tests/product-claim-coverage.test.mjs
```

Expected: FAIL because `product-claim-coverage.ts` does not exist.

- [ ] **Step 3: Add the pure model**

Create `plugins/codex-autoresearch/lib/product-claim-coverage.ts` with exports:

```ts
export type ProductClaimMaturity = "experimental" | "development" | "product_grade";

export interface ProductProofRequirement {
  id: string;
  label: string;
  requiredForProductGrade: boolean;
}

export interface ProductClaimCoverage {
  maturity: ProductClaimMaturity;
  productGradeReady: boolean;
  requirements: ProductProofRequirement[];
  coveredProof: ProductProofRequirement[];
  missingRequiredProof: ProductProofRequirement[];
  blockers: string[];
}

export interface ProductClaimCoverageInput {
  goal?: string | null;
  acceptedEvidence?: string[];
}
```

Implement `buildProductClaimCoverage(input)` with these rules:

- If goal text contains `shippable`, `product-grade`, `final`, `lazy`, `retrieval`, `accuracy`, `ranking`, `semantic`, or `performance`, evaluate the proof requirements.
- Retrieval/semantic/performance goals require `retrieval_accuracy`, `sidecar_safety`, `lazy_behavior`, `ranking_quality`, and `docs_tests`.
- Evidence matching is case-insensitive and may use phrase families:
  - `retrieval_accuracy`: `accuracy`, `recall`, `mrr`, `hit@`, `quality validation`
  - `sidecar_safety`: `sidecar safety`, `fail closed`, `sidecar fails closed`
  - `lazy_behavior`: `lazy`, `query-triggered`, `backfill`, `selective`
  - `ranking_quality`: `ranking`, `rank quality`, `search quality`
  - `docs_tests`: `tests and docs`, `docs updated`, `test updated`
- `productGradeReady` is true only when all required proof is covered.
- `maturity` is `product_grade` when ready, `development` when at least one required proof is covered, and `experimental` otherwise.

- [ ] **Step 4: Expose coverage in session state**

In `plugins/codex-autoresearch/lib/session-core.ts`, import `buildProductClaimCoverage` and add a `productClaimCoverage` field to the returned state using current config goal and accepted/current evidence text already available in the state. If no accepted evidence extractor exists, use run descriptions plus ASI evidence fields from kept/current runs.

- [ ] **Step 5: Expose coverage in dashboard view model**

In `plugins/codex-autoresearch/lib/dashboard-view-model.ts`, pass `state.productClaimCoverage` through as `viewModel.productClaimCoverage` without rendering it yet.

- [ ] **Step 6: Add CLI state regression**

In `plugins/codex-autoresearch/tests/autoresearch-cli.test.ts`, add a temp-session test that writes a shippable retrieval goal plus only one keep evidence item and asserts `state.productClaimCoverage.productGradeReady === false`.

- [ ] **Step 7: Run targeted verification**

Run:

```powershell
cd C:\Users\alber\source\repos\autoresearch\plugins\codex-autoresearch
npm run build:node
node --test dist/tests/product-claim-coverage.test.mjs dist/tests/autoresearch-cli.test.mjs
```

Expected: PASS for the new tests.

- [ ] **Step 8: Commit**

```powershell
git add plugins/codex-autoresearch/lib/product-claim-coverage.ts plugins/codex-autoresearch/lib/session-core.ts plugins/codex-autoresearch/lib/dashboard-view-model.ts plugins/codex-autoresearch/tests/product-claim-coverage.test.ts plugins/codex-autoresearch/tests/autoresearch-cli.test.ts
git commit -m "feat: model product claim coverage"
```

