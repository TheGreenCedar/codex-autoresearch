# AGENTS.md

## Purpose And Scope

- Optimize for evidence, resumability, and small reviewable diffs.
- This file is the repository-maintainer contract. It is not the Autoresearch operator manual, a command inventory, or a detailed architecture index.
- The repository root is a wrapper. The product package is `plugins/codex-autoresearch`.
- Before running Git, installs, builds, tests, release work, or Autoresearch commands, identify the owning repository, package root, and target `--cwd`.
- Start mutation work with `git status --short --branch`. Preserve unrelated changes and do not broaden cleanup to make the tree convenient.
- Package scripts live in `plugins/codex-autoresearch/package.json`; root npm commands are not product evidence unless root scripts are added later.
- Use the repository checkout when changing Autoresearch itself. Treat source behavior and installed-plugin behavior as different until their version and built-entrypoint fingerprint agree.

## Canonical Sources

Read the smallest relevant owner before changing a contract:

| Question | Canonical source |
| --- | --- |
| Public promise, installation, and first run | root `README.md` |
| Codex operator behavior | `plugins/codex-autoresearch/skills/codex-autoresearch/SKILL.md` and its relevant reference |
| Documentation audiences and invariant product facts | `plugins/codex-autoresearch/docs/STYLE.md` |
| Implementation ownership and package shape | `plugins/codex-autoresearch/docs/architecture.md` |
| Shared CLI, report, and dashboard decisions | `plugins/codex-autoresearch/docs/control-plane.md` |
| Development, checks, packaging, and release | `plugins/codex-autoresearch/docs/maintainers.md` |
| Command names, arguments, policies, help, handlers, and compatibility | `plugins/codex-autoresearch/lib/command-table.ts` |
| User-facing release history | root `CHANGELOG.md` |
| Executable package commands | `plugins/codex-autoresearch/package.json` |
| Release and branch behavior | `.github/workflows/` |

Do not maintain a second command list, module inventory, operator runbook, or release procedure here. A disagreement between code, tests, workflows, skill, docs, terminal output, and dashboard is drift to resolve, not permission to choose the convenient version.

## Stable Product Boundaries

- The product is a private Codex marketplace plugin with a CLI and one Codex skill. Do not restore retired subskills, slash-command documentation, MCP launchers, or a default MCP server without an explicit product-direction change and corresponding migration work.
- The dashboard is a read-only projection. Setup, packet execution, logging, gap mutation, export, and finalization remain CLI-owned.
- State, doctor, terminal reports, `recommend-next`, dashboard, and finalization must project one validated `resolvedDecision`. Consumers must not independently rederive the blocker or next action.
- `plugins/codex-autoresearch/lib/command-table.ts` is the one-edit authority for public command identity and policy. Do not add commands independently to help, schemas, handlers, compatibility facades, or dashboard safety.
- Preserve the evidence invariants named in `plugins/codex-autoresearch/docs/STYLE.md`: finite metric rules, no invented sentinel metrics, `measure` is not a keep, `quality_gap=0` is round-local, and ordinary finalization uses accepted current keeps.
- `finalize-current-tree` is an exceptional recovery contract. Use it only when canonical state routes there; review the exact clean non-session branch diff and plan before mutation.
- Malformed, stale, missing, or unproven evidence remains unknown or blocking. Do not coerce it into success.
- Respect session locks, pending transaction receipts, process-lifecycle blockers, protected paths, and configured Git scope. Do not bypass them because the intended result appears obvious.
- Benchmark and checks commands are not sandboxed. Packet environments remain minimal by default, working directories stay within `--cwd` unless explicitly authorized, and secrets must stay out of command lines and output.

## Source And Package Boundaries

- Authored runtime behavior lives in TypeScript under `plugins/codex-autoresearch/lib/` and `plugins/codex-autoresearch/scripts/`. Keep public `.mjs` launchers small; edit standalone `.mjs` utilities only when they intentionally have no TypeScript owner.
- `plugins/codex-autoresearch/dashboard/src/` is the dashboard UI source.
- `plugins/codex-autoresearch/dist/` and `plugins/codex-autoresearch/assets/dashboard-build/` are generated and ignored in source but required in release artifacts. Do not hand-edit or commit them.
- A source launcher may rebuild local source when dependencies are present or hydrate the matching released runtime when they are not. A successful launcher probe alone is not evidence that unbuilt source edits are active.
- Changes to package `files`, public launchers, built entrypoints, or dashboard runtime assets must keep package contents, bootstrap archive validation, hydration behavior, and pack-and-extract smoke synchronized.
- If the same bug class occurs twice, add a narrow regression test or product gate instead of another cautionary paragraph.

## Local Routing

From the wrapper root:

```bash
node plugins/codex-autoresearch/scripts/autoresearch.mjs --help
```

From the package root:

```bash
node scripts/autoresearch.mjs --help
node scripts/autoresearch.mjs --help --all
```

Use live help for advanced and maintainer commands instead of copying their inventory into documentation. When testing authored source, ensure dependencies are installed and build the relevant runtime before treating launcher output as source evidence.

## Change Synchronization

- Keep the root `README.md` and ordinary topic docs written for people using the plugin. Do not put Codex self-instructions or contributor checklists there.
- Update the skill when Codex operator behavior changes.
- Update the nearest topic doc when workflow, trust, architecture, dashboard, finalization, packaging, or release behavior changes.
- Update root `CHANGELOG.md` for user-facing behavior, documentation, skill, command-surface, dashboard, migration, or version changes. Removed invocation surfaces need migration guidance.
- For command changes, edit `plugins/codex-autoresearch/lib/command-table.ts`, the focused implementation, and schema-driven parity tests. Compatibility commands require an exact migration error, replacement, and removal date.
- Update `plugins/codex-autoresearch/scripts/operator-task-benchmark.ts` and its tests when a bounded externally observed operator contract changes; its `.mjs` counterpart remains a launcher.
- Do not add tests that pin editorial prose. Test stable identifiers, structure, links, package contents, schemas, and behavior.
- Prefer replacing stale guidance over appending a second version.

## Dashboard Work

- After dashboard source, view-model, copy, layout, or visual changes, rebuild and inspect a served or exported dashboard.
- Keep review exports, screenshots, and generated bundles under ignored `tmp/` paths.
- Update `plugins/codex-autoresearch/assets/showcase/dashboard-demo.png` only when the maintained public showcase should intentionally reflect the change.
- Do not reintroduce tracked demo HTML or `plugins/codex-autoresearch/assets/dashboard-build/`.
- Verify that dashboard and terminal surfaces agree on the canonical decision, blocker, command, runtime provenance, and finalization state.

## Verification

Node.js 24 or newer is the supported development floor.

Use focused package scripts while iterating. Before claiming product, skill, README, or package-documentation work complete, run from `plugins/codex-autoresearch`:

```bash
npm run check
git diff --check
```

Additional evidence requirements:

- Dashboard-visible changes require served or exported visual inspection and `npm run test:dashboard:browser`.
- Run `npm run test:dashboard:cross-browser` for release-critical layout, interaction, accessibility, or browser-compatibility changes. These real-browser gates are separate from `npm run check`.
- Packaging and release changes require packed-artifact inspection, extracted-launcher smoke, and source-shaped hydration coverage when affected.
- Workflow changes require `node .github/scripts/check-workflow-policy.mjs`; external actions remain pinned to full commit SHAs.
- An `AGENTS.md`-only change requires rendered Markdown inspection and `git diff --check`.
- If a required check cannot run, report exactly what was skipped and why.

## Git And Release Work

- Keep diffs focused. Avoid drive-by cleanup, unrelated renames, and style churn.
- Never overwrite, revert, or clean user changes unless explicitly asked.
- Do not use destructive Git commands without explicit authorization.
- Inspect the active branch and remotes before finalization, push, PR, or release claims.
- Repository policy permits PRs into `main` only from the same repository's `dev` branch.
- Synchronize version changes across `plugins/codex-autoresearch/package.json`, both `plugins/codex-autoresearch/package-lock.json` version fields, `plugins/codex-autoresearch/.codex-plugin/plugin.json`, root `CHANGELOG.md`, and intentional version assertions.
- Do not push release tags manually.
- A synchronized stable version bump landing on `main` triggers Auto Release. Manual release dispatch is a recovery path.
- Before claiming a release is live, inspect the workflow result, GitHub release and tag, packaged artifact, provenance evidence, and installed runtime when relevant.
- Do not commit secrets, credentials, generated caches, private logs, or unrelated experiment artifacts.

## Handoff

Final reports after changes must state:

- what changed and where
- what evidence or behavior motivated it
- what was verified
- what was skipped
- any remaining risk, runtime drift, or release-state assumption
