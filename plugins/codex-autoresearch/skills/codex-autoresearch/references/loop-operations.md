# Loop Operations Reference

Load this only when the happy path is blocked, stale, budgeted, or being resumed after compaction.

## Packet Brake

Before running `next` or any heavy benchmark, answer:

- What is the authoritative next action from `recommend-next --compact` or the operator checklist?
- Is the benchmark the real goal benchmark, and did `benchmark-lint` prove the primary `METRIC` line?
- Is this command bounded by timeout, narrowed scope, command file, query/task slice, or read-only scout lane?
- Are protected benchmark paths and secondary metric constraints clean before treating a keep as promotable?
- Did the last failed or timed-out packet leave partial results that should be inspected first?
- Is the key lesson from the previous segment written into ASI, `autoresearch.ideas.md`, or a decision capsule?

If any answer is missing, do the cheap read-only action first: inspect state, run `benchmark-inspect` or `benchmark-lint`, inspect partial results, import bounded session forensics, or run `research-fanout --dry-run`.

## Budget Operations

Setup and config can record `packetBudget`, `wallClockBudgetSeconds`, and `budgetNote`.

- `config --packet-budget <n>` updates the packet budget.
- `config --wall-clock-budget-seconds <n>` resets the wall-clock window from the time of config.
- `config --packet-budget "" --wall-clock-budget-seconds "" --budget-note ""` clears those budget fields.
- Packet and wall-clock budgets are not API spend tracking. Treat them as stop/rescope signals.

## Logging Discipline

Use `log --from-last`; do not retype metrics when a packet exists. Include ASI every time: hypothesis, evidence, rollback reason for rejected paths, next action hint, and optional lane/family/risk metadata.

For shells where inline JSON is fragile, use `--asi-json-file` and `--metrics-file`.

## Git Safety

Repair stale `commitPaths` before relying on keep commits. Use scoped `commitPaths` or `revertPaths` for discard/crash/checks-failed cleanup. Use `--allow-add-all` or broad dirty cleanup only when every dirty file is intentionally in scope.
