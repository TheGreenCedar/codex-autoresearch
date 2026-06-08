# Autoresearch Dashboard Proof And Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard show proof coverage and live handoff status while improving keyboard and screen-reader ergonomics.

**Architecture:** Keep the dashboard read-only. Add a proof/readiness band from the view model, improve live URL status in the header, and reduce tab overload in long trend charts.

**Tech Stack:** TypeScript, React 19, Vite, Recharts, node:test.

---

## File Structure

- Modify: `plugins/codex-autoresearch/lib/dashboard-view-model.ts`
- Modify: `plugins/codex-autoresearch/dashboard/src/Dashboard.tsx`
- Modify: `plugins/codex-autoresearch/dashboard/src/components/SignalStrip.tsx`
- Modify: `plugins/codex-autoresearch/dashboard/src/components/Header.tsx`
- Modify: `plugins/codex-autoresearch/dashboard/src/components/DecisionRail.tsx`
- Modify: `plugins/codex-autoresearch/dashboard/src/components/Ledger.tsx`
- Modify: `plugins/codex-autoresearch/dashboard/src/components/trend/TrendChartFigure.tsx`
- Modify: `plugins/codex-autoresearch/dashboard/src/styles.css`
- Test: `plugins/codex-autoresearch/tests/dashboard-verification.test.ts`

---

### Task 1: Render Proof Coverage Before Chart Detail

- [ ] **Step 1: Write failing dashboard view-model test**

In `plugins/codex-autoresearch/tests/dashboard-verification.test.ts`, add a test fixture where `productClaimCoverage.productGradeReady === false`. Assert the built dashboard model includes:

```ts
assert.equal(model.productClaimCoverage.productGradeReady, false);
assert.match(JSON.stringify(model.signals), /Product proof missing|claim coverage/i);
```

- [ ] **Step 2: Run failing dashboard test**

Run:

```powershell
cd C:\Users\alber\source\repos\autoresearch\plugins\codex-autoresearch
npm run build:node
node --test --test-name-pattern "claim coverage|Product proof" dist/tests/dashboard-verification.test.mjs
```

Expected: FAIL because proof coverage is not modeled for dashboard signals.

- [ ] **Step 3: Add proof coverage signal**

In `plugins/codex-autoresearch/lib/dashboard-view-model.ts`, map `state.productClaimCoverage` into:

```ts
productClaimCoverage: {
  productGradeReady,
  maturity,
  missingRequiredProof,
  blockers,
}
```

Also add a top signal when blockers exist:

```text
Product proof missing
```

- [ ] **Step 4: Render signal before chart when blocked**

In `plugins/codex-autoresearch/dashboard/src/Dashboard.tsx`, render `SignalStrip` above the trend/chart area when claim blockers or finalization blockers exist.

- [ ] **Step 5: Improve live dashboard handoff receipt**

In `Header.tsx`, show live status, URL/port, stale/dead state, and copy status. Copying the URL must announce:

```text
Copied live dashboard URL; no session state changed.
```

- [ ] **Step 6: Clarify decision action labels**

In `DecisionRail.tsx`, change ambiguous stale labels:

- `Stale packet` -> `Replace stale packet`
- `Finalize` -> `Preview finalization`
- `Copy` -> `Copy read-only command`

- [ ] **Step 7: Reduce chart tab stops**

In `TrendChartFigure.tsx`, use roving tab index so only selected, latest, best, and failure points are tabbable. Arrow keys move the selected point and update the selected-run details.

- [ ] **Step 8: Improve ledger semantics**

In `Ledger.tsx`, use native table elements for ledger rows or add complete `rowgroup`, `rowindex`, and `colindex` attributes if the component must remain div-based.

- [ ] **Step 9: Run targeted verification**

Run:

```powershell
cd C:\Users\alber\source\repos\autoresearch\plugins\codex-autoresearch
npm run build:node
node --test dist/tests/dashboard-verification.test.mjs
npm run build:dashboard
```

Expected: PASS and dashboard assets rebuilt when the UI bundle changes.

- [ ] **Step 10: Commit**

```powershell
git add plugins/codex-autoresearch/lib/dashboard-view-model.ts plugins/codex-autoresearch/dashboard/src/Dashboard.tsx plugins/codex-autoresearch/dashboard/src/components/SignalStrip.tsx plugins/codex-autoresearch/dashboard/src/components/Header.tsx plugins/codex-autoresearch/dashboard/src/components/DecisionRail.tsx plugins/codex-autoresearch/dashboard/src/components/Ledger.tsx plugins/codex-autoresearch/dashboard/src/components/trend/TrendChartFigure.tsx plugins/codex-autoresearch/dashboard/src/styles.css plugins/codex-autoresearch/tests/dashboard-verification.test.ts plugins/codex-autoresearch/assets/dashboard-build
git commit -m "feat: surface dashboard proof coverage"
```

