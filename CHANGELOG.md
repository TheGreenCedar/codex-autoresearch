# Changelog

All notable user-facing changes to Codex Autoresearch are recorded here.

This project uses a root-only changelog because the root README is the public documentation surface for the plugin wrapper.

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
- Added dashboard trust blockers, run chart, next safe action, copyable report/handoff outputs, stale-session guidance, and safe local live actions.

### Changed

- Bumped public package, plugin manifest, CLI server, and MCP server version surfaces to `1.0.0`.
- Reframed the root README around human prompts and live demo usage; the README embeds the served live-dashboard screenshot instead of a static report export.
- Rewrote the root README and linked user-facing docs in a sharper authored voice while preserving the command contracts and safety rules.
- Promoted visual workflow/architecture docs ahead of long-form reference pages.
- Rewrote the main skill around a compact state machine and GPT-5.5-friendly active-loop protocol.
- Moved low-level dashboard diagnostics out of visible warning tags and into the Codex handoff/model data unless they are the actual next action.

### Safety Notes

- Static dashboard exports remain read-only snapshots. Serve the live dashboard for guarded local actions and current packet freshness.
- Custom command materialization over MCP still requires explicit unsafe-command gating.
- Hooks remain opt-in examples only, not required core behavior.
