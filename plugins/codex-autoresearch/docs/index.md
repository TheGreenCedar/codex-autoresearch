# Codex Autoresearch Docs

The root `README.md` is the public front door. These topic pages hold the durable operating detail for people and agents running the plugin.

## Read In This Order

1. [Workflow diagrams](workflows.md): first-five-minutes loop, prompt-to-loop planning, active packets, research, and dashboard reading order.
2. [Architecture diagrams](architecture.md): runtime surfaces, trust boundaries, source layout, MCP path, and finalization.
3. [Start](start.md): first five minutes, session files, benchmark contract, and first packet.
4. [Operate](operate.md): resume, dashboard, packet logging, quality-gap rounds, and active-loop continuation.
5. [Trust](trust.md): metric integrity, stale packets, drift, dirty Git, static exports, and unsafe command gates.
6. [Finish](finish.md): finalization preview, review branches, merge/cleanup, and reporting.
7. [Recipes](recipes.md): built-in recipes, recommendation flow, benchmark linting, and external catalogs.
8. [Troubleshooting](troubleshooting.md): symptom-to-layer diagnosis for MCP, cache drift, dashboard, metrics, Git, and stale sessions.
9. [Hooks](hooks.md): optional Codex hook ideas and current caveats.

Reference pages:

- [MCP tools](mcp-tools.md)
- [Maintainers](maintainers.md)

Additional topic pages:

- [Getting started](getting-started.md)
- [Operator workflows](operator-workflows.md)
- [Evidence and safety](evidence-and-safety.md)

## Documentation Boundary

Keep the root README short and human-facing. It should answer what the plugin does, how to install it, how to start, where to see the dashboard, and where the docs live.

Keep workflow rules here. If a command, MCP tool, dashboard mode, finalization behavior, or safety rule changes, update the closest topic page together with the skill, changelog, tests, and product benchmark.

There is no current public `specification-delight-roadmap/` page. Historical design notes should stay out of first-run onboarding unless they are deliberately restored as an archive.
