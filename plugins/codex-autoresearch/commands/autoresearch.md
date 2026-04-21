---
description: Start, resume, inspect, run next, export, stop, or clear a Codex Autoresearch session. Arguments: start text, next, status, export, off, clear, or help.
---

# Autoresearch

Interpret `$ARGUMENTS` as a subcommand or session goal.

## Local Plugin Routing

This command doc is the canonical CLI walkthrough for repo-local autoresearch runs. When this repository is the target, use the local plugin over any globally installed copy, including any marketplace-cache copy. Treat `plugins/codex-autoresearch` as `<plugin-root>` and prefer `node <plugin-root>/scripts/autoresearch.mjs ...` until the current iteration is complete.

From the repository root:

```bash
node plugins/codex-autoresearch/scripts/autoresearch.mjs mcp-smoke
node plugins/codex-autoresearch/scripts/autoresearch.mjs doctor --cwd plugins/codex-autoresearch --check-benchmark
node plugins/codex-autoresearch/scripts/autoresearch.mjs next --cwd plugins/codex-autoresearch
node plugins/codex-autoresearch/scripts/autoresearch.mjs export --cwd plugins/codex-autoresearch
```

From `plugins/codex-autoresearch`, use `node scripts/autoresearch.mjs ...` with the target project passed through `--cwd`.

For MCP, the local `.mcp.json` starts `./scripts/autoresearch-mcp.mjs` with `cwd` set to `.` and `startup_timeout_sec` set. That entrypoint is intentionally tiny: it answers `initialize` and `tools/list` before loading the full CLI, then shells out to `scripts/autoresearch.mjs` only for `tools/call`. Run `node <plugin-root>/scripts/autoresearch.mjs mcp-smoke` to verify the stdio server directly.

Direct CLI sequence:

```bash
node <plugin-root>/scripts/autoresearch.mjs setup-plan --cwd <current-project>
node <plugin-root>/scripts/autoresearch.mjs recipes list
node <plugin-root>/scripts/autoresearch.mjs setup --cwd <current-project> --name "test speed" --metric-name seconds --metric-unit s --direction lower --benchmark-command "npm test -- --runInBand" --checks-command "npm test" --max-iterations 50
node <plugin-root>/scripts/autoresearch.mjs doctor --cwd <current-project> --check-benchmark
node <plugin-root>/scripts/autoresearch.mjs export --cwd <current-project>
node <plugin-root>/scripts/autoresearch.mjs next --cwd <current-project>
node <plugin-root>/scripts/autoresearch.mjs log --cwd <current-project> --from-last --status keep --description "Use worker pool" --commit-paths "src,test"
node <plugin-root>/scripts/autoresearch.mjs export --cwd <current-project>
```

After any start or resume path, directly provide the dashboard file link before continuing with experiments or status narration. Use a clickable Markdown link to the absolute `autoresearch-dashboard.html` path, for example `[autoresearch-dashboard.html](/absolute/project/path/autoresearch-dashboard.html)`.

## Active Loop Contract

An active autoresearch run is not a one-shot command. After `next`, log the packet. After `log`, follow the returned `continuation` object. If `continuation.shouldContinue` is true, keep working in the same conversation: pick the next hypothesis, edit, run `next`, and log again. If `continuation.forbidFinalAnswer` is true, do not return a final answer between runs; use brief progress updates until a stop condition is reached.

## Dispatch

Use the local routing above when this repository is the target.

- Empty or `help`: summarize available actions.
- `setup-plan`: run `node <plugin-root>/scripts/autoresearch.mjs setup-plan --cwd <current-project>` to get a read-only guided setup plan, missing fields, recipe recommendation, and exact next setup command. Add `--catalog <path-or-url>` when planning from a local or remote recipe catalog.
- `recipes ...`: run `node <plugin-root>/scripts/autoresearch.mjs recipes list|show ...` to inspect built-in or local/remote catalog benchmark recipes. Catalog recipe IDs can be used by `setup --recipe <id> --catalog <path-or-url>`.
- `doctor`: run `node <plugin-root>/scripts/autoresearch.mjs doctor --cwd <current-project> --check-benchmark` when a benchmark is configured, then report issues, warnings, and next action.
- `next`: run `node <plugin-root>/scripts/autoresearch.mjs next --cwd <current-project>`, then report doctor status, metric, allowed log statuses, ASI template, and next action.
- `log`: run `node <plugin-root>/scripts/autoresearch.mjs log --cwd <current-project> --from-last --status <keep|discard|crash|checks_failed> --description <text>`, then follow `continuation`; do not ask the user to rerun `autoresearch-create` for the next packet.
- `config ...`: run `node <plugin-root>/scripts/autoresearch.mjs config --cwd <current-project> ...` for runtime settings such as `--autonomy-mode`, `--checks-policy`, `--keep-policy`, `--extend`, and `--dashboard-refresh-seconds`.
- `status`: run `node <plugin-root>/scripts/autoresearch.mjs state --cwd <current-project>` and summarize.
- `export`: use the `autoresearch-dashboard` skill or run `node <plugin-root>/scripts/autoresearch.mjs export --cwd <current-project>`.
- `off`: stop continuing the loop in this conversation. Do not delete files; report where the session can be resumed.
- `clear`: use MCP `clear_session` or run `node <plugin-root>/scripts/autoresearch.mjs clear --cwd <current-project> --yes` after confirming the target project path.
- `research <goal>`: use the `autoresearch-deep-research` skill or MCP `setup_research_session` to create `autoresearch.research/<slug>/`, initialize a `quality_gap` session, then measure gaps with `quality-gap`.
- `gap-candidates`: run `node <plugin-root>/scripts/autoresearch.mjs gap-candidates --cwd <current-project> --research-slug <slug>` to extract validated candidates from synthesis and optional model-command JSON; add `--apply` only after reviewing the candidates.
- `finalize-preview`: run `node <plugin-root>/scripts/autoresearch.mjs finalize-preview --cwd <current-project>` to inspect review-branch readiness without creating branches.
- `serve`: run `node <plugin-root>/scripts/autoresearch.mjs serve --cwd <current-project>` to start the local live dashboard and safe action endpoints.
- `integrations ...`: run `node <plugin-root>/scripts/autoresearch.mjs integrations list|doctor|sync-recipes` to inspect additive integration surfaces such as recipe catalogs and model commands.
- Any other text: use the `autoresearch-create` skill to start or resume the loop using the text as the goal/context, then export or refresh `autoresearch-dashboard.html` and directly provide the dashboard file link.

## Safety

Before `clear`, show the absolute files that will be deleted and ask for confirmation. `clear_session` and CLI `clear --yes` are the only session-deletion paths.

Before starting a new loop, check git status. If the worktree is dirty, ask whether to branch from the current state, commit first, or stop.

Before logging a kept result in a dirty tree, prefer scoped commit paths from the session scope or ask the user to confirm broad staging.

After `next`, prefer `log --from-last` so Codex does not retype parsed metrics from the previous packet. Still choose `keep` or `discard` deliberately based on the metric and ASI.

Before logging a discard/crash/checks-failed result, use configured `commitPaths`/`revertPaths`. Do not pass `--allow-dirty-revert` unless the user explicitly accepts broad cleanup.

When calling MCP tools with custom shell commands, pass `allow_unsafe_command: true` only after confirming the command and target directory.

For qualitative research loops, use `autoresearch-deep-research`. Its benchmark counts unchecked items in `autoresearch.research/<slug>/quality-gaps.md`, so the loop can continue until high-impact findings are implemented, intentionally rejected with evidence, or no longer relevant.

Model-assisted gap generation must stay provider-agnostic. Use `gap-candidates --model-command <cmd>` only when the command prints a JSON array of candidate objects; the helper validates and previews the output before `--apply`.

Dashboard live actions are local-only and limited to safe commands: doctor, setup-plan, recipes, gap-candidates preview, finalize-preview, and export. Mutating review branch creation remains in `/autoresearch-finalize`.

When using this repo-local copy, `<plugin-root>` is `plugins/codex-autoresearch`.
