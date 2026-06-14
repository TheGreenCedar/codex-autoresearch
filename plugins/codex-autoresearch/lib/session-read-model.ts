import {
  approvalRequirementsFromLaneResults,
  approvalRequirementFromLane,
  buildApprovalLedgerStatus,
  dedupeApprovalRequirements,
} from "./approval-ledger.js";
import { classifyEvidenceMaturity, runsFromState } from "./evidence-maturity.js";
import { buildGoalContract } from "./goal-frame.js";
import { planFailureRecoveryLanes } from "./lane-orchestration-controller.js";
import { buildResourcePreflight, resourceBudgetFromConfig } from "./process-governor.js";
import { STATUS_VALUES, isKeepStatus } from "./run-status.js";
import type { UnknownRecord } from "./types/json.js";

type ReadModelRecord = UnknownRecord & Record<string, any>;

export function buildCheapFinalizationPressure({
  state,
  qualityGap = null,
  warningDetails = [],
}: {
  state: ReadModelRecord;
  qualityGap?: ReadModelRecord | null;
  warningDetails?: ReadModelRecord[];
}): ReadModelRecord {
  const current = Array.isArray(state.current) ? state.current : [];
  const kept = current.filter((run: ReadModelRecord) => isKeepStatus(run.status));
  const productClaimCoverage = (state.productClaimCoverage as ReadModelRecord) || {};
  const productGradeReady = productClaimCoverage.productGradeReady !== false;
  const blockers = Array.isArray(warningDetails)
    ? warningDetails.filter((warning) => warning?.severity === "blocker")
    : [];
  const hasAcceptedEvidence = kept.length > 0;
  const qualityGapOpen =
    qualityGap?.done === false &&
    (Number(qualityGap.open ?? qualityGap.openItems ?? qualityGap.remaining ?? 0) > 0 ||
      (Array.isArray(qualityGap.openItems) && qualityGap.openItems.length > 0));
  const readyForPreview =
    hasAcceptedEvidence && productGradeReady && blockers.length === 0 && !qualityGapOpen;
  return {
    available: true,
    cheap: true,
    ready: false,
    productGradeReady,
    productGradeIssue:
      productClaimCoverage.productGradeIssue ||
      productClaimCoverage.product_grade_issue ||
      productClaimCoverage.missingRequiredProof?.[0] ||
      (qualityGapOpen ? "Open quality-gap items remain." : null) ||
      null,
    actionCode: readyForPreview
      ? "cheap-finalization-pressure-preview"
      : "cheap-finalization-pressure",
    nextAction: readyForPreview
      ? "Run finalize-preview for Git-backed review readiness before making merge or completion claims."
      : hasAcceptedEvidence
        ? "Resolve blockers or missing proof, then run finalize-preview for review readiness."
        : "Run finalization preview from a Git-backed autoresearch branch.",
    warnings: [
      ...(readyForPreview
        ? [
            "Cheap finalization pressure is not a Git finalizer preview; run finalize-preview for branch, diff, and package evidence.",
          ]
        : []),
      ...(qualityGapOpen ? ["Open quality-gap items still block finalization pressure."] : []),
    ],
  };
}

export function buildSessionReadModelState({
  state,
  qualityGap,
  laneLifecycle,
  packetDiagnostics,
  runtimeProvenance,
  runtimeDriftSummary,
  dashboardHealth = null,
  sourceCleanliness,
  gateQuality,
  preflight,
}: {
  state: ReadModelRecord;
  qualityGap: ReadModelRecord | null;
  laneLifecycle: unknown;
  packetDiagnostics: unknown;
  runtimeProvenance: unknown;
  runtimeDriftSummary?: unknown;
  dashboardHealth?: unknown;
  sourceCleanliness: unknown;
  gateQuality?: unknown;
  preflight?: unknown;
}): ReadModelRecord {
  return {
    ...state,
    qualityGap,
    laneLifecycle,
    packetDiagnostics,
    runtimeProvenance,
    runtimeDriftSummary,
    dashboardHealth,
    sourceCleanliness,
    gateQuality,
    preflight,
  };
}

export function statusCountsFromState(state: ReadModelRecord): Record<string, number> {
  const current = Array.isArray(state.current) ? state.current : [];
  return Object.fromEntries(
    [...STATUS_VALUES].map((status: string) => [
      status,
      current.filter((run: ReadModelRecord) => run.status === status).length,
    ]),
  );
}

export function buildSessionReadModel({
  workDir,
  config,
  state,
  records,
  codexGoalObjective,
  parallelLanes,
  workflowFriction = [],
  finalization = null,
  commands = {},
  ...stateFields
}: {
  workDir: string;
  config: ReadModelRecord;
  state: ReadModelRecord;
  records: ReadModelRecord[];
  codexGoalObjective?: unknown;
  parallelLanes?: unknown[];
  workflowFriction?: unknown[];
  finalization?: ReadModelRecord | null;
  commands?: ReadModelRecord;
  qualityGap: ReadModelRecord | null;
  laneLifecycle: unknown;
  packetDiagnostics: unknown;
  runtimeProvenance: unknown;
  runtimeDriftSummary?: unknown;
  dashboardHealth?: unknown;
  sourceCleanliness: unknown;
  gateQuality?: unknown;
  preflight?: unknown;
}): ReadModelRecord {
  const stateWithReadModel = buildSessionReadModelState({ state, ...stateFields });
  const effectiveFinalization =
    finalization ||
    buildCheapFinalizationPressure({
      state,
      qualityGap: stateFields.qualityGap,
      warningDetails: [],
    });
  return {
    stateWithReadModel,
    statusCounts: statusCountsFromState(state),
    controlPlane: buildControlPlaneContracts({
      workDir,
      config,
      state,
      records,
      codexGoalObjective,
      parallelLanes,
      workflowFriction,
      finalization: effectiveFinalization,
      commands,
    }),
    finalization: effectiveFinalization,
  };
}

export function buildControlPlaneContracts({
  config,
  state,
  records,
  codexGoalObjective,
  parallelLanes,
  workflowFriction = [],
  finalization = null,
  commands = {},
}: {
  workDir?: string;
  config: ReadModelRecord;
  state: ReadModelRecord;
  records: ReadModelRecord[];
  codexGoalObjective?: unknown;
  parallelLanes?: unknown[];
  workflowFriction?: unknown[];
  finalization?: ReadModelRecord | null;
  commands?: ReadModelRecord;
}): ReadModelRecord {
  const goalContract = buildGoalContract({
    autoresearchGoal: state.config?.goal || config.goal,
    codexGoalObjective,
    benchmarkGoal: config.benchmarkGoal || state.config?.benchmarkGoal || state.config?.goal,
    finalizationClaim:
      config.finalizationClaim ||
      state.config?.finalizationClaim ||
      finalization?.finalizationClaim,
    recoveryCommand: commands.codexGoalBrief || commands.state || "",
  });
  const approvalRequirements = dedupeApprovalRequirements([
    ...(Array.isArray(parallelLanes) ? parallelLanes : [])
      .map(approvalRequirementFromLane)
      .filter((requirement): requirement is NonNullable<typeof requirement> =>
        Boolean(requirement),
      ),
    ...approvalRequirementsFromLaneResults(records),
  ]);
  const approvalLedger = buildApprovalLedgerStatus({
    entries: records,
    required: approvalRequirements,
  });
  const resourcePreflight = buildResourcePreflight({
    entries: records,
    budgets: resourceBudgetFromConfig(config),
  });
  const evidenceMaturity = classifyEvidenceMaturity({
    runs: runsFromState(state),
    requestedClaim:
      config.finalizationClaim ||
      state.config?.finalizationClaim ||
      finalization?.summary ||
      finalization?.productGradeSummary,
  });
  const laneOrchestration = planFailureRecoveryLanes({
    signals: [
      ...(Array.isArray(workflowFriction) ? workflowFriction : []),
      ...(Array.isArray(state.sessionDecisionCapsule?.productSignals)
        ? state.sessionDecisionCapsule.productSignals
        : []),
    ],
    writeScope: config.commitPaths || [],
  });
  return {
    goalContract,
    approvalLedger,
    resourcePreflight,
    evidenceMaturity,
    laneOrchestration,
    finalizationRunway: finalization?.finalizationRunway || finalization?.runway || null,
  };
}
