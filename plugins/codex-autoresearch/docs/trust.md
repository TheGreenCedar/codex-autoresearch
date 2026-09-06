# Trust and safety

Autoresearch keeps each result attached to the code and experiment that produced it. A changed benchmark, stale packet, or different installed runtime can break that connection even when the reported number looks convincing.

## What the plugin can change

Fit routing is read-only. Its direct path creates no Autoresearch state. Setup and configuration write session files only after a complete loop is selected. `next` runs the evaluator and checks accepted by that contract, which means it can do anything those local commands do. Logging a keep can create a commit limited to configured paths. Logging `discard`, `crash`, or `checks_failed` can restore and clean the explicit `--revert-paths`, or the configured experiment scope when no explicit cleanup scope is supplied. Logging a measurement records evidence without staging, committing, or reverting source. Finalization preview is read-only, while branch creation happens later and requires approval.

Check `git status --short --branch` before setup, logging, failure cleanup, or finalization. Unrelated work in the same tree is not merely untidy; it can fall inside configured experiment paths and makes it harder to prove which change produced the result.

`lane-runner` scout commands have a deliberately narrow boundary. Before execution, the CLI parses the command without a shell and accepts only documented Git read subcommands and options. Interpreters, shells, redirection, chaining, Git config/ref mutation, network commands, pagers, external diff/textconv, hooks, and lazy fetch are refused. Git porcelain still runs before and after the command when a worktree is available, but that is best-effort detection, not filesystem or process containment. The old `--allow-non-git-command` escape was removed; use an implementation lane with a separate worktree or declared write scope for anything outside the allowlist.

## A parsed metric is only the beginning

The accepted evaluator must print the configured primary metric:

```text
METRIC seconds=12.34
```

`benchmark-lint` can prove that Autoresearch knows how to read the line. It cannot prove that the workload represents the product, that the cache is fresh, or that a faster result is still correct.

Missing, clipped, crashed, null, and stale results are unknown. Do not turn them into zero, a baseline, or a win. A keep, discard, or measurement needs a finite primary metric; a crash or failed check does not.

Use `measure` for baselines and diagnostics. Measurements can explain a trend, but they are not kept changes and cannot enter finalization.

Benchmark files and fixtures can be protected so a change cannot quietly make the test easier:

```bash
node scripts/autoresearch.mjs config --cwd <project> --protected-benchmark-paths "bench.mjs,fixtures/"
```

Accepted evaluator, check, parser, fixture, dataset, environment-file, and runner inputs must sit outside editable scope or in protected scope. Keep that set small enough to fingerprint reliably. If an intentional change alters their meaning, accept a complete replacement contract in a new segment instead of comparing the new number with the old one.

Some sessions use a fixed control artifact. In config and detailed output this appears as `fixedControl`. Reuse that artifact rather than rerunning a command matched by its forbidden patterns unless the user explicitly approves `--allow-fixed-control-rerun`.

Checks and secondary constraints protect the part of the product the primary metric does not describe:

```bash
node scripts/autoresearch.mjs config --cwd <project> --secondary-metric-constraints "memory_mb <= baseline * 1.05,coverage >= baseline" --secondary-metric-constraint-mode blocking
```

A speed improvement without the required accuracy, recall, accessibility, safety, or data-integrity check is still an experiment, not a product result.

## Keep the evidence fresh

`log --from-last` works only while the packet still matches the accepted contract, segment, protected inputs, commit scope, candidate fingerprint, and Git identity. Command, command-file, separator, config, wrapper, and environment overrides cannot bypass the accepted execution digest. Intentional evaluator or checks changes require a complete replacement contract. Use `benchmark-inspect` for bounded diagnostic probes; the legacy `run` name fails fast with that migration.

Source and installed plugin behavior can drift too. A change in the repository is not proof about the installed marketplace copy until the active version and built-entrypoint fingerprint match. It is fine to keep working from the source checkout; just describe the result as source-checkout evidence until the installed runtime has been refreshed.

Packet diagnostics can reveal a different kind of drift: evidence was retrieved but citations disappeared, a synthesis lost the claim, a quality score was skipped, or a confident summary survived a failed benchmark. Those runs can tell you what to repair, but they do not prove the product improved.

## Match the claim to the proof

One local win rarely supports the broadest possible description. Retrieval, search, ranking, lazy behavior, and performance claims usually need both outcome evidence and behavior evidence. A faster benchmark may support "this workload got faster." It does not automatically support "search is better" or "this is ready to ship."

Detailed state distinguishes exploratory results, repeats, holdouts, promotion evidence, invalidated runs, and historical runs. You do not need to memorize every label. The useful question is whether the accepted evidence covers the exact claim you plan to make.

`review_required=1` keeps a result provisional until the structured experiment note records what was reviewed. `quality_gap=0` closes one accepted checklist round, not all future discovery.

Be suspicious of changes keyed to known benchmark rows, static citations, protected probes, scorer behavior, or fixture names. They may be valuable diagnostics, but they need repeat, holdout, breadth, or an explicit promotion gate before they support a product claim.

## Keep Git automation narrow

Configure `commitPaths` before allowing a keep to create a commit. Pass explicit `--revert-paths` for cleanup after `discard`, `crash`, or `checks_failed`; otherwise configured commit paths may define the cleanup scope. Git paths are literal: wildcard pathspec characters are rejected. Use `--commit <hash>` when the change was already committed outside Autoresearch. Use `--allow-add-all` only when every dirty file belongs to the experiment. A scoped keep leaves unrelated staged files staged and excludes them from the Autoresearch commit.

Only one command may mutate a session at a time. If the owner process dies, the next mutation reclaims its lock; a live owner's lock is never stolen. If logging is interrupted, the version-2 receipt records its completed stages. Rerun the exact same `log` arguments: Autoresearch verifies any existing commit and ledger event, resumes tracked and untracked cleanup independently, and keeps the receipt until every required stage is done. Different arguments reject while it is pending.

Session notes and research scratchpads are excluded from review branches by default. Include them only when the reviewer actually needs them.

## Commands and local data

Autoresearch does not sandbox evaluator or checks commands. They run as local child processes with your permissions and the environment policy captured by the accepted contract. Review the complete contract before accepting it. Raw secret values are never persisted; declared variable values contribute only locally salted digests to execution identity. Inheriting the caller environment may still expose credentials to the child process.

A configured `workingDir` must stay inside the session `--cwd`. Use `--allow-outside-workdir` only when the external directory is intentional and trusted.

Ordinary `doctor` runs do not contact a stored remote recipe catalog. `doctor --revalidate-catalog` performs the explicit network check: public catalogs must use HTTPS, resolve only to public addresses, reject redirects, and match their expected digest. Private or internal catalogs must be local files.

Keep secrets out of commands, output, descriptions, experiment notes, and artifacts. Redaction is best-effort. [Privacy](privacy.md) describes the files that remain after a session and what may leave the machine through your own commands.

The live dashboard serves current local state over loopback. An export is a portable snapshot. Neither should be treated as fresh evidence after the underlying session has changed.

If dashboard data or metadata injection is missing, malformed, or declares an incompatible payload version, the readout shows a payload-unavailable screen instead of session evidence. Regenerate the static export or restart `serve` using the recovery command on that screen. Demo data appears only in an explicit `--showcase` export or the development server with `?showcase=1`, and the dashboard labels that provenance. A rejected live refresh leaves the last validated readout visible with a failure label; it never replaces that evidence with demo data.

The ledger is append-only. Every non-empty line must be a JSON object record; primitives and arrays are corrupt even when their JSON syntax is valid. Autoresearch reports the file, physical line, observed JSON kind, and `ledger-doctor --cwd <project> --json` recovery command. Diagnostic reads may preserve the remaining valid rows for inspection, but invalid rows block accepted-state and finalization trust instead of silently truncating history.

Dashboard export and live refresh parse that ledger once as a stream. They retain at most 5,000 newest rows plus the governing config while accumulating full-ledger counts, status totals, baseline, best accepted result, invalid-row samples, and the latest blocking typed process-lifecycle state. Lifecycle identity retention is bounded; overflow emits an explicit incomplete projection and blocks process clearance instead of silently evicting evidence. The readout labels omitted rows and full-stream summary provenance; confidence and detailed evidence lists remain bounded to retained rows when history is truncated, and full run-number health requires `ledger-doctor`.

`ledger-doctor` currently materializes the remaining valid records while building its tolerant diagnostic report. This known local-recovery limitation does not make those records accepted evidence while any line is invalid.
