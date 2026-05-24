# Codex Goal Bridge Tasks

## Implemented Slice

- [x] Add `goal` to `StateConfig` and `currentState()` carry-forward behavior.
- [x] Let `init --goal` persist the goal in JSONL config.
- [x] Preserve deep-research goals through `research-setup`.
- [x] Add `codex-goal-brief` CLI command.
- [x] Add `codex_goal_bridge` tool schema, registry entry, and tool contract.
- [x] Add `goalAdvice` to the decision envelope and compact state.
- [x] Update skill, hooks docs, architecture docs, README, and changelog.
- [x] Add full-product regression coverage.

## Follow-Up Candidates

- [ ] Add a small dashboard chip for `goalAdvice` if the readout starts hiding it too deeply.
- [ ] Add a targeted `dashboard-verification` test if visible UI changes land.
- [ ] Add app-server integration only if Codex exposes a stable plugin-safe API for thread goals.

## Traceability

| Requirement | Implementation |
|---|---|
| R1 Durable goal | `session-core.ts`, `scripts/autoresearch.ts` |
| R2 Goal bridge readout | `scripts/autoresearch.ts`, `cli-handlers.ts`, `tool-schemas.ts` |
| R3 Completion safety | `codexGoalCompletionAudit()` |
| R4 Decision envelope | `buildDecisionEnvelope()` / `goalAdvice` |
| R5 Guidance | `SKILL.md`, `docs/hooks.md`, README |
