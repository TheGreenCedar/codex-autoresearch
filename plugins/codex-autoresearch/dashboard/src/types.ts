export type MetricMode = "raw" | "weighted_cost";
export type MetricDirection = "lower" | "higher";
export type RunStatus = "keep" | "discard" | "crash" | "checks_failed";

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
  type?: "config" | "run";
  [key: string]: unknown;
}

export interface NormalizedEntries {
  segments: SessionSegment[];
  latestSegment: number;
}

export interface DashboardSummary {
  segment?: number;
  baseline?: number;
  best?: number;
  confidence?: number;
  runs?: number;
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
  status?: string;
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
  nextBestAction?: NextBestAction;
  missionControl?: MissionControlModel;
  experimentMemory?: ExperimentMemoryModel;
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
  finalizePreview?: FinalizePreviewModel;
  trustState?: TrustStateModel;
  trust?: TrustStateModel;
  trustWarnings?: unknown;
  warnings?: unknown;
  evidenceChips?: EvidenceChip[];
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

export interface DashboardContext {
  state: {
    config: SessionConfig | Record<string, unknown>;
    segment?: number;
    current?: SessionRun[];
    baseline?: number | null;
    best?: number | null;
    confidence?: number | null;
    workDir?: string;
    cwd?: string;
    researchTruth?: ResearchTruthModel;
    [key: string]: unknown;
  };
  settings?: DashboardSettingsInput;
  commands?: Array<{ label?: string; command?: string; [key: string]: unknown }>;
  setupPlan?: Record<string, unknown> | null;
  guidedSetup?: Record<string, unknown> | null;
  qualityGap?: QualityGapModel | null;
  finalizePreview?: FinalizePreviewModel | null;
  recipes?: Array<Record<string, unknown>>;
  experimentMemory?: ExperimentMemoryModel | null;
  drift?: Record<string, unknown> | null;
  warnings?: unknown[];
}

export interface DashboardMode {
  liveRefresh: boolean;
  liveActions: boolean;
  showcase?: boolean;
  title: string;
  detail: string;
  refreshDone: string;
  actionNote: string;
}

export interface DashboardMeta {
  deliveryMode?: string;
  liveRefreshAvailable?: boolean;
  liveActionsAvailable?: boolean;
  showcaseMode?: boolean;
  generatedAt?: string;
  refreshMs?: number;
  actionNonce?: string;
  modeGuidance?: { title?: string; detail?: string; [key: string]: unknown };
  settings?: { showcaseMode?: boolean; [key: string]: unknown };
  trustState?: TrustStateModel;
  viewModel?: DashboardViewModel;
  [key: string]: unknown;
}

export interface ActionReceipt {
  ok?: boolean;
  action?: string;
  status?: string;
  nextStep?: string;
  stderrSummary?: string;
  stdoutSummary?: string;
  durationMs?: number;
  ledgerRun?: number;
  lastRunCleared?: boolean;
  command?: string;
  receiptId?: string;
  [key: string]: unknown;
}

export interface ActionState {
  pending?: boolean;
  error?: string;
  receipt?: ActionReceipt;
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
  best: number | null;
  bestRun: SessionRun | null;
  latestFailure: SessionRun | null;
  nextAction: string;
  confidence: number | null;
  confidenceText: string;
  improvement: number | null;
  recentRuns: SessionRun[];
  plottedRuns: SessionRun[];
  metricDefinition: WeightedMetricDefinition;
}

export interface ChartPoint {
  run: SessionRun;
  chartMetric: number;
  heldMetric: boolean;
  x: number;
  y: number;
  best: boolean;
  latest: boolean;
}

export interface ChartModel {
  points: ChartPoint[];
  linePath: string;
  baselineY: number | null;
  bestY: number | null;
  baselineValue: number | null;
  bestValue: number | null;
  domain: [number, number] | null;
  winZone: { x: number; y: number; width: number; height: number } | null;
  winZoneBounds: { y1: number; y2: number } | null;
  note: string;
  summary: string;
}
