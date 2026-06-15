# Loop Operations Reference

Load this when the happy path is blocked, stale, budgeted, or being resumed after compaction.

## Pre-first-packet checklist

Before the first expensive `next`, prove the loop shape cheaply:

- `recommend-next --compact --operator-checklist` names packet work as the next action.
- The benchmark command is the real goal benchmark, not a placeholder recipe.
- `benchmark-lint` proves the primary `METRIC` line can be parsed inside its timeout.
- Imported `sessionDecisionCapsule` state is clear, acknowledged, or deliberately being handled.
- The first packet is bounded by timeout, sample, task slice, or command file.
- Unrelated dirty files are not part of keep/discard cleanup.

If `recommend-next` returns a `decision-capsule` action, do that action first. Hard capsules refuse generic `next`; bounded-next capsules require an explicit bounded command.

## Packet brake

Before running `next` or any heavy benchmark, answer:

- What is the authoritative next action from `recommend-next --compact` or the operator checklist?
- Is the benchmark the real goal benchmark, and did `benchmark-lint` prove the primary `METRIC` line?
- Is this command bounded by timeout, narrowed scope, command file, query/task slice, or read-only scout lane?
- Are protected benchmark paths and secondary metric constraints clean before treating a keep as promotable?
- Did the last failed or timed-out packet leave partial results that should be inspected first?
- Is the key lesson from the previous segment written into ASI, `autoresearch.ideas.md`, or a decision capsule?

If any answer is missing, do the cheap read-only action first: inspect state, run `benchmark-inspect` or `benchmark-lint`, inspect partial results, import bounded session forensics, or run `research-fanout --dry-run`.

Compact-state field names: `docs/concepts.md#state-fields`.

## Budget operations

Setup and config can record `packetBudget`, `wallClockBudgetSeconds`, and `budgetNote`.

- `config --packet-budget <n>` updates the packet budget.
- `config --wall-clock-budget-seconds <n>` resets the wall-clock window from the time of config.
- `config --packet-budget "" --wall-clock-budget-seconds "" --budget-note ""` clears those budget fields in the CLI.
- Packet and wall-clock budgets are not API spend tracking. Treat them as stop/rescope signals.

## Logging discipline

Use `log --from-last`; do not retype metrics when a packet exists. Include ASI every time: hypothesis, evidence, rollback reason for rejected paths, next action hint, and optional lane/family/risk metadata.

For shells where inline JSON is fragile, use `--asi-json-file` and `--metrics-file`.

## Git safety

Repair stale `commitPaths` before relying on keep commits. Use scoped `commitPaths` or `revertPaths` for discard/crash/checks-failed cleanup. Use `--allow-add-all` or broad dirty cleanup only when every dirty file is intentionally in scope.
