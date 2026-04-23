# Codex Autoresearch Docs

This directory holds focused operational docs for Codex Autoresearch. The repository root `README.md` remains the public-facing README; do not add another README under the plugin package.

Use these pages when the README would otherwise need dense policy, tool tables, or maintainer runbooks:

- [Getting started](getting-started.md): install, target a repo, create a session, and run the first measured packet.
- [Operator workflows](operator-workflows.md): resume a loop, use the dashboard, run packets, log decisions, deep-research gaps, and finalization.
- [Evidence and safety](evidence-and-safety.md): metric integrity, stale packets, static versus live dashboards, Git safety, and recovery behavior.
- [MCP tools](mcp-tools.md): the Codex-facing tool surface, command gating, and when to choose adjacent tools.
- [Maintainers](maintainers.md): repo shape, local plugin routing, release surfaces, verification, and docs synchronization.

## Documentation Boundary

Keep the root README short and human-facing. It should answer what the plugin does, how to install it, how to start with Codex, and where to see the dashboard or demo.

Keep durable workflow detail here. These docs should describe actual CLI, MCP, dashboard, and file behavior. If a command, public contract, dashboard mode, or finalization flow changes, update the closest topic page together with the skill, changelog, and tests that assert that behavior.

## Internal Roadmap Archive

`specification-delight-roadmap/` is an internal/archive planning record for the guided operator experience. It is useful design evidence, not first-run onboarding. Prefer the topic pages above for current user-facing guidance.

