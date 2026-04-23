# Changelog

All notable user-facing changes to Codex Autoresearch are recorded here.

This project uses a root-only changelog because the root README is the public documentation surface for the plugin wrapper.

## 2026-04-23

### Added

- Reworked the public README into a short product front door with a dashboard screenshot, demo links, install guidance, and one clear starting prompt.
- Split detailed usage, evidence, MCP, and maintainer guidance into focused docs under `plugins/codex-autoresearch/docs/`.
- Added a visible demo path with a 100-point runtime-improvement session, a scrubbed static dashboard snapshot, and screenshot notes.
- Added a weighted demo metric with an inline formula and a metric-details breakdown for time and memory: `0.7 * (seconds / baseline_seconds) + 0.3 * (memory_mb / baseline_memory_mb)`.
- Documented the evidence rules for metric parsing, missing metrics, no-change keeps, stale packets, and corrupt JSONL.
- Documented live versus static dashboard behavior, including when to serve a fresh dashboard instead of trusting an old export.
- Documented the finalization checklist from preview through merge and cleanup, including read-only plan expectations and collapse-overlap guidance for coupled kept commits.

### Fixed

- Migrated the authored plugin, dashboard, and owned tests from JS/MJS/JSX to TypeScript while keeping the public `scripts/*.mjs` command surface stable through tiny shims.
- Standardized the package toolchain on `tsdown`, `@typescript/native-preview` (`tsgo`), `oxlint`, `oxfmt`, and `npm-run-all2`, and made the package gate exercise the dashboard verification test alongside the core product suite.
- Preserved the full union file set when executing collapsed finalizer plans for overlapping kept commits.
- Made finalizer plans reject unsafe paths, excluded-commit tampering, inconsistent metadata, and excluded-file leakage before branch creation.
- Made last-run freshness notice untracked directory edits, preserved edited raw ASI JSON, and rejected fractional values for integer limits.
- Made dashboard trust reasons fully visible, bounded retained CLI metric maps while preserving the primary metric in large streams, surfaced corrupt JSONL file paths in state readers, and made `npm run check` catch stale dashboard rebuilds.
- Removed passive dashboard and doctor warning noise around empty `commitPaths`, and turned missing keep-commit metadata into a calm finalization-backlog state instead of a trust-warning flood.
- Rejected finalizer plan paths that target `.git` metadata and required `allow_unsafe_command: true` for MCP setup guidance backed by external recipe catalogs.
- Normalized invalid metric values before CLI state and experiment-memory ranking so unknown metrics cannot become best evidence.
- Restored MCP parity for `setup_plan` and `guided_setup` setup inputs such as checks commands, commit paths, and iteration limits while keeping custom command materialization behind `allow_unsafe_command: true`.
- Made publishable package artifacts explicitly include the built `dist/` runtime, and taught the package gate to fail if `npm pack --dry-run` drops runtime shims or accidentally ships authored source and tests.

### Migration Notes

- Authored source now lives in `.ts` and `.tsx`; keep using the stable `scripts/*.mjs` entrypoints from the package root and let them delegate into the built TypeScript runtime.
- Treat old dashboard exports as snapshots only; regenerate or serve a fresh dashboard before trusting packet freshness, live actions, or finalization readiness.
- Do not interpret missing metrics or missing deltas as zero. Rerun the packet or repair the benchmark so it prints the required primary `METRIC name=value`.
- Rerun stale last-run packets after Git, file, command, config, or ledger changes instead of logging from old evidence.
- Use the single `codex-autoresearch` skill surface for all setup, dashboard, deep-research, logging, and finalization guidance. Existing CLI and MCP helpers remain implementation surfaces behind that skill.
- The root `README.md` is a public overview. Use `plugins/codex-autoresearch/docs/` for operator workflow, evidence, MCP, and maintainer detail.

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
- Released `0.6.0` with the TypeScript rebuild, weighted metric dashboard demo, quieter default demo diagnostics, timestamp-axis polish, and package artifact verification for publishable runtime bundles.

### Removed

- Removed the duplicate plugin README. The root `README.md` is now the only README.
- Removed separate command docs for `/autoresearch` and `/autoresearch-finalize`.
- Removed separate `autoresearch-create`, `autoresearch-dashboard`, `autoresearch-deep-research`, and `autoresearch-finalize` skills and their OpenAI agent metadata.

### Migration Notes

- Users should ask Codex to use Codex Autoresearch directly instead of invoking old subskills or slash-command docs.
- Existing CLI and MCP helpers remain available as deterministic implementation surfaces behind the main skill.
- Static dashboard exports are now explicitly read-only. Use the served local dashboard for guarded live actions and use the CLI for branch creation or finalizer mutation.
- MCP clients that previously sent misspelled or extra arguments must remove them; command-bearing arguments now require explicit `allow_unsafe_command: true`.
