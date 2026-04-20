---
description: Start, resume, inspect, export, stop, or clear a Codex Autoresearch session. Arguments: start text, status, export, off, clear, or help.
---

# Autoresearch

Interpret `$ARGUMENTS` as a subcommand or session goal.

## Dispatch

- Empty or `help`: summarize available actions.
- `status`: run `node <plugin-root>/scripts/autoresearch.mjs state --cwd <current-project>` and summarize.
- `export`: use the `autoresearch-dashboard` skill or run `node <plugin-root>/scripts/autoresearch.mjs export --cwd <current-project>`.
- `off`: stop continuing the loop in this conversation. Do not delete files; report where the session can be resumed.
- `clear`: use MCP `clear_session` or run `node <plugin-root>/scripts/autoresearch.mjs clear --cwd <current-project> --yes` after confirming the target project path.
- Any other text: use the `autoresearch-create` skill to start or resume the loop using the text as the goal/context.

## Safety

Before `clear`, show the absolute files that will be deleted and ask for confirmation. `clear_session` and CLI `clear --yes` are the only destructive paths.

Before starting a new loop, check git status. If the worktree is dirty, ask whether to branch from the current state, commit first, or stop.

When using this repo-local copy, `<plugin-root>` is `plugins/codex-autoresearch`.
