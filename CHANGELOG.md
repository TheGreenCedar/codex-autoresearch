# Changelog

All notable user-facing changes to Codex Autoresearch are recorded here.

This project uses a root-only changelog because the root README is the public documentation surface for the plugin wrapper.

## Unreleased

### Added

- Added `research-fanout` / `research_fanout`, a generic parallel lane planner that turns current session memory into read-only scout lanes and isolated implementation lanes without creating project-specific metrics.
- Added `lane-runner` / `lane_runner`, a conservative coordinator path for recording or running one lane with read-only defaults, implementation isolation checks, time budgets, and one synthesized next measured packet recommendation.
- Added `--metrics-file` for `log` so PowerShell and Windows sessions can record structured metric metadata without brittle inline JSON quoting.
- Added `--asi-json-file` for `log` so PowerShell and Windows sessions can record ASI without fragile inline JSON quoting while preserving inline `--asi` and legacy `--asi-file`.
- Added run-level `evidenceStatus` labels and artifact evidence summaries so accepted, rejected, provisional, superseded, and quarantined evidence stay visible without becoming promotion signals by accident.
- Added watchdog, process-hygiene, and finalization-pressure dashboard readouts so long quiet windows, stale snapshots, runtime provenance, and accumulating kept work become visible before the loop sleepwalks into more packets.
- Added a central EvidenceRegistry so accepted/current evidence is separated from rejected, provisional, superseded, and quarantined audit evidence before state and dashboard consumers read it.

### Changed

- Redesigned the dashboard into an operator-first surface: a restrained editorial visual system (single accent, hairline dividers, no decorative glow/gradient stacks), a dominant next-action decision card with plain-language labels, and an operate/audit view split that keeps audit context (session memory, research truth, finalization, process hygiene, quality gap) collapsed until a reviewer needs it.
- Dashboard view, selected segment, and chart value/axis preferences are now stored in the URL (`?view=`, `?segment=`, `?value=`, `?axis=`) so a served link restores and shares the exact readout state.
- Removed dashboard accessibility/guideline anti-patterns: scoped all `transition` declarations to explicit properties and replaced literal ellipses with the `…` character.
- Dashboard view models now expose `fanoutPlan`, `parallelLanes`, and an `evidenceLedger`, and the session-memory panel shows lane mode and evidence status.
- The decision envelope can now prioritize watchdog intervention when no metric movement, logged decision, kept commit, or completed lane appears inside the configured quiet-window threshold.
- `state`, `recommend-next`, and the dashboard now share the same watchdog-aware decision envelope inputs, so quiet-window pressure is visible on CLI surfaces as well as the dashboard.
- `research-fanout` plans are segment-scoped: a new segment ignores prior fanout plans and falls back to memory/default lanes until a fresh plan is recorded for that segment.
- Completed `lane-runner` results now enrich parallel lane status and count as watchdog progress signals.
- Read-only scout lanes fail closed when running commands outside a Git worktree unless `--allow-non-git-command` is explicitly passed.
- Autoresearch-owned dirty files such as `autoresearch.jsonl`, notes, dashboards, and research scratchpads no longer count as dirty source drift; unrelated source dirtiness still blocks trust.

## 1.5.1

### Fixed

- Replaced the broken README dashboard screenshot with a fresh demo dashboard capture.
- Moved dashboard metric-construction details into a visible Metric Details section below the chart so formula, inputs, and decision-rule evidence stay visible without taking chart space.
- Corrected the release notes to describe the full 1.5 session release train instead of only the final simplifier PR.

### Changed

- Bumped public package, lockfile, plugin manifest, demo export, and runtime drift surfaces to `1.5.1`.

## 1.5.0

### Added

- Added `codex-goal-brief` / `codex_goal_bridge`, durable goal state, and `goalAdvice` so resumed loops keep the Codex-facing objective and completion boundary visible without relying on chat memory.
- Added `session-forensics` / `session_forensics` for long Codex session imports, writing bounded context capsules, quality-gap candidates, decision notes, and evidence-index claims into `autoresearch.research/<slug>/`.
- Added shared decision thresholds, safe research-slug path guards, evidence index helpers, and canonical `context-distillation` next-action guidance for sessions hitting compaction, token, tool-call, polling, or output-budget limits.
- Added active runner progress snapshots, experiment-economics warnings, workflow-friction signals, and experiment-memory exhaustion/shelf detection so wasted packets and stale progress become explicit next-action blockers.
- Added `partial-results` / `partial_results` so crashed or timed-out packets can expose artifact rows and record selected rows as diagnostic `measure` evidence with provenance.

### Changed

- `state --compact`, `recommend-next --compact`, dashboard data, setup, stale packet handling, quality gaps, partial-result review, finalization, and plateau pivots now route through one canonical next-action surface.
- Dashboard segment navigation now uses a keyboardable segment strip instead of the long dropdown, with controlled tabpanel summaries for long multi-segment sessions.
- Dashboard metric readouts now show metric construction, detected inputs, decision rule, selected-run evidence, no-trend states, secondary metrics, and missing-formula warnings instead of repeating right-rail totals.
- Refreshed dashboard build assets, demo export, showcase screenshot, docs, skill guidance, command contracts, and regression coverage for the current operator workflow.
- Simplified the CLI by reusing shared session option helpers instead of maintaining duplicate local copies.
- Bumped public package, lockfile, plugin manifest, demo export, and runtime drift surfaces to `1.5.0`.

## 1.4.1

### Added

- Added `codex-goal-brief` / `codex_goal_bridge`, a read-only Codex Goal bridge that turns Autoresearch state into a Goal objective draft, completion audit, and explicit ownership boundary.
- Added durable `goal` state in config/readouts plus `goalAdvice` in the decision envelope so resumed loops keep the objective visible without relying on chat memory.
- Added `session-forensics` / `session_forensics`, a safe import path for long Codex session JSONL that writes bounded session digests, quality-gap candidates, decision notes, and evidence-index claims into `autoresearch.research/<slug>/`.
- Added shared decision thresholds, safe research-slug path guards, and canonical `context-distillation` next-action guidance for sessions that exceed compaction, token, tool-call, polling, or output-budget limits.
- Added packet progress/economics readouts, workflow-friction signals, and experiment-memory exhaustion/shelf detection to the shared decision envelope.
- Added `partial-results` / `partial_results` so crashed or timed-out packets can expose artifact rows and record selected rows as diagnostic `measure` evidence with evidence-index provenance.

### Changed

- `state --compact`, `recommend-next --compact`, and dashboard data now share canonical next-action priorities for workflow friction, stale progress, partial-result review, context distillation, quality gaps, plateau pivots, finalization, and next packets.
- Dashboard segment navigation now uses a keyboardable segment strip, and metric panels show metric construction, selected-run evidence, no-trend states, secondary metrics, and missing-formula warnings without repeating the right-rail totals.
- Bumped public package and plugin manifest version surfaces to `1.4.1`.

## 1.4.0

### Added

- Added the reusable resume-audit / decision-envelope readout across compact next-action, state, onboarding, dashboard, export, and served-dashboard summaries so resumed loops expose one authoritative next decision.
- Added `status: "measure"` for baseline, no-change, and diagnostic evidence that updates trend readouts without staging, committing, reverting, counting as `keep`, or becoming finalizer evidence.
- Added finalization reporting for current-tree included/excluded files, current-tree fingerprints, and session-artifact exclusions, plus an explicit `--include-session-artifacts` escape hatch.

### Changed

- `recommend-next --compact` and dashboard summaries now prioritize stale packets, setup blockers, fresh log decisions, segment transitions, plateau escape, and finalization readiness before suggesting another packet.
- `run` remains a raw benchmark probe; only `next` writes the reusable last-run packet used by `log --from-last`, and stale/no-packet errors now print exact recovery commands.
- Current-tree finalization now excludes `autoresearch.*`, `autoresearch.research/**`, dashboard exports, and finalization scratch files by default, and finalizer summaries avoid cleanup commands until merge verification succeeds.

### Fixed

- Quality-gap and plateau readouts now keep `quality_gap=0` round-local, expose fresh-round suggestions, and steer repeated exact-score shelves toward scout, constraint-removal, or new-segment work.

Bumped public package and plugin manifest version surfaces to `1.4.0`.

## 1.3.7

### Changed

- Refreshed the checked-in demo dashboard export and showcase image for the current readout UI.
- Removed completed improvement-plan docs now that their work has landed.

### Fixed

- Static dashboard exports no longer render live command-copy controls in the decision rail or mission-control readout.
- Dashboard CSS no longer imports Google Fonts, keeping exported snapshots self-contained.
- Demo export checks now pass without leaking local workstation paths or non-public export flags.

Bumped public package and plugin manifest version surfaces to `1.3.7`.

## 1.3.6

### Added

- Added release-ready hardening coverage for recurring skill progression areas: evidence hygiene, release workflow invariants, prompt-plan taxonomy, dashboard read-only behavior, and cross-surface release discipline.
- Added maintainer guidance that maps recent PR/review evidence patterns to concrete practice tasks and validation gates.

### Fixed

- Evidence redaction now collapses stack-trace file frames before dashboard, live-server, or packet evidence storage can expose local source paths.
- Prompt planning now treats qualitative security hygiene, release readiness, and dashboard/operator UX requests as `quality_gap` loops unless the prompt provides an explicit measured benchmark contract.

Bumped public package and plugin manifest version surfaces to `1.3.6`.

## 1.3.5

### Fixed

- Prompt planning now treats explicit `quality_gap`, friction, manual E2E, and user/AI experience prompts as quality-gap loops instead of borrowing unrelated existing benchmark scripts.

Bumped public package and plugin manifest version surfaces to `1.3.5`.

## 1.3.4

### Added

- External recipe catalogs now require explicit `--trust-catalog` opt-in before their commands can be used. Trusted catalog recipes record provenance in session config and later `doctor` / `next` runs block if the recipe changes.
- Packet evidence now quarantines `ARTIFACT` paths that resolve outside the target working directory instead of storing them as usable artifact paths.
- The checked-in demo session now includes a Unix-compatible benchmark replay script, so demo doctor checks work on non-Windows hosts without requiring PowerShell.

### Changed

- The served dashboard and static export are now strictly read-only readouts. Dashboard action routes, action controls, nonce plumbing, and action receipts were removed; setup, packet runs, logging, export, and finalization remain CLI-owned.
- Dashboard wording, mode labels, copy feedback, and chart dialog behavior now describe the surface as an `Autoresearch Readout` instead of an action console.
- Public docs and skill guidance now use the current CLI command names, keep workflow and architecture diagrams first in the docs index, and keep the root README focused on trying and installing the plugin.
- The checked-in demo dashboard export and showcase image were refreshed for the current readout design and plugin version.

### Fixed

- Demo scaffold `commitPaths` now point at existing demo-owned files, and product checks now fail when the checked-in demo doctor/export evidence drifts from the current source.
- Default benchmark discovery now prefers `autoresearch.sh` on non-Windows hosts before falling back to `autoresearch.ps1`, preventing Linux CI from failing demo doctor checks with `exit 127`.
- Generated command displays, benchmark output tails, dashboard JSONL, and static readouts now redact token-looking values, URL credentials, home paths, and env-file paths before storing or serving evidence.

Bumped public package and plugin manifest version surfaces to `1.3.4`.

## 1.3.3

### Fixed

- Hardened CI token permissions, generated command display escaping, Markdown table escaping, and live dashboard action error output to resolve CodeQL code-scanning findings.
- Fixed recipe-backed setup planning so recommended recipes can supply their default benchmark command before missing setup fields are reported.
- Fixed packet artifact evidence so relative artifact paths are checked against the target working directory instead of the plugin process directory.

### Changed

- Removed the MCP server declaration and launcher surface. Codex Autoresearch now runs as a CLI/skill-only plugin to avoid Codex startup hangs from automatic MCP registration.
- Updated package checks, CI/release smoke tests, docs, and skill guidance to use `node scripts/autoresearch.mjs --help` and normal CLI commands instead of `mcp-smoke`.

Bumped public package and plugin manifest version surfaces to `1.3.3`.

## 1.3.0

### Added

- Added `scaffoldHealth` and `researchIntegrity` readouts across setup planning, guided setup, state, doctor, benchmark linting, dashboard state, and MCP resources so wrapper health and evidence promotion risk are visible before a packet is trusted.
- Added run evidence labels for development-only bests, pending repeats, promotion-eligible evidence, invalidated evidence, historical context, and blocked states.
- Added `finalize-current-tree --exclude-session-artifacts` / MCP `finalize_current_tree` to package the current non-session branch diff when commit-level kept evidence is stale or incomplete.
- Added the shared first-valid-loop next-step contract across setup planning, guided setup, prompt planning, onboarding, and next-action recommendations.
- Added packet evidence bundles with packet id, command identity, timeout, exit status, output tails, metrics, artifacts, checks, and freshness fingerprints.
- Added read-only MCP resource templates for packet summary, packet evidence, packet artifacts, and finalization plans, plus a `finalize-kept-work` MCP prompt.
- Added Go and .NET runtime recipes while keeping placeholder/custom recipes as explicit failing setup commands until real metric commands are supplied.

### Changed

- Changed `benchmark-lint` to separate metric parsing from research-integrity checks, including suspicious perfect metrics, missing holdout/repeat guards, and dev-only evidence.
- Changed `finalize-preview` to include semantic safety blockers for later-invalidated keeps, contaminated keeps, reverted keeps, and current final-tree coverage instead of trusting every historical keep entry.
- Changed prompt planning so documented repo benchmark hints can outrank generic language or Cargo recipes when the docs name the metric-emitting harness.
- Changed logged decisions to persist metric eligibility, packet fingerprints, and promotion-state labels without requiring fake metrics for crashes or failed checks.
- Changed dashboard readouts to surface evidence labels and proof gaps beside the next safe action while keeping static exports read-only.

### Fixed

- Fixed finalization readiness for sessions where a later discard, contamination note, cache replay, failed repeat, or revert makes an earlier kept commit unsafe to promote.
- Fixed current-tree finalization so generated plans include finalizer fingerprints, exclude session artifacts by default, and preview blocks excluded commits that overlap planned files.
- Fixed scaffold health detection for direct PowerShell self-recursive wrappers such as `& .\autoresearch.ps1`.
- Added recovery-oriented docs for stale bests, contaminated evaluators, failed repeats, cache replay, current-tree finalization, command quoting recovery, and scaffold/config health blockers.

Bumped public package and plugin manifest version surfaces to `1.3.0`.

## 1.2.0

### Added

- Added packet `command_file` / env-file support (`--command-file` and CLI-safe `--packet-env-file`) plus `ARTIFACT name=path` parsing for benchmark-produced manifests.
- Added development-vs-promotion evidence tracks in state/dashboard data and broader prompt-plan benchmark discovery across scripts, package/cargo hints, docs, and autoresearch hints.
- Added finalizer-preview blockers for unkept non-session commits between base and HEAD, with final-tree coverage metadata.

### Changed

- Changed score-like composite prompt inference so generic `score` defaults higher-is-better unless the user states otherwise.
- Changed dashboard action ranking so ready finalization no longer outranks active ASI next-action research while budget remains.
- Changed the dashboard masthead status strip to show metric evidence instead of generic live-refresh boilerplate.
- Changed run-note writes to use a managed ledger block in `autoresearch.md` instead of appending at arbitrary markdown positions.

### Fixed

- Fixed dashboard mobile overflow and stopped showcase/demo mode from polling live-refresh endpoints that are unavailable in static or Vite preview contexts.
- Moved the dashboard current-decision rail directly below the chart so chart evidence stays first while the next safe operator action is no longer buried under context panels.
- Added preflight diagnostics for evaluator-contamination risk, benchmark contract changes after logged runs, missing commit paths before `git add`, Git index-lock recovery, discard cleanup ownership, and suspicious perfect secondary metrics.
- Fixed those diagnostics to hash command/env files, ignore internal empty Git runtime directories, allow tracked deletions in `commitPaths`, and require a metric wrapper before suggesting Cargo bench packets.

Bumped public package, plugin manifest, CLI server, and MCP server version surfaces to `1.2.0`.

## 1.1.15

### Added

- Added MCP resource templates and prompts for read-only session truth: state, last-run, quality-gap, dashboard-summary, continue-loop, review-last-packet, and first-valid-loop.
- Added explicit `guided_setup` dashboard startup support over MCP with `start_dashboard`, returning a verified live dashboard URL when requested.

### Changed

- Clarified that `guided_setup` is read-only by default but becomes a local process-starting operation when `start_dashboard=true`.

Bumped public package, plugin manifest, CLI server, and MCP server version surfaces to `1.1.15`.

## 1.1.14

### Fixed

- Restored published plugin reliability around runtime bootstrap behavior by ensuring the release artifact includes docs and runtime metadata checks are included in artifact verification.

### Changed

- Default the served dashboard live-refresh control to "on" when the dashboard is in a live-readout mode, so sessions now begin with automatic refresh enabled and stay up-to-date by default.

Bumped public package, plugin manifest, CLI server, and MCP server version surfaces to `1.1.14`.

## 1.1.13

### Fixed

- Added launcher bootstrapping for Git marketplace installs: if `dist/` is missing from a source-shaped plugin cache, `scripts/*.mjs` downloads and extracts the matching GitHub release tarball before importing the compiled runtime.

Bumped public package, plugin manifest, CLI server, and MCP server version surfaces to `1.1.13`.

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
