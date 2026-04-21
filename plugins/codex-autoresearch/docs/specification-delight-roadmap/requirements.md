# Requirements Document

## Introduction

This document defines traceable requirements for the Codex Autoresearch delight roadmap. The requirements target the components defined in `blueprint.md` and are designed to be implemented incrementally without breaking existing CLI, MCP, dashboard, or static-export behavior.

## Glossary

- **ASI**: Actionable side information recorded with run results, such as `hypothesis`, `evidence`, `rollback_reason`, and `next_action_hint`.
- **Baseline packet**: The first measured `next` run that establishes the current benchmark value before optimization.
- **Continuation contract**: The machine-readable `continuation` object returned by state, doctor, next, and log flows.
- **Mission control**: The dashboard/readout surface that tells the operator what happened, what is safe, and what to do next.
- **Version drift**: A mismatch between source package version, plugin manifest version, MCP server version, lightweight entrypoint version, or installed plugin cache.

## Requirements

### Requirement 1: Guided First-Run and Resume Flow

#### Acceptance Criteria

1. WHEN an operator asks to start or resume an autoresearch loop, THE **GuidedSetupFlow** SHALL return a single read-only packet containing setup readiness, missing fields, recommended recipe, doctor summary, baseline command, log command, dashboard command, and safe next action.
2. WHEN no session exists but a recipe can be inferred, THE **GuidedSetupFlow** SHALL present the inferred recipe, benchmark command, checks command, metric name, direction, and caveats before any mutating setup action.
3. WHEN a session exists with no logged runs, THE **GuidedSetupFlow** SHALL prioritize running and logging a baseline before proposing optimization changes.
4. WHEN a last-run packet exists, THE **GuidedSetupFlow** SHALL surface only allowed log statuses and a `log --from-last` command template.
5. WHEN generated `autoresearch.md` is created or refreshed, THE **GuidedSetupFlow** SHALL include a concise resume block with exact `state`, `doctor`, `next`, `log --from-last`, and `export` commands.

### Requirement 2: Mission-Control Dashboard

#### Acceptance Criteria

1. WHEN `export_dashboard` runs, THE **MissionControlDashboard** SHALL preserve the current self-contained static HTML export.
2. WHEN served through live mode, THE **MissionControlDashboard** SHALL show setup readiness, doctor warnings, quality gaps, finalization readiness, experiment memory, and next action from one view model.
3. WHEN a live action is rendered, THE **MissionControlDashboard** SHALL limit actions to safe local commands unless a separate future requirement explicitly approves mutation.
4. WHEN an operator reviews a run, THE **MissionControlDashboard** SHALL show metric, status, commit, confidence, ASI summary, and rollback or next-action evidence.
5. WHEN the dashboard cannot reach live endpoints, THE **MissionControlDashboard** SHALL degrade to the embedded snapshot without showing misleading live affordances.

### Requirement 3: Experiment Memory from ASI

#### Acceptance Criteria

1. WHEN at least one run is logged, THE **ExperimentMemory** SHALL summarize kept hypotheses, discarded hypotheses, crashes, checks failures, rollback reasons, and next-action hints.
2. WHEN a new proposed hypothesis matches a prior discarded or failed hypothesis, THE **ExperimentMemory** SHALL warn before rerunning the same idea.
3. WHEN no ASI exists for recent runs, THE **ExperimentMemory** SHALL report that memory quality is weak and recommend the minimum ASI fields to fill.
4. WHEN dashboard state is built, THE **ExperimentMemory** SHALL provide compact values suitable for cockpit panels and detailed values suitable for a ledger view.
5. WHEN state or doctor output is requested from CLI or MCP, THE **ExperimentMemory** SHALL expose a text-safe summary without requiring dashboard HTML.

### Requirement 4: Slow-Run Progress and Cancellation

#### Acceptance Criteria

1. WHEN `next`, `doctor --check-benchmark`, `export`, or `finalize-preview` may take longer than the configured threshold, THE **RunProgressAdapter** SHALL expose elapsed time, command stage, latest output tail, and final status.
2. WHEN the caller and transport support MCP progress notifications, THE **RunProgressAdapter** SHALL emit progress updates without changing the final synchronous result shape.
3. WHEN the caller and transport support MCP tasks, THE **RunProgressAdapter** SHALL optionally expose task state, polling, result retrieval, and cancellation metadata.
4. WHEN cancellation is requested, THE **RunProgressAdapter** SHALL stop the child process best-effort, avoid writing a false keep/discard run, and return an explicit cancelled status.
5. WHEN task or progress support is unavailable, THE **RunProgressAdapter** SHALL fall back to the existing synchronous CLI/MCP behavior.

### Requirement 5: MCP Tool Contract Clarity

#### Acceptance Criteria

1. WHEN MCP tools are listed, THE **ToolContractCatalog** SHALL provide compact descriptions that include purpose, when to use, and the most common adjacent-tool distinction.
2. WHEN a tool returns structured JSON, THE **ToolContractCatalog** SHALL define an output contract fixture for the fields agents rely on.
3. WHEN two tools are adjacent, such as `setup_plan` and `setup_session` or `run_experiment` and `next_experiment`, THE **ToolContractCatalog** SHALL document the contrast in tests and generated guidance.
4. WHEN a new MCP tool is added, THE **ToolContractCatalog** SHALL fail validation if purpose, inputs, output contract, safety caveat, and adjacent-tool contrast are missing.
5. WHEN tool descriptions are revised, THE **ToolContractCatalog** SHALL keep descriptions concise enough to avoid unnecessary context bloat.

### Requirement 6: Source and Installed Version Drift Doctor

#### Acceptance Criteria

1. WHEN `doctor` runs, THE **DriftDoctor** SHALL report source package version, plugin manifest version, full CLI MCP server version, and lightweight MCP entrypoint version.
2. WHEN version surfaces disagree, THE **DriftDoctor** SHALL emit a warning with the specific files or runtime surfaces that disagree.
3. WHEN `codex mcp get codex-autoresearch` is available and safe to run, THE **DriftDoctor** SHALL optionally report the installed plugin path and version.
4. WHEN the installed cache version differs from the local source version, THE **DriftDoctor** SHALL describe that as a routing/cache warning rather than a code failure.
5. WHEN version probing fails because Codex CLI is unavailable, THE **DriftDoctor** SHALL continue doctoring and include a non-fatal unavailable diagnostic.

### Requirement 7: Research Gap and Recipe Predictability

#### Acceptance Criteria

1. WHEN the `quality-gap` recipe is used, THE **ResearchGapPolicy** SHALL detect the active research slug or require the operator to choose one instead of silently defaulting to `research`.
2. WHEN `gap-candidates --apply` runs repeatedly, THE **ResearchGapPolicy** SHALL maintain one canonical candidate section or append only genuinely new checklist items under a stable heading.
3. WHEN recipes are listed, THE **ResearchGapPolicy** SHALL include tags or categories such as `runtime`, `frontend`, `research`, `build`, `memory`, and `safety`.
4. WHEN research artifacts are generated at repo root or plugin root, THE **ResearchGapPolicy** SHALL ensure `.gitignore` and docs agree on whether those artifacts are expected to be ignored.
5. WHEN quality gaps are listed, THE **ResearchGapPolicy** SHALL expose both count metrics and open item titles in a machine-readable option.

### Requirement 8: Validation and Regression Safety

#### Acceptance Criteria

1. WHEN any roadmap slice changes CLI behavior, THE owning component SHALL add targeted Node tests for the changed contract.
2. WHEN dashboard behavior changes, THE **MissionControlDashboard** SHALL keep static export tests and live-server endpoint tests passing.
3. WHEN MCP tool schemas change, THE **ToolContractCatalog** SHALL keep MCP smoke and tool schema validation passing.
4. WHEN runner, progress, or cancellation behavior changes, THE **RunProgressAdapter** SHALL include a deliberately slow or cancellable benchmark fixture.
5. WHEN a slice is ready for review, THE validation gate SHALL run `npm run check` from `plugins/codex-autoresearch`.
