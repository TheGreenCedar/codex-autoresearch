# Autoresearch Docs And Skill Ship Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update durable docs and the main skill so agents do not finalize experiments as shippable product work.

**Architecture:** Keep the public README friendly and short. Put operational rules in focused docs and the main Codex-facing skill, with changelog coverage for user-facing behavior.

**Tech Stack:** Markdown, TypeScript doc surface checks, root changelog discipline.

---

## File Structure

- Modify: `CHANGELOG.md`
- Modify: `plugins/codex-autoresearch/docs/finish.md`
- Modify: `plugins/codex-autoresearch/docs/operate.md`
- Modify: `plugins/codex-autoresearch/docs/trust.md`
- Modify: `plugins/codex-autoresearch/docs/start.md`
- Modify: `plugins/codex-autoresearch/docs/troubleshooting.md`
- Modify: `plugins/codex-autoresearch/skills/codex-autoresearch/SKILL.md`
- Test: `plugins/codex-autoresearch/tests/full-product.test.ts`
- Test: `plugins/codex-autoresearch/tests/perfection-benchmark.test.ts`

---

### Task 1: Document Experimental Vs Product-Grade Evidence

- [ ] **Step 1: Add docs expectations test**

In `plugins/codex-autoresearch/tests/full-product.test.ts`, add assertions that docs and skill include:

```ts
[
  "product-grade",
  "experimental primitive",
  "claim coverage",
  "accuracy",
  "lazy behavior",
  "finalization preview",
]
```

For `finish.md`, also assert it includes:

```ts
"Do not finalize an experimental primitive as a shippable deliverable"
```

- [ ] **Step 2: Run failing docs test**

Run:

```powershell
cd C:\Users\alber\source\repos\autoresearch\plugins\codex-autoresearch
npm run build:node
node --test --test-name-pattern "product-grade|experimental primitive" dist/tests/full-product.test.mjs
```

Expected: FAIL until docs include the new contract.

- [ ] **Step 3: Update `finish.md`**

Add a section titled `Product-Grade Finalization Bar` with:

- A finalization preview can package evidence, but it must not imply shippability when product claims are unproven.
- Experimental primitive branches must use experimental wording.
- Retrieval/search/performance work needs accuracy or ranking proof before product-grade finalization.
- If default branch/trunk is ambiguous, use an explicit trunk such as `--trunk origin/main`.

- [ ] **Step 4: Update `operate.md`**

Add a recovery recipe for:

- `new-segment` after benchmark-contract drift.
- Dashboard live vs static handoff.
- Oversized exploration output.
- Restarting after false-done/product-bar rejection.

- [ ] **Step 5: Update `trust.md`**

Add claim coverage vocabulary:

- `experimental`
- `development`
- `product_grade`
- `missing_required_proof`
- `accepted evidence is not automatically shippable evidence`

- [ ] **Step 6: Update `start.md` and `troubleshooting.md`**

Make `prompt-plan` explicitly a draft. Add a troubleshooting entry for a performance loop that has a speed metric but no correctness constraint.

- [ ] **Step 7: Update the main skill**

In `plugins/codex-autoresearch/skills/codex-autoresearch/SKILL.md`, add guidance:

- For shippable/product/final requests, identify product claims before setup.
- For retrieval/search/ranking/performance work, require quality constraints before promotion.
- Before finalization, compare claim coverage against accepted evidence.
- If coverage is missing, report experimental status and do not create merge-looking PR language.

- [ ] **Step 8: Update changelog**

In root `CHANGELOG.md`, add an `Unreleased` entry summarizing docs/skill changes and any CLI/dashboard behavior from sibling stories already merged.

- [ ] **Step 9: Run targeted verification**

Run:

```powershell
cd C:\Users\alber\source\repos\autoresearch\plugins\codex-autoresearch
npm run build:node
node --test dist/tests/full-product.test.mjs dist/tests/perfection-benchmark.test.mjs
git diff --check
```

Expected: PASS.

- [ ] **Step 10: Commit**

```powershell
git add CHANGELOG.md plugins/codex-autoresearch/docs/finish.md plugins/codex-autoresearch/docs/operate.md plugins/codex-autoresearch/docs/trust.md plugins/codex-autoresearch/docs/start.md plugins/codex-autoresearch/docs/troubleshooting.md plugins/codex-autoresearch/skills/codex-autoresearch/SKILL.md plugins/codex-autoresearch/tests/full-product.test.ts plugins/codex-autoresearch/tests/perfection-benchmark.test.ts
git commit -m "docs: document product-grade autoresearch bar"
```

