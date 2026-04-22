# Changelog

All notable user-facing changes to Codex Autoresearch are recorded here.

This project uses a root-only changelog because the root README is the public documentation surface for the plugin wrapper.

## 2026-04-22

### Added

- Added a single Codex-facing `codex-autoresearch` skill that owns setup/resume, active-loop continuation, deep research, live dashboard handoff, and finalization guidance.
- Added root README concept diagrams for the loop, state machine, deep-research flow, and runtime surface.
- Added practical dashboard run-chart affordances: status legend, win zone, baseline line, best/latest markers, run ticks, callouts, and screen-reader chart summary wiring.
- Added dashboard regression coverage for crash-run clipping and best-evidence calculation.
- Added a Vite-built React dashboard app with committed static assets so exported `autoresearch-dashboard.html` files stay self-contained.

### Changed

- Released `0.4.1` with the React dashboard migration, live/static dashboard mode fixes, automatic live refresh restoration, segment-local readouts, and newest-first decision history.
- Released `0.4.0` with synchronized package, plugin manifest, full CLI MCP, and lightweight MCP version surfaces.
- Reworked the dashboard into an operator cockpit with a dominant next-action lane, compact metric readout, guided-flow controls, strategy memory, quality-gap status, and a virtualized run ledger.
- Rethemed the dashboard with a Flip7-inspired teal/coral/gold visual system and moved the metric chart into the primary workspace using a Recharts-backed rendering surface.
- Rewrote the root README around Codex-first interaction rather than command-line-first operation.
- Made AX and UX explicit product contracts: one smooth path for the AI agent mediating the loop and one smooth path for the user asking for outcomes.
- Repointed plugin metadata and default prompts at the plugin-level workflow instead of separate subskill names.
- Updated dashboard evidence calculations so crash/sentinel metrics do not become baseline, best, latest-plotted, or chart-scale evidence while measured `checks_failed` runs remain eligible.
- Updated the product benchmark to guard the single-skill surface, root-only docs, practical chart, and operational dashboard copy.

### Removed

- Removed the duplicate plugin README. The root `README.md` is now the only README.
- Removed separate command docs for `/autoresearch` and `/autoresearch-finalize`.
- Removed separate `autoresearch-create`, `autoresearch-dashboard`, `autoresearch-deep-research`, and `autoresearch-finalize` skills and their OpenAI agent metadata.

### Migration Notes

- Users should ask Codex to use Codex Autoresearch directly instead of invoking old subskills or slash-command docs.
- Existing CLI and MCP helpers remain available as deterministic implementation surfaces behind the main skill.
