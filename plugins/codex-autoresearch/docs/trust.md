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

`crash` and `checks_failed` can be logged without inventing sentinel metrics. A normal `keep`, `discard`, or `measure` needs a finite primary metric.

Use `measure` for non-promotional evidence: baselines, no-change checks, environment probes, and diagnostics. It can inform latest/trend/baseline readouts, but it is never a keep and never a finalizer input.

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

If anything changed, rerun `next` before logging. If the data came from a raw `run` probe and you still want it in the ledger, log it explicitly with `--metric <value> --status measure`.

When a `keep` has no source changes, record it as no-change evidence. Do not borrow an old `HEAD` and dress it up as a new result.

Fresh packets also carry a packet evidence bundle: packet id, command identity, command execution boundary, timeout, exit status, bounded stdout/stderr tails, parsed metrics, artifacts, checks result, and a freshness fingerprint. Use that bundle to review what actually ran; do not infer promotion readiness from "a metric was parsed."

## Benchmark Drift

`doctor --check-benchmark` compares the current command output against the configured primary metric and can warn when current output is far worse than the historical best.

When that happens, treat the old best as historical evidence. Do not claim it is current runtime proof until a fresh packet confirms it.

## Runtime Provenance And Packet Diagnostics

Runtime provenance is a trust gate, not decoration. Read `runtimeProvenance` and `runtimeDriftSummary` before making live claims from source changes, dashboard exports, or compact state. If source and installed runtime disagree, source-only changes are not live evidence; inspect the active runtime path/version and built-entrypoint fingerprint before saying the behavior is live. If installed runtime or fingerprint evidence cannot be inspected, call it unavailable instead of fresh.

Packet diagnostics are also trust gates. Read `packetDiagnostics` before rerunning or promoting a packet that lost evidence. A packet that retrieved evidence but failed citation carry, lost claims during synthesis, missed a quality score, or marked itself sufficient while the benchmark failed is diagnostic evidence. It can explain the next fix, but it is not a product win.

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

## Claim Coverage

Accepted evidence is not automatically shippable evidence. Claim coverage describes whether the current accepted evidence proves the claim the operator is about to make.

Vocabulary:

- `experimental`: useful local or exploratory evidence exists, but the product claim is not covered.
- `development`: some claim proof exists, but required proof is still missing.
- `product_grade`: required proof is present for the active claim.
- `missing_required_proof`: the named proof labels that must be added before product-grade finalization.

For retrieval, search, ranking, lazy behavior, or performance claims, product-grade claim coverage usually needs accuracy or ranking proof plus behavior proof under the claimed mode. Examples include recall, MRR, hit@k, ranking quality, lazy behavior, sidecar safety, and docs or tests that keep the behavior from drifting.

If claim coverage is missing, use experimental primitive or development wording. Finalization preview can still package a review branch, but it must not describe the work as shippable, merge-ready product proof.

## Benchmark Guardrails

`protectedBenchmarkPaths` records the project-relative benchmark files or fixture folders that define the measurement contract. `doctor`, `next`, and `log --from-last` warn or block when those paths are dirty, missing, changed after the baseline snapshot, or resolve outside the working directory through symlinks. Intentional benchmark changes should start a new segment or promotion gate so old and new evidence are not mixed.

Keep protected paths tight. Directory snapshots recursively walk leaves and hash file contents, so large generated, cache, fixture, or data folders can make normal `doctor`, `next`, and logging preflights expensive. Prefer a small manifest, fixture list, or benchmark contract file that represents the measurement surface.

Secondary metric constraints add explicit tradeoff checks without replacing the primary metric contract:

```bash
node scripts/autoresearch.mjs config --cwd <project> --secondary-metric-constraints "memory_mb <= baseline * 1.05,coverage >= baseline" --secondary-metric-constraint-mode blocking
```

Supported thresholds are numeric values, `baseline`, `baseline * N`, `N * baseline`, and `baseline +/- N`. Advisory constraints record pass/fail/unavailable status. Blocking constraints keep the primary packet evidence but make violating keeps provisional and non-promotable until the constraint is satisfied or the operator intentionally changes the rule.

This is not Pareto optimization. Autoresearch still chooses by one primary `METRIC name=value`; constraints are guardrails for known secondary risks.

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

Autoresearch does not sandbox benchmark or checks commands. Approved commands run as local shell processes with the current user's permissions, environment access, and filesystem reach from the target working directory. Packet evidence, `state --report`, the dashboard trust state, and `doctor --check-benchmark --explain` can surface this as `commandExecutionBoundary: not_sandboxed` when command-bearing evidence exists.

Review generated commands before running them, keep secrets out of command lines and benchmark output, and use project-local wrappers when the command needs careful environment setup. Prefer `--command-file` and `--packet-env-file` for commands or environment overrides that would otherwise need fragile inline quoting.

`run` and `next` default to `--packet-env-mode inherit`, which preserves the current process environment and overlays keys from `--packet-env-file`. Use `--packet-env-mode minimal` when you want a smaller environment: Autoresearch keeps only `PATH`, `SystemRoot`, `TEMP`, and `TMP` from the parent process, then overlays explicit packet env file keys. Packet evidence records the mode and explicit key names, not env values.

Evidence redaction is best-effort, not a confidentiality guarantee. Dashboard, ledger, and packet evidence paths try to scrub common secrets, credentials, home paths, and env-file references, but sensitive data should not be emitted into Autoresearch evidence in the first place.

Trusted external recipes store catalog provenance in session config. `doctor` and `next` revalidate that provenance and block when the recipe or catalog has drifted, cannot be fetched, or no longer matches the trusted hash.

## Privacy And Local Data

Autoresearch has no hosted backend of its own. Session files, dashboard exports, ASI, packet evidence, benchmark output tails, and artifact indexes are local project records unless your own commands, Git workflow, Codex environment, or external services move them elsewhere.

Treat `autoresearch.jsonl`, `autoresearch.md`, `autoresearch.research/**`, `autoresearch-dashboard.html`, and generated finalization previews as potentially sensitive. They may include command names, relative paths, metric values, summaries of attempted work, and artifact references. Keep secrets and private data out of benchmark output and ASI; do not rely on redaction as a security boundary.

See [Privacy](privacy.md) and [Terms](terms.md) for the user-facing policy surfaces that match this trust model.

## Corrupt Or Partial State

If `autoresearch.jsonl` is corrupt, surface the failing file and line. Do not silently continue from a partial ledger.

If dashboard trust warnings mention stale packets, dirty Git, drift, missing metrics, corrupt state, or static mode, resolve those warnings before claiming a result is final.

---

Previous: [Operate](operate.md) · Next: [Finish](finish.md) — finalization preview, review branches, and merge.
