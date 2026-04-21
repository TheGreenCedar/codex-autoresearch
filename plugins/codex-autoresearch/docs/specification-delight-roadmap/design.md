# Design Document

## Overview

The delight roadmap should be implemented as small, reviewable slices that reuse the existing CLI, MCP, dashboard, and test architecture. The design adds focused modules around the current `scripts/autoresearch.mjs` command surface instead of moving core behavior into a new framework.

## Principles

- Preserve the CLI and static dashboard as the durable base path.
- Add richer live/MCP behavior as progressive enhancement.
- Keep all mutating actions explicit, logged, and scoped.
- Treat ASI as durable operator memory, not incidental metadata.
- Prefer warnings over failures for environment drift unless a mismatch makes the requested action unsafe.
- Keep requirement IDs visible in tests and implementation notes.

## Component Specifications

#### Component: GuidedSetupFlow

**Purpose**: Produce a single first-run or resume packet that combines setup readiness, recipe choice, doctor status, baseline command, and log-next action.

**Location**: `plugins/codex-autoresearch/lib/guided-flow.mjs`

**Interface**:

```js
export async function buildGuidedSetupPacket({
  cwd,
  recipe,
  catalog,
  includeDoctor = true,
  includeDashboard = true,
}) {
  // Implements Req 1.1, 1.2, 1.3, 1.4
}

export async function writeResumeBlock({
  workDir,
  pluginRoot,
  targetFile = "autoresearch.md",
}) {
  // Implements Req 1.5
}
```

**Integration Notes**:

- `scripts/autoresearch.mjs` should expose the packet through either `guide` or an expanded `setup-plan`.
- `setupSession` and `setupResearchSession` should call `writeResumeBlock` after creating session files.
- The packet should reuse existing `setupPlan`, `doctorSession`, `dashboardCommands`, and `currentQualityGapSlug` behavior rather than duplicating command construction.

#### Component: MissionControlDashboard

**Purpose**: Render the operator cockpit for setup, run state, experiment memory, quality gaps, safe actions, and finalization readiness while preserving static export.

**Location**: `plugins/codex-autoresearch/lib/dashboard-view-model.mjs`, `plugins/codex-autoresearch/assets/template.html`, `plugins/codex-autoresearch/lib/live-server.mjs`

**Interface**:

```js
export function buildDashboardViewModel({
  state,
  settings,
  commands,
  setupPlan,
  guidedSetup,
  qualityGap,
  finalizePreview,
  recipes,
  experimentMemory,
  drift,
}) {
  // Implements Req 2.1, 2.2, 2.4, 2.5, 3.4
}

export const SAFE_DASHBOARD_ACTIONS = new Set([
  "doctor",
  "setup-plan",
  "guide",
  "recipes",
  "gap-candidates",
  "finalize-preview",
  "export",
]);
// Implements Req 2.3
```

**Integration Notes**:

- The dashboard template should render missing live endpoints as snapshot-only, not as failed product state.
- Live actions should remain local-only and read-only or preview-only.
- Mutating actions such as branch finalization and keep/discard logging stay outside dashboard live actions until separately specified.

#### Component: ExperimentMemory

**Purpose**: Summarize ASI and run ledger evidence into durable hypotheses, dead ends, next actions, and resume guidance.

**Location**: `plugins/codex-autoresearch/lib/experiment-memory.mjs`

**Interface**:

```js
export function buildExperimentMemory({ runs, direction }) {
  // Implements Req 3.1, 3.3, 3.4, 3.5
}

export function detectRepeatedHypothesis({ proposed, memory }) {
  // Implements Req 3.2
}
```

**Data Shape**:

```js
{
  kept: [{ run, metric, hypothesis, evidence, commit }],
  rejected: [{ run, status, hypothesis, rollbackReason, evidence }],
  nextActions: [{ run, nextActionHint }],
  warnings: ["Recent runs are missing ASI hypothesis fields."],
  repeatRisk: { matchedRun, reason },
}
```

**Integration Notes**:

- `publicState` can include a compact memory summary.
- `doctorSession` can include warnings when recent runs lack ASI.
- `nextExperiment` can accept an optional proposed hypothesis later, but this first spec only requires detection support and display.

#### Component: RunProgressAdapter

**Purpose**: Expose progress, task, output-tail, and cancellation state for slow operations without corrupting the run ledger.

**Location**: `plugins/codex-autoresearch/lib/progress-adapter.mjs`, `plugins/codex-autoresearch/lib/runner.mjs`, `plugins/codex-autoresearch/scripts/autoresearch-mcp.mjs`

**Interface**:

```js
export async function runWithProgress({
  label,
  command,
  cwd,
  timeoutSeconds,
  progressSink,
  cancellationSignal,
}) {
  // Implements Req 4.1, 4.2, 4.4, 4.5
}

export function createTaskRecord({ label, ttlMs }) {
  // Implements Req 4.3
}

export async function cancelTask({ taskId }) {
  // Implements Req 4.4
}
```

**Integration Notes**:

- Start with progress output and cancellation-safe process control before implementing full task persistence.
- The adapter must not append to `autoresearch.jsonl`; only `logExperiment` writes accepted run results.
- MCP task support should be optional and declared only after capability negotiation and tests exist.

#### Component: ToolContractCatalog

**Purpose**: Define compact MCP tool guidance, adjacent-tool contrast, and output contracts for the tool surface.

**Location**: `plugins/codex-autoresearch/lib/tool-contracts.mjs`, `plugins/codex-autoresearch/lib/mcp-interface.mjs`

**Interface**:

```js
export function toolGuidanceFor(name) {
  // Implements Req 5.1, 5.3, 5.5
}

export function outputContractFor(name) {
  // Implements Req 5.2
}

export function validateToolContracts(toolSchemas) {
  // Implements Req 5.4
}
```

**Integration Notes**:

- Keep descriptions short and specific.
- Use output contracts in tests even if the MCP host does not yet consume output schemas.
- Adjacent-tool contrast should cover at least `setup_plan` vs `setup_session`, `run_experiment` vs `next_experiment`, `measure_quality_gap` vs `gap_candidates`, and `finalize_preview` vs `autoresearch-finalize`.

#### Component: DriftDoctor

**Purpose**: Detect and report source/manifest/MCP/cache version drift during doctor and status workflows.

**Location**: `plugins/codex-autoresearch/lib/drift-doctor.mjs`, `plugins/codex-autoresearch/scripts/autoresearch.mjs`

**Interface**:

```js
export async function inspectVersionSurfaces({ pluginRoot }) {
  // Implements Req 6.1, 6.2
}

export async function inspectInstalledRouting({ pluginName = "codex-autoresearch", timeoutMs = 5000 }) {
  // Implements Req 6.3, 6.4, 6.5
}
```

**Version Surfaces**:

- `plugins/codex-autoresearch/package.json`
- `plugins/codex-autoresearch/.codex-plugin/plugin.json`
- `scripts/autoresearch.mjs` MCP `serverInfo.version`
- `scripts/autoresearch-mcp.mjs` lightweight `VERSION`
- Optional `codex mcp get codex-autoresearch` installed path and version

#### Component: ResearchGapPolicy

**Purpose**: Keep quality-gap recipes, candidate application, and research artifact behavior predictable.

**Location**: `plugins/codex-autoresearch/lib/research-gaps.mjs`, `plugins/codex-autoresearch/lib/recipes.mjs`, `plugins/codex-autoresearch/scripts/autoresearch.mjs`

**Interface**:

```js
export async function resolveQualityGapSlug({ workDir, requestedSlug }) {
  // Implements Req 7.1
}

export async function applyCandidateGaps({ gapsPath, candidates, mode = "canonical-section" }) {
  // Implements Req 7.2
}

export function listRecipeTags(recipe) {
  // Implements Req 7.3
}
```

**Integration Notes**:

- `quality-gap --list --json` should expose open item titles for dashboard and agents.
- Root and plugin `.gitignore` state should be tested or documented so self-dogfooding does not surprise operators.

## Error Handling

- Guided setup errors should include a next command and avoid mutating the session.
- Progress cancellation should return cancelled state and avoid appending a run.
- Drift inspection should degrade to warnings unless version surfaces within the local source disagree.
- Dashboard live endpoint failures should leave the static snapshot readable.
- Candidate application should be idempotent for existing candidate text.

## Test Strategy

- Add unit tests for each new helper module.
- Add CLI tests for `guide` or expanded `setup-plan`, resume blocks, drift doctor output, `quality-gap --list --json`, and recipe tags.
- Add dashboard tests for static fallback, experiment memory rendering, guided setup rendering, and live safe action availability.
- Add MCP smoke/schema tests for tool contract validation.
- Add a slow fixture for progress/cancellation behavior.
