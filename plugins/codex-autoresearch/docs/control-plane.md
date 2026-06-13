# Control Plane Contracts

Autoresearch should not rely on chat memory to decide whether another packet, branch, or final answer is safe. The shared control plane is the compact set of checks that `state`, `recommend-next`, terminal reports, and dashboard inputs must carry together.

## What Must Agree

`state --compact`, `state --report`, `recommend-next --compact`, and the dashboard decision envelope should agree on:

- `goalContract`: durable Autoresearch goal, live Codex objective role, benchmark goal, finalization claim, mismatch status, and recovery command.
- `approvalLedger`: scoped human approvals with gate, scope, source, timestamp, expiry, and evidence.
- `resourcePreflight`: active-process, wall-clock, output, polling, repeated-command, and stale process-manager checks.
- `evidenceMaturity`: whether accepted evidence supports a broad claim or only diagnostic/provisional wording.
- `laneOrchestration`: scout, implementation, review, and finalization lanes for broad failure recovery.
- `finalizationRunway`: review-branch publication state, including local-only, stale, divergent, checked-out, PR, CI, merge, and cleanup stages.
- `operatorReadout`: the canonical next action, blocker, warnings, runtime provenance, and read-only dashboard boundary.

If these disagree, treat it as a product bug. Do not choose the most convenient surface.

## Goal Contract

The durable Autoresearch goal is authoritative. A live Codex prompt is an operator instruction unless it matches that goal. A missing live Codex objective warns and provides a `codex-goal-brief` recovery path; a mismatched objective blocks broad packet work and finalization.

Benchmark and finalization claims are also compared against the durable goal. If the benchmark goal or finalization claim drifts, the loop should repair the contract, start a new segment, or restate the claim before spending packets.

## Approval Ledger

Human approvals are durable ledger entries, not vibes. Approval records include:

- gate
- scope
- source
- timestamp
- expiry
- evidence

Resolution is exact by gate and scope. An expired approval or approval for a different lane does not satisfy the current gate. Big-idea lanes can record a bounded recommendation, but implementation or measured packet work needs scoped approval first.

Big-idea approval gates are durable: an unapproved recorded lane result blocks implementation and measured packets until a matching `approval` ledger record exists.

## Resource Governor

Before packet or lane work, check resource budgets. The governor should stop or warn on:

- too many active processes
- wall-clock budget exhaustion
- repeated benchmark commands as resource warnings, not packet blockers
- oversized command output
- excessive shell polling
- stale process-manager or reboot residue

Hard resource blockers are active-process over-budget, wall-clock over-budget, and typed stale process residue.

When output is already large, prefer bounded file reads, compact forensics, evidence indexes, or `partial-results` instead of repeating raw command output.

## Evidence Maturity

Benchmark-shaped wins are not automatically product wins. Row-specific detectors, protected probes, static citations, answer-key steering, and manifest-tuned fixes can be useful diagnostics, but broad superiority requires holdout, repeat, breadth, and promotion proof.

When proof is incomplete, the readout should present the weaker supportable claim instead of letting finalization imply a stronger one.

## Recovery Lanes

Broad failures should split work into accountable lanes:

- scout: map failure modes without editing source
- implementation: change one bounded contract with a worktree or write scope
- review: independently check regressions, missing tests, and overclaim risk
- finalization: separate local commit, push or PR, CI, merge, and cleanup

The parent recommendation should synthesize lane evidence only after each lane reports its scope and merge criteria.

## Finalization Runway

Finalization is not a single state. Keep these stages separate:

- preview
- branch creation
- local-only branch
- pushed branch or PR
- CI
- merge
- merge verification
- cleanup

An existing review branch should be classified as equivalent, stale, divergent, checked-out, unverified, or unsafe before reuse. `equivalent` is reserved for review branches whose content has been verified against the finalization plan. Existing branches without content verification are reported as unverified/unsafe and should be recreated or verified before PR/merge claims. A local branch with no push or PR evidence is local-only, not final.

---

Previous: [Operate](operate.md) · Next: [Trust](trust.md)
