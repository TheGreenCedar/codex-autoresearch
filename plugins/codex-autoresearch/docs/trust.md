# Trust

Autoresearch is only valuable when evidence stays honest. Otherwise it is just a very elaborate way to lie to yourself with better formatting.

## Metric integrity

Benchmarks must print:

```text
METRIC name=value
```

Use `benchmark-lint` before setup or when output is uncertain:

```bash
node scripts/autoresearch.mjs benchmark-lint --cwd <project> --sample "METRIC seconds=1.23" --metric-name seconds
```

Missing, null, crashed, clipped, or ineligible metrics are unknown. Do not report them as `0`, `0%`, baseline, best, latest plotted evidence, or a win.

`crash` and `checks_failed` can be logged without inventing sentinel metrics. A normal `keep`, `discard`, or `measure` needs a finite primary metric.

Use `measure` for non-promotional evidence: baselines, no-change checks, environment probes, and diagnostics. It can inform latest/trend/baseline readouts, but it is never a keep and never a finalizer input.

`benchmark-lint` reports two layers:

- **metric parsing**: whether `METRIC <primary>=<number>` was parsed
- **research integrity**: whether the evidence is promotable or merely local/dev evidence

Parsing a metric is not enough. Perfect score-like metrics, dev-only bests, missing holdout/repeat guards, stale cache artifacts, failed repeats, and contamination notes should block promotion until the benchmark is broadened or a fresh segment records stronger metadata.

## Scaffold health

`state`, `doctor`, `guide`, and the dashboard expose `scaffoldHealth`.

Treat these as setup blockers:

- generated wrappers that call themselves
- wrappers with no real benchmark workload
- missing or stale `commitPaths` / `revertPaths`
- Git index locks, including lock age and retry guidance

Fix the broken layer before the first packet or before `log keep`.

## Stale packets

Log from `--from-last` only while the packet is fresh against ledger segment, config, metric, command policy, working directory, and Git/file fingerprint.

If anything changed, rerun `next` before logging. If the data came from a raw `run` probe, log explicitly with `--metric <value> --status measure`.

When a `keep` has no source changes, record it as no-change evidence. Do not borrow an old `HEAD` and dress it up as a new result.

Fresh packets carry a packet evidence bundle: packet id, command identity, timeout, exit status, bounded stdout/stderr tails, parsed metrics, artifacts, checks result, and freshness fingerprint.

## Benchmark drift

`doctor --check-benchmark` compares current output against the configured primary metric and can warn when current output is far worse than the historical best. Treat the old best as historical evidence until a fresh packet confirms it.

## Runtime provenance and packet diagnostics

Runtime provenance is a trust gate. Read it before making live claims from source changes, dashboard exports, or compact state. If source and installed runtime disagree, source-only changes are not live evidence.

The scope matters. A stale installed-plugin runtime blocks installed behavior claims. Source-checkout work can continue when the source runtime is fresh and the command is run from that checkout; label the proof as source-checkout evidence until the installed runtime is refreshed.

Packet diagnostics classify evidence loss: failed citation carry, lost claims during synthesis, missed quality scores, or sufficiency marked while the benchmark failed. Diagnostic evidence explains the next fix; it is not a product win.

Metrics such as `review_required=1` make the packet provisional until ASI acknowledges what was reviewed and why the evidence can or cannot count. `quality_gap=0` closes the accepted checklist for the current research round; it is not universal proof that discovery is complete.

## Promotion evidence

State and dashboard readouts separate local development evidence from promotion-grade evidence.

| Label | Meaning |
| --- | --- |
| `exploratory` | Valid local evidence needing repeat, breadth, holdout, or promotion gate |
| `dev_best` | Interesting local best, not promotion evidence |
| `pending_repeat` | First-pass win awaiting repeat |
| `repeated` | Repeat exists; promotion may still need breadth or holdout |
| `holdout` | Holdout evidence exists for the current gate |
| `promotion_eligible` | Run includes explicit promotion metadata |
| `invalidated` | Later ASI or status invalidated the evidence |
| `historical` | Useful context from an earlier segment |
| `blocked` | Evidence cannot support the next claim |

If ASI says to stop, broaden validation, rerun on holdout, or invalidate a family, honor that over remaining iteration budget.

## Benchmark overfit and steering

Autoresearch can make a benchmark look cleaner while the actual product gets less honest. Treat a result as benchmark-shaped when the implementation or harness adds task-family detectors, protected probes, static citations, manifest edits, or scorer changes keyed to the benchmark row.

Those changes can still be useful diagnostics. Log them as `measure` with provisional wording, or start a new segment when the benchmark contract changed. Do not promote them as a product win until holdout, repeat, breadth, or an explicit promotion gate covers the broader claim.

`session-forensics` treats explicit overfit and row-specific steering as a decision-capsule blocker. Resolve by separating harness-quality changes from row-specific repairs and planning holdout or breadth validation.

Generic harness improvements (cost accounting, provenance capture, manifest-quality scoring) support a harness-quality claim — keep that separate from "the product won this language/task."

## Claim coverage

Accepted evidence is not automatically shippable evidence.

| Status | Meaning |
| --- | --- |
| `experimental` | Useful local evidence; product claim not covered |
| `development` | Some proof exists; required proof still missing |
| `product_grade` | Required proof present for the active claim |
| `missing_required_proof` | Named proof labels must be added before product-grade finalization |

For retrieval, search, ranking, lazy behavior, or performance claims, product-grade coverage usually needs accuracy or ranking proof plus behavior proof under the claimed mode.

If claim coverage is missing, use experimental or development wording. Finalization preview can package a review branch but must not describe the work as shippable product proof.

## Benchmark guardrails

`protectedBenchmarkPaths` records project-relative benchmark files or fixture folders that define the measurement contract. `doctor`, `next`, and `log --from-last` warn or block when those paths are dirty, missing, changed after baseline snapshot, or resolve outside the working directory.

Keep protected paths tight. Very large or deep folders can make `next` refuse when freshness cannot be proven.

If `autoresearch.config.json` contains `fixedControl`, the named artifact is the fixed control truth. Commands matching `fixedControl.forbiddenCommandPatterns` must not rerun the control baseline unless the rerun is explicitly accepted with `--allow-fixed-control-rerun`; use `fixedControl.reuseCommandHint` when it exists.

Secondary metric constraints add explicit tradeoff checks:

```bash
node scripts/autoresearch.mjs config --cwd <project> --secondary-metric-constraints "memory_mb <= baseline * 1.05,coverage >= baseline" --secondary-metric-constraint-mode blocking
```

Supported thresholds: numeric values, `baseline`, `baseline * N`, `N * baseline`, `baseline +/- N`. Blocking constraints make violating keeps provisional and non-promotable.

This is not Pareto optimization. Autoresearch still chooses by one primary `METRIC name=value`; constraints guard known secondary risks.

## Git safety

- Check Git before setup, logging, discard cleanup, or finalization.
- Configure `commitPaths` for kept results in Git repos.
- Use scoped `revertPaths` for discarded paths.
- Use `--commit <hash>` when work was already committed outside the helper.
- Use `--allow-add-all` only when every dirty file belongs to the experiment.

`doctor` and `state --compact` warn when the worktree is dirty or configured commit paths are missing.

## Live versus static

Live:

```bash
node scripts/autoresearch.mjs serve --cwd <project>
```

Static:

```bash
node scripts/autoresearch.mjs export --cwd <project>
```

Static exports are review snapshots. They are not proof of current packet freshness and should not expose live mutation controls.

## Command gate

Command-bearing setup and inspection paths require deliberate approval before materializing custom commands:

- `command`
- `benchmark_command`
- `checks_command`
- `model_command`
- setup guidance from external recipe catalogs (with `--trust-catalog`)

Prefer project-local `autoresearch.sh` or `autoresearch.ps1` scripts when possible.

Autoresearch does not sandbox benchmark or checks commands. Approved commands run as local shell processes with the current user's permissions. Review generated commands, keep secrets out of command lines and output, and prefer `--command-file` and `--packet-env-file` for fragile setup.

`--command-file` and `--packet-env-file` are trusted local CLI inputs, including when they point outside the working directory. Keep them project-local when possible so reviewers can inspect them with the session. Persisted last-run packets reduce outside-workdir option-file paths to placeholders, but the commands still run with the current user's local permissions.

If catalog or option-file inputs are exposed through a tool surface, keep them behind the existing explicit command gate (`allow_unsafe_command` for tools, `--trust-catalog` for external setup catalogs). Catalog recipes can materialize commands, so inspect the source before admitting them.

`run` and `next` default to `--packet-env-mode inherit`. Use `--packet-env-mode minimal` for a smaller environment (PATH, SystemRoot, TEMP, TMP plus explicit packet env keys).

Evidence redaction is best-effort, not a confidentiality guarantee. Keep sensitive data out of benchmark output and ASI in the first place.

The served dashboard binds to loopback, rejects wrong-port `Host` headers, sends no-store headers, and keeps the raw ledger endpoint disabled unless `--debug-ledger` is explicitly used.

Partial-result salvage reads only in-workdir artifacts. Oversized or malformed artifacts are skipped; salvaged rows remain diagnostic `measure` evidence only.

## Privacy and local data

Autoresearch has no hosted backend. Session files, dashboard exports, ASI, packet evidence, and artifact indexes are local project records unless your commands, Git workflow, or external services move them elsewhere.

See [Privacy](privacy.md) and [Terms](terms.md) for the user-facing policy surfaces.

## Corrupt or partial state

If `autoresearch.jsonl` is corrupt, surface the failing file and line. Do not silently continue from a partial ledger.

If dashboard trust warnings mention stale packets, dirty Git, drift, missing metrics, corrupt state, or static mode, resolve those warnings before claiming a result is final.

---

Previous: [Operate](operate.md) · Next: [Finish](finish.md) — finalization preview, review branches, and merge.
