type JsonObject = Record<string, unknown>;

export interface CompactStateBuilderInput {
  ok?: boolean;
  workDir: string;
  name?: string;
  goal?: string;
  metric?: string;
  direction?: string;
  segment?: number;
  runs?: number;
  kept?: number;
  discarded?: number;
  measured?: number;
  baseline?: unknown;
  best?: unknown;
  historicalBest?: unknown;
  developmentBest?: unknown;
  promotionBest?: unknown;
  goalFrame?: unknown;
  goalContract?: unknown;
  operatorHandoff?: unknown;
  evidenceRegistry?: unknown;
  productClaimCoverage?: unknown;
  sessionDecisionCapsule?: unknown;
  evidenceLabels?: unknown[];
  scaffoldHealth?: unknown;
  researchIntegrity?: unknown;
  limitReached?: boolean;
  remainingIterations?: unknown;
  nextAction?: string;
  shouldContinue?: boolean;
  forbidFinalAnswer?: boolean;
  activeBudget?: boolean;
  requiresLogDecision?: boolean;
  afterLogAction?: string;
  finalAnswerPolicy?: string;
  parallelLanes?: unknown[];
  fanoutPlan?: unknown;
  fanoutProvenance?: unknown;
  watchdogSummary?: unknown;
  blockers?: unknown[];
  goalAdvice?: unknown;
  report?: unknown;
  memory?: unknown;
  experimentEconomics?: unknown;
  partialResults?: unknown;
  commandExecutionBoundary?: unknown;
  workflowFriction?: unknown[];
  commands?: JsonObject;
  resumeAudit?: unknown;
  decisionEnvelope?: unknown;
  canonicalNextAction?: unknown;
  runtimeProvenance?: unknown;
  runtimeDriftSummary?: unknown;
  dashboardHealth?: unknown;
  sourceCleanliness?: unknown;
  ledgerHealth?: unknown;
  gateQuality?: unknown;
  preflight?: unknown;
  portfolioRecommendation?: unknown;
  loopContract?: unknown;
  approvalLedger?: unknown;
  resourcePreflight?: unknown;
  evidenceMaturity?: unknown;
  laneOrchestration?: unknown;
  finalizationRunway?: unknown;
  operatorReadout?: unknown;
  laneLifecycle?: unknown;
  packetDiagnostics?: unknown;
  metricSemanticsWarning?: unknown;
  fixedControl?: unknown;
}

const OPTIONAL_COMPACT_STATE_FIELDS = [
  "runtimeProvenance",
  "runtimeDriftSummary",
  "dashboardHealth",
  "sourceCleanliness",
  "ledgerHealth",
  "gateQuality",
  "preflight",
  "portfolioRecommendation",
  "loopContract",
  "approvalLedger",
  "resourcePreflight",
  "evidenceMaturity",
  "laneOrchestration",
  "finalizationRunway",
  "operatorReadout",
  "laneLifecycle",
  "packetDiagnostics",
  "commandExecutionBoundary",
  "metricSemanticsWarning",
  "fixedControl",
] as const satisfies readonly (keyof CompactStateBuilderInput)[];

export interface CompactStateResponse {
  ok: boolean;
  workDir: string;
  name: string;
  goal: string;
  metric: string;
  direction: string;
  segment: number;
  runs: number;
  kept: number;
  discarded: number;
  measured: number;
  baseline: unknown;
  best: unknown;
  historicalBest: unknown;
  developmentBest: unknown;
  promotionBest: unknown;
  goalFrame: unknown;
  goalContract: unknown;
  operatorHandoff: unknown;
  evidenceRegistry: unknown;
  productClaimCoverage: unknown;
  sessionDecisionCapsule: unknown;
  evidenceLabels: unknown[];
  scaffoldHealth: unknown;
  researchIntegrity: unknown;
  limitReached: boolean;
  remainingIterations: unknown;
  nextAction: string;
  shouldContinue: boolean;
  forbidFinalAnswer: boolean;
  activeBudget: boolean;
  requiresLogDecision: boolean;
  afterLogAction: string;
  finalAnswerPolicy: string;
  parallelLanes: unknown[];
  fanoutPlan: unknown;
  fanoutProvenance: unknown;
  watchdogSummary: unknown;
  blockers: unknown[];
  goalAdvice: unknown;
  report: unknown;
  memory: unknown;
  experimentEconomics: unknown;
  partialResults: unknown;
  commandExecutionBoundary?: unknown;
  workflowFriction: unknown[];
  commands: JsonObject;
  resumeAudit: unknown;
  decisionEnvelope: unknown;
  canonicalNextAction: unknown;
  runtimeProvenance?: unknown;
  runtimeDriftSummary?: unknown;
  dashboardHealth?: unknown;
  sourceCleanliness?: unknown;
  ledgerHealth?: unknown;
  gateQuality?: unknown;
  preflight?: unknown;
  portfolioRecommendation?: unknown;
  loopContract?: unknown;
  approvalLedger?: unknown;
  resourcePreflight?: unknown;
  evidenceMaturity?: unknown;
  laneOrchestration?: unknown;
  finalizationRunway?: unknown;
  operatorReadout?: unknown;
  laneLifecycle?: unknown;
  packetDiagnostics?: unknown;
  metricSemanticsWarning?: unknown;
  fixedControl?: unknown;
}

export function buildCompactStateResponse(input: CompactStateBuilderInput): CompactStateResponse {
  const response: CompactStateResponse = {
    ok: input.ok ?? true,
    workDir: input.workDir,
    name: input.name || "Autoresearch",
    goal: input.goal || "",
    metric: input.metric || "metric",
    direction: input.direction || "lower",
    segment: input.segment ?? 0,
    runs: input.runs ?? 0,
    kept: input.kept ?? 0,
    discarded: input.discarded ?? 0,
    measured: input.measured ?? 0,
    baseline: input.baseline ?? null,
    best: input.best ?? null,
    historicalBest: input.historicalBest ?? null,
    developmentBest: input.developmentBest ?? null,
    promotionBest: input.promotionBest ?? null,
    goalFrame: input.goalFrame ?? null,
    goalContract: input.goalContract ?? null,
    operatorHandoff: input.operatorHandoff ?? null,
    evidenceRegistry: input.evidenceRegistry ?? null,
    productClaimCoverage: input.productClaimCoverage ?? null,
    sessionDecisionCapsule: input.sessionDecisionCapsule ?? null,
    evidenceLabels: Array.isArray(input.evidenceLabels) ? input.evidenceLabels : [],
    scaffoldHealth: input.scaffoldHealth ?? null,
    researchIntegrity: input.researchIntegrity ?? null,
    limitReached: input.limitReached === true,
    remainingIterations: input.remainingIterations ?? null,
    nextAction: input.nextAction || "Run doctor, then next.",
    shouldContinue: input.shouldContinue === true,
    forbidFinalAnswer: input.forbidFinalAnswer === true,
    activeBudget: input.activeBudget === true,
    requiresLogDecision: input.requiresLogDecision === true,
    afterLogAction: input.afterLogAction || "",
    finalAnswerPolicy: input.finalAnswerPolicy || "",
    parallelLanes: Array.isArray(input.parallelLanes) ? input.parallelLanes : [],
    fanoutPlan: input.fanoutPlan ?? null,
    fanoutProvenance: input.fanoutProvenance ?? null,
    watchdogSummary: input.watchdogSummary ?? null,
    blockers: Array.isArray(input.blockers) ? input.blockers : [],
    goalAdvice: input.goalAdvice ?? null,
    report: input.report ?? null,
    memory: input.memory ?? null,
    experimentEconomics: input.experimentEconomics ?? null,
    partialResults: input.partialResults ?? null,
    workflowFriction: Array.isArray(input.workflowFriction) ? input.workflowFriction : [],
    commands: input.commands || {},
    resumeAudit: input.resumeAudit ?? null,
    decisionEnvelope: input.decisionEnvelope ?? input.resumeAudit ?? null,
    canonicalNextAction: input.canonicalNextAction ?? null,
  };

  for (const field of OPTIONAL_COMPACT_STATE_FIELDS) {
    copyIfProvided(response, field, input[field]);
  }

  return response;
}

function copyIfProvided<T extends object>(target: T, key: string, value: unknown) {
  if (value !== undefined) (target as JsonObject)[key] = value;
}
