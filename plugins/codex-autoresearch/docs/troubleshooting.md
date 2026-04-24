# Troubleshooting

Find the failing layer first. Do not mash retry like a vending machine button when no precondition changed.

| Symptom | Likely Layer | What To Do |
| --- | --- | --- |
| MCP tools do not appear | Codex session or installed cache | Run `node scripts/autoresearch.mjs mcp-smoke`, then inspect `codex mcp get codex-autoresearch`. |
| `mcp-smoke` fails | Local MCP entrypoint | Check `.mcp.json`, `scripts/autoresearch-mcp.mjs`, startup noise, and schema imports. |
| Source differs from Codex behavior | Installed runtime drift | Compare source version to `codex mcp get codex-autoresearch`; refresh installed plugin/cache before changing source again. |
| Benchmark has no primary metric | Benchmark contract | Run `benchmark-lint`; repair output to `METRIC <primary>=<number>`. |
| Current benchmark is far worse than best | Runtime or benchmark drift | Treat old best as history; rerun doctor/check-benchmark and start a new segment if the old phase is stale. |
| Dashboard opens as `file://` | Static export | Run `serve --cwd <project>` and use the `http://127.0.0.1:<port>/` URL for live actions. |
| Dashboard live action fails | Action guard | Check nonce, same-origin, JSON body, allowed action, packet fingerprint, and command timeout. |
| Last packet will not log | Packet freshness | Rerun `next`; the ledger, config, command, working directory, Git, or relevant file fingerprint changed. |
| Keep will not commit | Git scope | Configure `commitPaths`, pass `--commit-paths`, or intentionally use `--allow-add-all`. |
| Configured commit paths are missing | Stale config | Update `autoresearch.config.json` or pass explicit paths on the next log. |
| Finalization preview blocks | Dirty tree or overlap | Clean/scope the tree, inspect kept runs, collapse only safe overlaps, then refresh preview. |
| `quality_gap=0` looks final | Research scope confusion | It closes the accepted checklist only. Start a fresh gap round for broader discovery. |

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
