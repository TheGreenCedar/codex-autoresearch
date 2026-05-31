# Troubleshooting

Find the failing layer first. Do not retry a live step until a precondition has changed.

| Symptom | Likely Layer | What To Do |
| --- | --- | --- |
| CLI command is missing or fails before loading runtime | Source checkout missing `dist/` | Run `node scripts/autoresearch.mjs --help` from the plugin directory once to hydrate the matching release runtime. |
| Source differs from Codex behavior | Installed runtime drift | Refresh the installed plugin/cache before changing source again. |
| Benchmark has no primary metric | Benchmark contract | Run `benchmark-lint`; repair output to `METRIC <primary>=<number>`. |
| Benchmark parses but is not promotable | Research integrity | Inspect `researchIntegrity`; add repeat/holdout/freshness/promotion metadata before treating a dev best as final. |
| Perfect metric looks too good | Evaluator contamination or cache replay | Treat it as suspicious until breadth, freshness, holdout/adversarial coverage, and repeat evidence are present. |
| Current benchmark is far worse than best | Runtime or benchmark drift | Treat old best as history; rerun doctor/check-benchmark and start a new segment if the old phase is stale. |
| Setup wrapper loops forever or calls itself | Scaffold health | Inspect `scaffoldHealth`; replace the self-recursive wrapper with the real workload or rerun setup with `--benchmark-command`. |
| Dashboard opens as `file://` | Static export | Run `serve --cwd <project>` and use the `http://127.0.0.1:<port>/` URL for fresh state. |
| Dashboard looks actionable but does not mutate | Product contract | The dashboard is a readout. Use CLI for setup, packet runs, logging, gap review, export, and finalization preview. |
| Last packet will not log | Packet freshness or raw `run` probe | Rerun `next` to create a loggable packet, or log a manual diagnostic with `log --metric <value> --status measure`. |
| Keep will not commit | Git scope | Configure `commitPaths`, pass `--commit-paths`, or intentionally use `--allow-add-all`. |
| Configured commit paths are missing | Stale config | Update `autoresearch.config.json` or pass explicit paths on the next log. |
| Finalization preview blocks | Dirty tree, semantic safety, or coverage | Clean/scope the tree, inspect kept runs, resolve invalidated/reverted evidence, or use `finalize-current-tree` when current branch contents are the review unit. Session artifacts are excluded by default. |
| Finalization preview includes rejected or provisional evidence | Evidence status | Confirm runs are accepted/current keeps before finalization. Rejected, provisional, superseded, and quarantined evidence stays audit-only. |
| `quality_gap=0` looks final | Research scope confusion | It closes the accepted checklist only. Start a fresh gap round for broader discovery. |
| Watchdog fires | No-progress window | Inspect the process, finalize useful kept work, rescope the segment, or start a fresh segment before running another packet. |
| Operator checklist blocks `next` | Loop governance | Follow the checklist command first. It outranks another packet until the named blocker is cleared. |
| Runtime provenance is unavailable or stale | Runtime drift | Inspect or refresh the installed plugin/cache before claiming source behavior is live. |
| Packet diagnostics report evidence loss | Packet evidence | Treat the run as diagnostic evidence. Repair citation carry, synthesis, quality scoring, or benchmark failure before promoting it. |
| `lane-runner` refuses a command outside Git | Lane isolation | Run the lane in a Git worktree, record a read-only summary without a command, or pass `--allow-non-git-command` only when that non-Git command is intentionally admitted. |
| Benchmark runs but no METRIC line | Benchmark output | The command must print `METRIC name=value` to stdout. Wrap the workload in a script that captures timing and emits the line, or use `--benchmark-prints-metric false` to let the wrapper time it. |
| Accidentally logged a wrong keep | Log correction | Discard cleanup must be scoped. Use `revertPaths` to roll back the kept commit. Then rerun `next` and log correctly. The ledger is append-only — the bad entry stays as historical evidence. |
| Later run invalidates a keep | Evidence correction | Log the later packet with ASI explaining contamination, failed repeat, cache replay, or rollback. `finalize-preview` should then block that earlier keep from promotion. |
| Dashboard chart is empty | No logged packets | Run at least one `next` and `log` cycle. Use `measure` for legitimate baseline or diagnostic evidence that should appear in trend readouts without becoming finalizer evidence. |
| Want to change the primary metric | Session reconfiguration | Use `new-segment` to start a fresh segment with the new metric. Do not edit `autoresearch.jsonl` by hand. |
| Session has too many packets | Session age | Use `new-segment --dry-run` to preview a fresh segment, then confirm. Old history is preserved in the ledger. |

## Common Mistakes

- **Logging before checking**: running `log --from-last` without verifying that `doctor` or `state --compact` shows a clean session. Always check freshness first.
- **Treating dashboard as truth**: the dashboard is a readout. If it shows stale data, serve a fresh instance instead of reading old state as current.
- **Broad Git cleanup after discard**: using `--allow-add-all` or broad revert when only experiment files should change. Scope reverts with `revertPaths`.
- **Skipping ASI**: logging decisions without hypothesis/evidence/next-action metadata. The next session then has no memory and repeats failed approaches.

## Fast Diagnostics

```bash
node scripts/autoresearch.mjs state --cwd <project> --compact
node scripts/autoresearch.mjs doctor --cwd <project> --check-benchmark --explain
node scripts/autoresearch.mjs onboarding-packet --cwd <project> --compact
node scripts/autoresearch.mjs recommend-next --cwd <project> --compact
```

For this repo, run from the wrapper root:

```bash
node plugins/codex-autoresearch/scripts/autoresearch.mjs --help
```
