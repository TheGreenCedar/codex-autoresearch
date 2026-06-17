# Changelog

All notable user-facing changes to Codex Autoresearch are recorded here.

This project uses a root-only changelog because the root README is the public documentation surface for the plugin wrapper.

## Unreleased

### Added

- Added `ledger-doctor --cwd <project> [--json]` to report ledger run-number health, with guarded `--repair --yes` duplicate-run normalization that writes a timestamped backup first.

### Changed

- Fixed-control guard help now documents `--allow-fixed-control-rerun` on guarded benchmark-running commands; `fixedControl.forbiddenCommandPatterns` use literal substring matches and reruns require the explicit override.

## 2.3.15 - 2026-06-16

### Changed

- README: added the Ponytail plugin pairing note for short, measured improvement loops.
- README: problem/solution opener, worked example, and questions section (structure only; no behavior change).
- Documentation rewrite: plain-warm senior-engineer voice, clearer audience split between human docs and agent contracts, restructured docs index, and `concepts.md#state-fields` glossary for compact-state labels.
- Removed brittle doc-copy test gates (`ax-ux-golden-path`, `full-product-docs`, `loop-governance-docs`) and relaxed README phrase assertions in product tests.
- Clarified finalization preview docs and split reusable CLI parsing/dashboard helpers out of the main launcher.

### Fixed

- Showcase exports now embed showcase mode while retaining offline command stripping and ledger bounds, with demo trust gates covering stale showcase metadata.

## 2.3.14 - 2026-06-15

### Changed

- Centralized path-containment checks so finalizer, benchmark guards,
  session forensics, and research path guards share the same containment
  semantics.

## 2.3.13 - 2026-06-15

### Changed

- Human-facing docs now describe operator decisions without Codex-only process
  contracts, while the skill keeps agent-specific continuation guidance.
- README docs routing now favors first-run, trust, troubleshooting, and
  changelog surfaces instead of maintainer implementation paths.

## 2.3.12 - 2026-06-15

### Changed

- Removed unused helper exports and collapsed repeated optional-field response copy lists in compact state and recommendation builders.

## 2.3.11 - 2026-06-15

### Changed

- Removed unreachable dashboard command-copy UI and the stale live-ledger fallback because dashboard actions remain CLI-owned and `/view-model.json` carries the served readout payload.

## 2.3.10 - 2026-06-15

### Changed

- Wall-clock compact-read startup budgets moved into an explicit perf test so the normal correctness gate is not blocked by local machine variance.

## 2.3.9 - 2026-06-15

### Fixed

- Decision-capsule loop brakes now point operators at callable recovery surfaces instead of a non-existent `decision_capsule` tool.

## 2.3.8 - 2026-06-15

### Fixed

- Broad discard cleanup now preserves dashboard exports, `target/autoresearch/`, and `.autoresearch-cache/` before removing Autoresearch-owned dirty paths.

## 2.3.7 - 2026-06-15

### Fixed

- Dashboard readouts now keep the packet trend chart first; the next-action rail and readiness signals render below the chart instead of above or inside it.

## 2.3.6 - 2026-06-15

### Changed

- Added regression coverage for large repeated experiment families so memory
  summaries keep exhausted-family counts intact.

## 2.3.5 - 2026-06-15

### Changed

- Public README, package metadata, plugin metadata, and trust docs now use
  clearer customer-facing language for measured loops, live readouts, approved
  finalization, uninstall scope, and experiment outcomes.
- The public docs map now separates first-run operation, trust,
  troubleshooting, architecture, and maintainer surfaces.

## 2.3.4 - 2026-06-15

### Changed

- Partial-result salvage now byte-caps and row-caps artifacts, reports unsafe
  artifact notices, and keeps salvaged rows diagnostic-only.
- Hardened CLI and dashboard evidence redaction for response payloads, env-file
  references, common secret-key variants, home paths, and network paths.

### Fixed

- Rejected Git pathspec magic in keep, discard, and finalizer path inputs before
  Git can expand them beyond the intended scope.
- Guarded finalizer recursive removal against linked parent directories that
  resolve outside the working directory.
- `next` now refuses before benchmark execution when dirty Git fingerprint
  evidence would be truncated.

## 2.3.3 - 2026-06-15

### Changed

- Bounded long live dashboard ledger payloads with config continuity, chart
  downsampling, and compact view-model transport.
- Updated dashboard readout copy and refreshed the public live-readout
  screenshot, checked-in dashboard bundle, and showcase export.
- Served dashboard refreshes now retry one structured retryable view-model
  conflict before reporting a live refresh failure.

### Fixed

- Live dashboard pages now start from the served `/view-model.json` payload
  when bootstrapped empty instead of retaining demo data.

## 2.3.2 - 2026-06-15

### Changed

- Added shared session record/read-model helpers for compact state,
  recommendations, dashboard exports, and command readouts.
- Split log, next, run, and recommendation command behavior into focused
  command modules while preserving the public CLI surface.

### Fixed

- Reused loaded session records across state and compact readouts instead of
  reparsing the ledger during the same view-model build.

## 2.3.1 - 2026-06-15

### Changed

- Added reusable workflow policy validation and tightened CI/release launcher
  smoke coverage for the Codex Autoresearch package.
- Stabilized compiled CLI test sharding by reducing the CLI shard worker count.

## 2.3.0

### Changed

- Added shared control-plane contracts across compact state, recommendations,
  loop governance, packet preflight, lane approvals, evidence maturity,
  session forensics, and finalization runway readouts so goal mismatches,
  approval stalls, stale process residue, unsupported broad claims, local-only
  review branches, and unsafe branch reuse become explicit blockers or
  warnings.
- Tightened Autoresearch control-plane behavior: finalization review branches
  now require content-equivalence before reuse, big-idea approvals remain
  durable after lane results are recorded, repeated command heads, including
  benchmark commands, are warnings instead of hard resource blockers, and the
  temporary control-plane spec pack has been removed from the release diff.
- Clarified Autoresearch trust guidance for benchmark-shaped wins: row-specific
  detectors, exact probes, static benchmark citations, or manifest-tuned fixes
  are diagnostic/provisional until holdout, repeat, breadth, or promotion-gate
  evidence proves the broader claim.
- Added session-forensics detection for benchmark overfit/steering so imported
  sessions can hard-block generic packets and finalization until row-specific
  evidence is downgraded and holdout or breadth validation has passed.
- Made `session-forensics` compact by default, preserving full signal and
  command-class output behind `--json-full`/`--verbose` for direct JSON
  consumers that need `commandClasses` or ungrouped arrays, and render imported
  capsule commands with the plugin launcher instead of target-repo-relative
  `scripts/autoresearch.mjs` paths.
- Tightened the Codex-facing skill so loop-contract blockers outrank source
  cleanliness when deciding whether to spend another packet.
- Updated public prompt examples to begin with `/goal` and mention
  `@Codex Autoresearch`, while keeping marketplace starters as simple
  `@Codex Autoresearch` mentions.

### Release

- Bumped public package, lockfile, and plugin manifest surfaces to `2.3.0`.

## 2.2.1

### Fixed

- Bumped `shell-quote` to `1.8.4` for the dependency security patch.

### Release

- Bumped public package, lockfile, and plugin manifest surfaces to `2.2.1`.

## 2.2.0

### Changed

- Added product-grade claim coverage across state, dashboard, and finalization so shippable/final requests separate experimental evidence from proof of accuracy, lazy behavior, ranking quality, and docs/tests coverage.
- Finalization plans and current-tree plans now carry fingerprinted claim coverage; tampered or missing product-grade proof downgrades review-branch wording instead of implying merge-ready delivery.
- `finalizationReadiness` now exposes `productGradeReady` and `productGradeIssue` alongside mechanical preview readiness.
- Performance setup can persist quality constraints into the session config and surface them through gate-quality promotion checks.
- `new-segment` accepts benchmark commands through validated tool calls (`allow_unsafe_command`) and honors explicit `--direction lower`.
- Dashboard `serve` reuses healthy same-cwd registry entries, records debug-ledger mode, and reports accurate reuse metadata.
- Dashboard proof coverage, chart roving tabindex, and live handoff receipts surface claim gaps and recovery state earlier.
- `recommend-next --compact` bounded handoffs preserve operator handoff, loop contract essentials, runnable commands, and an output-side size budget.
- Session forensics detects false-done/product-bar rejections with polarity checks and dedupes oversized-output noise.
- Documented the finalization preview ship bar, dashboard live handoff expectations, new-segment benchmark repair, oversized-output recovery, and speed-without-correctness troubleshooting across the main docs and Codex-facing skill.
- Lightened common read commands with per-invocation session read caching and a compact `guide` fast path.

### Fixed

- Negation-blind claim coverage no longer treats "accuracy was NOT tested" as proof of accuracy.
- Plain performance goals no longer inherit retrieval-specific sidecar requirements unless the goal names retrieval/search semantics.
- Reused dashboard responses no longer claim `debugLedger.enabled: false` when the live server was started with `--debug-ledger`.

### Release

- Bumped public package, lockfile, plugin manifest, and runtime drift surfaces to `2.2.0`.

## 2.1.8

### Changed

- Kept the dashboard chart-first while moving trust blockers, proof gaps, and process warnings into a below-chart disclosure; improved chart point accessible labels, focus recovery, mission state, refresh announcements, and generated dashboard/brand assets.
- Centralized unsafe command approval for tool-style benchmark/check command arguments and added a live view-model cache with session-file invalidation.
- Clarified Codex plugin install guidance around the workspace/plugin UI path, with the CLI marketplace command treated as build-dependent source-marketplace support.
- Added real privacy and terms docs and aligned README/trust guidance around local-only session files, non-sandboxed benchmark commands, best-effort redaction, and user responsibility for secrets and external services.
- Corrected demo and walkthrough docs so benchmark parsing, doctor readiness, finalization blockers, and illustrative output are not presented as the same level of proof.
- Added local safety checkpoints before mutating log, discard, revert, and finalization examples.
- Made compact state, `recommend-next --compact`, `doctor --check-benchmark --explain`, terminal reports, and dashboard readouts share finalization readiness and canonical next-action authority.
- Updated default help and start docs to show read-only `setup-plan`/`prompt-plan` before mutating `setup`.
- Reframed the dashboard decision rail as a read-only "Do this first" surface and kept the ledger navigation target visible even before runs are logged.
- Tightened the resume/finalize journey so plateau pivots no longer suggest another packet, stale dashboards point to fresh `serve`, first baselines log as `measure`, and finalizer output avoids cleanup commands before verified merge.
- Clarified the qualitative checklist-measured journey with front-door `research-setup -> quality-gap -> gap-candidates` guidance and aligned README, docs, skill, and plugin metadata around `measure`.

### Fixed

- Stripped finalization command-shaped fields such as suggested commands, argv/display payloads, and plan-output paths from dashboard view models.
- Added pending log-mutation receipts so interrupted keep/discard automation blocks later state, doctor, and log attempts until the ledger is reconciled.
- Added a terminal `ready-with-warnings` status so advisory warnings no longer collapse into plain ready.

### Release

- Bumped public package, lockfile, plugin manifest, and runtime drift surfaces to `2.1.8`.

## 2.1.7

### Fixed

- Removed shell-routed Windows check commands from the maintainer gate and resolved npm through `npm-cli.js` instead, with a clear failure when a shell-free npm entrypoint cannot be found.
- Added regression coverage for Windows npm resolution so the CodeQL fix does not break direct `node scripts/check.mjs` runs on normal Windows installs.

### Release

- Bumped public package, lockfile, plugin manifest, and runtime drift surfaces to `2.1.7`.

## 2.1.6

### Fixed

- Hardened source-checkout runtime hydration so missing `dist/` is filled only from a matching release tarball with a verified adjacent SHA-256 checksum and matching packaged name/version.

### Release

- Bumped public package, lockfile, plugin manifest, and runtime drift surfaces to `2.1.6`.

## 2.1.5

### Fixed

- Render generated commands with explicit PowerShell/POSIX shell quoting, and include `--cwd` in finalizer plan suggestions so copied finalizer commands target the previewed repo.
- Restored served dashboard live refresh from the redacted view model path while keeping raw ledger access limited to the debug surface.
- Added live-refresh tests and type coverage so dashboard snapshots can update without reintroducing raw-session payload exposure.
- Corrected `--help --all` so `guide` documents the same setup guardrail and budget flags as the read-only setup planning flow.
- Hardened artifact evidence and dashboard exports so symlinks or junctions cannot make trusted paths escape `--cwd`.
- Corrected first-run baseline docs to log `measure`, hardened live dashboard refresh ordering and chart semantics, and made maintainer verification guidance match the source-checkout scripts.

### Release

- Bumped public package, lockfile, plugin manifest, and runtime drift surfaces to `2.1.5`.

## 2.1.4

### Fixed

- Added explicit tool/CLI handling for clearing packet budgets, wall-clock budgets, and budget notes without accepting bare numeric budget flags.
- Hardened protected benchmark path and dashboard launcher validation with regression coverage for hostile edits and canonical package-local launchers.
- Kept lane-runner budget behavior aligned with the guarded loop contract when budget values are updated or cleared.

### Release

- Bumped public package, lockfile, plugin manifest, and runtime drift surfaces to `2.1.4`.

## 2.1.3

### Changed

- Clarified onboarding, marketplace prompts, and generated prompt-plan/report handoffs so the default loop stays on the short CLI path, with the live dashboard available when a fresh visual readout is useful.
- Documented that benchmark and checks commands are not sandboxed, packet environments inherit local state by default, and evidence redaction is best-effort rather than a confidentiality guarantee.
- Reframed docs, skill guidance, default prompts, and tests around dashboard-optional operation instead of dashboard-first workflow.

### Release

- Bumped public package, lockfile, plugin manifest, and runtime drift surfaces to `2.1.3`.

## 2.1.2

### Changed

- Reduced the Codex-facing skill entrypoint and moved deeper loop, dashboard/trust, and finalization guidance into deferred reference files.

### Fixed

- Fixed `config` so protected benchmark paths, secondary metric constraints, commit paths, packet budgets, wall-clock budgets, and budget notes can be updated or intentionally cleared through the normal CLI/tool path.
- Fixed secondary metric constraint evaluation so per-constraint blocking/advisory modes are preserved and blank metric strings are treated as unavailable instead of zero.
- Hardened dashboard command safety so absolute Autoresearch launcher paths must point inside the installed/source plugin package, not arbitrary `scripts/autoresearch.mjs` lookalikes.
- Added runner timeout fallback resolution after kill attempts so stubborn child processes do not leave main runner paths waiting indefinitely.

### Release

- Bumped public package, lockfile, plugin manifest, and runtime drift surfaces to `2.1.2`.

## 2.1.1

### Changed

- Clarified public onboarding and trust docs around scoped staging/revert/finalization boundaries, bounded packet stop conditions, the Node.js 24 development floor, non-sandboxed benchmark/check commands, and best-effort evidence redaction.
- Added explicit benchmark guardrails for protected benchmark paths, packet/wall-clock budgets, secondary metric non-regression constraints, and approval-gated big-idea lanes.

### Fixed

- Added source/package hygiene checks so local agent/editor artifacts, stale formatter config, missing Node engine metadata, and dashboard-only runtime dependencies are caught before release-style verification.
- Fixed unbounded sessions so `remainingIterations: null` no longer creates a bogus segment-transition blocker before the first packet.

### Release

- Bumped public package, lockfile, plugin manifest, and runtime drift surfaces to `2.1.1`.

## 2.1.0

### Added

- Added gate-quality, preflight, runtime-drift, structured lane-brief, dashboard-health, and packet-diagnostic readouts to state, report, doctor, and recommend-next surfaces, plus optional `task_manifest` packet evidence on next/log/state evidence surfaces and advisory portfolio guidance on state and `recommend-next`.
- Added `state --report`, a compact terminal-first report with `report.text` and `report.json` so blockers, next command, gate quality, runtime drift, dashboard status, packet diagnostics, and portfolio guidance are visible without opening the dashboard.
- Added `sourceCleanliness` so state/report can distinguish source drift from dirty Autoresearch session artifacts, and added opt-in `--progress` stderr heartbeats for slow finalization/export commands.

### Changed

- `serve` now returns read-only dashboard health metadata such as pid, cwd, port, version, registry path, health URL, started time, and liveness; `/health` exposes the active process liveness subset without adding dashboard mutation controls.
- Remediated decision guidance around one canonical guidance authority: HTTP-verified dashboard liveness, durable task artifact diagnostics, policy-aware missing-checks guidance, and terminal report rendering now come from the same state path before packet work is recommended.
- Saturated gap-style metrics such as `agent_value_gap=0` now become a review/rescope checkpoint when promotion-grade evidence is missing instead of silently recommending another same-metric packet.
- `finalize-preview` now emits structured `actionCode` guidance so current-tree finalization blockers are detected without relying only on prose matching.

### Fixed

- Hardened optional `task_manifest` packet evidence so symlinked or realpath-resolved manifests outside `--cwd` are quarantined before task rows are read.
- Dashboard command safety now accepts generated Windows launcher paths for read-only Autoresearch commands while continuing to reject mutating command payloads.
- Source cleanliness no longer emits a copyable `git stash` cleanup command for dirty Autoresearch session artifacts; readouts keep cleanup guidance descriptive instead of shell-ready.
- Stale last-run replacement guidance now uses replay-safe packet commands instead of display-redacted command evidence, keeping `state` and `recommend-next` replacement commands runnable across CI platforms.
- Runtime drift inspection command quoting now normalizes path separators before JSON-encoding quoted arguments so generated smoke-check commands remain correctly encoded.
- Runtime drift now requires matching built-entrypoint fingerprints before a same-version installed runtime is reported as fresh.
- Gate quality keeps benchmark-as-checks classified as smoke coverage even when promotion metadata is present.
- `serve` now derives returned dashboard health from `/health` verification, including port, cwd, and version matching, before reporting the dashboard as verified.
- `next` now refuses to overwrite a fresh unlogged last-run packet, while stale-packet replacement commands remain runnable and copy safely through Windows PowerShell.
- Loop guidance now keeps independent gate/preflight blockers ahead of stale-packet replacement, prioritizes partial-result salvage before fresh-packet logging, and keeps read-only dashboard guidance on preview commands instead of mutating finalization.
- `guide`, dashboard exports, and `recommend-next` now agree on canonical preflight blockers before packet work while keeping setup repair, stale-packet replacement, and pending-log paths sharper.
- Dashboard command rails now omit mutating run/log/current-tree-finalization/limit-extension commands and keep diagnostic, preview, and dry-run commands only.
- Dashboard command rails now stay readout-only: generated copyable commands no longer include server starts, static exports, benchmark execution checks, or bare benchmark-lint invocations.
- Dashboard command safety now rejects unquoted parenthesized shell expressions and custom `--command` / `--checks-command` payloads before marking read-only commands as copyable.
- Dashboard command safety now requires the real `node ... scripts/autoresearch.mjs` launcher, blocks `--` separator payloads, and aligns copyable commands with registry action policy plus dashboard-only readout overrides.
- Dashboard and terminal-report command fallbacks now apply the same readout policy, including Windows quote safety and registry-derived custom command flags such as `--benchmark-command`.
- Terminal reports now keep readout command fields non-mutating by filtering explicit canonical check commands, dashboard restart commands, and Git cleanup commands to descriptive guidance or read-only health probes.
- Full `state`, dashboard, and non-compact `recommend-next` now use the runnable stale-packet replacement or full finalization authority instead of falling back to another status read or compact next-packet guidance.
- `integrations` now respects normalized subcommand arguments, so tool-driven `doctor` and `sync-recipes` calls no longer fall back to `list`.
- `next_experiment` output schemas now include the full packet, history, last-run path, and report fields that the tool already returns.

### Release

- Bumped public package, lockfile, plugin manifest, and runtime drift surfaces to `2.1.0`.

## 2.0.2

### Added

- Added GitHub community-standard files for contribution guidance, conduct, security reporting, issue templates, and pull request review shape.
- Added compact `goalFrame` and `operatorHandoff` fields so Codex resumes from the durable Autoresearch goal instead of treating the latest operator prompt as the objective.
- Added session-forensics detection for prompt-vs-research-goal corrections through the `goal_frame_mismatch` decision capsule.

### Changed

- Replaced the tall README dashboard screenshot with a compact showcase snapshot and added a product-gate check so the public README image does not regress into a full-page capture.
- Updated the Codex-facing Autoresearch skill to suggest opening a GitHub issue when user frustration or repeated failures point to an Autoresearch product bug, docs gap, stale runtime trap, or UX paper cut.
- Changed compact `recommend-next` to use state-first handoff data instead of dashboard-grade rendering work during Codex resume.

### Fixed

- Rejected latest dashboard runs now keep rejected styling in the chart halo, selected metric details, and experiment modal instead of borrowing kept-run teal emphasis.
- Fixed `benchmark-lint --sample` so configured holdout guards count during parser-only integrity checks.

### Release

- Bumped public package, lockfile, plugin manifest, built assets, and runtime drift surfaces to `2.0.2`.

## 2.0.1

### Changed

- `session-forensics` now emits and writes a structured decision capsule so long-session imports preserve the bottleneck, evidence, next experiment, wrong next actions, and repeated command families before another expensive packet is spent.
- Decision capsules now recognize broken benchmark contracts, including `benchmark-lint` timeouts or missing primary `METRIC` lines, as setup repair work rather than product packet progress.
- Active decision capsules now appear as `sessionDecisionCapsule` in state-style outputs and can surface `decision-capsule` as the canonical next action; hard blockers refuse generic `next` and finalization until repaired or acknowledged.
- Added packet-brake guidance to the Codex-facing skill and operator docs so agents check the resume contract, benchmark-lint contract, partial results, and carry-forward lesson before heavy reruns.

### Fixed

- Dashboard ASI readouts now render structured evidence arrays and objects as readable text instead of leaking `[object Object]` into chart details, modal evidence, ledger previews, and next-action surfaces.

### Release

- Bumped public package, lockfile, plugin manifest, built assets, and runtime drift surfaces to `2.0.1`.

## 2.0.0

### Added

- Added `research-fanout` / `research_fanout`, a generic parallel lane planner that turns current session memory into read-only scout lanes and isolated implementation lanes without creating project-specific metrics.
- Added `lane-runner` / `lane_runner`, a conservative coordinator path for recording or running one lane with read-only defaults, implementation isolation checks, time budgets, and one synthesized next measured packet recommendation.
- Added `--metrics-file` for `log` so PowerShell and Windows sessions can record structured metric metadata without brittle inline JSON quoting.
- Added `--asi-json-file` for `log` so PowerShell and Windows sessions can record ASI without fragile inline JSON quoting while preserving inline `--asi` and legacy `--asi-file`.
- Added run-level `evidenceStatus` labels and artifact evidence summaries so accepted, rejected, provisional, superseded, and quarantined evidence stay visible without becoming promotion signals by accident.
- Added watchdog, process-hygiene, and finalization-pressure dashboard readouts so long quiet windows, stale snapshots, runtime provenance, and accumulating kept work become visible before the loop sleepwalks into more packets.
- Added loop-governance readouts, operator checklist mode, stale lane lifecycle, runtime provenance, packet diagnostic taxonomy, and dashboard packet brake status so long Codex loops are harder to continue unsafely.
- Added a central EvidenceRegistry so accepted/current evidence is separated from rejected, provisional, superseded, and quarantined audit evidence before state and dashboard consumers read it.
- Hardened finalization and best-run readouts so only accepted/current keeps drive promotion surfaces and review branches; rejected, provisional, superseded, and quarantined evidence remains audit-only.

### Changed

- Redesigned the dashboard with an audit/operate split: the served dashboard now opens in audit view (full traceability); operate (Focus view) is a chart-first surface with audit panels omitted from the DOM. The run chart leads after the header in both views (taller in operate). URL-backed view and chart preferences are included.
- The served dashboard now returns its verified local URL before loading heavier decision diagnostics; the live page refreshes the full view model from `/view-model.json`.
- Dashboard segment navigation now uses a native dropdown again.
- Added a quiet chart-adjacent readiness strip for next action, evidence status, lane readiness, watchdog state, and finalization pressure without adding dashboard mutation controls.
- Dashboard view, selected segment, and chart value/axis preferences are now stored in the URL (`?view=`, `?segment=`, `?value=`, `?axis=`) so a served link restores and shares the exact readout state.
- Removed dashboard accessibility/guideline anti-patterns: scoped all `transition` declarations to explicit properties and replaced literal ellipses with the `…` character.
- Dashboard view models now expose `fanoutPlan`, `parallelLanes`, and an `evidenceLedger`, and the Strategy Lanes board shows lane mode, lane status, evidence status, and next recommendations.
- The decision envelope can now prioritize watchdog intervention when no metric movement, logged decision, kept commit, or completed lane appears inside the configured quiet-window threshold.
- `state`, `recommend-next`, and the dashboard now share the same watchdog-aware decision envelope inputs, so quiet-window pressure is visible on CLI surfaces as well as the dashboard.
- `research-fanout` plans are segment-scoped: a new segment ignores prior fanout plans and falls back to memory/default lanes until a fresh plan is recorded for that segment.
- Completed `lane-runner` results now enrich parallel lane status and count as watchdog progress signals.
- Dashboard best-kept and finalization surfaces now ignore rejected, superseded, non-accepted, and quarantined keeps across both server view-model and client readout paths.
- Lane lifecycle readouts now ignore completed lane results from older segments even when passed through direct lane-result inputs.
- Empty `lane-runner --yes` records are planning breadcrumbs, not completed accepted evidence, and do not reset watchdog progress.
- Read-only scout lanes fail closed when running commands outside a Git worktree unless `--allow-non-git-command` is explicitly passed.
- `research_fanout` tool metadata now avoids unconditional read-only claims because `--yes` appends a fanout plan to the ledger.
- Autoresearch-owned dirty files such as `autoresearch.jsonl`, notes, dashboards, and research scratchpads no longer count as dirty source drift; unrelated source dirtiness still blocks trust.
- Added narrower package test scripts for CLI, dashboard, finalization, and core evidence slices; the compiled CLI regression path now runs bounded shards instead of one giant serial file.
- Stabilized served-dashboard live refresh so successful metadata updates do not recreate the refresh interval or trigger an extra immediate fetch.
- Hardened bounded test sharding so invalid job counts fail with usage errors, unsharded files run once, and sharded files must emit an explicit test-count marker.
- Tightened `session-forensics` privacy defaults: outside-workdir JSONL reads now require an explicit gate, snippets stay opt-in, and returned source/command paths are redacted or relative.
- Made `finalize-preview` fail closed on corrupt `autoresearch.jsonl` ledgers instead of treating them as an empty finalization history.
- Aligned the dashboard dev entry with the TypeScript source entrypoint (`/src/main.tsx`).
- Simplified internal tool schema lookups, CLI projection helpers, runner/setup response assembly, finalization progress metadata, evidence predicates, next-action policy rules, and dashboard component/live-refresh surfaces without changing public JSON contracts.
- Continued the simplification sweep by sharing verification runners and temp cleanup, extracting finalization plan helpers and focused CLI command modules, centralizing evidence status taxonomy, splitting dashboard chart/details/modal surfaces, and rendering weighted metric formulas from configured weights.

### Fixed
- Refreshed the v2 documentation map, glossary, workflow diagrams, finalization wording, troubleshooting rows, and public README so they describe the current operator checklist, watchdog, lane, runtime-provenance, packet-diagnostic, evidence-status, and audit/operate dashboard behavior.
- Scrubbed branch-specific finalization warnings from public showcase dashboard exports and added release-gate checks so demo snapshots cannot ship with transient source-branch warnings.
- Made the documented `scripts/finalize-autoresearch.mjs` launcher hydrate the matching release runtime like the main CLI launcher, and added package smoke coverage for it.

### Release

- Bumped public package, lockfile, plugin manifest, built assets, and local cache runtime surfaces to `2.0.0`.

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
