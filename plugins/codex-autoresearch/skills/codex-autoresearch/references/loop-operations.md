# Loop operations

Load this reference before a stale, blocked, budgeted, expensive, or resumed session.

## Before another packet

Confirm that:

- `state --report` gives `run-packet` capability and names the accepted contract;
- the benchmark is the real goal benchmark, not a placeholder;
- `benchmark-lint` parses the configured primary metric;
- evaluator, checks, parser, protected inputs, and accepted execution digests are current;
- unrelated dirty files sit outside keep and discard scope;
- the workload has a timeout, task slice, command file, or other hard bound; and
- a failed packet has no useful `partial-results --cwd <project> --from-last` left to inspect.

If the `DecisionPlan` blocks `run-packet`, follow its bounded action instead of spending another packet.
Prefer a smaller workload or task slice over increasing a timeout just to make a run finish.

Do not run a third equivalent attempt after two no-learning packets or two same-layer failures unless the registered relevant precondition digest changed. A pause hands control back to direct work; it does not start fanout or a new segment.

## Recover the failed layer

| Problem | First useful command |
| --- | --- |
| Timed-out packet with artifacts | `partial-results --cwd <project> --from-last` |
| Correctness checks failed | `checks-inspect --cwd <project> --command "<checks>"` |
| Duplicate runs, stale segments, or hand-edited ledger | `ledger-doctor --cwd <project> --json` |
| Accepted contract meaning or execution identity changed | `new-segment --cwd <project> --dry-run` |
| Interrupted `log` transaction | Rerun the exact same `log` arguments |
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

Learning defaults to `none`. Use `causal` or `discriminating` only with evidence and a concrete changed belief. Optimistic prose is not learning evidence.

## Keep budgets and Git scope explicit

- Set the packet limit with `config --packet-budget <n>`.
- Start a new wall-clock window with `config --wall-clock-budget-seconds <n>`.
- Treat packet count, evaluator invocations, and plugin wall-clock time as enforced experiment limits. Model token and call limits are authoritative only with trusted host telemetry; estimates stay advisory.
- Use `commitPaths` or `--commit-paths` for kept commits.
- When accepted work was committed outside Autoresearch, verify the hash and log the keep with `--commit <hash>`.
- Use explicit `--revert-paths` for cleanup after `discard`, `crash`, or `checks_failed`; otherwise configured commit paths may define the cleanup scope.
- Use `--allow-add-all` only when every dirty source file belongs to the packet.

When the limit is reached, stop, rescope, start a new segment, or finalize useful work. Do not reinterpret exhaustion as success.

## Resume a pending log transaction

The transaction receipt records completed stages. Retry with the exact same input so the command can verify an existing commit or ledger event and finish the remaining cleanup. Different arguments must fail while the receipt is pending.

Do not delete the receipt or manually append the ledger. Keep and non-keep transactions have different safe stage orderings, and tracked and untracked cleanup resume independently. Session-dependent final claims remain blocked until the transaction reaches `done`.
