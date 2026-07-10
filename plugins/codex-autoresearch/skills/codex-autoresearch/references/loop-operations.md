# Loop operations

Load this reference before a stale, blocked, budgeted, expensive, or resumed session.

## Before another packet

Confirm that:

- `recommend-next --compact --operator-checklist` allows packet work;
- the benchmark is the real goal benchmark, not a placeholder;
- `benchmark-lint` parses the configured primary metric;
- protected paths and blocking secondary constraints are clean;
- unrelated dirty files sit outside keep and discard scope;
- the workload has a timeout, task slice, command file, or other hard bound; and
- a failed packet has no useful `partial-results --cwd <project> --from-last` left to inspect.

If a decision capsule blocks work, follow its bounded next action instead of spending another packet.
Prefer a smaller workload or task slice over increasing a timeout just to make a run finish.

## Recover the failed layer

| Problem | First useful command |
| --- | --- |
| Timed-out packet with artifacts | `partial-results --cwd <project> --from-last` |
| Correctness checks failed | `checks-inspect --cwd <project> --command "<checks>"` |
| Duplicate runs, stale segments, or hand-edited ledger | `ledger-doctor --cwd <project> --json` |
| Benchmark meaning, metric, direction, or phase changed | `new-segment --cwd <project> --dry-run` |
| An older Codex task contains a useful bounded decision | `session-forensics --cwd <project> --session-jsonl <path> --research-slug <slug> --dry-run` |

Run `ledger-doctor --repair --yes` only after reading the JSON health summary. Confirm the returned `backupPath` before continuing.

If `partial-results --cwd <project> --from-last` returns no usable candidate, follow its reported next action. Do not invent a metric or record a keep to clear the way.

## Write the experiment note

For shells where inline JSON is brittle, write the note to a file and pass `--asi-json-file <path>`:

```json
{
  "hypothesis": "What this change was expected to improve",
  "evidence": "What the metric, checks, and diff showed",
  "rollback_reason": "Why rejected work should stay rejected",
  "next_action_hint": "The next useful experiment or stop condition"
}
```

Omit `rollback_reason` when there is nothing to roll back. Keep the note factual; it becomes memory for the next session.

## Keep budgets and Git scope explicit

- Set the packet limit with `config --packet-budget <n>`.
- Start a new wall-clock window with `config --wall-clock-budget-seconds <n>`.
- Treat those as experiment limits, not API-spend meters.
- Use `commitPaths` or `--commit-paths` for kept commits.
- When accepted work was committed outside Autoresearch, verify the hash and log the keep with `--commit <hash>`.
- Use explicit `--revert-paths` for cleanup after `discard`, `crash`, or `checks_failed`; otherwise configured commit paths may define the cleanup scope.
- Use `--allow-add-all` only when every dirty source file belongs to the packet.

When the limit is reached, stop, rescope, start a new segment, or finalize useful work. Do not reinterpret exhaustion as success.
