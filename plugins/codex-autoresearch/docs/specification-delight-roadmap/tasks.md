# Implementation Plan

- [ ] 1. Implement **GuidedSetupFlow**
  - [ ] 1.1 Create `plugins/codex-autoresearch/lib/guided-flow.mjs` with `buildGuidedSetupPacket`.
  - [ ] 1.2 Reuse existing setup-plan, recipe recommendation, doctor, state, and dashboard command helpers.
  - [ ] 1.3 Add a `guide` command or expand `setup-plan` with a `guided` packet while preserving existing output fields.
  - [ ] 1.4 Add resume block generation to session setup and research setup.
  - [ ] 1.5 Add CLI tests for no-session, no-baseline, and last-run-packet resume states.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [ ] 2. Upgrade **MissionControlDashboard** view model and template
  - [ ] 2.1 Extend `buildDashboardViewModel` to include `guidedSetup`, `experimentMemory`, and `drift`.
  - [ ] 2.2 Add setup/readiness/resume panels to `assets/template.html`.
  - [ ] 2.3 Add experiment memory panels and ledger expansion without breaking current static export.
  - [ ] 2.4 Add snapshot-only copy when live endpoints are unavailable.
  - [ ] 2.5 Keep live actions limited to safe local read/preview/export actions.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.4_

- [ ] 3. Implement **ExperimentMemory**
  - [ ] 3.1 Create `plugins/codex-autoresearch/lib/experiment-memory.mjs`.
  - [ ] 3.2 Summarize kept, discarded, crashed, checks-failed, rollback, and next-action ASI.
  - [ ] 3.3 Add weak-memory warnings when recent runs lack ASI.
  - [ ] 3.4 Add repeated-hypothesis detection helper and tests.
  - [ ] 3.5 Include compact memory in `state`, `doctor`, and dashboard view-model output.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [ ] 4. Add **RunProgressAdapter** as progressive enhancement
  - [ ] 4.1 Create `plugins/codex-autoresearch/lib/progress-adapter.mjs`.
  - [ ] 4.2 Wrap runner execution with elapsed time, stage, output tail, and final status reporting.
  - [ ] 4.3 Add cancellation-safe process termination tests using a deliberately slow benchmark fixture.
  - [ ] 4.4 Add MCP progress notifications where transport support exists.
  - [ ] 4.5 Gate MCP task support behind explicit capability negotiation and keep synchronous fallback.
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

- [ ] 5. Build **ToolContractCatalog**
  - [ ] 5.1 Create `plugins/codex-autoresearch/lib/tool-contracts.mjs`.
  - [ ] 5.2 Define purpose, when-to-use, adjacent-tool contrast, safety caveat, and output contract for each MCP tool.
  - [ ] 5.3 Generate concise descriptions or validate the existing `toolSchemas` descriptions against catalog entries.
  - [ ] 5.4 Add fixture tests for the adjacent tool pairs.
  - [ ] 5.5 Keep MCP smoke and tools/list tests passing.
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 8.3_

- [ ] 6. Implement **DriftDoctor**
  - [ ] 6.1 Create `plugins/codex-autoresearch/lib/drift-doctor.mjs`.
  - [ ] 6.2 Parse package, manifest, full CLI MCP server, and lightweight MCP entrypoint versions.
  - [ ] 6.3 Add non-fatal optional probing for `codex mcp get codex-autoresearch`.
  - [ ] 6.4 Add doctor warnings for mismatched local source surfaces or installed cache drift.
  - [ ] 6.5 Add tests for synced versions, local mismatch, unavailable Codex CLI, and installed-cache mismatch.
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

- [ ] 7. Tighten **ResearchGapPolicy**
  - [ ] 7.1 Add active quality-gap slug resolution for the `quality-gap` recipe.
  - [ ] 7.2 Change `gap-candidates --apply` to maintain one canonical candidate section.
  - [ ] 7.3 Add recipe tags and include them in recipe list/show outputs.
  - [ ] 7.4 Add `quality-gap --list --json` with open and closed item titles.
  - [ ] 7.5 Add tests that root and plugin artifact ignore behavior matches documented self-dogfooding paths.
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

- [ ] 8. Validate roadmap slices
  - [ ] 8.1 Run targeted tests for each component after its slice lands.
  - [ ] 8.2 Run `node --test tests/*.test.mjs` from `plugins/codex-autoresearch`.
  - [ ] 8.3 Run `npm run check` from `plugins/codex-autoresearch`.
  - [ ] 8.4 Export or serve the dashboard and inspect static fallback after dashboard slices.
  - [ ] 8.5 Update this specification if implementation deliberately diverges.
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_
