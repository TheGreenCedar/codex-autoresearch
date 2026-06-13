# Requirements Document

> Status: historical implementation spec. The first implementation landed in commit `fa80d8d`; current behavior is defined by source code and `plugins/codex-autoresearch/docs/control-plane.md`.

## Introduction

This document defines the functional and non-functional requirements for the Codex Autoresearch session-control-plane remediation. The requirements are derived from session `019eb85a-e76a-7793-ab2a-26e9ff093659`, current Autoresearch architecture, and the failure report that identified drift between useful evidence generation and real control-plane ownership.

## Glossary

- **GoalContractBridge**: The component responsible for making Codex goal, Autoresearch goal, benchmark goal, and finalization claim visible as one contract.
- **SessionForensicsIngestor**: The component responsible for importing raw session JSONL into bounded signals and decision capsules.
- **ApprovalLedger**: The component responsible for durable, scoped approval state.
- **ResourceProcessGovernor**: The component responsible for packet, lane, process, output, and stale-process budgets.
- **LaneOrchestrationController**: The component responsible for bounded multi-lane research and implementation coordination.
- **EvidenceMaturityGate**: The component responsible for evidence maturity, benchmark-overfit, claim-coverage, and promotion blocking.
- **FinalizationRunway**: The component responsible for resumable finalization from preview through cleanup.
- **OperatorReadoutSurface**: The component responsible for consistent CLI, terminal, and dashboard readouts.
- **RegressionGateSuite**: The component responsible for tests, fixtures, validation scripts, and package gates.
- **Control plane**: The combined state and decision contract that determines whether Autoresearch may run, log, fan out, finalize, or stop.

## Requirements

### Requirement 1: Goal Contract Ownership

**Description**: Autoresearch must make the active user goal and durable research goal visible, comparable, and finalization-blocking when they diverge.

#### Acceptance Criteria

1. WHEN state is built with a Codex goal objective, THE **GoalContractBridge** SHALL persist `codexGoalObjective`, `authoritativeGoal`, `benchmarkGoal`, `finalizationClaim`, `codexObjectiveRole`, and `mismatch` in the decision envelope.
2. WHEN the Codex goal is missing but the surrounding session contains a goal objective, THE **GoalContractBridge** SHALL surface `codexObjectiveRole: "missing"` as a warning with an explicit recovery command.
3. WHEN the Codex goal differs materially from the Autoresearch goal, THE **EvidenceMaturityGate** SHALL block broad packet execution and finalization until the operator reconciles the goal contract.

### Requirement 2: Real-Session Forensics Regression

**Description**: The 019eb85a failure must become a durable regression input, not only a retrospective report.

#### Acceptance Criteria

1. WHEN `session-forensics` runs against the 019eb85a-derived fixture, THE **SessionForensicsIngestor** SHALL detect early false-done correction, goal-frame mismatch, approval stall, resource interruption, benchmark-overfit risk, finalization-local-only state, and cleanup-afterthought signals.
2. WHEN compact forensics output is requested, THE **OperatorReadoutSurface** SHALL hide raw arrays while preserving counts, top command heads, blockers, and canonical next action.
3. WHEN full forensics output is requested, THE **SessionForensicsIngestor** SHALL redact secret-like command text before returning or persisting command classes.

### Requirement 3: Approval Ledger Semantics

**Description**: Approval must be durable, scoped, and consumed by gates without making the user restate an already-granted approval.

#### Acceptance Criteria

1. WHEN a user approval is recorded, THE **ApprovalLedger** SHALL store timestamp, source, normalized scope, expiry policy, consuming gate, and evidence pointer.
2. WHEN a lane, packet, or finalization gate requires approval, THE **ApprovalLedger** SHALL resolve whether an unexpired approval covers that exact gate before blocking.
3. WHEN approval is missing or expired, THE **OperatorReadoutSurface** SHALL state the missing scope and the exact command or user action required to clear it.

### Requirement 4: Resource And Process Governance

**Description**: Autoresearch must prevent runaway local sessions from consuming the workstation or growing transcripts without bound.

#### Acceptance Criteria

1. WHEN a packet or lane command is about to start, THE **ResourceProcessGovernor** SHALL enforce configured process count, wall-clock, output, polling, and command-repeat budgets.
2. WHEN stale process-manager records or reboot residue are detected, THE **ResourceProcessGovernor** SHALL classify them as stale, live, unknown, or cleanup-needed before more packet work starts.
3. WHEN output exceeds configured budget, THE **OperatorReadoutSurface** SHALL recommend bounded artifact summaries or compact forensics instead of rerunning the noisy command.

### Requirement 5: Lane Orchestration As Accountable Work

**Description**: Broad user requests must route through bounded lanes instead of one giant serial loop or harness-only parallelism.

#### Acceptance Criteria

1. WHEN the session-control plane sees a broad, multi-failure remediation request, THE **LaneOrchestrationController** SHALL propose scout, implementation, review, and finalization lanes with owner, scope, budget, and merge criteria.
2. WHEN an implementation lane is planned, THE **LaneOrchestrationController** SHALL require a separate worktree or explicit write scope before edits can run.
3. WHEN lane results are recorded, THE **LaneOrchestrationController** SHALL synthesize one parent-loop recommendation and one measured-packet or finalization action.

### Requirement 6: Evidence Maturity And Anti-Overfit Gates

**Description**: Autoresearch must separate diagnostic benchmark repairs from product proof before allowing finalization.

#### Acceptance Criteria

1. WHEN evidence comes from row-specific detectors, protected probes, static citations, benchmark manifest edits, or answer-key-like steering, THE **EvidenceMaturityGate** SHALL mark it diagnostic or provisional.
2. WHEN a broad product superiority claim is present, THE **EvidenceMaturityGate** SHALL require holdout, repeat, breadth, or promotion-grade proof before finalization can be ready.
3. WHEN evidence maturity is below the finalization claim, THE **OperatorReadoutSurface** SHALL show the weaker claim that is currently supportable.

### Requirement 7: Resumable Finalization Runway

**Description**: Finalization must behave like an idempotent state machine instead of a one-shot script that fails on stale branches.

#### Acceptance Criteria

1. WHEN a finalization branch already exists, THE **FinalizationRunway** SHALL classify it as equivalent, stale, divergent, checked-out, or unsafe instead of throwing only `Branch already exists`.
2. WHEN finalization has created a local commit but no push or PR exists, THE **FinalizationRunway** SHALL report local-only completion and the next publish command.
3. WHEN PR, CI, merge, or cleanup state can be inspected, THE **FinalizationRunway** SHALL expose those states separately and SHALL NOT collapse them into `finalized`.

### Requirement 8: Unified Operator Readout

**Description**: The operator must see one canonical next action across CLI, terminal report, and dashboard.

#### Acceptance Criteria

1. WHEN `state --compact`, `recommend-next --compact`, terminal report, and dashboard view model are generated from the same session, THE **OperatorReadoutSurface** SHALL render the same blocker priority and canonical next action.
2. WHEN the dashboard is used, THE **OperatorReadoutSurface** SHALL remain read-only and SHALL NOT expose mutation controls for setup, packet execution, logging, or finalization.
3. WHEN source checkout and installed runtime differ, THE **OperatorReadoutSurface** SHALL show runtime provenance before treating source edits as live behavior.

### Requirement 9: Implementation Validation Gates

**Description**: The remediation must be validated with focused regressions and the package gate before it can be executed or shipped.

#### Acceptance Criteria

1. WHEN the implementation is complete, THE **RegressionGateSuite** SHALL run focused tests for goal contract, approval ledger, process governance, evidence maturity, lane orchestration, finalization runway, and readout agreement.
2. WHEN package behavior changes, THE **RegressionGateSuite** SHALL run `npm run check` from `plugins/codex-autoresearch`.
3. WHEN dashboard model or visual readout changes, THE **RegressionGateSuite** SHALL rebuild and inspect the dashboard surface or explicitly record why visual inspection was not possible.

### Requirement 10: Documentation And Skill Sync

**Description**: The durable operator guidance must match the new control-plane contract.

#### Acceptance Criteria

1. WHEN command behavior or safety rules change, THE **RegressionGateSuite** SHALL update the closest topic doc under `plugins/codex-autoresearch/docs/`.
2. WHEN Codex operator behavior changes, THE **RegressionGateSuite** SHALL update `plugins/codex-autoresearch/skills/codex-autoresearch/SKILL.md`.
3. WHEN user-facing behavior changes, THE **RegressionGateSuite** SHALL update `CHANGELOG.md` with migration notes and verification scope.

## Historical Phase Note

These 10 requirements and 30 acceptance criteria were assigned to specific components for the implementation pass. This file is archived evidence, not an active instruction to proceed to detailed design.
