# Implementation Plan

## Phase 1: Goal And Forensics Foundation

- [ ] 1. Implement the GoalContractBridge
  - [ ] 1.1 Extend `lib/goal-frame.ts` with `GoalContract` fields for benchmark goal and finalization claim.
  - [ ] 1.2 Thread `codexGoalObjective` and goal contract state through `lib/session-core.ts`, `lib/commands/state.ts`, and `lib/commands/recommend-next.ts`.
  - [ ] 1.3 Add loop-governance blockers for missing or mismatched active goals.
  - [ ] 1.4 Add focused tests for matching, missing, operator-instruction, and different-goal cases.
  - _Requirements: 1.1, 1.2, 1.3_

- [ ] 2. Implement the SessionForensicsIngestor regression fixture
  - [ ] 2.1 Create a minimized 019eb85a-derived JSONL fixture that preserves false-done, goal mismatch, approval stall, resource interruption, overfit, local-only finalization, and cleanup signals.
  - [ ] 2.2 Extend `lib/session-forensics.ts` detectors for the full failure set.
  - [ ] 2.3 Ensure compact output keeps counts, grouped signals, top command heads, and canonical next action while hiding raw arrays.
  - [ ] 2.4 Ensure full output redacts command classes before persistence or response.
  - _Requirements: 2.1, 2.2, 2.3_

## Phase 2: Approval And Resource Control

- [ ] 3. Implement the ApprovalLedger
  - [ ] 3.1 Add `lib/approval-ledger.ts` with approval record normalization, append, read, expiry, and scope matching.
  - [ ] 3.2 Integrate approval resolution into `lib/commands/lane-runner.ts` and loop-governance gate selection.
  - [ ] 3.3 Render missing approval scope and recovery action through terminal and compact readouts.
  - [ ] 3.4 Add tests for unexpired, expired, wrong-scope, and consumed approval records.
  - _Requirements: 3.1, 3.2, 3.3_

- [ ] 4. Implement the ResourceProcessGovernor
  - [ ] 4.1 Add `lib/process-governor.ts` with process count, timeout, output, poll, and repeated-command budget checks.
  - [ ] 4.2 Integrate resource preflight into packet and lane command start paths.
  - [ ] 4.3 Add stale process-manager reconciliation for live, stale, unknown, and cleanup-needed process records.
  - [ ] 4.4 Add workflow-friction/readout messages for noisy output and bounded artifact-summary recovery.
  - _Requirements: 4.1, 4.2, 4.3_

## Phase 3: Lanes And Evidence Maturity

- [ ] 5. Implement LaneOrchestrationController upgrades
  - [ ] 5.1 Add broad-failure lane planning for scout, implementation, review, and finalization lanes.
  - [ ] 5.2 Require explicit worktree or write scope for all implementation lanes before edits.
  - [ ] 5.3 Synthesize one parent-loop recommendation from accepted lane evidence.
  - [ ] 5.4 Add tests for broad request planning, isolation refusal, and parent recommendation synthesis.
  - _Requirements: 5.1, 5.2, 5.3_

- [ ] 6. Implement EvidenceMaturityGate upgrades
  - [ ] 6.1 Extend benchmark-overfit and claim-coverage classification into a shared evidence maturity decision.
  - [ ] 6.2 Mark row-specific steering, protected probes, static citations, manifest edits, and answer-key-like evidence as diagnostic or provisional.
  - [ ] 6.3 Require holdout, repeat, breadth, or promotion-grade proof before broad finalization claims become ready.
  - [ ] 6.4 Render the supportable weaker claim in compact state, terminal report, and dashboard.
  - _Requirements: 6.1, 6.2, 6.3_

## Phase 4: Finalization And Readout Unity

- [ ] 7. Implement the FinalizationRunway
  - [ ] 7.1 Add `lib/finalization-runway.ts` to inspect existing branch, worktree, local commit, pushed branch, PR, checks, merge, and cleanup state.
  - [ ] 7.2 Update `scripts/finalize-autoresearch.ts` to classify existing branches as equivalent, stale, divergent, checked-out, or unsafe before failing.
  - [ ] 7.3 Update finalization preview/readout to distinguish local-only completion from pushed/PR-visible completion.
  - [ ] 7.4 Add tests for stale branch, equivalent branch, local-only commit, missing PR, and merged PR states.
  - _Requirements: 7.1, 7.2, 7.3_

- [ ] 8. Implement OperatorReadoutSurface agreement
  - [ ] 8.1 Build a shared readout packet consumed by `state`, `recommend-next`, `terminal-report`, and `dashboard-view-model`.
  - [ ] 8.2 Assert the same blocker priority and canonical next action across compact CLI, terminal report, and dashboard model tests.
  - [ ] 8.3 Preserve dashboard read-only behavior and block visible mutation controls.
  - [ ] 8.4 Surface runtime provenance before claiming source changes are live behavior.
  - _Requirements: 8.1, 8.2, 8.3_

## Phase 5: Regression Gates And Documentation

- [ ] 9. Implement the RegressionGateSuite
  - [ ] 9.1 Add `tests/session-control-plane.test.ts` covering goal contract, approval ledger, process governance, evidence maturity, lane orchestration, finalization runway, and readout agreement.
  - [ ] 9.2 Add the focused tests to the package check path or ensure existing package checks execute them after build.
  - [ ] 9.3 Run `npm run check` from `plugins/codex-autoresearch` after implementation.
  - [ ] 9.4 Rebuild and inspect the dashboard if dashboard model or visual readout changes.
  - _Requirements: 9.1, 9.2, 9.3_

- [ ] 10. Update documentation and skill guidance
  - [ ] 10.1 Update the nearest topic docs under `plugins/codex-autoresearch/docs/` for goal contract, approvals, process budgets, evidence maturity, lanes, finalization runway, and readout agreement.
  - [ ] 10.2 Update `plugins/codex-autoresearch/skills/codex-autoresearch/SKILL.md` for Codex operator behavior.
  - [ ] 10.3 Update `CHANGELOG.md` with user-facing migration notes and verification scope.
  - [ ] 10.4 Run markdown inspection and `git diff --check`.
  - _Requirements: 10.1, 10.2, 10.3_

## Phase Gate

Implementation plan created with 10 tasks. Proceed to final validation.
