# MCP Tools

The `codex-autoresearch` skill is the user-facing entrypoint. MCP tools are deterministic helpers behind that skill. Prefer MCP tools when available; use the CLI as the fallback.

## Tool Surface

| Tool | Use |
| --- | --- |
| `setup_plan` | Return a read-only setup readiness plan with missing fields, recipe suggestion, and next commands. |
| `guided_setup` | Return a guided first-run or resume packet with setup, doctor, baseline, log, and dashboard actions. |
| `list_recipes` | List built-in and optional catalog recipes. |
| `setup_session` | Create session files and append the initial config header. |
| `setup_research_session` | Create a deep-research scratchpad and initialize a `quality_gap` session. |
| `configure_session` | Update autonomy mode, checks policy, keep policy, dashboard refresh, commit paths, or iteration limit. |
| `init_experiment` | Append an autoresearch config header to `autoresearch.jsonl`. |
| `run_experiment` | Run a benchmark command, parse `METRIC` lines, and optionally run checks. |
| `next_experiment` | Run preflight and benchmark as one decision packet, with log options, ASI template, and continuation data. |
| `log_experiment` | Append a decision, keep/commit or discard/revert scoped changes, and return continuation state. |
| `read_state` | Summarize baseline, best, run counts, confidence, limits, settings, and commands. |
| `measure_quality_gap` | Count open and closed checklist items in `autoresearch.research/<slug>/quality-gaps.md`. |
| `gap_candidates` | Extract or apply validated gap candidates from synthesis and optional model output. |
| `finalize_preview` | Return finalization readiness without creating branches. |
| `integrations` | List, doctor, or sync external recipe/catalog integration surfaces. |
| `export_dashboard` | Write a self-contained fallback HTML snapshot. |
| `serve_dashboard` | Start a local live dashboard and return the operator URL. |
| `doctor_session` | Run setup/Git/benchmark preflight checks and optional installed-runtime checks. |
| `clear_session` | Delete runtime artifacts only after explicit confirmation; use dry-run first. |

## Adjacent Tool Choices

Use `setup_plan` before mutation. Use `setup_session` only when essentials are known and the user is ready to create files.

Use `guided_setup` when Codex needs the next action in one packet. It is better than separate ad hoc calls during first-run or resume workflows.

Use `next_experiment` for the normal loop. It packages preflight, benchmark, allowed log decisions, ASI fields, and continuation guidance. Use `run_experiment` only when you need a lower-level benchmark run.

Use `measure_quality_gap` to count the current checklist. Use `gap_candidates` to propose or apply candidate checklist items from research evidence.

Use `finalize_preview` for readiness. Branch creation stays in the finalizer CLI, not the dashboard or MCP preview surface.

## Argument Safety

Tool arguments are validated before dispatch. Unknown arguments fail loudly so misspelled options do not become silent no-ops.

The public `tools/list` response stays conservative for compatibility with older MCP clients: `name`, `description`, and `inputSchema`. The source also exposes richer internal tool metadata with `outputSchema` and safety annotations so tests, docs, and future modern clients can use the same contracts without weakening lightweight startup.

Operational metadata such as CLI command name, mutation status, and command-bearing argument fields lives in the shared tool registry. When adding a tool, update the schema, contract, registry, dispatch handler, CLI fallback, docs, and parity tests together.

Command-bearing fields require `allow_unsafe_command: true` over MCP:

- `command`
- `benchmark_command`
- `checks_command`
- `model_command`
- setup guidance that materializes commands from an external recipe catalog

Prefer project-local benchmark scripts over inline shell commands. If a custom command is necessary, keep it narrow and explain why the gate is being opened.

## CLI Fallbacks

From `plugins/codex-autoresearch`, the common CLI equivalents are:

```bash
node scripts/autoresearch.mjs setup-plan --cwd <project>
node scripts/autoresearch.mjs guide --cwd <project>
node scripts/autoresearch.mjs next --cwd <project>
node scripts/autoresearch.mjs log --cwd <project> --from-last --status keep --description "Describe the kept change"
node scripts/autoresearch.mjs state --cwd <project>
node scripts/autoresearch.mjs serve --cwd <project>
node scripts/autoresearch.mjs export --cwd <project>
node scripts/autoresearch.mjs doctor --cwd <project> --check-benchmark
node scripts/autoresearch.mjs finalize-preview --cwd <project>
```

Verify MCP startup with:

```bash
node scripts/autoresearch.mjs mcp-smoke
```
