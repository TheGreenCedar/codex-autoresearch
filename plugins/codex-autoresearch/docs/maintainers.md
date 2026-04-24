# Maintainers

This repository is a wrapper for the Codex Autoresearch plugin. The active package root is `plugins/codex-autoresearch`.

## Repo Shape

- Root `README.md` is the only README and the public documentation surface.
- Root `CHANGELOG.md` is the release-note surface for user-facing changes.
- The main skill is `plugins/codex-autoresearch/skills/codex-autoresearch/SKILL.md`.
- Topic docs live in `plugins/codex-autoresearch/docs/`.
- Current task docs are `start.md`, `operate.md`, `trust.md`, `finish.md`, `recipes.md`, `troubleshooting.md`, and `hooks.md`.
- Internal planning archives are not first-run onboarding.

Do not assume root-level npm scripts exist. Package scripts live in `plugins/codex-autoresearch/package.json`.

## Local Plugin Routing

When this repo is the target, use the repo-local plugin before any globally installed or marketplace-cache copy. Installed cache drift is real, annoying, and very good at wearing a source-code costume.

From the wrapper root:

```bash
node plugins/codex-autoresearch/scripts/autoresearch.mjs mcp-smoke
node plugins/codex-autoresearch/scripts/autoresearch.mjs doctor --cwd plugins/codex-autoresearch --check-benchmark
node plugins/codex-autoresearch/scripts/autoresearch.mjs next --cwd plugins/codex-autoresearch
node plugins/codex-autoresearch/scripts/autoresearch.mjs export --cwd plugins/codex-autoresearch
```

From `plugins/codex-autoresearch`, use:

```bash
node scripts/autoresearch.mjs mcp-smoke
node scripts/autoresearch.mjs doctor --cwd . --check-benchmark
```

## User-Facing Change Sync

When behavior, command surfaces, dashboard behavior, MCP contracts, migration behavior, or finalization behavior changes, keep these surfaces synchronized:

- root `README.md` for public promise and short getting-started path
- root `CHANGELOG.md` for release notes and migration notes
- `skills/codex-autoresearch/SKILL.md` for Codex operator behavior
- closest topic doc under `docs/`
- relevant tests and `scripts/perfection-benchmark.mjs` expectations
- MCP schemas or CLI help when tool or command contracts change

For non-versioned user-facing changes, refresh the newest dated changelog entry. Removed invocation surfaces need migration notes.

## Verification

Use the narrowest relevant check while iterating. Before claiming plugin work is done, run the product gate from `plugins/codex-autoresearch`:

```bash
npm run check
```

Useful targeted checks:

```bash
node --check scripts/autoresearch.mjs
node --check scripts/autoresearch-mcp.mjs
node --test tests/autoresearch-cli.test.mjs
node --test tests/dashboard-verification.test.mjs
node scripts/autoresearch.mjs mcp-smoke
npm pack --dry-run
git diff --check
```

For dashboard or view-model changes, export or serve a dashboard and inspect it. Static code and tests alone do not prove the operator surface is understandable.

When refreshing the checked-in demo, use the public showcase export so workstation paths and transient branch warnings are scrubbed:

```bash
node scripts/autoresearch.mjs export --cwd examples/demo-session --output autoresearch-dashboard.html --showcase
```

Before publishing, inspect the package artifact itself. The shipped `scripts/*.mjs` shims depend on `dist/`, so a publishable artifact must include the built runtime and exclude authored source and tests.

## Version Surfaces

For a version bump, update all version surfaces together:

- `plugins/codex-autoresearch/package.json`
- `plugins/codex-autoresearch/.codex-plugin/plugin.json`
- `plugins/codex-autoresearch/scripts/autoresearch.mjs` `serverInfo.version`
- `plugins/codex-autoresearch/scripts/autoresearch-mcp.mjs` `VERSION`
- root `CHANGELOG.md`
- any tests or docs that intentionally assert or display the version

If installed Codex behavior differs from source, inspect the active runtime before changing source again:

```bash
codex mcp get codex-autoresearch
```

Then check the versioned cache under the user's Codex plugin cache. Typical drift layers are wrong cwd, stale marketplace cache, old versioned cache, schema/tool metadata mismatch, startup noise, and slow full-CLI imports.
