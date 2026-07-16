# Troubleshooting

Find the broken layer before repeating the command. A retry with the same preconditions usually produces the same mess, only older.

## Install and runtime

| Symptom | Failing layer | What to do |
| --- | --- | --- |
| Source checkout missing `dist/` | Source launcher hydration | Install `gh`, confirm GitHub network access, then run `node scripts/autoresearch.mjs --help` from the plugin directory. Hydration stops if checksum, release attestation, or archive validation fails. |
| Hydration reports a retained rollback directory | Runtime replacement recovery | Inspect the named active and rollback directories. Do not delete an unmarked or linked path; retry only after restoring the marked rollback when the active target is missing, or removing the obsolete marked rollback after verifying the active target. |
| Source behavior differs from Codex | Installed runtime drift | Run `doctor --check-installed --explain`. Read `installedRuntimePath`, `installedRuntimeShape`, and `installedRuntimeProvenance`; hydrate a source-shaped package, refresh a stale cache, or remove ambiguity between multiple canonical versions before changing source again. |
| Setup wrapper calls itself | Scaffold health | Replace the recursive wrapper or rerun setup with the real `--benchmark-command`. |

## Benchmark and checks

| Symptom | Failing layer | What to do |
| --- | --- | --- |
| Benchmark prints no primary metric | Benchmark contract | Run `benchmark-lint`; make the command print `METRIC <primary>=<number>`, or configure `--benchmark-prints-metric false` for a raw timed command. |
| Metric parses but cannot be promoted | Missing repeat, holdout, breadth, or freshness proof | Read `researchIntegrity` and add the proof required by the claim. |
| Speed improves but correctness is unknown | Missing checks | Add accuracy, recall, ranking, accessibility, safety, or data-integrity checks; keep the result experimental until they pass. |
| A perfect metric looks suspicious | Cache replay or benchmark contamination | Repeat with fresh inputs and require holdout or breadth evidence. |
| Current result is much worse than the historical best | Benchmark or environment drift | Treat the old best as history; run doctor and start a new segment if the phase changed. |
| `benchmark-lint` times out | Broken or too-large benchmark probe | Repair the wrapper, warm the cache, or use a bounded task slice. This is benchmark repair, not product progress. |
| Packet timed out after writing artifacts | Partial results exist | Run `partial-results --cwd <project> --from-last` before rerunning; recorded rows remain diagnostic `measure` evidence. |
| State reports `termination_failed` | Process-tree cleanup could not be proven | Treat the reported PID as possibly alive. Verify that PID and its descendants are absent before removing only `.git/autoresearch/progress.json` (Git) or `autoresearch.progress.json` (non-Git); do not start another packet first. |
| State reports an invalid or active process lifecycle | Typed lifecycle ledger state is malformed or has no later terminal row | Preserve the ledger. Repair the malformed `process_lifecycle` row or append a valid `terminated` row for the same packet/process identity only after verifying the process is absent. Historical descriptive prose needs no repair. |
| Checks failed | Correctness boundary | Run `checks-inspect --cwd <project> --command "<checks>"`, then fix or reject the packet. Logging `checks_failed` may clean configured or explicit experiment paths. |

## Git and logging

| Symptom | Failing layer | What to do |
| --- | --- | --- |
| Duplicate run numbers or edited ledger entries | Ledger integrity | Run `ledger-doctor --cwd <project> --json`. |
| `log --from-last` refuses the packet | Stale packet or legacy `run` probe | Run a fresh `next`, or log the raw number explicitly as `measure`; use `benchmark-inspect` for future diagnostic probes. |
| Successful work was committed outside Autoresearch | Keep receipt lacks commit evidence | Verify the hash, then log the keep with `--commit <hash>`. |
| Keep refuses to commit | Missing Git scope | Configure `commitPaths`, pass `--commit-paths`, or deliberately use `--allow-add-all`. |
| Failure cleanup refuses to run | Missing cleanup scope | Pass explicit `--revert-paths`; do not broaden cleanup in a dirty tree. |
| `next_blocked_by_truncated_fingerprints` | Dirty paths cannot be fingerprinted safely | Clean, commit, stash, or narrow the dirty set, then rerun `next`. |
| `next_blocked_by_loop_contract` | A decision capsule or control-plane blocker owns the next action | Run the printed blocking command, acknowledge it, or start a fresh segment. |

## Dashboard

| Symptom | Failing layer | What to do |
| --- | --- | --- |
| Dashboard opens as `file://` | Static export | Run `serve --cwd <project>` and use the printed loopback URL. |
| Live refresh returns HTTP 409 | Session changed during refresh | Retry after the write completes or wait for the next refresh. |
| Dashboard has no chart | No logged packets | Complete one `next` and `log` cycle. |
| Dashboard looks like it should run actions | Wrong mental model | It is read-only. Use the CLI for setup, packets, logging, export, and finalization. |

## Research and finalization

| Symptom | Failing layer | What to do |
| --- | --- | --- |
| Source is clean but session artifacts are dirty | Autoresearch files changed | Read/run work is safe; stash or commit those files before branch-changing finalization. |
| Finalization blocks on current tree | Commit evidence no longer describes the final diff | Review the whole clean non-session diff, then follow `finalize-current-tree --cwd <project> --exclude-session-artifacts` only when canonical state routes there. |
| Finalization or export is quiet for a long time | Slow history or JSON output | Rerun with `--progress` for stderr heartbeats. |
| Checked qualitative gaps still report `needs-evidence` | Markdown boxes are provisional | Run `quality-gap --list`, then record each stable gap ID with `gap-decide` plus evidence and validation. |
| `quality_gap=0` appears to finish everything | Checklist scope is being overread | Read `researchIntegrity`, open proof gaps, and promotion status; start another discovery round when the question is still open. |
| Packet state reports conflicting private stores | Both `.git/autoresearch/` and worktree fallback files exist | Inspect both copies and preserve the authoritative one; do not delete or merge them blindly. Rerun setup or the blocked mutation after the conflict is resolved. |
| An older Codex task contains a bounded decision | Session evidence has not been imported | Run `session-forensics --cwd <project> --session-jsonl <path> --research-slug <slug> --dry-run`. |
| Loop keeps running without learning | Repeated idea family or stale phase | Stop packets; inspect the saved experiment notes, run `research-fanout --dry-run`, rescope, or start a new segment. |
| Watchdog fires | No meaningful progress in the quiet window | Inspect active work, finalize useful keeps, or rescope. |
| `lane-runner` rejects a scout command | Pre-execution command policy | Scout commands must match the strict Git read-only argv allowlist. There is no non-Git override; use an implementation lane with a separate worktree or declared write scope, and remember that neither provides process/filesystem containment. |
| Primary metric must change | Session semantics changed | Use `new-segment`; do not edit the ledger by hand. |

## Repair a ledger

Inspect first:

```bash
node scripts/autoresearch.mjs ledger-doctor --cwd <project> --json
```

If duplicate-run normalization is appropriate:

```bash
node scripts/autoresearch.mjs ledger-doctor --repair --yes --cwd <project>
```

Confirm the returned `backupPath` before continuing.

## Fast diagnostic packet

```bash
node scripts/autoresearch.mjs state --cwd <project> --compact
node scripts/autoresearch.mjs recommend-next --cwd <project> --compact --operator-checklist
node scripts/autoresearch.mjs doctor --cwd <project> --check-benchmark --explain
node scripts/autoresearch.mjs onboarding-packet --cwd <project> --compact
```

Before any command that can commit, revert, or change branches, also run `git status --short`.
