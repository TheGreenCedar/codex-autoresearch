# Control-plane contracts

The CLI, terminal report, compact state, and dashboard must tell the same story. If they disagree about the goal, blocker, or next action, the disagreement is the bug.

## Shared decisions

| Contract | Question |
| --- | --- |
| Goal | Does the current prompt still match the durable goal, benchmark, and final claim? |
| Approval | Is there a current approval for this gate and this exact scope? |
| Resources | Is another process, packet, or wall-clock slice allowed? |
| Evidence | What is the strongest claim accepted evidence can support? |
| Lanes | Which scout, implementation, review, or finalization lane owns the next work? |
| Finalization | Is the work previewed, local, pushed, in CI, merged, or safe to clean up? |
| Readout | What single action should the person or Codex take next? |

`state --compact`, `state --report`, `recommend-next --compact`, doctor, finalization preview, and the dashboard project the same validated `resolvedDecision` authority. The status, strongest blocker, next action, safe command, runtime provenance, and finalization pressure must agree. Field names are listed in [Concepts](concepts.md#state-fields).

Default projections are deliberately bounded so a long session remains readable: compact state is capped at 10 KiB and 200 lines, default state at 20 KiB and 260 lines, and doctor/report at 8 KiB and 100 lines. A synthetic 100-run regression fixture enforces those ceilings and requires compact state to remain smaller than default state. Use explicit `--json-full` only for complete state or doctor diagnostics.

## Goal contract

The durable Autoresearch goal is authoritative. A fresh chat prompt is an instruction unless it clearly matches or deliberately replaces that goal.

A missing live objective warns and offers `codex-goal-brief`. A mismatched objective blocks broad packet and finalization work until the goal is restated, repaired, or moved to a new segment.

## Approval contract

Approvals record gate, scope, source, time, expiry, and evidence. Approval for one lane or an expired approval cannot unlock another.

A `big_idea` lane may record advice without approval. Turning it into implementation or a measured packet requires a new scoped approval.

## Resource contract

Packet and lane work checks active process count, wall-clock budget, repeated command heads, output size, polling, and the latest typed process lifecycle state. Historical prose about stale or orphaned PIDs is compatibility context only; it cannot create a blocker. Malformed lifecycle rows and terminal rows with unproven termination fail closed.

When output is already large, use compact state, bounded file reads, `partial-results`, or an evidence index. Reprinting the same wall of output is not progress.

## Evidence contract

Benchmark-specific detectors, static citations, protected probes, and scorer-tuned fixes may support a narrow diagnostic claim. Broad superiority needs repeat, holdout, breadth, and the checks implied by the claim.

The control plane must choose the weaker supportable wording when proof is incomplete, even if branch creation is technically possible.

## Lane contract

Broad work may split into:

- **scout** - map the problem without source edits
- **implementation** - change one bounded surface in a worktree or write scope
- **review** - test regressions and overclaim risk
- **finalization** - package, publish, merge, and verify

The parent session combines lane evidence only after each lane reports its scope, evidence, recommendation, and merge criteria.

## Finalization contract

Keep these states separate: preview, branch created, local-only, pushed or PR, CI, merged, merge verified, cleanup-ready.

An existing branch is reusable only after it is checked against the current finalization plan. A branch name alone proves nothing.

## When surfaces disagree

1. Save the disagreeing outputs.
2. Stop packet and branch mutation.
3. Compare their source ledger, config, segment, runtime fingerprint, and generation time.
4. Fix the shared state or projection bug.
5. Rerun all affected readouts before continuing.
