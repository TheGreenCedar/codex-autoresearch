# Trust and safety

The point of Autoresearch is not to produce more numbers. It is to keep the number, the code, and the claim attached to the same experiment. Most of the safety rules exist because one of those three can drift while the others still look convincing.

## What the plugin can change

Setup and configuration write session files. `next` runs the benchmark and checks, which means it can do anything those local commands do. Logging a keep can create a commit limited to configured paths. Logging `discard`, `crash`, or `checks_failed` can restore and clean the explicit `--revert-paths`, or the configured experiment scope when no explicit cleanup scope is supplied. Logging a measurement records evidence without staging, committing, or reverting source. Finalization preview is read-only, while branch creation happens later and requires approval.

Check `git status --short --branch` before setup, logging, failure cleanup, or finalization. Unrelated work in the same tree is not merely untidy; it can fall inside configured experiment paths and makes it harder to prove which change produced the result.

## A parsed metric is only the beginning

The benchmark must print the configured primary metric:

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

Keep that set small enough to fingerprint reliably. If an intentional change alters the meaning of the benchmark, start a new segment instead of comparing the new number with the old one.

Some sessions use a fixed control artifact. In config and detailed output this appears as `fixedControl`. Reuse that artifact rather than rerunning a command matched by its forbidden patterns unless the user explicitly approves `--allow-fixed-control-rerun`.

Checks and secondary constraints protect the part of the product the primary metric does not describe:

```bash
node scripts/autoresearch.mjs config --cwd <project> --secondary-metric-constraints "memory_mb <= baseline * 1.05,coverage >= baseline" --secondary-metric-constraint-mode blocking
```

A speed improvement without the required accuracy, recall, accessibility, safety, or data-integrity check is still an experiment, not a product result.

## Keep the evidence fresh

`log --from-last` works only while the packet still matches the current segment, benchmark and checks commands, checks policy, protected paths, fixed control, secondary constraints, packet environment mode, commit scope, working directory, recipe provenance, and Git fingerprint. If any of those changed after `next`, run a fresh packet. A raw `run` probe should be logged explicitly as a measurement rather than dressed up as a reusable packet.

Source and installed plugin behavior can drift too. A change in the repository is not proof about the installed marketplace copy until the active version and built-entrypoint fingerprint match. It is fine to keep working from the source checkout; just describe the result as source-checkout evidence until the installed runtime has been refreshed.

Packet diagnostics can reveal a different kind of drift: evidence was retrieved but citations disappeared, a synthesis lost the claim, a quality score was skipped, or a confident summary survived a failed benchmark. Those runs can tell you what to repair, but they do not prove the product improved.

## Match the claim to the proof

One local win rarely supports the broadest possible description. Retrieval, search, ranking, lazy behavior, and performance claims usually need both outcome evidence and behavior evidence. A faster benchmark may support "this workload got faster." It does not automatically support "search is better" or "this is ready to ship."

Detailed state distinguishes exploratory results, repeats, holdouts, promotion evidence, invalidated runs, and historical runs. You do not need to memorize every label. The useful question is whether the accepted evidence covers the exact claim you plan to make.

`review_required=1` keeps a result provisional until the structured experiment note records what was reviewed. `quality_gap=0` closes one accepted checklist round, not all future discovery.

Be suspicious of changes keyed to known benchmark rows, static citations, protected probes, scorer behavior, or fixture names. They may be valuable diagnostics, but they need repeat, holdout, breadth, or an explicit promotion gate before they support a product claim.

## Keep Git automation narrow

Configure `commitPaths` before allowing a keep to create a commit. Pass explicit `--revert-paths` for cleanup after `discard`, `crash`, or `checks_failed`; otherwise configured commit paths may define the cleanup scope. Git paths are literal: wildcard pathspec characters are rejected. Use `--commit <hash>` when the change was already committed outside Autoresearch. Use `--allow-add-all` only when every dirty file belongs to the experiment. A scoped keep leaves unrelated staged files staged and excludes them from the Autoresearch commit.

Only one command may mutate a session at a time. If the owner process dies, the next mutation reclaims its lock; a live owner's lock is never stolen. If a keep or cleanup is interrupted halfway through, Autoresearch leaves a pending receipt. Resolve it before another mutation so the ledger cannot drift away from Git state.

Session notes and research scratchpads are excluded from review branches by default. Include them only when the reviewer actually needs them.

## Commands and local data

Autoresearch does not sandbox benchmark or checks commands. They run as local child processes with your permissions and a minimal environment by default. Review generated commands and recipes before running them. Prefer project-local wrappers or `--command-file` for long commands. Use `--packet-env-mode inherit` only when the benchmark genuinely needs the caller's full environment, because that may expose credentials to the child process.

A configured `workingDir` must stay inside the session `--cwd`. Use `--allow-outside-workdir` only when the external directory is intentional and trusted.

Ordinary `doctor` runs do not contact a stored remote recipe catalog. `doctor --revalidate-catalog` performs the explicit network check: public catalogs must use HTTPS, resolve only to public addresses, reject redirects, and match their expected digest. Private or internal catalogs must be local files.

Keep secrets out of commands, output, descriptions, experiment notes, and artifacts. Redaction is best-effort. [Privacy](privacy.md) describes the files that remain after a session and what may leave the machine through your own commands.

The live dashboard serves current local state over loopback. An export is a portable snapshot. Neither should be treated as fresh evidence after the underlying session has changed.

The ledger is append-only. If it is corrupt, report the file and line and use `ledger-doctor`; do not continue from a silently truncated history.
