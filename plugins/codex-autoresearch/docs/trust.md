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

`benchmark-lint` reports two layers:

- **metric parsing**: whether `METRIC <primary>=<number>` was parsed
- **research integrity**: whether the evidence is promotable or merely local/dev evidence

Parsing a metric is not enough. Perfect score-like metrics, dev-only bests, missing holdout/repeat guards, stale cache artifacts, failed repeats, contamination notes, and cache replay warnings should block promotion until the benchmark is broadened or a fresh segment records stronger metadata.

## Scaffold Health

`state`, `doctor`, `guide`, and the dashboard expose `scaffoldHealth`.

Treat these as setup blockers:

- generated wrappers that call themselves
- wrappers with no real benchmark workload
- missing or stale `commitPaths` / `revertPaths`
- Git index locks, including lock age and retry guidance

Fix the broken layer before the first packet or before `log keep`. A missing path should fail during doctor/setup, not during `git add` after trust has already been granted.

## Stale Packets

Log from `--from-last` only while the packet is fresh against:

- ledger segment and run count
- config and metric
- command and checks policy
- working directory
- Git/file fingerprint

If anything changed, rerun `next` before logging.

When a `keep` has no source changes, record it as no-change evidence. Do not borrow an old `HEAD` and dress it up as a new result.

Fresh packets also carry a packet evidence bundle: packet id, command identity, timeout, exit status, bounded stdout/stderr tails, parsed metrics, artifacts, checks result, and a freshness fingerprint. Use that bundle to review what actually ran; do not infer promotion readiness from "a metric was parsed."

## Benchmark Drift

`doctor --check-benchmark` compares the current command output against the configured primary metric and can warn when current output is far worse than the historical best.

When that happens, treat the old best as historical evidence. Do not claim it is current runtime proof until a fresh packet confirms it.

## Promotion Evidence

State and dashboard readouts separate local development evidence from promotion-grade evidence.

Common labels:

- `exploratory`: valid local evidence that still needs repeat, breadth, holdout, or a promotion gate
- `dev_best`: interesting local best, not promotion evidence
- `pending_repeat`: first-pass win awaiting repeat
- `repeated`: repeat evidence exists but promotion may still need breadth or holdout context
- `holdout`: holdout evidence exists for the current gate
- `promotion_eligible`: run includes explicit promotion metadata
- `invalidated`: later ASI or status invalidated the evidence
- `historical`: useful context from an earlier segment
- `blocked`: evidence cannot support the next claim

If ASI says to stop, broaden validation, rerun on holdout, or invalidate a family, honor that over remaining iteration budget.

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

## Command Gate

Command-bearing setup and inspection paths require deliberate approval before materializing custom commands:

- `command`
- `benchmark_command`
- `checks_command`
- `model_command`
- setup guidance materialized from external recipe catalogs, admitted with `--trust-catalog`

Prefer project-local `autoresearch.sh` or `autoresearch.ps1` scripts when possible.

Trusted external recipes store catalog provenance in session config. `doctor` and `next` revalidate that provenance and block when the recipe or catalog has drifted, cannot be fetched, or no longer matches the trusted hash.

## Corrupt Or Partial State

If `autoresearch.jsonl` is corrupt, surface the failing file and line. Do not silently continue from a partial ledger.

If dashboard trust warnings mention stale packets, dirty Git, drift, missing metrics, corrupt state, or static mode, resolve those warnings before claiming a result is final.

---

Previous: [Operate](operate.md) · Next: [Finish](finish.md) — finalization preview, review branches, and merge.
