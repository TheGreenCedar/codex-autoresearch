# AGENTS.md

## Project Shape

- This repository is a wrapper for the Codex Autoresearch plugin. The active product code lives under `plugins/codex-autoresearch`.
- Treat `plugins/codex-autoresearch` as the package root for implementation, checks, tests, release metadata, the main plugin skill, MCP server code, and dashboard assets.
- The root `README.md` is the only README and the public-facing documentation surface. Keep root-relative links valid.
- The root `CHANGELOG.md` is the release-note surface. Update it for user-facing behavior, docs, skill, command-surface, dashboard, MCP, migration, or version changes.
- Do not assume root-level npm scripts exist. The package scripts live in `plugins/codex-autoresearch/package.json`.

## Product Intent

- Codex Autoresearch is a measured, resumable optimization loop for Codex: choose one metric, run a benchmark, keep or discard changes with evidence, preserve ASI, export the dashboard, and finalize kept work into reviewable branches.
- Preserve the core contract: benchmark commands print `METRIC name=value`; primary metrics drive decisions; secondary metrics explain tradeoffs.
- Prefer durable loop state over chat memory. Important session knowledge belongs in `autoresearch.md`, `autoresearch.ideas.md`, `autoresearch.jsonl`, `autoresearch.research/<slug>/`, dashboard snapshots, and ASI.
- For qualitative or broad product-study work, convert accepted findings into a `quality_gap` checklist. `quality_gap=0` closes the accepted checklist for the current round; it does not mean discovery is permanently complete.
- The main product gap from prior work is guided decision flow. When product direction is ambiguous, prioritize making the next safe action obvious over adding more raw panels or low-level knobs.

## Local Plugin Routing

- When this repo is the target, use the repo-local plugin over any globally installed or marketplace-cache copy.
- From the repository root, prefer:

```bash
node plugins/codex-autoresearch/scripts/autoresearch.mjs mcp-smoke
node plugins/codex-autoresearch/scripts/autoresearch.mjs doctor --cwd plugins/codex-autoresearch --check-benchmark
node plugins/codex-autoresearch/scripts/autoresearch.mjs next --cwd plugins/codex-autoresearch
node plugins/codex-autoresearch/scripts/autoresearch.mjs export --cwd plugins/codex-autoresearch
```

- From `plugins/codex-autoresearch`, use `node scripts/autoresearch.mjs ...` and pass the target project with `--cwd`.
- The canonical agent workflow doc is `plugins/codex-autoresearch/skills/codex-autoresearch/SKILL.md`. Update it when command flow, safety rules, dashboard reporting behavior, or finalization behavior changes.

## Implementation Map

- CLI command handling is split between `scripts/autoresearch.mjs` and `lib/cli-handlers.mjs`.
- MCP tool schemas and argument validation live in `lib/mcp-tool-schemas.mjs`; in-process dispatch lives in `lib/mcp-interface.mjs`; stdio CLI bridging lives in `lib/mcp-cli-adapter.mjs`; the lightweight wrapper lives in `scripts/autoresearch-mcp.mjs`.
- Session state and metrics logic live in `lib/session-core.mjs`; keep script-facing and library-facing behavior in sync.
- Dashboard data shaping lives in `lib/dashboard-view-model.mjs`; dashboard HTML/CSS/JS lives in `assets/template.html`.
- Runner behavior lives in `lib/runner.mjs`; recipes and research-gap logic live in `lib/recipes.mjs` and `lib/research-gaps.mjs`.
- Finalization behavior lives in `scripts/finalize-autoresearch.mjs` and related tests.
- Product-quality expectations are encoded in `scripts/perfection-benchmark.mjs`. Update this benchmark when public commands, docs, MCP contracts, or session hygiene expectations intentionally change.
- Keep `skills/codex-autoresearch/SKILL.md`, the root README, the root changelog, tests, and MCP schemas synchronized when user-facing contracts change.

## MCP And Cache Drift

- The local MCP config is `plugins/codex-autoresearch/.mcp.json`. It should launch `node ./scripts/autoresearch-mcp.mjs` with `cwd: "."` and a startup timeout.
- Keep `scripts/autoresearch-mcp.mjs` lightweight. It should answer `initialize` and `tools/list` from static metadata before loading or spawning heavier CLI behavior for `tools/call`.
- For MCP startup failures, do not guess. Check the direct smoke path first:

```bash
node plugins/codex-autoresearch/scripts/autoresearch.mjs mcp-smoke
```

- If the installed Codex plugin behaves differently from source, verify the live runtime with `codex mcp get codex-autoresearch` and inspect the versioned cache under the user's Codex plugin cache. Source files and installed runtime can drift.
- Typical MCP failure layers are wrong cwd, stale marketplace cache, old versioned cache, schema/tool metadata mismatch, startup noise, and slow full-CLI imports. Identify the layer before changing timeouts.

## Autoresearch Workflow Safety

- Before starting or resuming a loop, check Git state. If the tree is dirty, distinguish user edits from experiment edits and avoid broad cleanup.
- After `next`, log the packet with `--from-last` instead of retyping parsed metrics. Choose `keep`, `discard`, `crash`, or `checks_failed` deliberately.
- Include useful ASI on every log entry: hypothesis, evidence, rollback reason when relevant, and a specific next-action hint.
- In Git repos, kept results should use configured `commitPaths` or `--commit-paths`. Use `--allow-add-all` only when every dirty file belongs in the kept commit.
- Discard, crash, and checks-failed cleanup should use scoped `commitPaths` or `revertPaths`. Do not use broad dirty-tree cleanup unless the user explicitly accepts that risk.
- If a change was already committed outside the helper, log it with `--commit <hash>` so autoresearch records the truth instead of staging again.

## Dashboard Rules

- Be explicit about dashboard mode. `autoresearch-dashboard.html` is a static read-only export with embedded data and no inert live controls or command-copy panel.
- The served dashboard from `node scripts/autoresearch.mjs serve --cwd <project>` is the live-action surface.
- Keep live dashboard actions local-only and bounded to safe operations such as doctor, setup-plan, recipes, gap-candidates preview, finalize-preview, export, and confirmed log decisions.
- Mutating finalization stays outside the dashboard surface.
- After dashboard or view-model changes, export or serve a dashboard and inspect the result, not just the tests.

## Version And Release Work

- For a version bump, update all version surfaces together:
  - `plugins/codex-autoresearch/package.json`
  - `plugins/codex-autoresearch/.codex-plugin/plugin.json`
  - `plugins/codex-autoresearch/scripts/autoresearch.mjs` `serverInfo.version`
  - `plugins/codex-autoresearch/scripts/autoresearch-mcp.mjs` `VERSION`
  - `CHANGELOG.md`
  - any tests or docs that intentionally assert or display the version
- For non-versioned user-facing changes, add or refresh the newest dated or versioned `CHANGELOG.md` entry. Removed invocation surfaces need migration notes.
- Run the plugin verification gate before committing or publishing a release.
- If the user says `bump`, `push`, `publish`, `promote`, or asks whether the release is live, treat it as an end-to-end request when credentials and risk allow: update, verify, commit, push, refresh or inspect the installed runtime, and report the live evidence.

## Verification

- Use the narrowest relevant check while iterating, then run the plugin gate before claiming done.
- Useful targeted checks:

```bash
node --check plugins/codex-autoresearch/scripts/autoresearch.mjs
node --check plugins/codex-autoresearch/scripts/autoresearch-mcp.mjs
node --test plugins/codex-autoresearch/tests/autoresearch-cli.test.mjs
node --test plugins/codex-autoresearch/tests/dashboard-verification.test.mjs
node plugins/codex-autoresearch/scripts/autoresearch.mjs mcp-smoke
git diff --check
```

- Full plugin checks from `plugins/codex-autoresearch`:

```bash
npm run check
npm test
```

- `npm run check` is the main product/release gate. It includes syntax checks, the perfection benchmark with `quality_gap=0`, help checks, and the test suite.
- Root `npm run check` or root `npm test` may fail with missing scripts; that is a repo-shape issue, not product evidence.
- If full verification is not possible, say exactly which check was skipped and why.

## Git And Change Hygiene

- Keep diffs tight and reviewable. Avoid drive-by cleanup, unrelated renames, and style churn.
- Do not overwrite or revert user changes. If unrelated files are dirty, work around them.
- Avoid destructive Git commands unless the user explicitly requested them.
- Prefer direct, non-interactive Git commands. On this repo, the usual branch is `main` and the remote is `origin`.
- For final responses after code changes, report what changed, where it changed, what was verified, and any remaining risk.

## Communication Defaults

- The user usually wants execution after direction is clear. Do not stop at analysis when implementation and verification are feasible.
- Report from evidence: command output, file state, tests, version checks, dashboard exports, or runtime probes.
- When debugging live plugin behavior, avoid repeating a failed reinstall or retry unless a precondition changed. Find the failing layer first.
- When asked for product study or delight improvements, start from the current docs, roadmap, dashboard behavior, and existing `autoresearch.research/*` artifacts before inventing a new direction.
