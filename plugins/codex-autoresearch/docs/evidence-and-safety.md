# Evidence And Safety

For the visual trust boundary, see [Architecture diagrams](architecture.md). For task-oriented evidence rules, see [Trust](trust.md).

Autoresearch is useful only when the loop preserves the truth of what was measured. Treat display surfaces as summaries and session files as the durable evidence.

## Metric Contract

Benchmarks must print the primary metric as:

```text
METRIC name=value
```

The configured primary metric drives decisions. Secondary metric lines can explain tradeoffs but should not silently replace the primary metric.

Do not parse decisions from dashboard snippets, output tails, summaries, or clipped logs. Use the packet data returned by `next_experiment` or `log --from-last`.

## Unknown Is Not Zero

Missing, null, crashed, or ineligible metrics are unknown. They must not be reported as:

- `0`
- `0%`
- a baseline
- a best run
- latest plotted evidence
- a win

`crash` and `checks_failed` can be logged without inventing sentinel metrics. A normal `keep` or `discard` needs a finite primary metric.

## Last-Run Freshness

A last-run packet is safe to log only while it is fresh against the session ledger, config, command, working directory, Git/file fingerprint, and packet command.

Rerun the packet before logging if any of these changed:

- `autoresearch.jsonl`
- session config or benchmark command
- active working directory
- Git state or relevant files
- checks policy or checks command

When a `keep` has no source changes, record it as no-change evidence. Do not borrow an old `HEAD` as if a new result was created.

## Live Versus Static Dashboard

Use the served dashboard for operations:

```bash
node scripts/autoresearch.mjs serve --cwd <project>
```

Live dashboard actions are local-only guarded adapters. They are bounded to safe operations such as doctor, setup plan, recipes, gap-candidates preview, finalize preview, export, and confirmed log decisions.

Static exports are read-only snapshots:

```bash
node scripts/autoresearch.mjs export --cwd <project>
```

Static exports contain embedded evidence for offline review. They should not expose live mutation controls, and they are not proof that a packet is still fresh.

## Git Safety

Before setup, logging, discard cleanup, or finalization, check Git status and separate user edits from experiment edits.

For kept results in Git repos, configure `commitPaths` or pass `--commit-paths` so commits stay scoped. Use `--commit <hash>` when the kept work was already committed outside the helper.

For failed or rejected paths, use scoped `revertPaths` or configured cleanup paths. Use `--allow-add-all` or broad dirty cleanup only when the user explicitly accepts that every dirty file is in scope.

Do not overwrite or revert unrelated user work.

## Unsafe Command Gate

Over MCP, command-bearing fields require `allow_unsafe_command: true`. This includes custom benchmark commands, checks commands, model commands, and setup guidance that materializes commands from an external recipe catalog.

Prefer configured `autoresearch.sh` or `autoresearch.ps1` scripts when possible. They are easier to inspect, rerun, and audit.

## Corrupt Or Partial State

If `autoresearch.jsonl` is corrupt, surface the failing file and line. Do not silently continue from a partial ledger.

If dashboard trust warnings mention stale packets, dirty Git, drift, missing metrics, corrupt state, or static mode, resolve those warnings before claiming a result is final.
