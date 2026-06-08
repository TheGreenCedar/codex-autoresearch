# Autoresearch Performance Quality Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make performance loops discover and preserve correctness constraints before optimizing speed.

**Architecture:** Add lightweight domain detection to setup/prompt planning and benchmark guidance. Retrieval, ranking, accuracy, accessibility, safety, and data-integrity work should require quality gates or explicit acceptance of missing quality proof.

**Tech Stack:** TypeScript, Node.js 24+, node:test.

---

## File Structure

- Modify: `plugins/codex-autoresearch/scripts/autoresearch.ts`
- Modify: `plugins/codex-autoresearch/lib/gate-quality.ts`
- Modify: `plugins/codex-autoresearch/lib/decision-guidance.ts`
- Modify: `plugins/codex-autoresearch/lib/tool-schemas.ts`
- Test: `plugins/codex-autoresearch/tests/benchmark-constraints.test.ts`
- Test: `plugins/codex-autoresearch/tests/autoresearch-cli.test.ts`
- Test: `plugins/codex-autoresearch/tests/decision-guidance-gate-quality.test.ts`

---

### Task 1: Detect Accuracy-Sensitive Performance Work

- [ ] **Step 1: Write failing prompt-plan test**

In `plugins/codex-autoresearch/tests/autoresearch-cli.test.ts`, add a test for:

```powershell
node scripts/autoresearch.mjs prompt-plan --cwd <tmp> --prompt "Speed up large-codebase semantic retrieval with lazy search"
```

Assert the JSON includes:

```ts
assert.match(JSON.stringify(payload), /quality constraint/i);
assert.match(JSON.stringify(payload), /accuracy|recall|ranking/i);
assert.doesNotMatch(JSON.stringify(payload), /cargo test.*primary benchmark/i);
```

- [ ] **Step 2: Write failing benchmark-constraints test**

In `plugins/codex-autoresearch/tests/benchmark-constraints.test.ts`, add a unit test that asserts retrieval performance goals require at least one quality gate command or a warning named `missing_quality_constraint`.

- [ ] **Step 3: Run failing tests**

Run:

```powershell
cd C:\Users\alber\source\repos\autoresearch\plugins\codex-autoresearch
npm run build:node
node --test --test-name-pattern "quality constraint|missing_quality_constraint" dist/tests/autoresearch-cli.test.mjs dist/tests/benchmark-constraints.test.mjs
```

Expected: FAIL because quality-contract routing does not exist yet.

- [ ] **Step 4: Add domain detector**

In `plugins/codex-autoresearch/scripts/autoresearch.ts`, add a helper near prompt analysis:

```ts
function qualitySensitivePerformanceDomain(text: string): string[] {
  const normalized = text.toLowerCase();
  const domains: string[] = [];
  if (/(retrieval|search|semantic|ranking|ranker|recall|mrr|accuracy)/.test(normalized)) {
    domains.push("retrieval_quality");
  }
  if (/(accessibility|wcag|keyboard|screen reader|aria)/.test(normalized)) {
    domains.push("accessibility_quality");
  }
  if (/(safety|security|auth|permission|data integrity|migration)/.test(normalized)) {
    domains.push("safety_integrity");
  }
  return domains;
}
```

- [ ] **Step 5: Surface required quality gates**

In prompt/setup-plan output, add:

```ts
qualityConstraints: domains.map((domain) => ({
  domain,
  requiredBeforePromotion: true,
  guidance:
    domain === "retrieval_quality"
      ? "Add or identify recall/MRR/hit@k/ranking checks before treating speed wins as product-grade."
      : "Add or identify a correctness check before promotion.",
}))
```

- [ ] **Step 6: Update gate-quality classification**

In `plugins/codex-autoresearch/lib/gate-quality.ts`, classify test commands containing `recall`, `mrr`, `ranking`, `quality`, `accessibility`, `axe`, `wcag`, or `security` as correctness gates when they are used as checks, not benchmark metrics.

- [ ] **Step 7: Run targeted verification**

Run:

```powershell
cd C:\Users\alber\source\repos\autoresearch\plugins\codex-autoresearch
npm run build:node
node --test dist/tests/benchmark-constraints.test.mjs dist/tests/autoresearch-cli.test.mjs dist/tests/decision-guidance-gate-quality.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add plugins/codex-autoresearch/scripts/autoresearch.ts plugins/codex-autoresearch/lib/gate-quality.ts plugins/codex-autoresearch/lib/decision-guidance.ts plugins/codex-autoresearch/lib/tool-schemas.ts plugins/codex-autoresearch/tests/benchmark-constraints.test.ts plugins/codex-autoresearch/tests/autoresearch-cli.test.ts plugins/codex-autoresearch/tests/decision-guidance-gate-quality.test.ts
git commit -m "feat: require quality contracts for performance loops"
```

