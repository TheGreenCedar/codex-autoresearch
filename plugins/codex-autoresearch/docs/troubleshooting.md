# Troubleshooting

Find the failing layer first. Do not mash retry like a vending machine button when no precondition changed.

| Symptom | Likely Layer | What To Do |
| --- | --- | --- |
| MCP tools do not appear | Codex session or installed cache | Run `node scripts/autoresearch.mjs mcp-smoke`, then inspect `codex mcp get codex-autoresearch`. |
| `mcp-smoke` fails | Local MCP entrypoint | Check `.mcp.json`, `scripts/autoresearch-mcp.mjs`, startup noise, and schema imports. |
| Source differs from Codex behavior | Installed runtime drift | Compare source version to `codex mcp get codex-autoresearch`; refresh installed plugin/cache before changing source again. |
| Benchmark has no primary metric | Benchmark contract | Run `benchmark-lint`; repair output to `METRIC <primary>=<number>`. |
| Current benchmark is far worse than best | Runtime or benchmark drift | Treat old best as history; rerun doctor/check-benchmark and start a new segment if the old phase is stale. |
| Dashboard opens as `file://` | Static export | Run `serve --cwd <project>` and use the `http://127.0.0.1:<port>/` URL for fresh state. |
| Dashboard looks actionable but does not mutate | Product contract | The dashboard is a readout. Use CLI or MCP for setup, packet runs, logging, gap review, export, and finalization preview. |
| Last packet will not log | Packet freshness | Rerun `next`; the ledger, config, command, working directory, Git, or relevant file fingerprint changed. |
| Keep will not commit | Git scope | Configure `commitPaths`, pass `--commit-paths`, or intentionally use `--allow-add-all`. |
| Configured commit paths are missing | Stale config | Update `autoresearch.config.json` or pass explicit paths on the next log. |
| Finalization preview blocks | Dirty tree or overlap | Clean/scope the tree, inspect kept runs, collapse only safe overlaps, then refresh preview. |
| `quality_gap=0` looks final | Research scope confusion | It closes the accepted checklist only. Start a fresh gap round for broader discovery. |
| Benchmark runs but no METRIC line | Benchmark output | The command must print `METRIC name=value` to stdout. Wrap the workload in a script that captures timing and emits the line, or use `--benchmark-prints-metric false` to let the wrapper time it. |
| Accidentally logged a wrong keep | Log correction | Discard cleanup must be scoped. Use `revertPaths` to roll back the kept commit. Then rerun `next` and log correctly. The ledger is append-only — the bad entry stays as historical evidence. |
| Dashboard chart is empty | No logged packets | Run at least one `next` and `log` cycle. The chart renders from ledger history, not from uncommitted state. |
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
node plugins/codex-autoresearch/scripts/autoresearch.mjs mcp-smoke
```
