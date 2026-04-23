# Changelog

All notable user-facing changes to Codex Autoresearch are recorded here.

This project uses a root-only changelog because the root README is the public documentation surface for the plugin wrapper.

## 2026-04-23

### Added

- Documented the evidence-integrity contract for metric parsing, missing metrics, no-change keeps, last-run freshness, and corrupt JSONL surfacing.
- Documented live/static dashboard trust state, including serve-or-restart guidance, read-only static exports, suspicious perfect-score handling, and the `quality_gap=0` research-round boundary.
- Documented the finalization checklist from preview through merge and cleanup, including clear dry-run expectations and collapse-overlap guidance for coupled kept commits.

### Fixed

- Preserved the full union file set when executing collapsed finalizer plans for overlapping kept commits.
- Hardened follow-up evidence fixes so finalizer plans reject unsafe paths, collapsed plans replay kept sources without excluded-file leakage, last-run freshness sees untracked directory edits, raw ASI JSON stays authoritative when edited, and integer limits reject fractional values.
- Normalized invalid metric values before CLI state and experiment-memory ranking so unknown metrics cannot become best evidence.
- Restored MCP parity for `setup_plan` and `guided_setup` read-only setup inputs such as checks commands, commit paths, and iteration limits.

### Migration Notes

- Treat old dashboard exports as snapshots only; regenerate or serve a fresh dashboard before trusting packet freshness, live actions, or finalization readiness.
- Do not interpret missing metrics or missing deltas as zero. Rerun the packet or repair the benchmark so it prints the required primary `METRIC name=value`.
- Rerun stale last-run packets after Git, file, command, config, or ledger changes instead of logging from old evidence.
- Use the single `codex-autoresearch` skill surface for all setup, dashboard, deep-research, logging, and finalization guidance. Existing CLI and MCP helpers remain implementation surfaces behind that skill.

## 2026-04-22

### Added

- Added a single Codex-facing `codex-autoresearch` skill that owns setup/resume, active-loop continuation, deep research, live dashboard handoff, and finalization guidance.
- Added root README concept diagrams for the loop, state machine, deep-research flow, and runtime surface.
- Added practical dashboard run-chart affordances: status legend, win zone, baseline line, best/latest markers, run ticks, callouts, and screen-reader chart summary wiring.
- Added dashboard regression coverage for crash-run clipping and best-evidence calculation.
- Added a Vite-built React dashboard app with committed static assets so exported `autoresearch-dashboard.html` files stay self-contained.
- Added nonce-bound served-dashboard action receipts with command summaries, duration, ledger focus, and fresh-packet log confirmations.
- Added dashboard ASI validation, accessible log form labels, skip links, reduced-motion handling, ledger table semantics, and chart text alternatives.
- Added finalizer plan fingerprints under Git metadata so preview planning does not dirty feature branches.

### Changed

- Released `0.5.0` with MCP module splitting, React dashboard orchestration cleanup, lightweight stdio adapter parity fixes, Apache 2.0 licensing, and regression coverage for schema-to-CLI option forwarding.
- Released `0.4.1` with the React dashboard migration, live/static dashboard mode fixes, automatic live refresh restoration, segment-local readouts, and newest-first decision history.
- Released `0.4.0` with synchronized package, plugin manifest, full CLI MCP, and lightweight MCP version surfaces.
- Split MCP internals into schema, dispatch, and stdio CLI-adapter modules, and moved dashboard orchestration into React hooks/components without changing the public tool or dashboard contracts.
- Fixed the lightweight MCP stdio adapter so `guided_setup` and schema-supported options for log, export, and doctor calls reach the CLI fallback.
- Reworked the dashboard into an operator cockpit with a dominant next-action lane, compact metric readout, guided-flow controls, strategy memory, quality-gap status, and a virtualized run ledger.
- Rethemed the dashboard with a Flip7-inspired teal/coral/gold visual system and moved the metric chart into the primary workspace using a Recharts-backed rendering surface.
- Rewrote the root README around Codex-first interaction rather than command-line-first operation.
- Made AX and UX explicit product contracts: one smooth path for the AI agent mediating the loop and one smooth path for the user asking for outcomes.
- Repointed plugin metadata and default prompts at the plugin-level workflow instead of separate subskill names.
- Updated dashboard evidence calculations so crash/sentinel metrics do not become baseline, best, latest-plotted, or chart-scale evidence while measured `checks_failed` runs remain eligible.
- Updated the product benchmark to guard the single-skill surface, root-only docs, practical chart, and operational dashboard copy.
- Hardened served-dashboard actions with nonce, same-origin, content-type, body-size, unknown-field, timeout, and bounded-output checks.
- Rejected unknown MCP arguments before dispatch and centralized unsafe-command gating across stdio and in-process MCP paths.
- Extended CLI parsing with `--flag=value` and `--` sentinel support while keeping command-aware validation.
- Made finalization safer and more portable with stale-plan refusals, structured command suggestions, and separate PowerShell/POSIX cleanup guidance.
- Released `0.5.1` with review fixes for collapsed finalizer plan fingerprints and direct CLI model-command timeout forwarding.

### Removed

- Removed the duplicate plugin README. The root `README.md` is now the only README.
- Removed separate command docs for `/autoresearch` and `/autoresearch-finalize`.
- Removed separate `autoresearch-create`, `autoresearch-dashboard`, `autoresearch-deep-research`, and `autoresearch-finalize` skills and their OpenAI agent metadata.

### Migration Notes

- Users should ask Codex to use Codex Autoresearch directly instead of invoking old subskills or slash-command docs.
- Existing CLI and MCP helpers remain available as deterministic implementation surfaces behind the main skill.
- Static dashboard exports are now explicitly read-only. Use the served local dashboard for guarded live actions and use the CLI for branch creation or finalizer mutation.
- MCP clients that previously sent misspelled or extra arguments must remove them; command-bearing arguments now require explicit `allow_unsafe_command: true`.
