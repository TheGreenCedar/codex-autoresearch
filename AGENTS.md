# AGENTS.md

## First Principles

- Optimize for evidence, resumability, and small reviewable diffs.
- Keep human docs for humans and agent contracts for Codex. Root `README.md` and `docs/*` (except maintainers, architecture, control-plane) speak to **you** — outcomes first. `SKILL.md` and `references/*` speak to Codex with executable steps. See `plugins/codex-autoresearch/docs/STYLE.md`.
- Treat this file as repo-local operating guidance for Codex. Keep it practical and current; move long procedures into `plugins/codex-autoresearch/docs/` or the plugin skill.
- Identify the owning repo/package before running Git, installs, builds, tests, release commands, or Autoresearch commands. This wrapper root is not the package root.
- Use the repo-local source checkout for Autoresearch work in this repo before trusting a globally installed or marketplace-cache copy.
- Do not present source edits as live plugin behavior until the active runtime surface has been checked when runtime drift is possible.

## Repository Shape

- The active product package lives in `plugins/codex-autoresearch`.
- The root `README.md` is the public front door. Keep it friendly for users evaluating or installing the plugin; do not put Codex self-instructions or agent checklists there.
- The root `CHANGELOG.md` is the release-note surface for user-facing behavior, docs, skill, command-surface, dashboard, migration, or version changes.
- The main Codex-facing skill is `plugins/codex-autoresearch/skills/codex-autoresearch/SKILL.md`. It is the single skill surface; do not revive old dashboard/finalizer subskills or slash-command docs.
- Topic docs live under `plugins/codex-autoresearch/docs/`. Use docs for durable workflow detail, not ad hoc notes in chat.
- Package scripts live in `plugins/codex-autoresearch/package.json`. Root `npm run check` and root `npm test` are not product evidence unless root scripts are added later.
- The package is private and distributed as a Codex plugin marketplace package, not as an operator-facing npm install.

## Product Contract

Codex Autoresearch turns "make this better" into a measured loop:

```text
setup -> doctor -> next -> log -> state -> finalize-preview
```

- Benchmark commands must print `METRIC name=value`. The primary metric drives decisions; secondary metrics explain or guard tradeoffs.
- Use `ARTIFACT name=path` only for benchmark-produced evidence that resolves inside the target working directory.
- Prefer durable loop state over chat memory: `autoresearch.md`, `autoresearch.jsonl`, `autoresearch.config.json`, `autoresearch.ideas.md`, Git-private `.git/autoresearch/last-run.json`, `.git/autoresearch/progress.json`, `.git/autoresearch/pending-log-*.json`, non-Git fallback `autoresearch.last-run.json`, `autoresearch.progress.json`, `autoresearch.pending-transaction.json`, `autoresearch.research/<slug>/`, evidence index files, and ASI.
- `keep`, ordinary `discard`, and `measure` need a finite primary metric. `crash` and `checks_failed` must not invent sentinel metric values.
- Use `measure` for baselines, no-change probes, environment checks, and diagnostic evidence. It is not a keep and not a finalizer input.
- `quality_gap=0` only closes the accepted checklist for the current research round. It does not prove discovery is complete forever.
- Accepted/current kept evidence can drive finalization. Rejected, provisional, superseded, quarantined, invalidated, later-discarded, or reverted evidence is audit-visible only.

## Local Command Routing

From the wrapper root:

```bash
node plugins/codex-autoresearch/scripts/autoresearch.mjs --help
node plugins/codex-autoresearch/scripts/autoresearch.mjs doctor --cwd plugins/codex-autoresearch --check-benchmark --explain
node plugins/codex-autoresearch/scripts/autoresearch.mjs state --cwd plugins/codex-autoresearch --report
node plugins/codex-autoresearch/scripts/autoresearch.mjs export --cwd plugins/codex-autoresearch
```

From the package root:

```bash
node scripts/autoresearch.mjs --help
node scripts/autoresearch.mjs doctor --cwd . --check-benchmark --explain
node scripts/autoresearch.mjs state --cwd . --report
```

- Use `setup-plan` or `prompt-plan` for read-only planning when essentials are unclear. Use `setup` only when the goal, benchmark, primary metric, direction, and scope are known enough to create files.
- Use `benchmark-lint` before trusting a new benchmark or ambiguous output.
- After `next`, log the fresh packet with `log --from-last`; do not retype parsed metrics unless you are deliberately recording a raw probe with `--metric`.
- Before spending another packet, read `state --report`, `state --compact`, or `recommend-next --compact` and obey blockers.
- Use advanced diagnostics only when the short path is blocked, stale, expensive, or too vague: `onboarding-packet`, `recommend-next`, `benchmark-inspect`, `checks-inspect`, `partial-results`, `session-forensics`, `research-fanout`, `lane-runner`, `new-segment`, `promote-gate`, `codex-goal-brief`, and `guide`.

## Implementation Map

- Public launchers live in `scripts/*.mjs`. Keep them tiny bootstrap shims where intended; `scripts/bootstrap-runtime.mjs` hydrates the packaged `dist/` runtime for source-shaped plugin installs.
- Authored Node/CLI code is TypeScript under `scripts/*.ts` and `lib/**/*.ts`. Keep tracked `.mjs` surfaces synchronized when the product gate expects them.
- Command identity, argument schemas, safety policy, help, handler bindings, and compatibility lifecycle live in `lib/command-table.ts`; `lib/tool-schemas.ts` and `lib/tool-registry.ts` are derived compatibility facades. CLI dispatch and command behavior live in `scripts/autoresearch.ts`, `lib/cli-handlers.ts`, `lib/commands/*`, and `lib/action-metadata.ts`.
- Session state, metrics, packet evidence, runner behavior, recipes, research gaps, and source hygiene live in `lib/session-core.ts`, `lib/runner.ts`, `lib/recipes.ts`, `lib/research-gaps.ts`, `lib/evidence-*`, `lib/task-artifact-indexer.ts`, and `lib/cli/source-hygiene.ts`.
- Decision guidance lives in `lib/decision-guidance.ts`, `lib/loop-governance.ts`, `lib/operator-checklist.ts`, `lib/session-decision-capsule.ts`, `lib/gate-quality.ts`, `lib/preflight-audit.ts`, `lib/packet-diagnostics.ts`, `lib/runtime-drift-doctor.ts`, `lib/source-cleanliness.ts`, `lib/portfolio-advisor.ts`, and `lib/lane-lifecycle.ts`.
- Finalization behavior lives in `scripts/finalize-autoresearch.ts`, `scripts/finalize-autoresearch.mjs`, `lib/finalize-preview.ts`, `lib/finalization-plan.ts`, and `lib/finalization-acceptance.ts`.
- Dashboard data shaping and live-readout behavior live in `lib/dashboard-view-model.ts`, `lib/live-server.ts`, `lib/dashboard-health.ts`, `lib/dashboard-server-registry.ts`, and `lib/dashboard-command-safety.ts`.
- Dashboard UI source lives in `dashboard/src/`; `assets/dashboard-build/` is generated/ignored output built by dashboard, package, and check flows.
- Product-quality gates live in `scripts/check.ts`, `scripts/check.mjs`, `scripts/operator-task-benchmark.ts`, and `scripts/operator-task-benchmark.mjs`.

## Dashboard Rules

- The dashboard is a read-only readout, not a control plane. Setup, packet execution, logging, gap review, export, and finalization stay in the CLI.
- Be explicit about mode. `serve --cwd <project>` returns a live local readout; `export --cwd <project>` writes a static read-only snapshot.
- Do not add visible live mutation controls, action routes, command-copy panels for mutating commands, or finalization mutations to the dashboard.
- Dashboard and terminal reports must agree on the canonical next action, blockers, runtime provenance, packet diagnostics, source cleanliness, and finalization pressure.
- After dashboard UI, dashboard model, visual copy, or generated asset changes, rebuild and inspect the dashboard surface. Refresh appropriate checked-in review/export/showcase evidence that represents the UI, such as demo exports or `assets/showcase/dashboard-demo.png` when intentionally affected, but do not reintroduce tracked `assets/dashboard-build/` bundles.

## Runtime And Packaging Truth

- This plugin is CLI/skill-only. Do not add a default MCP server declaration or MCP launcher unless the product direction explicitly changes and the docs, package checks, and migration notes change with it.
- Source checkouts intentionally do not track `plugins/codex-autoresearch/dist/`. Release/package artifacts must include `dist/`.
- The package artifact must include `.codex-plugin/`, `docs/`, `skills/`, generated dashboard-build assets, small launcher scripts, and compiled `dist/`; it must not leak authored source, tests, examples, MCP config, or stale MCP launchers.
- If installed Codex behavior differs from source, inspect the active cache under the user's Codex plugin cache and compare version plus built-entrypoint fingerprint before editing source again.
- Common drift layers are wrong cwd, stale marketplace cache, old versioned cache, runtime hydration, command metadata mismatch, generated asset drift, and slow full-CLI imports. Identify the layer before retrying the same live-service action.

## Documentation And Skill Sync

When behavior, architecture, command surfaces, dashboard behavior, safety rules, release behavior, or file structure changes, update the nearest durable surface:

- root `README.md` for the public promise and short start path
- root `CHANGELOG.md` for user-facing changes and migration notes
- `skills/codex-autoresearch/SKILL.md` for Codex operator behavior
- the closest topic doc under `plugins/codex-autoresearch/docs/`
- CLI help, schemas, tests, and `scripts/operator-task-benchmark.mjs` when command contracts or bounded operator-task expectations change

Keep root-relative links valid. Prefer rewriting stale guidance over appending duplicates.
Removed invocation surfaces need migration notes.

## Autoresearch Safety

- Check Git state before setup, packet work, logging, discard cleanup, finalization, version bumps, or release work.
- Configure `commitPaths` or pass `--commit-paths` for kept results in Git repos. Use `--allow-add-all` only when every dirty file belongs in the kept commit.
- Use scoped `revertPaths` for discard cleanup. Do not run broad cleanup on a dirty tree unless the user explicitly accepts that risk.
- If a change was already committed outside the helper, log it with the real commit hash so the ledger records truth instead of staging again.
- Treat protected benchmark path drift, secondary metric constraint violations, stale last-run packets, corrupt JSONL, runtime drift, dirty source, missing commit paths, and failed checks as trust blockers until resolved or explicitly accepted.
- Autoresearch does not sandbox benchmark or checks commands. Review generated commands, avoid secrets in command lines/output, and prefer `--command-file` or `--packet-env-file` for fragile or sensitive setup.

## Version And Release Work

For a version bump, update synchronized version surfaces together:

- `plugins/codex-autoresearch/package.json`
- `plugins/codex-autoresearch/package-lock.json`
- `plugins/codex-autoresearch/.codex-plugin/plugin.json`
- root `CHANGELOG.md`
- any tests or docs that intentionally assert or display the version

- Run the package verification gate before committing or publishing release work.
- Do not push release tags by hand. Current workflows build, check, pack, smoke-test, and create the release/tag after the version bump lands on the release branch. Inspect `.github/workflows/` before claiming a release is live.
- If the user says `bump`, `push`, `publish`, `promote`, or asks whether the release is live, treat it as an end-to-end request when credentials and risk allow: update surfaces, verify, commit, push, inspect workflow/runtime evidence, and report concrete status.

## Verification

Use the narrowest relevant check while iterating. Before claiming plugin work is done, run the package gate from `plugins/codex-autoresearch` unless the change is clearly outside package behavior:

```bash
npm run check
```

`npm run check` covers typecheck, lint, format check, syntax checks, source hygiene, dashboard rebuild parity, demo trust, source-checkout launcher rules, dogfood health, compiled tests, and package smoke.

Targeted checks:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:cli
npm run test:dashboard
npm run test:finalize
npm run test:core
node scripts/autoresearch.mjs --help
node scripts/autoresearch.mjs doctor --cwd . --check-benchmark --explain
node scripts/autoresearch.mjs benchmark-lint --cwd .
git diff --check
```

- For dashboard/view-model changes, build or serve/export the dashboard and inspect the readout. Tests alone do not prove the operator surface is understandable.
- For packaging/release changes, inspect the packed artifact and smoke the extracted launcher path.
- For docs-only or AGENTS-only changes, at minimum inspect the changed markdown and run `git diff --check`.
- If full verification is not possible, state exactly what was skipped and why.

## Git And Change Hygiene

- Keep diffs tight and reviewable. Avoid drive-by cleanup, unrelated renames, and style churn.
- Never overwrite, revert, or clean up user changes unless explicitly asked.
- Do not use destructive Git commands unless the user explicitly requested them.
- Prefer direct non-interactive Git commands.
- Do not assume the active branch is `main`; inspect branch and remotes before finalization, push, or release claims.
- Do not commit secrets, local credentials, generated caches, private logs, or unrelated experiment artifacts.

## Communication

- Report from evidence: command output, file state, tests, runtime probes, dashboard URLs, package smoke, workflow status, or Git state.
- When debugging live plugin behavior, do not repeat a failed reinstall, retry, or cache refresh unless a precondition changed.
- When asked for product study or delight improvements, start from current docs, roadmap-like artifacts, dashboard behavior, existing `autoresearch.research/*` artifacts, and command/report output before inventing a direction.
- Final responses after code changes should say what changed, where it changed, what was verified, and any remaining risk or assumption.
