# Maintainers

This repository is a wrapper for the Codex Autoresearch plugin. The active package root is `plugins/codex-autoresearch`.

## Repo Shape

- Root `README.md` is the only README and the public documentation surface.
- Root `CHANGELOG.md` is the release-note surface for user-facing changes.
- The main skill is `plugins/codex-autoresearch/skills/codex-autoresearch/SKILL.md`.
- Topic docs live in `plugins/codex-autoresearch/docs/`.
- Human-facing topic docs are `concepts.md`, `start.md`, `walkthrough.md`, `operate.md`, `trust.md`, `finish.md`, `recipes.md`, `troubleshooting.md`, and `hooks.md`.
- Internal planning archives are not first-run onboarding.

Do not assume root-level npm scripts exist. Package scripts live in `plugins/codex-autoresearch/package.json`.

## Local Plugin Routing

When this repo is the target, use the repo-local plugin before any globally installed or marketplace-cache copy. Installed cache drift is real, annoying, and very good at wearing a source-code costume.

From the wrapper root:

```bash
node plugins/codex-autoresearch/scripts/autoresearch.mjs --help
node plugins/codex-autoresearch/scripts/autoresearch.mjs doctor --cwd plugins/codex-autoresearch --check-benchmark
node plugins/codex-autoresearch/scripts/autoresearch.mjs next --cwd plugins/codex-autoresearch
node plugins/codex-autoresearch/scripts/autoresearch.mjs export --cwd plugins/codex-autoresearch
```

From `plugins/codex-autoresearch`, use:

```bash
node scripts/autoresearch.mjs --help
node scripts/autoresearch.mjs doctor --cwd . --check-benchmark
```

## User-Facing Change Sync

When behavior, command surfaces, dashboard behavior, migration behavior, or finalization behavior changes, keep these surfaces synchronized:

- root `README.md` for public promise and short getting-started path
- root `CHANGELOG.md` for release notes and migration notes
- `skills/codex-autoresearch/SKILL.md` for Codex operator behavior
- closest topic doc under `docs/`
- relevant tests and `scripts/perfection-benchmark.mjs` expectations
- CLI help and internal tool schemas when tool or command contracts change

For non-versioned user-facing changes, refresh the newest dated changelog entry. Removed invocation surfaces need migration notes.

## Verification

Use the narrowest relevant check while iterating. Before claiming plugin work is done, run the product gate from `plugins/codex-autoresearch`:

```bash
npm run check
```

Useful targeted checks:

```bash
node --check scripts/autoresearch.mjs
node --test tests/autoresearch-cli.test.mjs
node --test tests/dashboard-verification.test.mjs
node scripts/autoresearch.mjs --help
npm pack
git diff --check
```

For dashboard or view-model changes, export or serve a dashboard and inspect it. Static code and tests alone do not prove the operator surface is understandable.

When refreshing the checked-in demo, use the public showcase export so workstation paths and transient branch warnings are scrubbed:

```bash
node scripts/autoresearch.mjs export --cwd examples/demo-session --output autoresearch-dashboard.html --showcase
```

Before publishing, inspect the package artifact itself. The shipped `scripts/*.mjs` shims depend on `dist/`, but `dist/` is generated and ignored in the Git tree. If a Git marketplace source checkout is missing `dist/`, the CLI launcher downloads and extracts the matching GitHub release tarball into the plugin cache before importing the runtime. A publishable release tarball must include the built runtime, exclude authored source and tests, ship no MCP launcher/config, and pass `node <extracted-package>/scripts/autoresearch.mjs --help`.

Do not push release tags by hand. After a synchronized version bump lands on `main`, the `Auto Release` GitHub Actions workflow compares the previous and current package versions and calls the reusable `Release` workflow when the package version changed. The release workflow still runs the checks, builds and smoke-tests the tarball, refuses pre-existing tags, and only then creates the GitHub release/tag with the tarball asset attached. Use manual `Release` dispatch only as an explicit recovery path with the package version. This keeps update clients on the previous release until the new install artifact exists.

## Version Surfaces

For a version bump, update all version surfaces together:

- `plugins/codex-autoresearch/package.json`
- `plugins/codex-autoresearch/package-lock.json`
- `plugins/codex-autoresearch/.codex-plugin/plugin.json`
- root `CHANGELOG.md`
- any tests or docs that intentionally assert or display the version

If installed Codex behavior differs from source, refresh or inspect the versioned cache under the user's Codex plugin cache before changing source again. Typical drift layers are wrong cwd, stale marketplace cache, old versioned cache, runtime hydration, and slow full-CLI imports.
