# Control Plane Contracts

Autoresearch should not rely on chat memory to decide whether another packet, branch, or final answer is safe. The shared control plane is the compact set of checks that `state`, `recommend-next`, terminal reports, and dashboard inputs must carry together.

## What must agree

`state --compact`, `state --report`, `recommend-next --compact`, and the dashboard decision envelope should agree on canonical next action, blockers, and trust gates. If they disagree, treat it as a product bug — do not pick the most convenient surface.

Field glossary: [state-fields](concepts.md#state-fields).

| Contract area | What it governs |
| --- | --- |
| Goal contract | Durable goal vs live prompt; benchmark and finalization claim alignment |
| Approval ledger | Scoped human approvals with gate, scope, expiry, evidence |
| Resource preflight | Active-process, wall-clock, output-size, stale-process limits |
| Evidence maturity | Whether accepted evidence supports a broad claim or only diagnostic wording |
| Lane orchestration | Scout, implementation, review, and finalization lanes for broad failures |
| Finalization runway | Review-branch publication stage through merge and cleanup |
| Operator readout | Canonical next action, blocker, warnings, dashboard boundary |

## Goal contract

The durable Autoresearch goal is authoritative. A live Codex prompt is an instruction unless it matches that goal. A missing live objective warns and provides a `codex-goal-brief` recovery path; a mismatched objective blocks broad packet work and finalization.

Benchmark and finalization claims are compared against the durable goal. If they drift, repair the contract, start a new segment, or restate the claim before spending packets.

## Approval ledger

Human approvals are durable ledger entries. Records include gate, scope, source, timestamp, expiry, and evidence. Resolution is exact by gate and scope — an expired approval or approval for a different lane does not satisfy the current gate.

Big-idea lanes can record a bounded recommendation, but implementation or measured packet work needs scoped approval first.

## Resource governor

Before packet or lane work, check resource budgets. The governor should stop or warn on:

- too many active processes
- wall-clock budget exhaustion
- repeated command heads as resource warnings
- oversized command output
- excessive shell polling
- stale process-manager or reboot residue

Hard blockers: active-process over-budget, wall-clock over-budget, typed stale process residue.

When output is already large, prefer bounded file reads, compact forensics, evidence indexes, or `partial-results` instead of repeating raw command output.

## Evidence maturity

Benchmark-shaped wins are not automatically product wins. Row-specific detectors, protected probes, static citations, and manifest-tuned fixes can be useful diagnostics, but broad superiority requires holdout, repeat, breadth, and promotion proof.

When proof is incomplete, present the weaker supportable claim instead of letting finalization imply a stronger one.

## Recovery lanes

Broad failures split work into accountable lanes:

- scout: map failure modes without editing source
- implementation: change one bounded contract with a worktree or write scope
- review: check regressions, missing tests, and overclaim risk
- finalization: separate local commit, push/PR, CI, merge, and cleanup

The parent recommendation synthesizes lane evidence only after each lane reports its scope and merge criteria.

## Finalization runway

Finalization is not a single state. Keep these stages separate:

- preview
- branch creation
- local-only branch
- pushed branch or PR
- CI
- merge
- merge verification
- cleanup

An existing review branch should be classified as equivalent, stale, divergent, checked-out, unverified, or unsafe before reuse. `equivalent` is reserved for branches verified against the finalization plan. A local branch with no push or PR evidence is local-only, not final.

---

Previous: [Architecture](architecture.md) · Next: [Trust](trust.md).
