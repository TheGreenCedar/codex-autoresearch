# Contributing

Thanks for improving Codex Autoresearch. The best contributions make one measured loop easier to trust, resume, debug, or review.

## Before opening an issue

First find the failing layer if you can:

- source checkout or package root
- installed Codex plugin cache
- benchmark contract
- runtime environment
- dashboard serve/export mode
- Git dirty-tree or commit-path setup
- docs or skill guidance

If Autoresearch itself looks broken, confusing, stale, or under-documented, please open an issue. Include the command, cwd, plugin version, output tail, expected behavior, actual behavior, and any safe session artifacts.

## Before opening a pull request

- Keep the change focused and reviewable.
- Update the nearest docs or skill guidance when behavior, command surfaces, dashboards, or workflow expectations change.
- Update `CHANGELOG.md` for user-facing behavior, docs, skill, command-surface, dashboard, migration, or version changes.
- Do not commit secrets, local credentials, generated caches, or unrelated experiment artifacts.
- Work from `plugins/codex-autoresearch` for package checks.

## Local setup

From the package root:

```bash
cd plugins/codex-autoresearch
npm install
npm run check
npm test
node scripts/autoresearch.mjs --help
```

Targeted checks are useful while iterating:

```bash
npm run typecheck
npm run lint
npm run format:check
node scripts/autoresearch.mjs doctor --cwd . --check-benchmark --explain
git diff --check
```

## Pull request shape

Please include:

- what changed
- why it changed
- how you verified it
- any remaining risk or follow-up

For dashboard or screenshot-visible UI changes, include visual evidence or explain why it was not possible.

For benchmark-loop behavior, include the relevant metric, status decision, and ASI/evidence path when available.
