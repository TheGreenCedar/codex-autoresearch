# Autoresearch Product-Grade Finalization Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent finalization and PR handoff output from presenting experimental or under-proven work as product-grade.

**Architecture:** Reuse the claim coverage model from Story 01. Finalization preview remains read-only, but its readiness result must include product-claim blockers before branch creation or PR guidance can look shippable.

**Tech Stack:** TypeScript, Node.js 24+, node:test.

---

## File Structure

- Modify: `plugins/codex-autoresearch/lib/finalization-acceptance.ts`
- Modify: `plugins/codex-autoresearch/lib/finalize-preview.ts`
- Modify: `plugins/codex-autoresearch/scripts/finalize-autoresearch.ts`
- Modify: `plugins/codex-autoresearch/lib/dashboard-view-model.ts`
- Test: `plugins/codex-autoresearch/tests/finalize-report.test.ts`
- Test: `plugins/codex-autoresearch/tests/autoresearch-cli.test.ts`

---

### Task 1: Block Product-Grade Readiness When Claims Are Missing

- [ ] **Step 1: Write failing finalization preview test**

Add a test in `plugins/codex-autoresearch/tests/finalize-report.test.ts` that creates a session with:

- goal: `Deliver a shippable lazy semantic retrieval performance improvement.`
- one kept run with evidence: `foreground embedding work can be bounded`
- no accuracy, lazy behavior, ranking, or docs proof

Assert that finalization preview returns:

```ts
assert.equal(preview.productGradeReady, false);
assert.match(preview.blockers.join("\n"), /retrieval accuracy/i);
assert.match(preview.blockers.join("\n"), /lazy/i);
assert.doesNotMatch(preview.summary, /ready to merge|shippable/i);
```

- [ ] **Step 2: Run the failing test**

Run:

```powershell
cd C:\Users\alber\source\repos\autoresearch\plugins\codex-autoresearch
npm run build:node
node --test --test-name-pattern "product-grade" dist/tests/finalize-report.test.mjs
```

Expected: FAIL because finalization does not consume claim coverage yet.

- [ ] **Step 3: Add finalization acceptance rules**

In `plugins/codex-autoresearch/lib/finalization-acceptance.ts`, add a function:

```ts
export function productGradeFinalizationIssue(coverage: unknown): string | null
```

Rules:

- Return null when no coverage exists or `productGradeReady === true`.
- Return `Product-grade evidence is missing: ...` when `missingRequiredProof` is non-empty.
- Include proof labels, not only ids.

- [ ] **Step 4: Wire preview blockers**

In `plugins/codex-autoresearch/lib/finalize-preview.ts`, include the product-grade issue in preview blockers/checklist items. The preview should still be allowed for research branches, but it must not claim product-grade readiness.

- [ ] **Step 5: Downgrade finalizer language**

In `plugins/codex-autoresearch/scripts/finalize-autoresearch.ts`, change final stdout/JSON wording so an under-proven result says:

```text
Experimental review branch only: product-grade proof is missing.
```

Do not emit merge-ready wording while `productGradeReady` is false.

- [ ] **Step 6: Add CLI regression**

In `plugins/codex-autoresearch/tests/autoresearch-cli.test.ts`, add a `finalize-preview --json` test that asserts missing claim coverage appears in JSON and text output.

- [ ] **Step 7: Run targeted verification**

Run:

```powershell
cd C:\Users\alber\source\repos\autoresearch\plugins\codex-autoresearch
npm run build:node
node --test dist/tests/finalize-report.test.mjs dist/tests/autoresearch-cli.test.mjs
```

Expected: PASS for product-grade finalization guard tests.

- [ ] **Step 8: Commit**

```powershell
git add plugins/codex-autoresearch/lib/finalization-acceptance.ts plugins/codex-autoresearch/lib/finalize-preview.ts plugins/codex-autoresearch/scripts/finalize-autoresearch.ts plugins/codex-autoresearch/lib/dashboard-view-model.ts plugins/codex-autoresearch/tests/finalize-report.test.ts plugins/codex-autoresearch/tests/autoresearch-cli.test.ts
git commit -m "fix: guard product-grade finalization claims"
```

