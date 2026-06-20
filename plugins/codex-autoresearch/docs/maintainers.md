# Maintainers

This repository is a wrapper for the Codex Autoresearch plugin. The active package root is `plugins/codex-autoresearch`.

Doc voice and audience rules: [STYLE.md](STYLE.md).

## Repo Shape

- Root `README.md` is the public front door.
- Narrow archive READMEs may exist under `docs/`, but they are not first-run onboarding.
- Root `CHANGELOG.md` is the release-note surface for user-facing changes.
- The main skill is `plugins/codex-autoresearch/skills/codex-autoresearch/SKILL.md`.
- Topic docs live in `plugins/codex-autoresearch/docs/`.
- Human-facing topic docs are `concepts.md`, `start.md`, `walkthrough.md`, `operate.md`, `trust.md`, `finish.md`, `recipes.md`, `troubleshooting.md`, and `hooks.md`.
- Internal planning archives are not first-run onboarding.

Do not assume root-level npm scripts exist. Package scripts live in `plugins/codex-autoresearch/package.json`.

## Local Plugin Routing

When this repo is the target, use the repo-local plugin before any globally installed or marketplace-cache copy. Installed cache drift is common; inspect the active runtime before treating source changes as live behavior.

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

Develop and verify the local source checkout on Node.js 24 or newer. The package metadata and CI matrix treat Node 24 as the supported development floor.

```bash
npm run check
```

Useful targeted checks:

```bash
node --check scripts/autoresearch.mjs
npm run test:cli
npm run test:dashboard
node scripts/autoresearch.mjs --help
npm pack --dry-run --json --ignore-scripts
git diff --check
```

For dashboard or view-model changes, export or serve a dashboard and inspect it. Static code and tests alone do not prove the operator surface is understandable.

For dashboard or view-model review, write a temporary ignored showcase export in the demo session and compare or open that file:

```bash
node scripts/autoresearch.mjs export --cwd examples/demo-session --output tmp/autoresearch-dashboard.review.html --showcase
```

`npm run check` generates its own ignored trust export at `examples/demo-session/tmp/autoresearch-dashboard.check.html`. That generated export must embed the current plugin version, public/showcase flags, scrub workstation paths and transient branch warnings, omit action routes, and match `assets/dashboard-build/dashboard-app.css` plus `assets/dashboard-build/dashboard-app.js` after the exporter's `</style` and `</script` escaping rules.

The legacy checked-in `examples/demo-session/autoresearch-dashboard.html` is no longer the product-gate parity target. Do not refresh it just to make routine dashboard UI checks pass.

When intentionally refreshing the legacy fixture, use the public showcase export so workstation paths and transient branch warnings are scrubbed:

```bash
node scripts/autoresearch.mjs export --cwd examples/demo-session --output autoresearch-dashboard.html --showcase
```

Before publishing, inspect the package artifact itself. Use dry-run pack output
for routine review, then create and extract a real tarball for release smoke.
Dashboard runtime assets are package output. `prepack`, `npm run check`, and
the release workflow must build `assets/dashboard-build/dashboard-app.js` and
`assets/dashboard-build/dashboard-app.css` before `npm pack`. The source
checkout keeps failing clearly if those files are absent: run
`npm run build:dashboard` from `plugins/codex-autoresearch` before serving or
exporting dashboards. Package checks must assert both dashboard assets are in
the tarball and smoke an extracted-package dashboard export, not just launcher
help.

The shipped `scripts/*.mjs` shims depend on `dist/`, but `dist/` is generated
and ignored in the Git tree. If a Git marketplace source checkout is missing
`dist/`, the CLI launcher calls `scripts/bootstrap-runtime.mjs` to download the
matching GitHub release tarball plus
`codex-autoresearch-<version>.tgz.sha256`, verify the SHA-256 entry names that
exact tarball, verify the packaged name/version, and only then extract `dist/`
into the plugin cache before importing the runtime. A publishable release
tarball must include the built runtime, publish the adjacent checksum asset,
exclude authored source and tests, ship no MCP launcher/config, and pass
`node <extracted-package>/scripts/autoresearch.mjs --help` plus an extracted
package dashboard export smoke.

Do not push release tags by hand. After a synchronized version bump lands on `main`, the `Auto Release` GitHub Actions workflow compares the previous and current package versions and calls the reusable `Release` workflow when the package version changed. The release workflow still runs the checks, builds and smoke-tests the tarball, refuses pre-existing tags, and only then creates the GitHub release/tag with the tarball asset attached. Use manual `Release` dispatch only as an explicit recovery path with the package version. This keeps update clients on the previous release until the new install artifact exists.

## Skill Progression Map

Use recurring PR and review evidence to choose the next hardening drill. Each drill should leave a product safeguard behind, not just a private note.

| Skill track | Evidence pattern | Practice task | Validation gate |
| --- | --- | --- | --- |
| Security evidence hygiene | CodeQL or review findings around escaping, redaction, receipts, paths, env files, or stack traces | Add a failing leak fixture, fix the boundary, and prove dashboard/live/session payloads stay scrubbed | `npm run test:core` plus `npm run test:cli` for full-product export cases |
| Release workflow design | Failed or brittle release, tag, tarball, package, or version-surface behavior | Turn the release invariant into a workflow or product-check assertion before changing the workflow | `npm run check`, workflow YAML review, CodeQL, auto-release, and release workflow evidence |
| Prompt taxonomy and regression design | Natural-language goals routed to the wrong benchmark or loop type | Add prompt-plan cases for qualitative quality-gap loops and explicit measured contracts | `npm run test:cli` |
| Dashboard/operator UX contracts | Dashboard copy or controls imply live mutation, stale truth, or unclear next action | Remove the misleading affordance and test live/static mode, toolbar state, and absent action routes | `npm run test:dashboard` plus live-server route checks |
| Cross-surface release discipline | Docs, skill guidance, changelog, demo export, package metadata, or version surfaces drift | Update the nearest user/operator surface and add product-gate coverage when drift would be easy to repeat | `npm run check`, `git diff --check`, and demo export leak/version inspection |

## Version Surfaces

For a version bump, update all version surfaces together:

- `plugins/codex-autoresearch/package.json`
- `plugins/codex-autoresearch/package-lock.json`
- `plugins/codex-autoresearch/.codex-plugin/plugin.json`
- root `CHANGELOG.md`
- any tests or docs that intentionally assert or display the version

If installed Codex behavior differs from source, refresh or inspect the versioned cache under the user's Codex plugin cache before changing source again. Typical drift layers are wrong cwd, stale marketplace cache, old versioned cache, runtime hydration, and slow full-CLI imports.
