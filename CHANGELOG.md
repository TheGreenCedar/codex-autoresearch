# Changelog

All notable user-facing changes to Codex Autoresearch are recorded here.

This project uses a root-only changelog because the root README is the public documentation surface for the plugin wrapper.

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
