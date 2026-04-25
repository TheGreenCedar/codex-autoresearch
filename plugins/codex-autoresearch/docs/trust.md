# Trust

Autoresearch is only valuable when evidence stays honest. Otherwise it is just a very elaborate way to lie to yourself with better formatting.

## Metric Integrity

Benchmarks must print:

```text
METRIC name=value
```

Use `benchmark-lint` before setup or when output is uncertain:

```bash
node scripts/autoresearch.mjs benchmark-lint --cwd <project> --sample "METRIC seconds=1.23" --metric-name seconds
```

Missing, null, crashed, clipped, or ineligible metrics are unknown. Do not report them as `0`, `0%`, baseline, best, latest plotted evidence, or a win.

`crash` and `checks_failed` can be logged without inventing sentinel metrics. A normal `keep` or `discard` needs a finite primary metric.

## Stale Packets

Log from `--from-last` only while the packet is fresh against:

- ledger segment and run count
- config and metric
- command and checks policy
- working directory
- Git/file fingerprint

If anything changed, rerun `next` before logging.

When a `keep` has no source changes, record it as no-change evidence. Do not borrow an old `HEAD` and dress it up as a new result.

## Benchmark Drift

`doctor --check-benchmark` compares the current command output against the configured primary metric and can warn when current output is far worse than the historical best.

When that happens, treat the old best as historical evidence. Do not claim it is current runtime proof until a fresh packet confirms it.

## Git Safety

- Check Git before setup, logging, discard cleanup, or finalization.
- Configure `commitPaths` for kept results in Git repos.
- Use scoped `revertPaths` for discarded paths.
- Use `--commit <hash>` when work was already committed outside the helper.
- Use `--allow-add-all` only when every dirty file belongs to the experiment.

`doctor` and `state --compact` warn when the worktree is dirty or configured commit paths are missing.

## Live Versus Static

Live:

```bash
node scripts/autoresearch.mjs serve --cwd <project>
```

Static:

```bash
node scripts/autoresearch.mjs export --cwd <project>
```

Static exports are review snapshots. They are not proof of current packet freshness and should not expose live mutation controls.

## MCP Command Gate

Over MCP, command-bearing fields require `allow_unsafe_command: true`:

- `command`
- `benchmark_command`
- `checks_command`
- `model_command`
- setup guidance materialized from external recipe catalogs

Prefer project-local `autoresearch.sh` or `autoresearch.ps1` scripts when possible.

## Corrupt Or Partial State

If `autoresearch.jsonl` is corrupt, surface the failing file and line. Do not silently continue from a partial ledger.

If dashboard trust warnings mention stale packets, dirty Git, drift, missing metrics, corrupt state, or static mode, resolve those warnings before claiming a result is final.

---

Previous: [Operate](operate.md) · Next: [Finish](finish.md) — finalization preview, review branches, and merge.
