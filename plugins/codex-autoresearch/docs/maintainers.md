# Maintainer guide

The repository root is a wrapper. The product package is `plugins/codex-autoresearch`; run package commands there.

## Repository map

| Surface                                                         | Purpose                                |
| --------------------------------------------------------------- | -------------------------------------- |
| root `README.md`                                                | Public product front door              |
| root `CHANGELOG.md`                                             | User-facing release history            |
| `plugins/codex-autoresearch/skills/codex-autoresearch/SKILL.md` | Codex execution contract               |
| `plugins/codex-autoresearch/docs/`                              | User and maintainer documentation      |
| `plugins/codex-autoresearch/lib/`, `scripts/`                   | Authored runtime source                |
| `plugins/codex-autoresearch/dashboard/src/`                     | Dashboard source                       |
| `plugins/codex-autoresearch/tests/`                             | Product contracts and regression tests |

Audience and voice rules live in [Documentation style](STYLE.md).

## Run the local source

Prefer the repository checkout over a globally installed or marketplace-cached copy when changing this project.

From the wrapper root:

```bash
node plugins/codex-autoresearch/scripts/autoresearch.mjs --help
node plugins/codex-autoresearch/scripts/autoresearch.mjs doctor --cwd plugins/codex-autoresearch --check-benchmark --explain
node plugins/codex-autoresearch/scripts/autoresearch.mjs state --cwd plugins/codex-autoresearch --report
```

From the package root:

```bash
node scripts/autoresearch.mjs --help
node scripts/autoresearch.mjs doctor --cwd . --check-benchmark --explain
```

Installed cache drift is common. Verify the active version and built-entrypoint fingerprint before describing source changes as live installed behavior.

## Keep user surfaces in sync

When behavior, commands, dashboard wording, safety rules, finalization, packaging, or migration changes, update the smallest complete set:

- README for the public promise and first run
- CHANGELOG for shipped user impact and migration notes
- SKILL for Codex behavior
- nearest topic doc
- `lib/command-table.ts` for command identity, schemas, safety, help, handler binding, and compatibility lifecycle; the CLI/tool/dashboard surfaces derive from it
- focused contract tests and `scripts/operator-task-benchmark.mjs` where externally observed drift should fail the product gate

Rewrite stale guidance instead of appending a second version. Removed invocation paths need a migration note.

Do not add a command independently to help, handlers, schemas, or dashboard safety. Add its typed definition and implementation, then extend the schema-driven command-surface test. `lib/tool-schemas.ts` and `lib/tool-registry.ts` are compatibility facades, not second registries. Retained compatibility commands require an exact migration error, replacement, and removal date.

## Verification

Node.js 24 or newer is the supported development floor.

The final package gate is:

```bash
npm run check
```

Useful focused checks:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run test:cli
npm run test:dashboard
npm run test:finalize
npm run test:core
node scripts/autoresearch.mjs --help
npm pack --dry-run --json --ignore-scripts
git diff --check
```

Compiled tests are organized by domain under `tests/cli/`, `tests/dashboard/`, `tests/finalize/`, `tests/process/`, and `tests/product/`. Package scripts use Node's native file-level concurrency with explicit 120-second test bounds; the outer CLI, dashboard, finalizer, process, and core groups remain serial to avoid cross-surface resource contention. The Windows process-lifecycle domain uses a native single-file lane so identity and termination probes do not compete with other process-heavy integration tests. Add new coverage to the narrowest domain file rather than rebuilding a catch-all suite or a custom scheduler.

Session read-model budgets are reviewed product contracts. The 100-run fixture caps compact state at 10 KiB/200 lines, default state at 20 KiB/260 lines, and doctor/report at 8 KiB/100 lines; compact must remain smaller than default and must not repeat exact object subtrees. Change a ceiling only with measured before/after output and a reason the additional data belongs on the default surface. Full state and doctor detail is opt-in through `--json-full`.

For docs-only work, read the rendered Markdown and check the command text, then run `git diff --check` and the package gate. The package gate checks required files and local Markdown links; it does not judge whether the prose is any good.

## Operator integration gate

`npm run check` executes seven portable operator tasks through `scripts/operator-task-benchmark.mjs`: decision consistency across public readouts, invalid CLI rejection, installed-cache discovery, hostile-path finalization safety, the zero-run qualitative session journey, bounded default and mutation output, and long-history retention. Each task emits one machine-readable `EVIDENCE` record, followed by one reconciled `EVIDENCE_SUMMARY`. The independent `METRIC operator_task_failures=<count>` ceiling is zero; `--fail-on-failure` makes any failed case fail the product phase.

Dashboard geometry is the separate browser operator task. It requires a real browser, so the required Chrome dashboard gate emits its own `EVIDENCE` and `EVIDENCE_SUMMARY` records instead of hiding a browser dependency inside the portable package check. Focused contract-integrity tests separately protect version and manifest agreement, package contents, documentation links, release wiring, and session-artifact invariants. Tests also feed each portable validator intentionally faulty raw observations and require the case-specific failure code, proving that representative defects are rejected rather than converted into a qualitative score.

These scripted integration tasks do not compare optimization quality, cost, or intervention rates against plain Codex. Report that advantage only from a separate paired task evaluation with equal budgets and independently checked outcomes.

This evidence is not proof of perfection, broad UX quality, manual screen-reader behavior, physical-device behavior, undiscovered defects, or every possible session. Ordinary qualitative research still uses `quality_gap`; `quality_gap=0` remains valid only for the accepted checklist in the current research round. The product gate uses `operator_task_failures` for its explicitly bounded cases.

## Dashboard review

`npm run test:dashboard` includes a 100,000-record streaming-ledger gate. Its intentionally broad CI ceilings are 96 MiB sampled peak heap delta, 15 seconds wall time, 2.5 MB serialized response, and exactly 5,000 retained rows; the test prints the measured values for review.

Tests do not prove that the dashboard is understandable. Serve or export the demo and inspect it after dashboard source, view-model, copy, or asset changes:

```bash
node scripts/autoresearch.mjs export --cwd examples/demo-session --output tmp/autoresearch-dashboard.review.html --showcase
```

`npm run test:dashboard:browser` is a separate local real-browser check and a required Ubuntu Chrome step in normal and release CI. It drives an installed Chrome or Edge through DevTools, captures current desktop and mobile screenshots under `tmp/`, and checks decision-first viewport bounds, operate/audit agreement, refresh focus and failure state, static-share safety, keyboard disclosures, ledger geometry, modal focus restoration, chart keyboard navigation, mobile layout, reduced motion, pagination, accessible names, dialog semantics, and ARIA references. Its long-history fixture also enforces at most 1,200 mobile DOM elements, 20 buttons, 10 mobile or 48 desktop plotted points, one chart range control, 20 ledger rows per page, at most 10 nodes of DOM growth from 100 to 5,000 runs, a 2.5 MB response, 2-second readiness, 200 ms interactions, and 12 px operational text. It is not a manual screen-reader validation.

`npm run test:dashboard:cross-browser` is the smaller release gate for the same built fixture in Playwright Chromium, Firefox, and WebKit. It runs the browsers sequentially, covers served and static modes, live refresh, chart keyboard selection, modal focus restoration, computed reduced-motion styles, forced colors, 200%/400% equivalent reflow, emulated touch taps and target geometry, and long-ledger pagination, then replaces the screenshots under `tmp/dashboard-cross-browser/` with evidence from the current run. Install its package-locked engines with `npx playwright install chromium firefox webkit`; CI installs their Linux system dependencies and uploads the ignored screenshots.

Automation does not prove spoken output, physical-device behavior, or accessibility compliance. Before release, record the date, OS, browser and version, fixture and delivery mode, screen reader and version, and pass/fail/needs-follow-up plus the actual announcement for chart help, changed selection, modal context, and restored focus. Record Windows High Contrast, 200% and 400% zoom/reflow, and one touch-device or realistic touch-emulation result separately. Link that evidence from the release issue; do not turn an unrecorded or partial pass into a compliance claim.

## Package shape and runtime hydration

`dist/` and `assets/dashboard-build/` are generated and ignored in source. Release artifacts must include them.

`npm run check` runs compiled test suites sequentially with a separate bounded deadline for each suite; streamed failures include timeout causes. It builds the runtime and dashboard, checks the generated assets, packs the plugin, extracts it, and smokes both the launcher and dashboard export. `prepack` is the single publish-time build path.

If a Git marketplace checkout lacks `dist/`, `scripts/bootstrap-runtime.mjs` downloads the matching GitHub release tarball and adjacent `codex-autoresearch-<version>.tgz.sha256`. Hydration requires `gh` and network access, verifies the checksum and release attestation for this repository's release workflow, validates every archive entry before extraction, checks package name/version, and only then hydrates the plugin cache. Hydration stages and verifies both the runtime and dashboard beside their targets, retains ownership-marked rollback directories until both installs succeed, and restores the prior pair if either install fails. There is no unverified fallback.

A release tarball must:

- include plugin metadata, docs, skill, launcher shims, compiled `dist/`, and dashboard assets
- exclude authored source, tests, local state, MCP config, and stale MCP launchers
- pass `node <extracted-package>/scripts/autoresearch.mjs --help`
- pass an extracted-package dashboard export smoke

`npm run audit:prod` is advisory. The package declares no runtime npm dependencies, but its bundled runtime is built from development dependencies. Release trust comes from the product gate, checksum, provenance, and extracted-package smoke.

## Release flow

CI has a 15-minute job limit. Linux runs the complete product, package, and browser gates. macOS and Windows run `npm run test:platform`: native shell and process behavior, session paths, runtime hydration, and scoped Git keep/discard, index-lock, and hook boundaries. The exhaustive platform-independent cases run on Linux.

CI runs for pull requests into `dev` and pushes to `main`. Promotion does not start duplicate `dev` push and `main` pull-request runs. Release requires successful CI for the exact `main` commit, then independently builds, inspects, smokes, and attests the package; it does not repeat the source test matrix. Missing, failed, cancelled, or unrelated CI blocks publication.

Do not push release tags by hand.

After a synchronized version bump lands on `main`, the `Auto Release` workflow accepts only a strictly increasing stable SemVer and calls the reusable `Release` workflow. That workflow verifies successful CI for its exact commit, builds through `prepack`, packs and extracts the artifact, refuses an existing tag, then creates the GitHub release and tag with the tarball and checksum.

Use manual `Release` dispatch only as a recovery path with the package version. A manual prerelease is published with GitHub's prerelease flag and does not move `latest`. Manual downgrades are rejected too.

## Release provenance smoke

Before the smoke, confirm:

- `gh` is installed and authenticated for `TheGreenCedar/codex-autoresearch`
- GitHub release metadata and attestation APIs are reachable
- the tarball, adjacent checksum, expected `v<version>` tag, and release target commit are known

Then run:

```bash
npm run smoke:release-provenance -- --tarball codex-autoresearch-<version>.tgz --checksum codex-autoresearch-<version>.tgz.sha256 --tag v<version>
```

The smoke reads release metadata with `gh api`, runs:

```bash
gh attestation verify <tarball> --repo TheGreenCedar/codex-autoresearch --signer-workflow TheGreenCedar/codex-autoresearch/.github/workflows/release.yml --format json
```

It verifies that the SLSA subject, local tarball, release asset, and checksum manifest digests agree. It also checks signer SAN, source repository, `refs/heads/main`, GitHub-hosted runner, and release target commit.

Check immutable-release status before publishing:

```bash
gh api -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2026-03-10" /repos/TheGreenCedar/codex-autoresearch/immutable-releases
```

If disabled, a repository admin can enable it through the API or Settings > Code security > Releases. The setting applies only to future releases.

## Turn repeated failures into gates

When the same class of bug shows up twice, leave behind a narrow check instead of another paragraph telling maintainers to be careful. Test the boundary that failed: a leak fixture for redaction, a route test for dashboard mutation, a pack-and-extract smoke for release shape, or a prompt case for command routing. Keep prose out of the assertion unless the exact text is itself the contract.

## Version surfaces

Update these together:

- `plugins/codex-autoresearch/package.json`
- `plugins/codex-autoresearch/package-lock.json`
- `plugins/codex-autoresearch/.codex-plugin/plugin.json`
- root `CHANGELOG.md`
- tests or docs that intentionally display or assert the version

After release, inspect the installed versioned cache before treating source and installed behavior as the same runtime.


The 3.0 candidate packages the internal outcome worker and comparison collector. Changes to either entrypoint must stay synchronized with package contents, bootstrap archive validation, and extracted-runtime smoke. Native platform checks include outcome worker cancellation and recovery. The CI workflow's synthetic round trip uploads a fixed candidate, dispatches the same workflow's bounded evaluator, and verifies the returned run and artifact. Its proof explicitly excludes evaluator independence and product usefulness.

Run no model-driven pilot or scoring trials as part of engineering verification. The [comparison protocol](comparative-evaluation.md) requires a separate budget and accepted host before any trial execution. Stable 3.0 remains gated on the comparative decision.
