# Changelog

All notable user-facing changes to Codex Autoresearch are recorded here.

This project uses a root-only changelog because the root README is the public documentation surface for the plugin wrapper.

## 1.1.1

- Fixed the dashboard timestamp x-axis toggle for exports that embed run timestamps as numeric epoch values.

## 1.1.0

Friction-reduction pass from live CodeStory onboarding forensics.

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

- Bumped public package, plugin manifest, CLI server, and MCP server version surfaces to `1.0.0`.
- Reframed the root README around human prompts and live demo usage; the README embeds the served live-dashboard screenshot instead of a static report export.
- Rewrote the root README and linked user-facing docs in a sharper authored voice while preserving the command contracts and safety rules.
- Promoted visual workflow/architecture docs ahead of long-form reference pages.
- Rewrote the main skill around a compact state machine and GPT-5.5-friendly active-loop protocol.
- Moved low-level dashboard diagnostics out of visible warning tags and into the Codex handoff/model data unless they are the actual next action.

### Safety Notes

- Static dashboard exports remain read-only snapshots. Serve the live dashboard for current packet freshness; use CLI or MCP for actions.
- Custom command materialization over MCP still requires explicit unsafe-command gating.
- Hooks remain opt-in examples only, not required core behavior.
