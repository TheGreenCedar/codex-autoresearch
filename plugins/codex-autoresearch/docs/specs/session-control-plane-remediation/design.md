# Design Document

## Overview

This design keeps the existing Autoresearch architecture intact and adds the missing contracts around it. The package remains CLI/skill-only; the dashboard remains read-only; the remediation works by strengthening session state, decision envelopes, forensics capsules, approval records, process governance, lane reconciliation, finalization status, and regression gates.

## Design Principles

- **Single Responsibility**: Each component owns one control-plane concern.
- **Loose Coupling**: Components exchange JSON-compatible packets through existing state, command, and dashboard model boundaries.
- **High Cohesion**: Goal, approval, resource, evidence, lane, finalization, and readout logic stay in their nearest existing module families.
- **Resumability**: Every gate writes enough durable state to survive compaction, reboot, and later session continuation.
- **No False Completion**: Local source edits, local commits, and diagnostic metrics must not be reported as broader proof.

## Component Specifications

### Component: GoalContractBridge

**Purpose**: Owns the visible relationship between the active Codex goal, durable Autoresearch goal, benchmark goal, and finalization claim.

**Location**: `plugins/codex-autoresearch/lib/goal-frame.ts`, `plugins/codex-autoresearch/lib/session-core.ts`, `plugins/codex-autoresearch/lib/loop-governance.ts`

**Interface**:

```ts
export interface GoalContract {
  authoritativeGoal: string;
  codexGoalObjective: string;
  benchmarkGoal: string;
  finalizationClaim: string;
  codexObjectiveRole:
    | "missing"
    | "matching_research_goal"
    | "operator_instruction"
    | "different_research_goal";
  mismatch: boolean;
  warning: string;
  recoveryCommand: string;
  blocksPacket: boolean;
  blocksFinalization: boolean;
}

export function buildGoalContract(input: {
  autoresearchGoal?: unknown;
  codexGoalObjective?: unknown;
  benchmarkGoal?: unknown;
  finalizationClaim?: unknown;
}): GoalContract;
// Implements: Req 1.1, Req 1.2, Req 1.3
```

**Dependencies**:
- Existing `buildGoalFrame` normalization logic.
- Session state builder in `session-core.ts`.
- Loop priority rules in `loop-governance.ts`.

**Data Model**:

```ts
export interface GoalContractState {
  goalContract: GoalContract;
  source: "cli-arg" | "tool-arg" | "session-forensics" | "missing";
  observedAt: string;
}
```

### Component: SessionForensicsIngestor

**Purpose**: Converts raw Codex session JSONL into compact signals, decision capsules, and real-session regression evidence.

**Location**: `plugins/codex-autoresearch/lib/session-forensics.ts`, `plugins/codex-autoresearch/lib/commands/session-forensics.ts`, `plugins/codex-autoresearch/lib/session-decision-capsule.ts`, `plugins/codex-autoresearch/tests/fixtures/session-019eb85a.jsonl`

**Interface**:

```ts
export interface SessionForensicsSummary {
  compact: boolean;
  counts: Record<string, number>;
  productSignals: ForensicsSignal[];
  workflowWaste: ForensicsSignal[];
  blockers: ForensicsSignal[];
  userCorrections: ForensicsSignal[];
  topCommandHeads: Array<{ commandHead: string; count: number }>;
  decisionCapsule: SessionDecisionCapsule | null;
}

export function analyzeSessionJsonl(input: {
  sessionJsonl: string;
  compact?: boolean;
  jsonFull?: boolean;
  redactCommands?: boolean;
}): Promise<SessionForensicsSummary>;
// Implements: Req 2.1, Req 2.2, Req 2.3
```

**Dependencies**:
- JSONL parser and existing command redaction helpers.
- Decision-capsule rules and command rendering.
- Test fixture derived from the real 019eb85a session.

**Data Model**:

```ts
export interface ForensicsSignal {
  kind: string;
  severity: "info" | "warning" | "blocker";
  message: string;
  count?: number;
  source?: string;
}
```

### Component: ApprovalLedger

**Purpose**: Records scoped human approvals with source, timestamp, scope, expiry, and consuming gate.

**Location**: `plugins/codex-autoresearch/lib/approval-ledger.ts`, `plugins/codex-autoresearch/lib/commands/lane-runner.ts`, `plugins/codex-autoresearch/lib/loop-governance.ts`

**Interface**:

```ts
export interface ApprovalRecord {
  id: string;
  timestamp: string;
  source: "user-message" | "cli-flag" | "tool-arg" | "imported-session";
  scope: "big-idea-lane" | "implementation-lane" | "measured-packet" | "finalization";
  subject: string;
  expiresAt?: string;
  evidenceRef: string;
  consumedBy?: string;
}

export function recordApproval(input: Omit<ApprovalRecord, "id">): ApprovalRecord;
export function resolveApproval(input: {
  records: ApprovalRecord[];
  scope: ApprovalRecord["scope"];
  subject: string;
  now: string;
}): { approved: boolean; record?: ApprovalRecord; reason: string };
// Implements: Req 3.1, Req 3.2, Req 3.3
```

**Dependencies**:
- `autoresearch.jsonl` append path.
- Lane runner approval gate.
- Terminal/dashboard readout copy.

**Data Model**:

```json
{
  "type": "approval_record",
  "timestamp": "2026-06-13T00:00:00.000Z",
  "scope": "big-idea-lane",
  "subject": "session-control-plane-remediation",
  "evidenceRef": "session:019eb85a:event:28849"
}
```

### Component: ResourceProcessGovernor

**Purpose**: Enforces process, wall-clock, output, polling, and stale-process budgets before packet or lane execution.

**Location**: `plugins/codex-autoresearch/lib/process-governor.ts`, `plugins/codex-autoresearch/lib/runner.ts`, `plugins/codex-autoresearch/lib/commands/lane-runner.ts`, `plugins/codex-autoresearch/lib/workflow-friction.ts`

**Interface**:

```ts
export interface ResourcePreflight {
  canStart: boolean;
  blockers: string[];
  warnings: string[];
  limits: {
    maxProcesses: number;
    timeoutSeconds: number;
    maxOutputBytes: number;
    maxPolls: number;
    repeatedCommandLimit: number;
  };
  staleProcesses: ProcessResidue[];
}

export function buildResourcePreflight(input: {
  workDir: string;
  commandHead: string;
  activeProcesses: ProcessResidue[];
  recentCommandHeads: Record<string, number>;
  limits: Partial<ResourcePreflight["limits"]>;
}): ResourcePreflight;
// Implements: Req 4.1, Req 4.2, Req 4.3
```

**Dependencies**:
- Existing runner timeout and output-tail behavior.
- Process-manager records when available.
- Workflow-friction command-output heuristics.

**Data Model**:

```ts
export interface ProcessResidue {
  pid: number;
  cwd: string;
  command: string;
  status: "live" | "stale" | "unknown" | "cleanup-needed";
  observedAt: string;
}
```

### Component: LaneOrchestrationController

**Purpose**: Plans and reconciles read-only, implementation, and review lanes as accountable bounded work streams.

**Location**: `plugins/codex-autoresearch/scripts/autoresearch.ts`, `plugins/codex-autoresearch/lib/commands/lane-runner.ts`, `plugins/codex-autoresearch/lib/lane-lifecycle.ts`, `plugins/codex-autoresearch/lib/lane-briefs.ts`, `plugins/codex-autoresearch/lib/lane-orchestration-controller.ts`

**Interface**:

```ts
export interface LanePlan {
  id: string;
  mode: "read_only_scout" | "implementation" | "big_idea" | "review";
  ownerRole: string;
  scope: string[];
  budget: { timeBudgetSeconds: number; outputBytes: number };
  mergeCriteria: string[];
  isolation: { worktree?: string; writeScope?: string[] };
}

export function planControlPlaneLanes(input: {
  sessionSignals: ForensicsSignal[];
  goalContract: GoalContract;
  resourcePreflight: ResourcePreflight;
}): LanePlan[];
// Implements: Req 5.1, Req 5.2, Req 5.3
```

**Dependencies**:
- Existing lane runner isolation checks.
- Approval ledger.
- Parent-loop synthesis.

**Data Model**:

```ts
export interface LaneSynthesis {
  status: "ready" | "blocked" | "awaiting_approval";
  canonicalNextAction: string;
  evidenceAccepted: boolean;
  measuredPacketRecommendation: string;
}
```

### Component: EvidenceMaturityGate

**Purpose**: Classifies evidence maturity and blocks promotion/finalization when proof is only diagnostic or row-specific.

**Location**: `plugins/codex-autoresearch/lib/session-decision-capsule.ts`, `plugins/codex-autoresearch/lib/product-claim-coverage.ts`, `plugins/codex-autoresearch/lib/finalization-acceptance.ts`, `plugins/codex-autoresearch/lib/loop-governance.ts`

**Interface**:

```ts
export type EvidenceMaturity =
  | "diagnostic"
  | "provisional"
  | "development"
  | "repeat"
  | "holdout"
  | "breadth"
  | "promotion_grade";

export interface EvidenceMaturityDecision {
  maturity: EvidenceMaturity;
  supportableClaim: string;
  requestedClaim: string;
  blocksPacket: boolean;
  blocksFinalization: boolean;
  requiredProof: string[];
}

export function classifyEvidenceMaturity(input: {
  decisionCapsule?: SessionDecisionCapsule | null;
  productClaimCoverage?: unknown;
  benchmarkSignals: ForensicsSignal[];
  requestedClaim: string;
}): EvidenceMaturityDecision;
// Implements: Req 1.3, Req 6.1, Req 6.2, Req 6.3
```

**Dependencies**:
- Existing benchmark-overfit rule.
- Product claim coverage from ledger.
- Finalization preview warnings.

**Data Model**:

```json
{
  "maturity": "diagnostic",
  "supportableClaim": "row-specific repair was measured",
  "requestedClaim": "CodeStory broadly wins without overfitting",
  "blocksFinalization": true,
  "requiredProof": ["blind holdout", "breadth run", "repeat evidence"]
}
```

### Component: FinalizationRunway

**Purpose**: Models finalization as resumable state from preview through branch, push, PR, merge, and cleanup.

**Location**: `plugins/codex-autoresearch/lib/finalize-preview.ts`, `plugins/codex-autoresearch/scripts/finalize-autoresearch.ts`, `plugins/codex-autoresearch/lib/finalization-runway.ts`

**Interface**:

```ts
export interface FinalizationRunwayState {
  preview: "missing" | "blocked" | "ready";
  branch: "missing" | "equivalent" | "stale" | "divergent" | "checked-out" | "unsafe";
  commit: "missing" | "local-only" | "pushed";
  pullRequest: "missing" | "open" | "merged" | "closed" | "unknown";
  checks: "missing" | "pending" | "passing" | "failing" | "unknown";
  cleanup: "not-started" | "partial" | "complete";
  nextCommand: string;
}

export async function inspectFinalizationRunway(input: {
  cwd: string;
  branchPrefix: string;
  goalSlug: string;
  inspectPr?: boolean;
}): Promise<FinalizationRunwayState>;
// Implements: Req 7.1, Req 7.2, Req 7.3
```

**Dependencies**:
- Existing finalization preview and finalizer plan.
- Git branch/worktree commands.
- Optional GitHub CLI PR status.

**Data Model**:

```json
{
  "preview": "ready",
  "branch": "equivalent",
  "commit": "local-only",
  "pullRequest": "missing",
  "checks": "missing",
  "cleanup": "not-started",
  "nextCommand": "git push --set-upstream origin <branch>"
}
```

### Component: OperatorReadoutSurface

**Purpose**: Renders one canonical next action consistently in CLI, terminal report, and dashboard readout.

**Location**: `plugins/codex-autoresearch/lib/commands/state.ts`, `plugins/codex-autoresearch/lib/commands/recommend-next.ts`, `plugins/codex-autoresearch/lib/terminal-report.ts`, `plugins/codex-autoresearch/lib/dashboard-view-model.ts`

**Interface**:

```ts
export interface OperatorReadout {
  canonicalNextAction: {
    kind: string;
    reason: string;
    command: string;
    triggeredBy: string[];
  };
  blockers: string[];
  warnings: string[];
  runtimeProvenance: unknown;
  dashboardMutationAllowed: false;
}

export function buildOperatorReadout(input: {
  goalContract: GoalContract;
  resourcePreflight: ResourcePreflight;
  evidenceMaturity: EvidenceMaturityDecision;
  finalizationRunway: FinalizationRunwayState;
}): OperatorReadout;
// Implements: Req 3.3, Req 4.3, Req 6.3, Req 8.1, Req 8.2, Req 8.3
```

**Dependencies**:
- Existing command map and terminal report.
- Dashboard read-only safety filters.
- Runtime provenance and drift doctor.

**Data Model**:

```json
{
  "canonicalNextAction": {
    "kind": "goal-contract",
    "reason": "Active Codex goal and Autoresearch benchmark goal differ.",
    "command": "node scripts/autoresearch.mjs state --cwd <project> --compact",
    "triggeredBy": ["goalContract"]
  },
  "dashboardMutationAllowed": false
}
```

### Component: RegressionGateSuite

**Purpose**: Proves the session-control-plane contracts through real-session fixtures, focused tests, and package checks.

**Location**: `plugins/codex-autoresearch/tests/autoresearch-cli.test.ts`, `plugins/codex-autoresearch/tests/loop-governance.test.ts`, `plugins/codex-autoresearch/tests/session-control-plane.test.ts`, `plugins/codex-autoresearch/scripts/check.ts`, `CHANGELOG.md`, `plugins/codex-autoresearch/docs/`, `plugins/codex-autoresearch/skills/codex-autoresearch/SKILL.md`

**Interface**:

```ts
export interface ControlPlaneGateResult {
  ok: boolean;
  focusedTests: string[];
  packageGate: "passed" | "failed" | "skipped";
  dashboardInspection: "passed" | "failed" | "not-applicable" | "skipped";
  docsUpdated: string[];
}

export function expectedControlPlaneGate(): ControlPlaneGateResult;
// Implements: Req 2.1, Req 9.1, Req 9.2, Req 9.3, Req 10.1, Req 10.2, Req 10.3
```

**Dependencies**:
- Node test runner.
- `npm run check`.
- Dashboard build and visual inspection when readout changes.

**Data Model**:

```json
{
  "ok": true,
  "focusedTests": ["goal contract", "approval ledger", "finalization runway"],
  "packageGate": "passed",
  "docsUpdated": ["docs/trust.md", "skills/codex-autoresearch/SKILL.md"]
}
```

## Integration Design

### CLI Contract

```text
state/recommend-next/session-forensics/finalize-preview
  -> session-core decision envelope
  -> goal contract, approval ledger, process preflight, maturity gate, runway state
  -> one canonical next action
```

### JSONL Ledger Entries

```json
{
  "type": "approval_record",
  "timestamp": "2026-06-13T09:56:56.444Z",
  "scope": "measured-packet",
  "subject": "make-codestory-win-without-overfitting",
  "evidenceRef": "session-019eb85a:28849"
}
```

```json
{
  "type": "control_plane_preflight",
  "timestamp": "2026-06-13T10:00:00.000Z",
  "goalContract": {},
  "resourcePreflight": {},
  "evidenceMaturity": {},
  "finalizationRunway": {}
}
```

### Dashboard Contract

The dashboard receives the same `OperatorReadout` as terminal reports and must not create alternate mutation routes. If a dashboard row needs an action, it displays the read-only safe action label and the CLI command text only when that command is non-mutating or already part of the existing readout convention.

## Phase Gate

Detailed design complete. All components from the blueprint have been specified. Proceed to generate implementation tasks.
