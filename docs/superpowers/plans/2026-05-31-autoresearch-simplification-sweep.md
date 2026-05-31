# Autoresearch Simplification Sweep Implementation Plan

## Goal

Apply the approved simplification audit for `plugins/codex-autoresearch` while preserving CLI,
dashboard, evidence, and finalization behavior.

## Branch

`codex/autoresearch-simplification-sweep`

## Architecture

Strengthen narrow verification first, then land low-risk local extractions, then handle
policy-sensitive refactors one subsystem at a time. Keep public behavior stable; only intentional
interface additions are internal helpers and package test scripts.

## Commit Plan

1. `test: add narrow autoresearch verification helpers`
2. `refactor: simplify tool schema lookups`
3. `refactor: simplify CLI command projection`
4. `refactor: extract runner and setup helpers`
5. `fix: clarify finalization artifact and progress metadata`
6. `refactor: centralize evidence status predicates`
7. `refactor: make next-action policy explicit`
8. `refactor: simplify dashboard interaction surfaces`
9. `docs: record autoresearch simplification sweep`

## Tasks

- [ ] Add narrow package scripts and shared bounded check runner.
- [ ] Replace duplicated check/test command runners where appropriate.
- [ ] Add finalizer temp repo cleanup with `try/finally`.
- [ ] Move tool contract output schemas to a module constant.
- [ ] Add schema lookup and alias helpers in tool schemas without changing normalized keys.
- [ ] Add setup argument projection helpers for setup-plan, guide, and prompt-plan.
- [ ] Add inspect response base helpers while preserving command-specific fields.
- [ ] Extract runner shell result assembly.
- [ ] Extract shared setup response/runtime config helpers.
- [ ] Add mode-aware session artifact classification.
- [ ] Clarify finalization progress metadata for current-tree finalization.
- [ ] Centralize evidence status predicates and use accepted-current semantics where intended.
- [ ] Refactor canonical next-action policy into ordered rule helpers with stable behavior.
- [ ] Simplify dashboard entrypoint, header toggle, trend interaction helpers, live hook, and status CSS.
- [ ] Update the root changelog and run final gates.

## Verification

Run narrow checks while iterating:

```bash
npm run typecheck:node
npm run typecheck:dashboard
npm run test:cli
npm run test:dashboard
npm run test:finalize
npm run test:core
```

Final gate from `plugins/codex-autoresearch`:

```bash
npm run format:check
npm run check
npm test
git diff --check
```

Dashboard smoke after dashboard refactors:

- chart visible
- point modal opens/closes
- focus returns after modal close
- theme toggle label/icon remain correct
- segment keyboard navigation works
- live refresh success and failure states still display correctly

## Assumptions

- All audit candidates, including policy-sensitive ones, are approved for implementation.
- No intentional CLI JSON, dashboard view-model, or finalizer plan schema changes except corrected
  progress stage labels.
- Existing untracked `.codex/` remains untouched.
