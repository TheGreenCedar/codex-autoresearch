import {
  approvalRequirementsFromLaneResults,
  approvalRequirementFromLane,
  buildApprovalLedgerStatus,
  dedupeApprovalRequirements,
} from "./approval-ledger.js";
import { resolveActionCommand } from "./action-metadata.js";
import { hasUnsafeShellOperator } from "./dashboard-command-safety.js";
import { isAcceptedCurrentRun } from "./evidence-registry.js";
import { classifyEvidenceMaturity, runsFromState } from "./evidence-maturity.js";
import { buildGoalContract } from "./goal-frame.js";
import { planFailureRecoveryLanes } from "./lane-orchestration-controller.js";
import { buildResourcePreflight, resourceBudgetFromConfig } from "./process-governor.js";
import { STATUS_VALUES } from "./run-status.js";
import { type UnknownRecord, unknownRecordOrEmpty } from "./types/json.js";
import { normalizeSessionState, type SessionState } from "./types/session.js";

type ReadModelRecord = UnknownRecord;

export const SESSION_READ_MODEL_VERSION = 1;
export const COMPACT_STATE_MAX_BYTES = 10_240;
export const COMPACT_STATE_MAX_LINES = 200;
export const COMPACT_STATE_MAX_TOKENS = 2_560;
export const DEFAULT_STATE_MAX_BYTES = 20_480;
export const DEFAULT_STATE_MAX_LINES = 260;
export const DEFAULT_STATE_MAX_TOKENS = 5_120;
export const DEFAULT_DOCTOR_MAX_BYTES = 8_192;
export const DEFAULT_DOCTOR_MAX_LINES = 100;
export const DEFAULT_DOCTOR_MAX_TOKENS = 2_048;
export const TERMINAL_REPORT_MAX_BYTES = 8_192;
export const TERMINAL_REPORT_MAX_LINES = 100;
export const TERMINAL_REPORT_MAX_TOKENS = 2_048;

export interface ResolvedDecision {
  version: 1;
  status: "blocked" | "ready" | "complete" | "unknown";
  strongestBlocker: string | null;
  nextAction: string;
  command: string;
  canonicalNextAction: UnknownRecord | null;
  loopContract: UnknownRecord | null;
  runtimeProvenance: UnknownRecord | null;
  runtimeAuthority: UnknownRecord | null;
  finalizationPressure: UnknownRecord | null;
}

export interface SessionReadModel {
  version: 1;
  workDir: string;
  state: SessionState;
  stateWithReadModel: ReadModelRecord;
  statusCounts: Record<string, number>;
  controlPlane: ReadModelRecord;
  finalization: ReadModelRecord;
  resolvedDecision: ResolvedDecision;
}

export interface ProjectionBudget {
  bytes: number;
  lines: number;
  tokens: number;
}

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
  const productClaimCoverage = (state.productClaimCoverage as ReadModelRecord) || {};
  const missingRequiredProof = Array.isArray(productClaimCoverage.missingRequiredProof)
    ? productClaimCoverage.missingRequiredProof
    : [];
  const productGradeReady = productClaimCoverage.productGradeReady !== false;
  const hasBlockers = Array.isArray(warningDetails)
    ? warningDetails.some((warning) => warning?.severity === "blocker")
    : false;
  const hasAcceptedEvidence = current.some((run: ReadModelRecord) => isAcceptedCurrentRun(run));
  const qualityGapOpen =
    qualityGap?.done === false &&
    (Number(qualityGap.open ?? qualityGap.openItems ?? qualityGap.remaining ?? 0) > 0 ||
      (Array.isArray(qualityGap.openItems) && qualityGap.openItems.length > 0));
  const readyForPreview =
    hasAcceptedEvidence && productGradeReady && !hasBlockers && !qualityGapOpen;
  return {
    available: true,
    cheap: true,
    ready: false,
    productGradeReady,
    productGradeIssue:
      productClaimCoverage.productGradeIssue ||
      productClaimCoverage.product_grade_issue ||
      missingRequiredProof[0] ||
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
  const counts: Record<string, number> = Object.fromEntries(
    [...STATUS_VALUES].map((status: string) => [status, 0]),
  );
  for (const run of current) {
    if (typeof run?.status === "string" && run.status in counts) {
      counts[run.status] += 1;
    }
  }
  return counts;
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
  processProgress = null,
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
  processProgress?: unknown;
  qualityGap: ReadModelRecord | null;
  laneLifecycle: unknown;
  packetDiagnostics: unknown;
  runtimeProvenance: unknown;
  runtimeDriftSummary?: unknown;
  dashboardHealth?: unknown;
  sourceCleanliness: unknown;
  gateQuality?: unknown;
  preflight?: unknown;
}): SessionReadModel {
  const stateWithReadModel = buildSessionReadModelState({ state, ...stateFields });
  const effectiveFinalization =
    finalization ||
    buildCheapFinalizationPressure({
      state,
      qualityGap: stateFields.qualityGap,
      warningDetails: [],
    });
  return {
    version: SESSION_READ_MODEL_VERSION,
    workDir,
    state: normalizeSessionState(state),
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
      processProgress,
    }),
    finalization: effectiveFinalization,
    resolvedDecision: resolveSessionDecision({
      state: stateWithReadModel,
      commands,
      finalization: effectiveFinalization,
    }),
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
  processProgress = null,
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
  processProgress?: unknown;
}): ReadModelRecord {
  const stateConfig = recordOrNull(state.config) || {};
  const sessionDecisionCapsule = recordOrNull(state.sessionDecisionCapsule);
  const finalizationClaim =
    config.finalizationClaim || stateConfig.finalizationClaim || finalization?.finalizationClaim;
  const goalContract = buildGoalContract({
    autoresearchGoal: stateConfig.goal || config.goal,
    codexGoalObjective,
    benchmarkGoal: config.benchmarkGoal || stateConfig.benchmarkGoal || stateConfig.goal,
    finalizationClaim,
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
    entries: processProgress
      ? [...records, { packetEvidence: { progressSnapshot: processProgress } }]
      : records,
    budgets: resourceBudgetFromConfig(config),
  });
  const evidenceMaturity = classifyEvidenceMaturity({
    runs: runsFromState(state),
    requestedClaim: finalizationClaim || finalization?.summary || finalization?.productGradeSummary,
  });
  const laneOrchestration = planFailureRecoveryLanes({
    signals: [
      ...(Array.isArray(workflowFriction) ? workflowFriction : []),
      ...(Array.isArray(sessionDecisionCapsule?.productSignals)
        ? sessionDecisionCapsule.productSignals
        : []),
    ],
    writeScope: Array.isArray(config.commitPaths) ? config.commitPaths.map(String) : [],
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

export function withResolvedSessionDecision(
  readModel: SessionReadModel,
  {
    state: stateInput,
    decisionEnvelope,
    commands,
    runtimeProvenance,
    finalization,
  }: {
    state?: unknown;
    decisionEnvelope?: unknown;
    commands?: unknown;
    runtimeProvenance?: unknown;
    finalization?: unknown;
  },
): SessionReadModel {
  return {
    ...readModel,
    resolvedDecision: resolveSessionDecision({
      state: {
        ...readModel.stateWithReadModel,
        ...readModel.controlPlane,
        ...unknownRecordOrEmpty(stateInput),
        decisionEnvelope,
      },
      decisionEnvelope,
      commands,
      runtimeProvenance,
      finalization,
    }),
  };
}

export function resolveSessionDecision({
  state: stateInput,
  decisionEnvelope: envelopeInput,
  commands: commandsInput,
  runtimeProvenance: runtimeInput,
  finalization: finalizationInput,
}: {
  state?: unknown;
  decisionEnvelope?: unknown;
  commands?: unknown;
  runtimeProvenance?: unknown;
  finalization?: unknown;
} = {}): ResolvedDecision {
  const state = unknownRecordOrEmpty(stateInput);
  const existing = recordOrNull(state.resolvedDecision);
  const envelope =
    recordOrNull(envelopeInput) ||
    recordOrNull(state.decisionEnvelope) ||
    // v2.7 migration: read the old alias, but projections never emit it.
    recordOrNull(state.resumeAudit);
  const loopContract =
    recordOrNull(existing?.loopContract) ||
    recordOrNull(envelope?.loopContract) ||
    recordOrNull(state.loopContract);
  const envelopeAction = recordOrNull(envelope?.canonicalNextAction);
  const existingAction = recordOrNull(existing?.canonicalNextAction);
  const stateAction = recordOrNull(state.canonicalNextAction);
  const canonical = existingAction
    ? {
        ...(stateAction?.kind === existingAction.kind ? stateAction : {}),
        ...(envelopeAction?.kind === existingAction.kind ? envelopeAction : {}),
        ...existingAction,
      }
    : envelopeAction
      ? {
          ...(stateAction?.kind === envelopeAction.kind ? stateAction : {}),
          ...envelopeAction,
        }
      : stateAction;
  const strongestAction = recordOrNull(loopContract?.strongestAction);
  const blockers = uniqueMessages([
    stringValue(existing?.strongestBlocker),
    ...messageList(loopContract?.blockers),
    ...messageList(state.blockers),
  ]);
  const strongestBlocker = blockers[0] || stringValue(existing?.strongestBlocker) || null;
  const authoritativeAction = strongestBlocker
    ? strongestAction
      ? canonical && strongestAction.kind === canonical.kind
        ? {
            ...canonical,
            ...strongestAction,
            command: stringValue(strongestAction.command) || stringValue(canonical.command),
          }
        : strongestAction
      : canonical && canonical.kind !== "next-packet"
        ? canonical
        : { kind: "blocked", reason: strongestBlocker, command: "" }
    : canonical;
  const commands = unknownRecordOrEmpty(commandsInput ?? state.commands);
  const resolvedCommand = resolveActionCommand(authoritativeAction?.kind, commands, {
    explicitCommand: authoritativeAction?.command ?? existing?.command,
  });
  const command = safeDecisionCommand(resolvedCommand) ? resolvedCommand : "";
  const finalizationPressure =
    recordOrNull(existing?.finalizationPressure) ||
    recordOrNull(finalizationInput) ||
    recordOrNull(envelope?.finalizationReadiness) ||
    recordOrNull(state.finalizationPressure) ||
    recordOrNull(state.finalizationRunway);
  const terminal = loopContract?.complete === true || loopContract?.terminal === true;
  const canRunNextPacket = loopContract?.canRunNextPacket;
  const existingStatus = decisionStatus(existing?.status);
  const status: ResolvedDecision["status"] = strongestBlocker
    ? "blocked"
    : existingStatus
      ? existingStatus
      : terminal
        ? "complete"
        : canRunNextPacket === true || finalizationPressure?.ready === true
          ? "ready"
          : "unknown";
  const nextAction =
    (strongestBlocker
      ? stringValue(strongestAction?.reason) || strongestBlocker
      : stringValue(authoritativeAction?.reason)) ||
    stringValue(existing?.nextAction) ||
    stringValue(state.nextAction) ||
    "Read state and choose the next safe Autoresearch action.";

  return {
    version: SESSION_READ_MODEL_VERSION,
    status,
    strongestBlocker,
    nextAction,
    command,
    canonicalNextAction: authoritativeAction ? { ...authoritativeAction, command } : null,
    loopContract,
    runtimeProvenance:
      recordOrNull(existing?.runtimeProvenance) ||
      recordOrNull(runtimeInput) ||
      recordOrNull(envelope?.runtimeProvenance) ||
      recordOrNull(state.runtimeProvenance),
    runtimeAuthority:
      recordOrNull(existing?.runtimeAuthority) ||
      recordOrNull(envelope?.runtimeAuthority) ||
      recordOrNull(state.runtimeAuthority),
    finalizationPressure,
  };
}

export function attachResolvedDecision<T extends UnknownRecord>(
  stateInput: T,
  overrides: {
    decisionEnvelope?: unknown;
    commands?: unknown;
    runtimeProvenance?: unknown;
    finalization?: unknown;
  } = {},
): T & { resolvedDecision: ResolvedDecision } {
  const {
    resumeAudit: _removedResumeAudit,
    decisionEnvelope: _removedDecisionEnvelope,
    canonicalNextAction: _canonicalAlias,
    loopContract: _loopAlias,
    ...state
  } = stateInput;
  return {
    ...state,
    resolvedDecision: resolveSessionDecision({ state: stateInput, ...overrides }),
  } as T & { resolvedDecision: ResolvedDecision };
}

export function projectFullState(stateInput: unknown): ReadModelRecord {
  const state = unknownRecordOrEmpty(stateInput);
  return attachResolvedDecision(state, {
    decisionEnvelope: state.decisionEnvelope,
    commands: state.commands,
    runtimeProvenance: state.runtimeProvenance,
    finalization: state.finalizationPressure,
  });
}

export function projectStateReadModel(
  stateInput: unknown,
  mode: "default" | "compact" = "default",
): ReadModelRecord {
  const state = unknownRecordOrEmpty(stateInput);
  const config = unknownRecordOrEmpty(state.config);
  const decision = resolveSessionDecision({
    state,
    commands: state.commands,
    runtimeProvenance: state.runtimeProvenance,
    finalization: state.finalizationPressure,
  });
  const projection: ReadModelRecord = {
    ok: state.ok !== false,
    code: boundedText(state.code),
    projection: mode,
    readModelVersion: SESSION_READ_MODEL_VERSION,
    workDir: boundedText(state.workDir),
    ledgerPath: boundedText(state.ledgerPath),
    parseErrors: boundedValue(state.parseErrors),
    name: boundedText(state.name || config.name || "Autoresearch"),
    goal: boundedText(state.goal || config.goal),
    config: boundedValue(config),
    metric: boundedText(state.metric || config.metricName || state.metricName),
    direction: boundedText(state.direction || config.bestDirection || "lower"),
    segment: finiteNumber(state.segment) ?? 0,
    runs: finiteNumber(state.runs) ?? finiteNumber(state.totalRuns) ?? 0,
    kept: finiteNumber(state.kept) ?? 0,
    discarded: finiteNumber(state.discarded) ?? 0,
    measured: finiteNumber(state.measured) ?? 0,
    crashed: finiteNumber(state.crashed) ?? 0,
    checksFailed: finiteNumber(state.checksFailed) ?? 0,
    baseline: boundedValue(state.baseline),
    best: boundedValue(state.best),
    historicalBest: boundedValue(state.historicalBest),
    developmentBest: boundedValue(state.developmentBest ?? recordOrNull(state.development)?.best),
    promotionBest: boundedValue(state.promotionBest ?? recordOrNull(state.promotion)?.best),
    resolvedDecision: compactResolvedDecision(decision),
    warnings: boundedMessages(state.warnings),
    warningDetails: boundedValue(state.warningDetails),
    commands: compactCommands(state.commands, decision.command, mode === "compact"),
    scaffoldHealth: boundedValue(state.scaffoldHealth),
    researchIntegrity: boundedValue(state.researchIntegrity),
    runtimeDriftSummary: boundedValue(state.runtimeDriftSummary),
    dashboardHealth: compactDashboardHealth(state.dashboardHealth),
    sourceCleanliness: boundedValue(state.sourceCleanliness),
    ledgerHealth: boundedValue(state.ledgerHealth),
    gateQuality: boundedValue(state.gateQuality),
    preflight: boundedValue(state.preflight),
    fixedControl: boundedValue(state.fixedControl),
    productClaimCoverage: boundedValue(state.productClaimCoverage),
    qualityGap: boundedValue(state.qualityGap),
    goalContract: boundedValue(state.goalContract),
    operatorReadout: boundedValue(state.operatorReadout),
    sessionDecisionCapsule: compactDecisionCapsule(state.sessionDecisionCapsule),
    packetDiagnostics: boundedValue(state.packetDiagnostics),
    laneLifecycle: boundedValue(state.laneLifecycle),
    portfolioRecommendation: boundedValue(state.portfolioRecommendation),
    workflowFriction: boundedValue(state.workflowFriction),
    parallelLanes: boundedValue(state.parallelLanes),
    limit: boundedValue(state.limit),
    compatibility: {
      reads: ["decisionEnvelope", "resumeAudit"],
      emits: "resolvedDecision",
      removedOutputAliases: [
        "decisionEnvelope",
        "resumeAudit",
        "canonicalNextAction",
        "loopContract",
      ],
    },
  };
  const budget =
    mode === "compact"
      ? {
          bytes: COMPACT_STATE_MAX_BYTES,
          lines: COMPACT_STATE_MAX_LINES,
          tokens: COMPACT_STATE_MAX_TOKENS,
        }
      : {
          bytes: DEFAULT_STATE_MAX_BYTES,
          lines: DEFAULT_STATE_MAX_LINES,
          tokens: DEFAULT_STATE_MAX_TOKENS,
        };
  if (mode === "compact") {
    for (const key of [
      "scaffoldHealth",
      "researchIntegrity",
      "runtimeDriftSummary",
      "goalContract",
      "operatorReadout",
      "packetDiagnostics",
      "laneLifecycle",
      "portfolioRecommendation",
      "parallelLanes",
    ]) {
      delete projection[key];
    }
  }
  return fitProjection(projection, budget, [
    "workflowFriction",
    "warningDetails",
    "parseErrors",
    "parallelLanes",
    "portfolioRecommendation",
    "laneLifecycle",
    "packetDiagnostics",
    "productClaimCoverage",
    "config",
    "operatorReadout",
    "goalContract",
    "qualityGap",
    "ledgerHealth",
    "sourceCleanliness",
    "runtimeDriftSummary",
    "researchIntegrity",
    "scaffoldHealth",
  ]);
}

export function projectDoctorReadModel(
  doctorInput: unknown,
  { full = false }: { full?: boolean } = {},
): ReadModelRecord {
  const doctor = unknownRecordOrEmpty(doctorInput);
  const state = unknownRecordOrEmpty(doctor.state);
  const { resolvedDecision: _stateDecision, ...stateWithoutDecision } = state;
  const decision = resolveSessionDecision({
    state: { ...stateWithoutDecision, ...doctor },
    decisionEnvelope: doctor.decisionEnvelope || state.decisionEnvelope,
    commands: recordOrNull(doctor.continuation)?.commands || state.commands,
    runtimeProvenance: doctor.runtimeProvenance || state.runtimeProvenance,
    finalization: recordOrNull(doctor.decisionEnvelope)?.finalizationReadiness,
  });
  if (full) {
    const {
      resumeAudit: _resumeAlias,
      decisionEnvelope: _decisionEnvelopeAlias,
      canonicalNextAction: _canonicalAlias,
      loopContract: _loopAlias,
      ...details
    } = doctor;
    return {
      ...details,
      state: projectFullState(state),
      resolvedDecision: decision,
    };
  }

  const projection: ReadModelRecord = {
    ok: doctor.ok !== false,
    projection: "doctor",
    readModelVersion: SESSION_READ_MODEL_VERSION,
    workDir: boundedText(doctor.workDir || state.workDir),
    status: decision.status,
    issues: boundedMessages(doctor.issues).slice(0, 4),
    warnings: boundedMessages(doctor.warnings).slice(0, 4),
    nextAction: boundedText(decision.nextAction),
    resolvedDecision: compactResolvedDecision(decision),
    git: boundedValue(doctor.git),
    benchmark: compactDoctorBenchmark(doctor.benchmark),
    commandExecutionBoundary: boundedValue(doctor.commandExecutionBoundary),
    explanation: boundedValue(doctor.explanation),
    fullDetail: "Pass --json-full (or json_full=true) for the complete machine diagnostic.",
  };
  return fitProjection(
    projection,
    {
      bytes: DEFAULT_DOCTOR_MAX_BYTES,
      lines: DEFAULT_DOCTOR_MAX_LINES,
      tokens: DEFAULT_DOCTOR_MAX_TOKENS,
    },
    ["explanation", "commandExecutionBoundary", "benchmark"],
  );
}

function compactDoctorBenchmark(value: unknown): ReadModelRecord | null {
  const benchmark = recordOrNull(value);
  return benchmark
    ? pickFields(benchmark, [
        "checked",
        "emitsPrimary",
        "exitCode",
        "timedOut",
        "metricError",
        "packetEnvMode",
      ])
    : null;
}

function compactDashboardHealth(value: unknown): ReadModelRecord | null {
  const health = recordOrNull(value);
  return health
    ? pickFields(health, [
        "liveness",
        "stale",
        "healthUrl",
        "liveUrl",
        "status",
        "reason",
        "nextAction",
      ])
    : null;
}

function compactDecisionCapsule(value: unknown): ReadModelRecord | null {
  const capsule = recordOrNull(value);
  if (!capsule) return null;
  const enforcement = recordOrNull(capsule.enforcement);
  return {
    ...pickFields(capsule, ["kind", "status", "bottleneck", "nextExperiment"]),
    enforcement: enforcement
      ? pickFields(enforcement, [
          "mode",
          "canRunNextPacket",
          "allowBoundedNext",
          "blocksFinalization",
          "clearingCondition",
          "commandHint",
        ])
      : null,
    evidence: boundedMessages(capsule.evidence).slice(0, 2),
  };
}

export function projectDashboardDecision(stateInput: unknown): ResolvedDecision {
  const state = unknownRecordOrEmpty(stateInput);
  return resolveSessionDecision({
    state,
    commands: state.commands,
    runtimeProvenance: state.runtimeProvenance,
    finalization: state.finalizationPressure,
  });
}

export function projectFinalizationDecision(stateInput: unknown): ReadModelRecord {
  const decision = projectDashboardDecision(stateInput);
  return {
    status: decision.status,
    strongestBlocker: decision.strongestBlocker,
    nextAction: decision.nextAction,
    command: decision.command,
    runtimeProvenance: boundedValue(decision.runtimeProvenance),
    runtimeAuthority: boundedValue(decision.runtimeAuthority),
    finalizationPressure: boundedValue(decision.finalizationPressure),
  };
}

export function resolveFinalizationDecision(
  finalizationInput: unknown,
  kind = "finalize-preview",
): ResolvedDecision {
  const finalization = unknownRecordOrEmpty(finalizationInput);
  const ready = finalization.ready === true;
  const nextAction =
    stringValue(finalization.nextAction) ||
    (ready ? "Review the finalization preview." : "Resolve finalization blockers.");
  const explicitBlockers = messageList(finalization.blockers);
  const blockers = ready
    ? explicitBlockers
    : explicitBlockers.length > 0
      ? explicitBlockers
      : [nextAction || messageList(finalization.warnings)[0]].filter(Boolean);
  const action = {
    kind: stringValue(finalization.actionCode) || kind,
    reason: nextAction,
    command: stringValue(finalization.suggestedCommand),
  };
  return resolveSessionDecision({
    state: { blockers, nextAction },
    decisionEnvelope: {
      canonicalNextAction: action,
      loopContract: {
        ok: ready,
        canRunNextPacket: false,
        blockers,
        warnings: messageList(finalization.warnings),
        strongestAction: ready ? null : action,
      },
      finalizationReadiness: finalization,
    },
    commands: { primary: finalization.suggestedCommand },
    finalization,
  });
}

export function projectionBudget(value: unknown): ProjectionBudget {
  const serialized = JSON.stringify(value, null, 2);
  const bytes = Buffer.byteLength(serialized, "utf8");
  return {
    bytes,
    lines: serialized ? serialized.split("\n").length : 0,
    tokens: Math.ceil(serialized.length / 4),
  };
}

export function assertProjectionBudget(
  value: unknown,
  maximum: ProjectionBudget,
  label: string,
): void {
  const actual = projectionBudget(value);
  if (
    actual.bytes > maximum.bytes ||
    actual.lines > maximum.lines ||
    actual.tokens > maximum.tokens
  ) {
    throw new RangeError(
      `${label} exceeds its reviewed output budget: ${actual.bytes}/${maximum.bytes} bytes, ${actual.lines}/${maximum.lines} lines, and ${actual.tokens}/${maximum.tokens} estimated tokens.`,
    );
  }
}

function compactResolvedDecision(decision: ResolvedDecision): ResolvedDecision {
  const action = recordOrNull(decision.canonicalNextAction);
  const loop = recordOrNull(decision.loopContract);
  const runtime = recordOrNull(decision.runtimeProvenance);
  const authority = recordOrNull(decision.runtimeAuthority);
  const finalization = recordOrNull(decision.finalizationPressure);
  return {
    version: SESSION_READ_MODEL_VERSION,
    status: decision.status,
    strongestBlocker: decision.strongestBlocker ? boundedText(decision.strongestBlocker) : null,
    nextAction: boundedText(decision.nextAction),
    command: boundedText(decision.command),
    canonicalNextAction: action
      ? pickFields(action, [
          "kind",
          "priority",
          "reason",
          "command",
          "toolName",
          "safeAction",
          "triggeredBy",
        ])
      : null,
    loopContract: loop
      ? {
          ...pickFields(loop, ["ok", "canRunNextPacket"]),
          ...(boundedMessages(loop.blockers).length > 0
            ? { blockers: boundedMessages(loop.blockers).slice(0, 3) }
            : {}),
          ...(boundedMessages(loop.warnings).length > 0
            ? { warnings: boundedMessages(loop.warnings).slice(0, 3) }
            : {}),
        }
      : null,
    runtimeProvenance: runtime
      ? pickFields(runtime, [
          "status",
          "source",
          "version",
          "sourceRuntime",
          "builtRuntime",
          "installedRuntime",
          "drifted",
          "driftConfidence",
        ])
      : null,
    runtimeAuthority: authority
      ? pickFields(authority, ["trustScope", "blocking", "blocker", "warning"])
      : null,
    finalizationPressure: finalization
      ? {
          ...pickFields(finalization, [
            "available",
            "ready",
            "productGradeReady",
            "productGradeIssue",
            "actionCode",
            "nextAction",
          ]),
          ...(boundedMessages(finalization.warnings).length > 0
            ? { warnings: boundedMessages(finalization.warnings).slice(0, 3) }
            : {}),
        }
      : null,
  };
}

function pickFields(record: ReadModelRecord, keys: string[]): ReadModelRecord {
  return Object.fromEntries(
    keys.filter((key) => record[key] !== undefined).map((key) => [key, boundedValue(record[key])]),
  );
}

function fitProjection(
  value: ReadModelRecord,
  maximum: ProjectionBudget,
  optionalKeys: string[],
): ReadModelRecord {
  const fitted = { ...value };
  for (const key of optionalKeys) {
    if (withinBudget(fitted, maximum)) break;
    delete fitted[key];
  }
  assertProjectionBudget(fitted, maximum, String(value.projection || "session projection"));
  return fitted;
}

function withinBudget(value: unknown, maximum: ProjectionBudget): boolean {
  const actual = projectionBudget(value);
  return (
    actual.bytes <= maximum.bytes &&
    actual.lines <= maximum.lines &&
    actual.tokens <= maximum.tokens
  );
}

function compactCommands(value: unknown, primary: string, compact = false): ReadModelRecord {
  const commands = unknownRecordOrEmpty(value);
  const picked: ReadModelRecord = {};
  const keys = compact
    ? ["state", "doctor", "ledgerDoctor", "next", "newSegmentDryRun", "replaceLast"]
    : [
        "state",
        "stateCompact",
        "doctor",
        "doctorExplain",
        "benchmarkLint",
        "ledgerDoctor",
        "next",
        "recommendNext",
        "partialResults",
        "finalizePreview",
        "newSegmentDryRun",
        "replaceLast",
      ];
  for (const key of keys) {
    const command = boundedText(commands[key]);
    if (command) picked[key] = command;
  }
  if (primary) picked.primary = boundedText(primary);
  return picked;
}

function boundedValue(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "boolean" || typeof value === "number")
    return value ?? null;
  if (typeof value === "string") return boundedText(value);
  if (depth >= 3) return Array.isArray(value) ? `[${value.length} items]` : "[details omitted]";
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => boundedValue(item, depth + 1));
  const record = recordOrNull(value);
  if (!record) return null;
  const seenSubtrees = new Set<string>();
  const entries: Array<[string, unknown]> = [];
  for (const [key, child] of Object.entries(record).slice(0, 16)) {
    const bounded = boundedValue(child, depth + 1);
    const serialized = bounded && typeof bounded === "object" ? JSON.stringify(bounded) : "";
    if (serialized.length >= 64 && seenSubtrees.has(serialized)) continue;
    if (serialized.length >= 64) seenSubtrees.add(serialized);
    entries.push([key, bounded]);
  }
  return Object.fromEntries(entries);
}

function boundedMessages(value: unknown): string[] {
  return messageList(value)
    .slice(0, 8)
    .map((message) => boundedText(message));
}

function boundedText(value: unknown, limit = 500): string {
  const text = stringValue(value);
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  const characters = Array.from(text);
  const templateSuffix = `… [truncated ${characters.length} chars]`;
  const suffixBytes = Buffer.byteLength(templateSuffix, "utf8");
  const kept: string[] = [];
  let bytes = 0;
  for (const character of characters) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes + suffixBytes > limit) break;
    kept.push(character);
    bytes += characterBytes;
  }
  const omitted = characters.length - kept.length;
  const suffix = `… [truncated ${omitted} chars]`;
  return `${kept.join("")}${suffix}`;
}

function decisionStatus(value: unknown): ResolvedDecision["status"] | null {
  return value === "blocked" || value === "ready" || value === "complete" || value === "unknown"
    ? value
    : null;
}

function safeDecisionCommand(value: unknown): boolean {
  const command = stringValue(value).trim();
  if (!command || /<[^>]+>/.test(command) || hasUnsafeShellOperator(command)) return false;
  return !/(?:^|\s)(?:node|python(?:3)?|powershell|pwsh|cmd|sh|bash)\s+(?:-e|--eval|-c|\/c|-command)\b/i.test(
    command,
  );
}

function messageList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(describeValue).filter(Boolean);
}

function uniqueMessages(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  const record = recordOrNull(value);
  if (!record) return "";
  return (
    stringValue(record.message) ||
    stringValue(record.reason) ||
    stringValue(record.title) ||
    stringValue(record.code) ||
    stringValue(record.kind)
  );
}

function recordOrNull(value: unknown): ReadModelRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ReadModelRecord)
    : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
