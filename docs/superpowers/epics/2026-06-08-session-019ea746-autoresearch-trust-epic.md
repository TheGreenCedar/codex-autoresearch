# Session 019ea746 Autoresearch Trust Epic

## Objective

Turn the session 019ea746 review into a swarm-ready delivery package that prevents Autoresearch from turning experimental progress into product-grade claims, while also reducing the session friction seen around benchmark-contract repair, dashboard handoff, compact readouts, finalization, documentation, and large-output exploration.

## Source Evidence

- Session: `C:\Users\alber\.codex\sessions\2026\06\08\rollout-2026-06-08T08-48-11-019ea746-9e7b-7b20-9bb4-5ccb767647b0.jsonl`
- Primary failure: a naive semantic document cap was treated as finalize/PR-ready even though accuracy, lazy retrieval behavior, ranking quality, and product shippability were not proven.
- Recovery evidence: PR #24 was closed as an experimental primitive, then the goal restarted with a stricter product bar: shippable lazy/selective semantic behavior, retrieval accuracy validation, sidecar safety, tests, docs, and PR only when product-grade.
- Review lenses: project manager, UX lead, AX lead, engineering lead, artistic whims, autistic whims, documentation technical writer, and performance.

## In Scope

- Product-grade claim coverage and finalization gates.
- Evidence maturity states that distinguish an experiment, a scaffold, a development keep, and a shippable product result.
- Performance-loop quality constraints for accuracy-sensitive work.
- Benchmark-contract drift repair after `new-segment`.
- Dashboard proof coverage, handoff lifecycle, and accessibility/cognitive-load fixes.
- Compact output and session-forensics friction detection.
- Docs and skill guidance that makes "experimental primitive" vs "product-grade deliverable" impossible to miss.

## Out Of Scope

- Implementing the CodeStory lazy semantic retrieval product itself.
- Running package gates from this planning turn.
- Changing marketplace packaging, releases, or installed plugin caches.
- Adding dashboard mutation controls.

## Components

| Component | Responsibility |
|---|---|
| Claim Coverage Core | Models product claims, required proof, evidence status, and maturity. |
| Finalization Guard | Blocks or downgrades finalize/PR readiness when claim coverage is incomplete. |
| Quality Contract Router | Adds correctness constraints to performance loops before optimization packets. |
| Segment Repair | Resets benchmark-contract trust after `new-segment` without manual ledger surgery. |
| Dashboard Proof UX | Shows claim coverage, recovery state, and live handoff status without adding controls. |
| Session Friction Analyzer | Flags false-done corrections, large outputs, closed stdin polls, foreground server churn, and non-compact compact output. |
| Docs And Skill Contract | Teaches agents the product-grade bar and story execution protocol. |

## Story Map

| Story | Plan | Parallelism | Primary Owner |
|---|---|---|---|
| AR-019EA746-01 Claim Coverage Core | `docs/superpowers/plans/2026-06-08-autoresearch-claim-coverage-core.md` | Wave 0 | Engineering lead |
| AR-019EA746-02 Product-Grade Finalization Guard | `docs/superpowers/plans/2026-06-08-autoresearch-product-grade-finalization-guard.md` | Wave 1 after Story 01 | Engineering lead |
| AR-019EA746-03 Performance Quality Contracts | `docs/superpowers/plans/2026-06-08-autoresearch-performance-quality-contracts.md` | Wave 1 | PM plus engineering |
| AR-019EA746-04 New-Segment Benchmark Repair | `docs/superpowers/plans/2026-06-08-autoresearch-new-segment-benchmark-repair.md` | Wave 1 | Engineering lead |
| AR-019EA746-05 Dashboard Proof And Handoff UX | `docs/superpowers/plans/2026-06-08-autoresearch-dashboard-proof-handoff.md` | Wave 2 after Story 01 | UX and AX |
| AR-019EA746-06 Forensics And Compact Friction | `docs/superpowers/plans/2026-06-08-autoresearch-forensics-compact-friction.md` | Wave 1 | Performance |
| AR-019EA746-07 Docs And Skill Ship Bar | `docs/superpowers/plans/2026-06-08-autoresearch-docs-skill-ship-bar.md` | Wave 2 | Documentation writer |
| AR-019EA746-08 Dashboard Serve Lifecycle | `docs/superpowers/plans/2026-06-08-autoresearch-dashboard-serve-lifecycle.md` | Wave 1 | Performance plus UX |
| AR-019EA746-09 CLI Startup And State Cache | `docs/superpowers/plans/2026-06-08-autoresearch-cli-startup-state-cache.md` | Wave 1 | Performance |

## Cross-Story Requirements

### Requirement 1: Product Claims Are Explicit

Acceptance criteria:

1.1. When a session or plan claims a product result, Autoresearch records the claim, proof requirement, proof status, and maturity level.

1.2. When proof is missing, CLI and dashboard readouts name the missing proof instead of implying readiness.

1.3. When evidence is accepted but not product-grade, finalization reports the gap as an experimental or development result.

### Requirement 2: Finalization Cannot Overclaim

Acceptance criteria:

2.1. Finalization preview refuses product-grade readiness when required claim coverage is missing.

2.2. Finalization output and PR handoff language cannot describe experimental work as shippable.

2.3. An explicit override, if added, uses experimental wording and cannot be mistaken for a ready-to-merge product PR.

### Requirement 3: Performance Loops Preserve Quality

Acceptance criteria:

3.1. Performance setup and prompt planning identify quality constraints when the domain is retrieval, ranking, accuracy, accessibility, safety, or data integrity.

3.2. `next` and `log` guidance distinguishes speed metrics from correctness constraints.

3.3. A performance improvement cannot be promoted when quality constraints are absent, stale, or failed.

### Requirement 4: Segment Repair Is Trustworthy

Acceptance criteria:

4.1. `new-segment` clears or rekeys benchmark-contract drift when the operator intentionally changes the benchmark surface.

4.2. The next packet after segment reset can run without manual metric logging solely to escape stale drift.

4.3. Segment metric semantics warn when old and new metrics are not comparable.

### Requirement 5: Dashboard Reduces Operator Friction

Acceptance criteria:

5.1. Dashboard readout shows claim coverage and finalization runway before chart-heavy detail when blockers exist.

5.2. Live dashboard header exposes URL, live/dead/stale status, process scope, and recovery command without mutation controls.

5.3. Keyboard and screen-reader users can navigate long trend charts, ledger rows, and decision actions without excessive tab stops or ambiguous labels.

### Requirement 6: Forensics Names Workflow Wounds

Acceptance criteria:

6.1. Session forensics detects false-done/product-bar rejection events from user corrections and assistant admissions.

6.2. Session forensics detects oversized tool outputs and recommends bounded mapping.

6.3. `state --compact` and `recommend-next --compact` are small enough for operator handoff.

### Requirement 7: Documentation Carries The Contract

Acceptance criteria:

7.1. `docs/finish.md`, `docs/operate.md`, `docs/trust.md`, and the main skill explain experimental vs product-grade evidence.

7.2. Docs name the finalization trunk/default-branch path, dashboard live/static lifecycle, and benchmark-contract recovery path.

7.3. Root `CHANGELOG.md` records any user-facing behavior, docs, skill, dashboard, or command-surface changes.

### Requirement 8: Live Dashboard Handoff Is Cheap

Acceptance criteria:

8.1. `serve` returns a reusable live URL, health URL, process id, registry reuse status, and recovery command.

8.2. Stale/dead dashboard reports recommend `serve --cwd <project>` rather than raw health probes.

8.3. Live refresh avoids avoidable full-tree or artifact fingerprint work on every request.

### Requirement 9: Common Read Commands Stay Small

Acceptance criteria:

9.1. `state --compact`, `recommend-next --compact`, and related read commands avoid repeated state parsing inside one invocation.

9.2. Common read commands keep startup imports light and defer expensive modules to uncommon command paths.

9.3. Local timing regressions catch obvious latency regressions without becoming the release gate.

## Swarm Execution Protocol

Each story is intended for a fresh worker in its own branch or worktree.

1. Read this epic and the story plan.
2. Announce: "I'm using the writing-plans skill to create/review the implementation plan."
3. If the story plan has a critical gap, patch the plan first and stop for review.
4. Announce: "I'm using the executing-plans skill to implement this plan."
5. Execute the story task-by-task.
6. Run only the targeted verifications named by the story plan unless the coordinator asks for the full package gate.
7. Update `CHANGELOG.md` only when the story changes user-facing behavior, docs, skill behavior, dashboard behavior, command output, or finalization semantics.
8. Stop immediately on unclear evidence semantics, finalizer safety ambiguity, or verification failure.

## Validation Matrix

| Requirement | Implementing Stories |
|---|---|
| 1.1 | Story 01 |
| 1.2 | Story 01, Story 05 |
| 1.3 | Story 01, Story 02, Story 07 |
| 2.1 | Story 02 |
| 2.2 | Story 02, Story 07 |
| 2.3 | Story 02 |
| 3.1 | Story 03 |
| 3.2 | Story 03, Story 06 |
| 3.3 | Story 02, Story 03 |
| 4.1 | Story 04 |
| 4.2 | Story 04 |
| 4.3 | Story 04, Story 07 |
| 5.1 | Story 05 |
| 5.2 | Story 05 |
| 5.3 | Story 05 |
| 6.1 | Story 06 |
| 6.2 | Story 06 |
| 6.3 | Story 06 |
| 7.1 | Story 07 |
| 7.2 | Story 07 |
| 7.3 | All stories that change user-facing behavior |
| 8.1 | Story 08 |
| 8.2 | Story 08 |
| 8.3 | Story 08, Story 09 |
| 9.1 | Story 09 |
| 9.2 | Story 09 |
| 9.3 | Story 09 |
