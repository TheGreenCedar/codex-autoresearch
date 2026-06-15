# Troubleshooting

Find the failing layer first. Do not retry a live step until a precondition has changed.

| Symptom | Likely layer | What to do |
| --- | --- | --- |
| CLI command missing or fails before loading runtime | Source checkout missing `dist/` | Run `node scripts/autoresearch.mjs --help` from the plugin directory once to hydrate the matching release runtime. |
| Source differs from Codex behavior | Installed runtime drift | Refresh the installed plugin/cache before changing source again. |
| Benchmark has no primary metric | Benchmark contract | Run `benchmark-lint`; repair output to `METRIC <primary>=<number>`. |
| Benchmark parses but is not promotable | Research integrity | Inspect `researchIntegrity`; add repeat/holdout/freshness/promotion metadata. |
| Speed improved but correctness unchecked | Quality constraint | Add checks for accuracy, recall, ranking, accessibility, security, or data integrity. Treat as experimental until claim coverage is present. |
| Perfect metric looks too good | Evaluator contamination or cache replay | Require breadth, freshness, holdout, and repeat evidence. |
| Current benchmark far worse than best | Runtime or benchmark drift | Treat old best as history; rerun doctor and start a new segment if the old phase is stale. |
| Setup wrapper loops or calls itself | Scaffold health | Replace self-recursive wrapper or rerun setup with `--benchmark-command`. |
| Dashboard opens as `file://` | Static export | Run `serve --cwd <project>` and use the `http://127.0.0.1:<port>/` URL. |
| Live refresh reports HTTP 409 | Session changed mid-refresh | Retry refresh or wait for next auto-refresh. |
| Dashboard looks actionable but does not mutate | Product contract | Dashboard is readout only. Use CLI for setup, packets, logging, and finalization. |
| Last packet will not log | Packet freshness or raw `run` probe | Rerun `next`, or log manually with `log --metric <value> --status measure`. |
| Keep will not commit | Git scope | Configure `commitPaths`, pass `--commit-paths`, or use `--allow-add-all` intentionally. |
| Configured commit paths missing | Stale config | Update `autoresearch.config.json` or pass explicit paths on next log. |
| Finalization preview blocks | Dirty tree, semantic safety, coverage | Clean/scope tree, resolve invalidated evidence, or use `finalize-current-tree`. |
| Source clean but session artifacts dirty | Session artifact cleanliness | Stash or commit `autoresearch.*` / `autoresearch.research/**` before branch-changing finalization. |
| Finalization or export looks hung | Slow command, quiet JSON stdout | Rerun with `--progress` for stderr heartbeats. |
| Preview includes rejected or provisional evidence | Evidence status | Confirm runs are accepted/current keeps. |
| Preview sounds shippable without claim coverage | Product-grade bar | Re-run `state --compact` and `finalize-preview`; branch is experimental review only. |
| `quality_gap=0` looks final | Research scope confusion | Closes the cheap metric only. Check `researchIntegrity`, promotion metadata, and open gaps. |
| Watchdog fires | No-progress window | Inspect process, finalize kept work, rescope, or start a fresh segment. |
| Checklist blocks `next` | Loop governance | Follow the checklist command first. |
| `next_blocked_by_truncated_fingerprints` | Dirty Git fingerprint trust | Clean, commit, stash, or scope dirty files, then rerun `next`. |
| Resume treats latest prompt as the goal | Goal frame mismatch | Read `goalFrame.authoritativeGoal` from `state --compact`; run `session-forensics` if a prior session contains a correction. |
| `next_blocked_by_loop_contract` | Decision capsule or loop contract | Follow `blockingAction.command`, repair the condition, acknowledge or start fresh segment. |
| `benchmark-lint` times out | Benchmark contract | Repair wrapper, warm-cache, or bounded task slice. Measurement-contract repair, not product progress. |
| Loop keeps running but not learning | Degenerate loop shape | Stop packets. Read `recommend-next --compact --operator-checklist`, inspect ASI/plateau, run `session-forensics --dry-run` or `research-fanout --dry-run`. |
| Heavy benchmark about to rerun after crash | Packet economics | Run `partial-results --from-last` first; record useful rows as diagnostic `measure`. |
| Runtime provenance unavailable | Runtime drift | Inspect or refresh installed plugin/cache. |
| Packet diagnostics report evidence loss | Packet evidence | Repair citation carry, synthesis, or benchmark failure before promoting. |
| `lane-runner` refuses command outside Git | Lane isolation | Use a worktree, record read-only summary, or pass `--allow-non-git-command` intentionally. |
| Benchmark runs but no METRIC line | Benchmark output | Command must print `METRIC name=value`, or use `--benchmark-prints-metric false` for wrapper timing. |
| Accidentally logged wrong keep | Log correction | Scope discard cleanup with `revertPaths`. Ledger is append-only. |
| Later run invalidates a keep | Evidence correction | Log later packet with ASI explaining contamination or rollback. |
| Dashboard chart empty | No logged packets | Run at least one `next` and `log` cycle. |
| Want to change primary metric | Session reconfiguration | Use `new-segment`. Do not edit `autoresearch.jsonl` by hand. |
| Session has too many packets | Session age | Use `new-segment --dry-run` then confirm. Old history is preserved. |

Compact-state field names: [state-fields](concepts.md#state-fields).

## Common mistakes

- **Logging before checking**: running `log --from-last` without verifying freshness in `doctor` or `state --compact`.
- **Treating dashboard as truth**: serve a fresh instance when data looks stale.
- **Broad Git cleanup after discard**: scope reverts with `revertPaths`; avoid `--allow-add-all` unless every dirty file is intentional.
- **Skipping ASI**: the next session has no memory and repeats failed approaches.

Before any command that can commit, discard, revert, or change branches:

```bash
git status --short
node scripts/autoresearch.mjs state --cwd <project> --compact
node scripts/autoresearch.mjs doctor --cwd <project> --explain
```

## Fast diagnostics

```bash
node scripts/autoresearch.mjs state --cwd <project> --compact
node scripts/autoresearch.mjs doctor --cwd <project> --check-benchmark --explain
node scripts/autoresearch.mjs onboarding-packet --cwd <project> --compact
node scripts/autoresearch.mjs recommend-next --cwd <project> --compact
```

From the wrapper root:

```bash
node plugins/codex-autoresearch/scripts/autoresearch.mjs --help
```

---

Previous: [Hooks](hooks.md) · Next: [Index](index.md).
