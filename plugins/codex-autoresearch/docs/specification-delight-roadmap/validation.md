# Validation Report

## 1. Requirements to Tasks Traceability Matrix

| Requirement | Acceptance Criterion | Implementing Task(s) | Status |
|---|---|---|---|
| 1. Guided First-Run and Resume Flow | 1.1 | Task 1.1, Task 1.2, Task 1.3 | Covered |
| 1. Guided First-Run and Resume Flow | 1.2 | Task 1.2, Task 1.3, Task 1.5 | Covered |
| 1. Guided First-Run and Resume Flow | 1.3 | Task 1.2, Task 1.5 | Covered |
| 1. Guided First-Run and Resume Flow | 1.4 | Task 1.2, Task 1.5 | Covered |
| 1. Guided First-Run and Resume Flow | 1.5 | Task 1.4, Task 1.5 | Covered |
| 2. Mission-Control Dashboard | 2.1 | Task 2.1, Task 2.3, Task 8.4 | Covered |
| 2. Mission-Control Dashboard | 2.2 | Task 2.1, Task 2.2, Task 2.3 | Covered |
| 2. Mission-Control Dashboard | 2.3 | Task 2.5 | Covered |
| 2. Mission-Control Dashboard | 2.4 | Task 2.3, Task 3.2 | Covered |
| 2. Mission-Control Dashboard | 2.5 | Task 2.4, Task 8.4 | Covered |
| 3. Experiment Memory from ASI | 3.1 | Task 3.1, Task 3.2 | Covered |
| 3. Experiment Memory from ASI | 3.2 | Task 3.4 | Covered |
| 3. Experiment Memory from ASI | 3.3 | Task 3.3 | Covered |
| 3. Experiment Memory from ASI | 3.4 | Task 2.1, Task 2.3, Task 3.5 | Covered |
| 3. Experiment Memory from ASI | 3.5 | Task 3.5 | Covered |
| 4. Slow-Run Progress and Cancellation | 4.1 | Task 4.1, Task 4.2 | Covered |
| 4. Slow-Run Progress and Cancellation | 4.2 | Task 4.4 | Covered |
| 4. Slow-Run Progress and Cancellation | 4.3 | Task 4.5 | Covered |
| 4. Slow-Run Progress and Cancellation | 4.4 | Task 4.3 | Covered |
| 4. Slow-Run Progress and Cancellation | 4.5 | Task 4.5 | Covered |
| 5. MCP Tool Contract Clarity | 5.1 | Task 5.1, Task 5.2, Task 5.3 | Covered |
| 5. MCP Tool Contract Clarity | 5.2 | Task 5.2, Task 5.4 | Covered |
| 5. MCP Tool Contract Clarity | 5.3 | Task 5.2, Task 5.4 | Covered |
| 5. MCP Tool Contract Clarity | 5.4 | Task 5.1, Task 5.4 | Covered |
| 5. MCP Tool Contract Clarity | 5.5 | Task 5.3, Task 5.5 | Covered |
| 6. Source and Installed Version Drift Doctor | 6.1 | Task 6.1, Task 6.2 | Covered |
| 6. Source and Installed Version Drift Doctor | 6.2 | Task 6.4, Task 6.5 | Covered |
| 6. Source and Installed Version Drift Doctor | 6.3 | Task 6.3, Task 6.5 | Covered |
| 6. Source and Installed Version Drift Doctor | 6.4 | Task 6.4, Task 6.5 | Covered |
| 6. Source and Installed Version Drift Doctor | 6.5 | Task 6.3, Task 6.5 | Covered |
| 7. Research Gap and Recipe Predictability | 7.1 | Task 7.1 | Covered |
| 7. Research Gap and Recipe Predictability | 7.2 | Task 7.2 | Covered |
| 7. Research Gap and Recipe Predictability | 7.3 | Task 7.3 | Covered |
| 7. Research Gap and Recipe Predictability | 7.4 | Task 7.4 | Covered |
| 7. Research Gap and Recipe Predictability | 7.5 | Task 7.5 | Covered |
| 8. Validation and Regression Safety | 8.1 | Task 8.1 | Covered |
| 8. Validation and Regression Safety | 8.2 | Task 2.3, Task 8.4 | Covered |
| 8. Validation and Regression Safety | 8.3 | Task 5.5, Task 8.3 | Covered |
| 8. Validation and Regression Safety | 8.4 | Task 4.3 | Covered |
| 8. Validation and Regression Safety | 8.5 | Task 8.3 | Covered |

## 2. Component Coverage Matrix

| Component | Requirements Covered | Design Location | Primary Tasks |
|---|---|---|---|
| **GuidedSetupFlow** | Req 1 | `lib/guided-flow.mjs` | Task 1 |
| **MissionControlDashboard** | Req 2, Req 3.4, Req 8.2 | `lib/dashboard-view-model.mjs`, `assets/template.html`, `lib/live-server.mjs` | Task 2 |
| **ExperimentMemory** | Req 3 | `lib/experiment-memory.mjs` | Task 3 |
| **RunProgressAdapter** | Req 4, Req 8.4 | `lib/progress-adapter.mjs`, `lib/runner.mjs`, `scripts/autoresearch-mcp.mjs` | Task 4 |
| **ToolContractCatalog** | Req 5, Req 8.3 | `lib/tool-contracts.mjs`, `lib/mcp-interface.mjs` | Task 5 |
| **DriftDoctor** | Req 6 | `lib/drift-doctor.mjs`, `scripts/autoresearch.mjs` | Task 6 |
| **ResearchGapPolicy** | Req 7 | `lib/research-gaps.mjs`, `lib/recipes.mjs`, `scripts/autoresearch.mjs` | Task 7 |

## 3. Quality Gates

| Gate | Validation Method | Required Before Merge |
|---|---|---|
| Static CLI behavior preserved | Existing CLI tests plus new command-specific tests | Yes |
| Static dashboard preserved | Dashboard export fixture and HTML assertions | Yes |
| Live dashboard safe actions preserved | Live server endpoint tests | Yes |
| MCP server valid | `mcp-smoke` and tool schema tests | Yes |
| Version drift diagnostics safe | DriftDoctor unit tests with unavailable external Codex CLI case | Yes |
| Progress cancellation safe | Slow fixture proves no false JSONL run is written on cancellation | Yes |
| Full plugin gate | `npm run check` in `plugins/codex-autoresearch` | Yes |

## 4. Open Risks

- MCP Tasks are experimental, so full task support should be isolated behind capability checks and can land after progress notifications.
- Dashboard interaction can grow quickly; live actions should stay safe and local until mutation has its own threat model.
- Tool description changes can accidentally become verbose; ToolContractCatalog tests should cap guidance size.
- Version probing that shells out to Codex CLI can be slow or unavailable; DriftDoctor must keep this optional and time-bounded.

## 5. Validation Summary

All requirements defined in `requirements.md` map to at least one implementation task in `tasks.md`, and every component in `blueprint.md` has a corresponding design location in `design.md`. The implementation should proceed slice by slice, with `npm run check` from `plugins/codex-autoresearch` as the final gate for each reviewable batch.
