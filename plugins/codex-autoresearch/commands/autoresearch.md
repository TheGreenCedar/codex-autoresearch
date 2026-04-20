---
description: Start, resume, inspect, run next, export, stop, or clear a Codex Autoresearch session. Arguments: start text, next, status, export, off, clear, or help.
---

# Autoresearch

Interpret `$ARGUMENTS` as a subcommand or session goal.

## Dispatch

When this repository is the target, use the local plugin over any globally installed copy. Treat `plugins/codex-autoresearch` as `<plugin-root>` and prefer `node <plugin-root>/scripts/autoresearch.mjs ...` until the current iteration is complete.

- Empty or `help`: summarize available actions.
- `doctor`: run `node <plugin-root>/scripts/autoresearch.mjs doctor --cwd <current-project> --check-benchmark` when a benchmark is configured, then report issues, warnings, and next action.
- `next`: run `node <plugin-root>/scripts/autoresearch.mjs next --cwd <current-project>`, then report doctor status, metric, allowed log statuses, ASI template, and next action.
- `status`: run `node <plugin-root>/scripts/autoresearch.mjs state --cwd <current-project>` and summarize.
- `export`: use the `autoresearch-dashboard` skill or run `node <plugin-root>/scripts/autoresearch.mjs export --cwd <current-project>`.
- `off`: stop continuing the loop in this conversation. Do not delete files; report where the session can be resumed.
- `clear`: use MCP `clear_session` or run `node <plugin-root>/scripts/autoresearch.mjs clear --cwd <current-project> --yes` after confirming the target project path.
- Any other text: use the `autoresearch-create` skill to start or resume the loop using the text as the goal/context.

## Safety

Before `clear`, show the absolute files that will be deleted and ask for confirmation. `clear_session` and CLI `clear --yes` are the only session-deletion paths.

Before starting a new loop, check git status. If the worktree is dirty, ask whether to branch from the current state, commit first, or stop.

Before logging a kept result in a dirty tree, prefer scoped commit paths from the session scope or ask the user to confirm broad staging.

Before logging a discard/crash/checks-failed result, use configured `commitPaths`/`revertPaths`. Do not pass `--allow-dirty-revert` unless the user explicitly accepts broad cleanup.

When calling MCP tools with custom shell commands, pass `allow_unsafe_command: true` only after confirming the command and target directory.

For qualitative research loops, prefer a primary `quality_gap` metric. The benchmark should print the count of unmet rubric items, so the loop can continue until high-impact findings are implemented, intentionally rejected with evidence, or no longer relevant.

When using this repo-local copy, `<plugin-root>` is `plugins/codex-autoresearch`.
