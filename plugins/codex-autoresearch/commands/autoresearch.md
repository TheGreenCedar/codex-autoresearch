---
description: Start, resume, inspect, run next, export, stop, or clear a Codex Autoresearch session. Arguments: start text, next, status, export, off, clear, or help.
---

# Autoresearch

Interpret `$ARGUMENTS` as a subcommand or session goal.

## Local Plugin Routing

This command doc is the canonical CLI walkthrough for repo-local autoresearch runs. When this repository is the target, use the local plugin over any globally installed copy, including any marketplace-cache copy. Treat `plugins/codex-autoresearch` as `<plugin-root>` and prefer `node <plugin-root>/scripts/autoresearch.mjs ...` until the current iteration is complete.

From the repository root:

```bash
node plugins/codex-autoresearch/scripts/autoresearch.mjs doctor --cwd plugins/codex-autoresearch --check-benchmark
node plugins/codex-autoresearch/scripts/autoresearch.mjs next --cwd plugins/codex-autoresearch
node plugins/codex-autoresearch/scripts/autoresearch.mjs export --cwd plugins/codex-autoresearch
```

From `plugins/codex-autoresearch`, use `node scripts/autoresearch.mjs ...` with the target project passed through `--cwd`.

For MCP, the local `.mcp.json` starts `./scripts/autoresearch.mjs --mcp` with `cwd` set to `.`. If Codex still routes to a globally installed plugin, call the repo-local CLI explicitly.

Direct CLI sequence:

```bash
node <plugin-root>/scripts/autoresearch.mjs setup --cwd <current-project> --name "test speed" --metric-name seconds --metric-unit s --direction lower --benchmark-command "npm test -- --runInBand" --checks-command "npm test" --max-iterations 50
node <plugin-root>/scripts/autoresearch.mjs doctor --cwd <current-project> --check-benchmark
node <plugin-root>/scripts/autoresearch.mjs next --cwd <current-project>
node <plugin-root>/scripts/autoresearch.mjs log --cwd <current-project> --from-last --status keep --description "Use worker pool" --commit-paths "src,test"
node <plugin-root>/scripts/autoresearch.mjs export --cwd <current-project>
```

## Dispatch

Use the local routing above when this repository is the target.

- Empty or `help`: summarize available actions.
- `doctor`: run `node <plugin-root>/scripts/autoresearch.mjs doctor --cwd <current-project> --check-benchmark` when a benchmark is configured, then report issues, warnings, and next action.
- `next`: run `node <plugin-root>/scripts/autoresearch.mjs next --cwd <current-project>`, then report doctor status, metric, allowed log statuses, ASI template, and next action.
- `config ...`: run `node <plugin-root>/scripts/autoresearch.mjs config --cwd <current-project> ...` for runtime settings such as `--autonomy-mode`, `--checks-policy`, `--keep-policy`, `--extend`, and `--dashboard-refresh-seconds`.
- `status`: run `node <plugin-root>/scripts/autoresearch.mjs state --cwd <current-project>` and summarize.
- `export`: use the `autoresearch-dashboard` skill or run `node <plugin-root>/scripts/autoresearch.mjs export --cwd <current-project>`.
- `off`: stop continuing the loop in this conversation. Do not delete files; report where the session can be resumed.
- `clear`: use MCP `clear_session` or run `node <plugin-root>/scripts/autoresearch.mjs clear --cwd <current-project> --yes` after confirming the target project path.
- `research <goal>`: use the `autoresearch-deep-research` skill or MCP `setup_research_session` to create `autoresearch.research/<slug>/`, initialize a `quality_gap` session, then measure gaps with `quality-gap`.
- Any other text: use the `autoresearch-create` skill to start or resume the loop using the text as the goal/context.

## Safety

Before `clear`, show the absolute files that will be deleted and ask for confirmation. `clear_session` and CLI `clear --yes` are the only session-deletion paths.

Before starting a new loop, check git status. If the worktree is dirty, ask whether to branch from the current state, commit first, or stop.

Before logging a kept result in a dirty tree, prefer scoped commit paths from the session scope or ask the user to confirm broad staging.

After `next`, prefer `log --from-last` so Codex does not retype parsed metrics from the previous packet. Still choose `keep` or `discard` deliberately based on the metric and ASI.

Before logging a discard/crash/checks-failed result, use configured `commitPaths`/`revertPaths`. Do not pass `--allow-dirty-revert` unless the user explicitly accepts broad cleanup.

When calling MCP tools with custom shell commands, pass `allow_unsafe_command: true` only after confirming the command and target directory.

For qualitative research loops, use `autoresearch-deep-research`. Its benchmark counts unchecked items in `autoresearch.research/<slug>/quality-gaps.md`, so the loop can continue until high-impact findings are implemented, intentionally rejected with evidence, or no longer relevant.

When using this repo-local copy, `<plugin-root>` is `plugins/codex-autoresearch`.
