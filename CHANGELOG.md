# Changelog

All notable user-facing changes to Codex Autoresearch are recorded here.

This project uses a root-only changelog because the root README is the public documentation surface for the plugin wrapper.

## Unreleased

## 1.1.12

### Fixed

- Moved the compiled `dist/` runtime out of the Git tree and into the release tarball contract: local checks now pack, extract, and smoke-test the generated package so source/runtime split regressions fail before release.
- Tightened package artifact verification so published `scripts/*.mjs` launcher files must remain small wrappers into `dist/scripts/` and the compiled MCP support modules under `dist/lib/` must be present, preventing source/runtime split regressions from passing local checks while failing after Codex installs the plugin.
- Changed release publishing so CI builds and smoke-tests the tarball before creating the GitHub release/tag, avoiding a tag-visible window where update clients could resolve a source archive without `dist/`.
- Fixed the CLI-reported plugin version surface so internal session and dashboard metadata now reports `1.1.12` instead of the stale `1.1.10` value.

### Changed

- Clarified licensing at the repository root by adding a full `LICENSE` file and linking it from the root README license section for explicit Apache-2.0 terms.

Bumped public package, plugin manifest, CLI server, and MCP server version surfaces to `1.1.12`.

## 1.1.11

### Fixed

- Fixed Windows cmd.exe output handling in the `npm run check` package artifact verification script by stripping ANSI escape codes before JSON parsing and simplifying the platform-specific CLI invocation logic.

Bumped public package, plugin manifest, CLI server, and MCP server version surfaces to `1.1.11`.

## 1.1.10

### Changed

- Moved dashboard and inspection CLI logic into focused command modules and clarified the empty top-level commands documentation expectation.
- Changed setup-generated missing benchmark/check scripts to fail loudly instead of shipping runnable TODO placeholders.
- Made experiment-memory lanes evidence-cited so generic strategic lanes do not render without session evidence.

### Added

- Added typed MCP output schema hints and installed-runtime drift confidence reporting.

### Security

- Hardened external recipe catalog loading with response size limits and request timeouts.

Bumped public package, plugin manifest, CLI server, and MCP server version surfaces to `1.1.10`.

## 1.1.5

### Fixed

- Fixed the dashboard timestamp x-axis toggle for exports that embed run timestamps as numeric epoch values.

### Changed

- Aligned dashboard docs and skill guidance around the dashboard as a live readout rather than a command center; CLI and MCP own setup, packet runs, logging, gap review, export, and finalization preview.
- Disabled served-dashboard mutation endpoints by default so the live dashboard contract is enforced by runtime behavior, not just documentation.
- Expanded MCP tool descriptors with output schemas and standard safety annotations, corrected open-world hints for command-running tools, and returned structured tool content alongside text JSON for clients that can consume it.

### Added

- Added dogfood health gates to the product check: a portable `quality_gap` session must pass, and local self-session artifacts block release-style verification when stale commit paths, benchmark drift, or maxed sessions are present.

Bumped public package, plugin manifest, CLI server, and MCP server version surfaces to `1.1.5`.


## 1.1.0

Friction-reduction pass from live measured-loop onboarding forensics.

### Changed

- `prompt-plan` now discovers existing `scripts/autoresearch-*.mjs` metric benchmarks and can infer score-style primary metrics from them before falling back to generic speed recipes.
- Setup-generated session notes now include an explicit metric decision contract and less-empty idea scaffolding.
- Benchmark linting now gives a clearer timeout recovery hint for expensive workloads: use sample/artifact mode or lint the generated wrapper before full packets.
- Active-loop continuation now marks log decisions as a log-then-continue step so long-budget loops do not read like they require a user handoff after every packet.
- Guarded sessions with a finite active iteration budget now set a stronger continuation/final-answer policy so Codex keeps running packets instead of stopping at a status report.
- `next --compact` now returns an operator-sized packet with tried/meaning/decision/next reporting while preserving the full last-run packet for `log --from-last`; generated next commands use compact mode by default.
- Served live dashboards now perform a `/health` liveness check before returning the URL, making stale localhost dashboard links easier to catch and restart.
- Onboarding/report templates now require a plain-English operator story instead of raw experiment parameters.
- Dashboard metric details no longer label raw score metrics as baseline time/memory.
- Onboarding packets now check installed Codex plugin runtime drift by default so stale marketplace/cache installs are visible during handoff.
- Added `benchmark-inspect` / MCP `benchmark_inspect` for bounded list/dry-run/sample probes before expensive benchmark packets.
- Added `checks-inspect` / MCP `checks_inspect` to catch malformed correctness commands, identify failed tests, and separate touched-path failures from broad-suite friction before logging `checks_failed`.
- Added `promote-gate` / MCP `promote_gate` to record stronger measurement gates as fresh segments with sample/gate metadata.
- Session setup now writes Autoresearch `.gitattributes` rules and ledger appends use LF line endings, reducing noisy CRLF warnings on Windows.
- The dashboard is now a visual aid instead of a command center: trust state, mission-control controls, live action panels, and action receipts are removed from the visible UI; Codex brief and session memory now sit below the chart, with the ledger immediately below the next action.

## 1.0.1

Patch release for TypeScript-built plugin installs.

### Fixed

- Fixed Git/marketplace-style source downloads after the TypeScript migration: source downloads now include the compiled TypeScript runtime that the public `.mjs` launcher scripts load.
- Added a release gate that verifies the tracked `dist/` runtime exists for source-checkout downloads, not only for `npm pack` artifacts.
- Fixed setup-generated benchmark wrappers so explicit metric-emitting benchmark commands no longer get an extra elapsed-time primary metric appended.
- Fixed setup session docs to carry configured commit paths into the initial "Files in Scope" section instead of leaving them as generic TBDs.
- Added setup checkpoint guidance so generated session files are surfaced before experiment-scoped keep commits.
- Added `log --asi-file <path>` for shells where inline JSON ASI is hard to quote reliably.
- Added first-run checklist guidance across setup, guide, and onboarding packets so benchmark linting, doctor checks, checkpointing, baseline, and logging happen in order.
- Added scope/commit-path drift warnings when setup receives both surfaces and they disagree.
- Documented `--benchmark-prints-metric false` for explicit benchmark commands that should be timed as raw workloads.
- Tightened dashboard chart y-axis labels for large raw metrics so ticks stay readable in narrow panels.

## 1.0.0

Initial release of the Codex Autoresearch plugin as a single Codex-facing measured-loop surface.

### Added

- Added natural-language prompt planning through CLI `prompt-plan` and MCP `prompt_plan`, so broad README-style requests can become inferred metrics, experiment lanes, missing essentials, and read-only setup commands before any files are changed.
- Added first-class workflow and architecture diagram docs for the first-five-minutes path, prompt-to-loop planning, active packets, quality-gap research, runtime surfaces, trust boundaries, MCP flow, and finalization.
- Added compact onboarding, recommend-next, benchmark linting, new-segment, doctor explain/hooks, live dashboard, and finalization preview surfaces across CLI/MCP/docs/skill.
- Added dashboard trust blockers, run chart, next safe action, copyable report/handoff outputs, stale-session guidance, and local live-action experiments that were later removed from the visible UI.

### Changed

- Reframed the root README around human prompts and live demo usage; the README embeds the served live-dashboard screenshot instead of a static report export.
- Rewrote the root README and linked user-facing docs in a sharper authored voice while preserving the command contracts and safety rules.
- Promoted visual workflow/architecture docs ahead of long-form reference pages.
- Rewrote the main skill around a compact state machine and GPT-5.5-friendly active-loop protocol.
- Moved low-level dashboard diagnostics out of visible warning tags and into the Codex handoff/model data unless they are the actual next action.
- Bumped public package, plugin manifest, CLI server, and MCP server version surfaces to `1.0.0`.

### Safety Notes

- Static dashboard exports remain read-only snapshots. Serve the live dashboard for current packet freshness; use CLI or MCP for actions.
- Custom command materialization over MCP still requires explicit unsafe-command gating.
- Hooks remain opt-in examples only, not required core behavior.
