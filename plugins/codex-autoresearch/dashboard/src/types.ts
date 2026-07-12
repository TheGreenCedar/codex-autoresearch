export type MetricMode = "raw" | "weighted_cost";
export type MetricDirection = "lower" | "higher";
export type RunStatus = "keep" | "discard" | "crash" | "checks_failed" | "measure";

export { DASHBOARD_PAYLOAD_VERSION } from "../../lib/types/dashboard-wire.js";

export interface MetricWeights {
  time: number;
  memory: number;
}

export interface RunAsi {
  hypothesis?: string;
  evidence?: string;
  rollback_reason?: string;
  rollbackReason?: string;
  next_action_hint?: string;
  nextAction?: string;
  next_action?: string;
  [key: string]: unknown;
}

export interface MetricConfigInput {
  mode?: MetricMode;
  weights?: Partial<MetricWeights> | null;
  memoryKey?: string;
  formulaText?: string;
}

export interface SessionConfig {
  name: string;
  metricName: string;
  metricUnit: string;
  bestDirection: MetricDirection;
  metricMode?: MetricMode;
  metricWeights?: Partial<MetricWeights> | null;
  metricMemoryKey?: string;
  memoryKey?: string;
  metricFormula?: string;
  metric_formula?: string;
  formulaText?: string;
  metricDefinition?: MetricConfigInput;
  [key: string]: unknown;
}

export interface SessionRun {
  run: number;
  metric: number | null;
  status: RunStatus;
  description: string;
  confidence?: number | null;
  metrics: Record<string, unknown>;
  asi: RunAsi;
  timestamp?: string | number;
  segment: number;
  [key: string]: unknown;
}

export interface SessionSegment {
  segment: number;
  config: SessionConfig;
  runs: SessionRun[];
}

export interface DashboardEntry {
  type?: "approval" | "config" | "lane_result" | "process_lifecycle" | "research_fanout" | "run";
  [key: string]: unknown;
}

export interface NormalizedEntries {
  segments: SessionSegment[];
  latestSegment: number;
  invalidLedgerEntryCount: number;
}

export interface DashboardSummary {
  segment?: number;
  baseline?: number;
  best?: number;
  confidence?: number;
  runs?: number;
  kept?: number;
  [key: string]: unknown;
}

export interface EvidenceChip {
  label?: string;
  title?: string;
  kind?: string;
  value?: string;
  detail?: string;
  text?: string;
  message?: string;
  tone?: string;
  state?: string;
  [key: string]: unknown;
}

export interface EvidenceReadoutModel {
  label?: string;
  title?: string;
  promotable?: boolean;
  reasons?: string[];
  [key: string]: unknown;
}

export interface ProofGapModel {
  label?: string;
  detail?: string;
  nextAction?: string;
  [key: string]: unknown;
}

export interface NextBestAction {
  priority?: string;
  title?: string;
  detail?: string;
  utilityCopy?: string;
  source?: string;
  safeAction?: string;
  tone?: string;
  explanation?: Record<string, string>;
  evidenceChips?: EvidenceChip[];
  [key: string]: unknown;
}

export interface DecisionEnvelopeModel {
  activeSegment?: {
    segment?: number;
    runs?: number;
    baseline?: number | null;
    best?: number | null;
    developmentBest?: number | null;
    [key: string]: unknown;
  };
  historicalBest?: Record<string, unknown> | null;
  promotionGradeBest?: Record<string, unknown> | null;
  latestPacketFreshness?: {
    fresh?: boolean | null;
    reason?: string;
    expectedNextRun?: number | null;
    actualNextRun?: number | null;
    [key: string]: unknown;
  };
  benchmarkConfigDrift?: Record<string, unknown>;
  dirtySourceDrift?: Record<string, unknown>;
  qualityRound?: Record<string, unknown>;
  scaffoldHealth?: {
    ok?: boolean;
    status?: string;
    blockers?: unknown[];
    [key: string]: unknown;
  } | null;
  researchIntegrity?: Record<string, unknown> | null;
  finalizationReadiness?: {
    available?: boolean;
    ready?: boolean | null;
    nextAction?: string;
    warnings?: unknown[];
    [key: string]: unknown;
  };
  nextAction?: string;
  [key: string]: unknown;
}

export interface DecisionEnvelopeSummary {
  kind?: string;
  priority?: string;
  title?: string;
  detail?: string;
  source?: string;
  fresh?: boolean | null;
  segment?: number | null;
  runs?: number | null;
  measurementRuns?: number;
  finalizationReady?: boolean | null;
  [key: string]: unknown;
}

export interface MissionStep {
  id?: string;
  title?: string;
  state?: string;
  detail?: string;
  safeAction?: string;
  command?: string;
  [key: string]: unknown;
}

export interface LogDecisionModel {
  available?: boolean;
  allowedStatuses?: string[];
  suggestedStatus?: string;
  defaultDescription?: string;
  lastRunFingerprint?: string;
  fingerprint?: string;
  asiTemplate?: RunAsi;
  command?: string;
  commandsByStatus?: Record<string, string>;
  [key: string]: unknown;
}

export interface MissionControlModel {
  activeStep?: string;
  steps?: MissionStep[];
  logDecision?: LogDecisionModel;
  [key: string]: unknown;
}

export interface StrategyLane {
  id?: string;
  title?: string;
  label?: string;
  status?: string;
  mode?: string;
  executionBoundary?: string;
  evidenceStatus?: string;
  nextActionHint?: string;
  recommendation?: string;
  [key: string]: unknown;
}

export interface ExperimentMemoryModel {
  latestNextAction?: string;
  plateau?: { detected?: boolean; [key: string]: unknown };
  lanePortfolio?: StrategyLane[];
  [key: string]: unknown;
}

export interface QualityGapModel {
  slug?: string;
  open?: number;
  closed?: number;
  total?: number;
  roundGuidance?: { requiredRefresh?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface ResearchTruthModel {
  open?: number;
  closed?: number;
  total?: number;
  score?: number;
  percent?: number;
  label?: string;
  title?: string;
  detail?: string;
  summary?: string;
  source?: string;
  suspiciousReasons?: unknown;
  suspicious_reasons?: unknown;
  suspiciousPerfectWarning?: string;
  suspiciousPerfect?: unknown;
  [key: string]: unknown;
}

export interface TrustStateModel {
  mode?: string;
  modeLabel?: string;
  detail?: string;
  summary?: string;
  actionState?: string;
  actions?: string;
  evidenceState?: string;
  evidence?: string;
  generatedAt?: string;
  reasons?: unknown;
  warnings?: unknown;
  [key: string]: unknown;
}

export interface ChecklistItemModel {
  id?: string;
  label?: string;
  title?: string;
  detail?: string;
  message?: string;
  reason?: string;
  state?: string;
  status?: string;
  complete?: boolean;
  [key: string]: unknown;
}

export interface FinalizePreviewModel {
  ready?: boolean;
  nextAction?: string;
  warnings?: unknown;
  checklist?:
    | {
        title?: string;
        ready?: boolean;
        items?: ChecklistItemModel[];
        warnings?: unknown;
        [key: string]: unknown;
      }
    | ChecklistItemModel[];
  [key: string]: unknown;
}

export interface AiSummaryModel {
  title?: string;
  happened?: string[];
  plan?: string[];
  blockers?: string[];
  source?: string;
  generatedFrom?: { latestRun?: number; [key: string]: unknown };
  [key: string]: unknown;
}

export interface DashboardViewModel {
  summary?: DashboardSummary;
  ledgerEntries?: DashboardEntry[];
  ledgerBounds?: LedgerBounds;
  decisionEnvelope?: DecisionEnvelopeModel | null;
  decisionEnvelopeSummary?: DecisionEnvelopeSummary;
  nextBestAction?: NextBestAction;
  missionControl?: MissionControlModel;
  experimentMemory?: ExperimentMemoryModel;
  fanoutPlan?: Record<string, unknown> | null;
  parallelLanes?: StrategyLane[];
  aiSummary?: AiSummaryModel;
  qualityGap?: QualityGapModel;
  researchTruth?: ResearchTruthModel;
  truthMeter?: ResearchTruthModel;
  finalizationChecklist?:
    | {
        title?: string;
        ready?: boolean;
        items?: ChecklistItemModel[];
        warnings?: unknown;
        [key: string]: unknown;
      }
    | ChecklistItemModel[];
  finalizationPressure?: Record<string, unknown>;
  watchdogSummary?: Record<string, unknown>;
  processHygiene?: Record<string, unknown>;
  finalizePreview?: FinalizePreviewModel;
  trustState?: TrustStateModel;
  trust?: TrustStateModel;
  trustWarnings?: unknown;
  warnings?: unknown;
  evidenceChips?: EvidenceChip[];
  evidenceLedger?: Record<string, unknown>;
  evidenceReadout?: EvidenceReadoutModel;
  proofGaps?: ProofGapModel[];
  readout?: {
    nextAction?: string;
    confidenceText?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface DashboardSettingsInput {
  deliveryMode?: string;
  liveUrl?: string;
  pluginVersion?: string;
  runtimeDrift?: unknown;
  generatedAt?: string;
  sourceCwd?: string;
  researchTruth?: ResearchTruthModel;
  [key: string]: unknown;
}

export type { DashboardContext } from "../../lib/types/dashboard-wire.js";

export interface DashboardMode {
  liveRefresh: boolean;
  liveActions: boolean;
  showcase?: boolean;
  title: string;
  detail: string;
  refreshDone: string;
  actionNote: string;
}

export interface LedgerBounds {
  truncated?: boolean;
  omittedEntries?: number;
  maxEntries?: number;
  totalEntries?: number;
  validEntries?: number;
  retainedEntries?: number;
  summarySource?: "full-ledger-stream";
  retention?: "newest-rows-plus-governing-config";
  processLifecycleProjectionIncomplete?: boolean;
  processLifecycleTrackedIdentities?: number;
  processLifecycleOverflowCount?: number;
  invalidLedgerEntryCount?: number;
  invalidLedgerEntries?: Array<{
    file?: string;
    line?: number;
    kind?: string;
    message?: string;
    command?: string;
  }>;
}

export interface DashboardMeta {
  payloadVersion?: number;
  deliveryMode?: string;
  liveRefreshAvailable?: boolean;
  liveActionsAvailable?: boolean;
  showcaseMode?: boolean;
  generatedAt?: string;
  ledgerBounds?: LedgerBounds;
  refreshMs?: number;
  modeGuidance?: { title?: string; detail?: string; [key: string]: unknown };
  settings?: { showcaseMode?: boolean; [key: string]: unknown };
  trustState?: TrustStateModel;
  viewModel?: DashboardViewModel;
  [key: string]: unknown;
}

export interface WeightedMetricDefinition {
  requestedMode: MetricMode;
  mode: MetricMode;
  metricName: string;
  displayUnit: string;
  bestDirection: MetricDirection;
  valueLabel: string;
  percentLabel: string;
  weights: MetricWeights;
  memoryKey: string;
  formulaInline: string;
  formulaDetails: string;
  formulaSource: string;
  formulaConfigured: boolean;
  fallbackNote: string;
  baselineMetric: number | null;
  baselineTime: number | null;
  baselineMemory: number | null;
}

export interface RunMetricBreakdown {
  run: SessionRun;
  metricValue: number | null;
  chartPercentValue: number | null;
  improvement: number | null;
  timeValue: number | null;
  timeScore: number | null;
  memoryValue: number | null;
  memoryScore: number | null;
  weightedTime: number | null;
  weightedMemory: number | null;
}

export interface DashboardReadout {
  baseline: number | null;
  baselineRun: SessionRun | null;
  best: number | null;
  bestRun: SessionRun | null;
  latestPlottedRun: SessionRun | null;
  latestFailure: SessionRun | null;
  nextAction: string;
  confidence: number | null;
  confidenceText: string;
  improvement: number | null;
  recentRuns: SessionRun[];
  plottedRuns: SessionRun[];
  metricDefinition: WeightedMetricDefinition;
  invalidLedgerEntryCount: number;
}

export interface ChartPoint {
  run: SessionRun;
  chartMetric: number;
  heldMetric: boolean;
  best: boolean;
  latest: boolean;
}

export interface ChartModel {
  points: ChartPoint[];
  baselineValue: number | null;
  bestValue: number | null;
  domain: [number, number] | null;
  winZoneBounds: { y1: number; y2: number } | null;
  note: string;
  summary: string;
}
