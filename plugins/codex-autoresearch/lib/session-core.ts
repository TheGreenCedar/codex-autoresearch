import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { buildEvidenceRegistry, isAcceptedCurrentRun } from "./evidence-registry.js";
import { buildBudgetStatus } from "./benchmark/budget-contract.js";
import { buildLoopContractStatus, canonicalNextActionForLoop } from "./loop-governance.js";
import { buildOperatorReadout } from "./operator-readout.js";
import { buildProductClaimCoverage, evidenceTextFromRun } from "./product-claim-coverage.js";
import {
  readActiveSessionDecisionCapsule,
  type SessionDecisionCapsule,
} from "./session-decision-capsule.js";
import {
  FAILURE_STATUSES,
  NON_PROMOTIONAL_STATUSES,
  STATUS_VALUES,
  isFailureStatus,
  isMetricEligibleStatus,
  isPromotionalStatus,
} from "./run-status.js";
import {
  loadSessionRecords,
  readJsonl,
  refreshSessionReadCacheForLedgerStamp,
  type SessionReadCache,
} from "./session-records.js";

export {
  appendJsonl,
  createSessionReadCache,
  jsonlPath,
  loadSessionRecords,
  readJsonl,
  readJsonlTail,
  streamJsonl,
  type SessionReadCache,
} from "./session-records.js";

export {
  FAILURE_STATUSES,
  NON_METRIC_ELIGIBLE_STATUSES,
  NON_PROMOTIONAL_STATUSES,
  REJECTED_RUN_STATUSES,
  STATUS_VALUES,
  isFailureStatus,
  isKeepStatus,
  isMetricEligibleStatus,
  isPromotionalStatus,
  isRejectedRunStatus,
  normalizeRunStatus,
} from "./run-status.js";
export const RESEARCH_DIR = "autoresearch.research";
type LooseObject = Record<string, any>;
type Direction = "lower" | "higher";
type RunRecord = LooseObject & {
  run?: number;
  metric?: unknown;
  status?: string;
  segment?: number;
  metrics?: LooseObject;
  asi?: LooseObject;
};
type StateConfig = LooseObject & {
  name: string | null;
  goal: string;
  metricName: string;
  metricUnit: string;
  bestDirection: Direction;
};
type SessionState = LooseObject & {
  config: StateConfig;
  segment: number;
  results: RunRecord[];
  current: RunRecord[];
  sessionDecisionCapsule: SessionDecisionCapsule | null;
};

export function listOption(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value == null || value === "") return [];
  return String(value)
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function safeSlug(value: unknown, fallback = "research"): string {
  const slug = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug || fallback;
}

export function shellQuote(value: unknown): string {
  return `"${String(value).replace(/[\\"]/g, "\\$&")}"`;
}

const METRIC_VALUE_PATTERN = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

export function finiteMetric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || !METRIC_VALUE_PATTERN.test(trimmed)) return null;
  const metric = Number(trimmed);
  return Number.isFinite(metric) ? metric : null;
}

export function hasFiniteMetric(run: RunRecord | null | undefined): boolean {
  return finiteMetric(run?.metric) != null;
}

export function isBaselineEligibleMetricRun(run: RunRecord | null | undefined): boolean {
  return hasFiniteMetric(run) && !isFailureStatus(run?.status);
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function readConfig(sessionCwd: string): LooseObject {
  const configPath = path.join(sessionCwd, "autoresearch.config.json");
  if (!fs.existsSync(configPath)) return {};
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

export function resolveWorkDir(cwdArg?: string): {
  sessionCwd: string;
  workDir: string;
  config: LooseObject;
} {
  const sessionCwd = path.resolve(
    cwdArg || process.env.CODEX_AUTORESEARCH_WORKDIR || process.cwd(),
  );
  const config = readConfig(sessionCwd);
  const workDir = config.workingDir ? path.resolve(sessionCwd, config.workingDir) : sessionCwd;
  if (!fs.existsSync(workDir) || !fs.statSync(workDir).isDirectory()) {
    throw new Error(`Working directory does not exist: ${workDir}`);
  }
  return { sessionCwd, workDir, config };
}

export function bestMetric(runs: RunRecord[], direction: Direction | string): number | null {
  let best = null;
  for (const run of runs) {
    const metric = finiteMetric(run.metric);
    if (metric == null) continue;
    if (best == null || isBetter(metric, best, direction)) best = metric;
  }
  return best;
}

export function bestKeptMetric(runs: RunRecord[], direction: Direction | string): number | null {
  return bestMetric(
    runs.filter((run) => isAcceptedCurrentRun(run)),
    direction,
  );
}

function bestMetricRun(runs: RunRecord[], direction: Direction | string): RunRecord | null {
  let bestRun = null;
  let best = null;
  for (const run of runs) {
    const metric = finiteMetric(run?.metric);
    if (metric == null) continue;
    if (best == null || isBetter(metric, best, direction)) {
      best = metric;
      bestRun = run;
    }
  }
  return bestRun;
}

function boolOrNull(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === "string") {
    if (/^(true|yes|1|promotion|promoted)$/i.test(value.trim())) return true;
    if (/^(false|no|0|dev|development)$/i.test(value.trim())) return false;
  }
  return null;
}

export function promotionGradeValue(run: RunRecord | null | undefined): boolean | null {
  const metrics = run?.metrics || {};
  const asi = run?.asi || {};
  for (const value of [
    run?.promotionGrade,
    run?.promotion_grade,
    run?.promotionEligible,
    run?.promotion_eligible,
    metrics.promotionGrade,
    metrics.promotion_grade,
    metrics.promotionEligible,
    metrics.promotion_eligible,
    asi.promotionGrade,
    asi.promotion_grade,
    asi.promotionEligible,
    asi.promotion_eligible,
  ]) {
    const result = boolOrNull(value);
    if (result !== null) return result;
  }
  return null;
}

export function isPromotionGradeRun(run: RunRecord | null | undefined): boolean {
  return promotionGradeValue(run) === true;
}

function evidenceTrack(runs: RunRecord[], direction: Direction | string) {
  const kept = runs.filter((run) => isAcceptedCurrentRun(run));
  const bestRun = bestMetricRun(kept, direction);
  return {
    count: runs.length,
    kept: kept.length,
    baseline: finiteMetric(runs.find(isBaselineEligibleMetricRun)?.metric),
    best: finiteMetric(bestRun?.metric),
    bestRun: bestRun || null,
    latest: runs.at(-1) || null,
  };
}

export function isBetter(value: number, current: number, direction: Direction | string): boolean {
  return direction === "higher" ? value > current : value < current;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function computeConfidence(runs: RunRecord[], direction: Direction | string): number | null {
  const values = runs
    .filter(isBaselineEligibleMetricRun)
    .map((run) => finiteMetric(run.metric))
    .filter((value): value is number => value != null);
  if (values.length < 3) return null;
  const baseline = values[0];
  const best = bestKeptMetric(runs, direction);
  if (best == null || best === baseline) return null;
  const med = median(values);
  const mad = median(values.map((value) => Math.abs(value - med)));
  if (mad === 0) return null;
  return Math.abs(best - baseline) / mad;
}

export function currentState(workDir: string): SessionState {
  return stateFromSessionRecords(workDir, readJsonl(workDir));
}

export function stateFromSessionRecords(workDir: string, entries: LooseObject[]): SessionState {
  let config: StateConfig = {
    name: null,
    goal: "",
    metricName: "metric",
    metricUnit: "",
    bestDirection: "lower",
  };
  let segment = 0;
  let activeConfigEntry: LooseObject | null = null;
  let previousConfigEntry: LooseObject | null = null;
  let metricSemanticsWarning: LooseObject | null = null;
  const results: RunRecord[] = [];
  for (const entry of entries) {
    if (entry.type === "config") {
      const previousConfig = config;
      const previousEntry = activeConfigEntry;
      const priorSegment = segment;
      const priorSegmentHadRuns = results.some(
        (run) => (run.segment ?? priorSegment) === priorSegment,
      );
      if (results.length > 0) segment += 1;
      config = {
        name: entry.name || config.name,
        goal: entry.goal !== undefined ? String(entry.goal || "").trim() : config.goal,
        metricName: entry.metricName || config.metricName,
        metricUnit: entry.metricUnit ?? config.metricUnit,
        bestDirection: entry.bestDirection === "higher" ? "higher" : "lower",
      };
      previousConfigEntry = previousEntry;
      activeConfigEntry = { ...entry, segment };
      metricSemanticsWarning =
        metricSemanticsChange(previousConfig, config) && previousEntry && priorSegmentHadRuns
          ? {
              code: "metric_semantics_changed",
              severity: "warning",
              message:
                "Metric semantics changed; active segment and historical best may not be directly comparable.",
              previous: {
                metricName: previousConfig.metricName,
                metricUnit: previousConfig.metricUnit,
                bestDirection: previousConfig.bestDirection,
              },
              current: {
                metricName: config.metricName,
                metricUnit: config.metricUnit,
                bestDirection: config.bestDirection,
              },
              segment,
            }
          : null;
      continue;
    }
    if (entry.run != null) {
      const run: RunRecord = { ...entry, segment: entry.segment ?? segment };
      if (Object.hasOwn(entry, "metric")) run.metric = finiteMetric(entry.metric);
      results.push(run);
    }
  }
  const current = results.filter((run) => run.segment === segment);
  const baseline = finiteMetric(current.find(isBaselineEligibleMetricRun)?.metric);
  const best = bestKeptMetric(current, config.bestDirection);
  const historicalBest = bestMetricRun(
    results.filter((run) => isAcceptedCurrentRun(run)),
    config.bestDirection,
  );
  const confidence = computeConfidence(current, config.bestDirection);
  const evidenceRegistry = buildEvidenceRegistry({ runs: current, workDir });
  const productClaimCoverage = buildProductClaimCoverage({
    goal: config.goal,
    acceptedEvidence: current
      .filter((run) => isAcceptedCurrentRun(run))
      .flatMap((run) => evidenceTextFromRun(run)),
  });
  const sessionDecisionCapsule = readActiveSessionDecisionCapsule(workDir, entries);
  const promotionRuns = evidenceRegistry.currentRuns.filter(
    (run) => isAcceptedCurrentRun(run) && isPromotionGradeRun(run),
  );
  return {
    config,
    activeConfigEntry,
    previousConfigEntry,
    metricSemanticsWarning,
    segment,
    results,
    current,
    baseline,
    best,
    historicalBest: bestRunSummary(historicalBest),
    confidence,
    development: evidenceTrack(current, config.bestDirection),
    promotion: evidenceTrack(promotionRuns, config.bestDirection),
    evidenceRegistry,
    productClaimCoverage,
    sessionDecisionCapsule,
  };
}

function metricSemanticsChange(previous: StateConfig, current: StateConfig): boolean {
  return (
    previous.metricName !== current.metricName ||
    previous.metricUnit !== current.metricUnit ||
    previous.bestDirection !== current.bestDirection
  );
}

export function loadSessionState(
  workDir: string,
  readCache?: SessionReadCache | null,
): SessionState {
  if (!readCache) return currentState(workDir);
  const cacheKey = path.resolve(workDir);
  refreshSessionReadCacheForLedgerStamp(workDir, readCache);
  const cached = readCache.stateByCwd.get(cacheKey);
  if (cached) return cached as SessionState;
  const state = stateFromSessionRecords(workDir, loadSessionRecords(workDir, readCache));
  readCache.stateByCwd.set(cacheKey, state);
  return state;
}

function bestRunSummary(run: RunRecord | null | undefined): LooseObject | null {
  if (!run) return null;
  return {
    run: run.run ?? null,
    metric: finiteMetric(run.metric),
    status: run.status || "",
    segment: run.segment ?? null,
    description: run.description || "",
    promotionGrade: promotionGradeValue(run),
  };
}

function warningCodes(warnings: unknown): Set<string> {
  if (!Array.isArray(warnings)) return new Set();
  return new Set(
    warnings
      .map((warning: any) =>
        typeof warning === "object" && warning ? String(warning.code || "") : "",
      )
      .filter(Boolean),
  );
}

function qualityRoundState(qualityGap: LooseObject | null | undefined): LooseObject {
  if (!qualityGap) return { active: false, open: null, closed: null, total: null, done: null };
  const open = finiteMetric(qualityGap.open);
  const closed = finiteMetric(qualityGap.closed);
  const total = finiteMetric(qualityGap.total);
  return {
    active: true,
    slug: qualityGap.slug || "",
    open,
    closed,
    total,
    done: open === 0,
  };
}

export function buildDecisionEnvelope({
  state,
  nextAction,
  lastRunFreshness = null,
  warningDetails = [],
  scaffoldHealth = null,
  researchIntegrity = null,
  finalization = null,
  qualityGap = null,
  contextDistillation = null,
  experimentEconomics = null,
  salvageCandidates = [],
  workflowFriction = [],
  experimentMemory = null,
  segmentTransition = null,
  setupState = null,
  watchdog = null,
}: LooseObject): LooseObject {
  const current: RunRecord[] = Array.isArray(state?.current) ? state.current : [];
  const all: RunRecord[] = Array.isArray(state?.results) ? state.results : current;
  const direction = state?.config?.bestDirection || "lower";
  const historicalBest = bestMetricRun(
    all.filter((run) => isAcceptedCurrentRun(run)),
    direction,
  );
  const promotionBest = bestMetricRun(
    current.filter((run) => isAcceptedCurrentRun(run) && isPromotionGradeRun(run)),
    direction,
  );
  const codes = warningCodes(warningDetails);
  const limit = state?.limit || {};
  const budgetStatus = limit.budgetStatus || state?.budgetStatus || null;
  const remainingIterations =
    limit.remainingIterations === null || limit.remainingIterations === undefined
      ? null
      : Number(limit.remainingIterations);
  const limitReached =
    limit.limitReached === true ||
    budgetStatus?.exhausted === true ||
    (remainingIterations != null &&
      Number.isFinite(remainingIterations) &&
      remainingIterations <= 0);
  const qualityRound = qualityRoundState(qualityGap);
  const cleanliness = sourceCleanliness(state);
  const segmentTransitionRequired =
    segmentTransition?.required === true || limitReached || qualityRound.done === true;
  const scaffoldBlockers = Array.isArray(scaffoldHealth?.checks)
    ? scaffoldHealth.checks
        .filter((check: any) => check?.severity === "blocker")
        .map((check: any) => check.message || check.code)
    : [];
  const envelope = {
    activeSegment: {
      segment: state?.segment ?? 0,
      runs: current.length,
      baseline: state?.baseline ?? null,
      best: state?.best ?? null,
      developmentBest: state?.development?.best ?? null,
    },
    historicalBest: bestRunSummary(historicalBest),
    promotionGradeBest: bestRunSummary(promotionBest),
    latestPacketFreshness: lastRunFreshness
      ? {
          fresh: lastRunFreshness.fresh === true,
          reason: lastRunFreshness.reason || "",
          expectedNextRun: lastRunFreshness.expectedNextRun ?? null,
          actualNextRun: lastRunFreshness.actualNextRun ?? null,
        }
      : {
          fresh: null,
          reason: "No last-run packet is pending.",
          expectedNextRun: null,
          actualNextRun: null,
        },
    benchmarkConfigDrift: {
      drifted: codes.has("benchmark_contract_changed"),
      warnings: Array.isArray(warningDetails)
        ? warningDetails.filter((warning: any) => warning?.code === "benchmark_contract_changed")
        : [],
    },
    dirtySourceDrift: {
      dirty: cleanliness?.sourceDirty === true || codes.has("git_dirty"),
      status: cleanliness?.status || (codes.has("git_dirty") ? "source-dirty" : "clean"),
      sessionArtifactDirty: cleanliness?.sessionArtifactDirty === true,
      sourcePaths: cleanliness?.sourcePaths || [],
      sessionArtifactPaths: cleanliness?.sessionArtifactPaths || [],
      warnings: Array.isArray(warningDetails)
        ? warningDetails.filter((warning: any) =>
            ["git_dirty", "missing_commit_paths"].includes(String(warning?.code || "")),
          )
        : [],
    },
    sourceCleanliness: cleanliness,
    qualityRound,
    scaffoldHealth: scaffoldHealth
      ? {
          ok: scaffoldHealth.ok,
          status: scaffoldHealth.status || "",
          blockers: scaffoldBlockers,
        }
      : null,
    researchIntegrity: researchIntegrity
      ? {
          ok: researchIntegrity.ok,
          currentLabel: researchIntegrity.currentLabel || "",
          evidenceLabels: researchIntegrity.evidenceLabels || [],
          notPromotableBecause: researchIntegrity.notPromotableBecause || [],
        }
      : null,
    goalAdvice: buildGoalAdvice({
      finalization,
      qualityGap,
      scaffoldBlockers,
      state,
      warningDetails,
    }),
    finalizationReadiness: finalization
      ? {
          available: finalization.available !== false,
          ready: finalization.ready === null ? null : finalization.ready === true,
          productGradeReady:
            finalization.productGradeReady === undefined
              ? finalization.product_grade_ready !== false
              : finalization.productGradeReady !== false,
          productGradeIssue:
            finalization.productGradeIssue || finalization.product_grade_issue || null,
          actionCode: finalization.actionCode || "",
          nextAction: finalization.nextAction || "",
          warnings: finalization.warnings || [],
        }
      : {
          available: false,
          ready: null,
          productGradeReady: true,
          productGradeIssue: null,
          nextAction: "",
          warnings: [],
        },
    experimentEconomics,
    salvageCandidates: Array.isArray(salvageCandidates) ? salvageCandidates : [],
    workflowFriction: Array.isArray(workflowFriction) ? workflowFriction : [],
    experimentMemory: experimentMemory
      ? {
          plateau: experimentMemory.plateau || null,
          exhaustedFamilies: experimentMemory.exhaustedFamilies || [],
          metricShelves: experimentMemory.metricShelves || [],
          missingAsiDetails: experimentMemory.missingAsiDetails || [],
        }
      : null,
    setupState: setupState
      ? {
          stage: setupState.stage || "",
          blockers: Array.isArray(setupState.blockers) ? setupState.blockers : [],
          nextAction: setupState.nextAction || "",
        }
      : null,
    segmentTransition: segmentTransitionRequired
      ? {
          required: true,
          nextAction:
            segmentTransition?.nextAction ||
            segmentTransition?.reason ||
            budgetStatus?.nextAction ||
            (qualityRound.done === true
              ? "The active quality round is closed; refresh gaps or preview finalization."
              : "The active segment reached its limit; extend the limit or start a new segment."),
          triggeredBy:
            segmentTransition?.triggeredBy ||
            (budgetStatus?.exhausted === true ? ["budget"] : null) ||
            (qualityRound.done === true ? ["qualityRound"] : ["limit"]),
        }
      : null,
    budgetStatus,
    watchdog: watchdog
      ? {
          status: watchdog.status || "",
          stale: watchdog.stale === true,
          thresholdHours: watchdog.thresholdHours ?? null,
          quietHours: watchdog.quietHours ?? null,
          recommendation: watchdog.recommendation || "",
          reasons: Array.isArray(watchdog.reasons) ? watchdog.reasons : [],
        }
      : null,
    contextDistillation,
    laneLifecycle: state?.laneLifecycle || null,
    laneOrchestration: state?.laneOrchestration || null,
    runtimeProvenance: state?.runtimeProvenance || null,
    runtimeAuthority: state?.runtimeAuthority || null,
    ledgerHealth: state?.ledgerHealth || null,
    goalContract: state?.goalContract || null,
    approvalLedger: state?.approvalLedger || null,
    resourcePreflight: state?.resourcePreflight || null,
    evidenceMaturity: state?.evidenceMaturity || null,
    finalizationRunway: state?.finalizationRunway || null,
    packetDiagnostics: state?.packetDiagnostics || null,
    sessionDecisionCapsule: state?.sessionDecisionCapsule || null,
    gateQuality: state?.gateQuality || null,
    preflight: state?.preflight || null,
    portfolioRecommendation: state?.portfolioRecommendation || null,
    nextAction: nextAction || "Run doctor, then next.",
  };
  const loopContract = buildLoopContractStatus(envelope);
  const supplementalAction = supplementalNextActionForEnvelope(envelope);
  const governanceAction = canonicalNextActionForLoop(envelope);
  const canonicalNextAction = loopContractShouldOverrideSupplemental(loopContract)
    ? governanceAction
    : supplementalAction;
  const operatorReadout = buildOperatorReadout({
    canonicalNextAction,
    loopContract,
    runtimeProvenance: envelope.runtimeProvenance,
  });
  return {
    ...envelope,
    loopContract,
    canonicalNextAction,
    operatorReadout,
  };
}

function loopContractShouldOverrideSupplemental(loopContract: {
  blockers?: LooseObject[];
  canRunNextPacket?: boolean;
}): boolean {
  const blockers = Array.isArray(loopContract.blockers) ? loopContract.blockers : [];
  if (blockers.length === 0) {
    if (loopContract.canRunNextPacket !== false) return false;
    return true;
  }
  return true;
}

type SupplementalActionRule = (envelope: LooseObject) => LooseObject | null;

const SUPPLEMENTAL_ACTION_PRIORITY = {
  essentialSafety: 1,
  earlyWorkflowBlocker: 2,
  workflowWarning: 3,
  setupOrFreshness: 4,
  pendingPacketDecision: 5,
  contextDistillation: 6,
  segmentOrQualityGap: 7,
  plateauOrWatchdogOrCurrentTree: 8,
  finalizationReady: 9,
  nextPacket: 10,
} as const;

// Loop governance owns packet brakes; this ladder supplies richer guidance once the loop contract allows continuation.
const SUPPLEMENTAL_NEXT_ACTION_RULES: SupplementalActionRule[] = [
  scaffoldBlockerAction,
  dirtySourceDriftAction,
  timeoutMismatchAction,
  workflowBlockerAction,
  metricSaturationAction,
  stalePacketAction,
  setupAction,
  benchmarkCommandAction,
  logDecisionAction,
  trustBlockerAction,
  workflowWarningAction,
  segmentTransitionAction,
  plateauAction,
  watchdogAction,
  finalizationAction,
  baselineAction,
  nextPacketAction,
];

function supplementalNextActionForEnvelope(envelope: LooseObject): LooseObject {
  for (const rule of SUPPLEMENTAL_NEXT_ACTION_RULES) {
    const action = rule(envelope);
    if (action) return action;
  }
  return nextPacketAction(envelope);
}

function scaffoldBlockerAction(envelope: LooseObject): LooseObject | null {
  const scaffoldBlockers = envelope.scaffoldHealth?.blockers || [];
  if (Array.isArray(scaffoldBlockers) && scaffoldBlockers.length > 0) {
    return {
      kind: "safety-blocker",
      priority: SUPPLEMENTAL_ACTION_PRIORITY.essentialSafety,
      reason: String(scaffoldBlockers[0] || "Resolve scaffold blockers."),
      command: "",
      triggeredBy: ["scaffoldHealth"],
    };
  }
  return null;
}

function dirtySourceDriftAction(envelope: LooseObject): LooseObject | null {
  if (envelope.dirtySourceDrift?.dirty === true) {
    return {
      kind: "workflow-friction",
      priority: SUPPLEMENTAL_ACTION_PRIORITY.earlyWorkflowBlocker,
      reason: "Review dirty source drift before another packet.",
      command: "",
      triggeredBy: ["dirtySourceDrift"],
    };
  }
  return null;
}

function timeoutMismatchAction(envelope: LooseObject): LooseObject | null {
  const timeoutMismatch = firstEconomicsWarning(
    envelope.experimentEconomics,
    "outer_timeout_shorter_than_inner",
  );
  if (timeoutMismatch) {
    return {
      kind: "benchmark-mismatch",
      priority: SUPPLEMENTAL_ACTION_PRIORITY.earlyWorkflowBlocker,
      reason: timeoutMismatch.recommendation || timeoutMismatch.message,
      command: "",
      triggeredBy: ["experimentEconomics", timeoutMismatch.code],
    };
  }
  return null;
}

function workflowBlockerAction(envelope: LooseObject): LooseObject | null {
  const workflowBlocker = firstWorkflowFriction(envelope.workflowFriction, "blocker");
  if (workflowBlocker) {
    return {
      kind: "workflow-friction",
      priority: SUPPLEMENTAL_ACTION_PRIORITY.earlyWorkflowBlocker,
      reason: workflowBlocker.suggestedAction?.reason || workflowBlocker.reason,
      command: workflowBlocker.suggestedAction?.command || "",
      triggeredBy: workflowBlocker.suggestedAction?.triggeredBy || [workflowBlocker.kind],
    };
  }
  return null;
}

function workflowWarningAction(envelope: LooseObject): LooseObject | null {
  const workflowWarning = firstWorkflowFriction(envelope.workflowFriction, "warning");
  if (workflowWarning) {
    return {
      kind: "workflow-friction",
      priority: SUPPLEMENTAL_ACTION_PRIORITY.workflowWarning,
      reason: workflowWarning.suggestedAction?.reason || workflowWarning.reason,
      command: workflowWarning.suggestedAction?.command || "",
      triggeredBy: workflowWarning.suggestedAction?.triggeredBy || [workflowWarning.kind],
    };
  }
  const repeatedSmallProbe = firstEconomicsWarning(
    envelope.experimentEconomics,
    "repeated_small_probe",
  );
  if (repeatedSmallProbe) {
    return {
      kind: "workflow-friction",
      priority: SUPPLEMENTAL_ACTION_PRIORITY.workflowWarning,
      reason: repeatedSmallProbe.recommendation || repeatedSmallProbe.message,
      command: "",
      triggeredBy: ["experimentEconomics", repeatedSmallProbe.code],
    };
  }
  return null;
}

function metricSaturationAction(envelope: LooseObject): LooseObject | null {
  const signal = firstWorkflowFrictionByKind(
    envelope.workflowFriction,
    "metric_saturated_not_promotable",
  );
  if (!signal) return null;
  return {
    kind: "metric-saturation",
    priority: SUPPLEMENTAL_ACTION_PRIORITY.workflowWarning,
    reason: signal.suggestedAction?.reason || signal.reason,
    command: signal.suggestedAction?.command || "",
    triggeredBy: signal.suggestedAction?.triggeredBy || [signal.kind],
  };
}

function trustBlockerAction(envelope: LooseObject): LooseObject | null {
  if (
    firstDiagnosticSalvage(envelope.salvageCandidates) ||
    envelope.latestPacketFreshness?.fresh === true
  ) {
    return null;
  }

  const gateQualityBlocker = firstNonEmptyString(envelope.gateQuality?.blockers);
  if (gateQualityBlocker) {
    return {
      kind: "gate-quality",
      priority: SUPPLEMENTAL_ACTION_PRIORITY.earlyWorkflowBlocker,
      reason: gateQualityBlocker,
      command: envelope.preflight?.nextCommand || "",
      triggeredBy: ["gateQuality"],
    };
  }

  if (hasSharperSetupOrFreshnessAction(envelope)) return null;

  const preflightBlocker = firstNonEmptyString(envelope.preflight?.blockers);
  if (preflightBlocker) {
    return {
      kind: "preflight",
      priority: SUPPLEMENTAL_ACTION_PRIORITY.earlyWorkflowBlocker,
      reason: preflightBlocker,
      command: envelope.preflight?.nextCommand || "",
      triggeredBy: ["preflight"],
    };
  }

  if (envelope.portfolioRecommendation?.kind === "trust-blocker") {
    return {
      kind: "portfolio-trust-blocker",
      priority: SUPPLEMENTAL_ACTION_PRIORITY.workflowWarning,
      reason:
        envelope.portfolioRecommendation.reason ||
        envelope.portfolioRecommendation.nextActionHint ||
        "Resolve the portfolio trust blocker before continuing.",
      command: envelope.preflight?.nextCommand || "",
      triggeredBy: ["portfolioRecommendation"],
    };
  }

  return null;
}

function hasSharperSetupOrFreshnessAction(envelope: LooseObject): boolean {
  const setupBlockers = Array.isArray(envelope.setupState?.blockers)
    ? envelope.setupState.blockers
    : [];
  return (
    envelope.latestPacketFreshness?.fresh === false ||
    setupBlockers.length > 0 ||
    envelope.setupState?.stage === "needs-setup" ||
    envelope.setupState?.stage === "needs-benchmark-command"
  );
}

function stalePacketAction(envelope: LooseObject): LooseObject | null {
  if (envelope.latestPacketFreshness?.fresh === false) {
    return {
      kind: "stale-packet",
      priority: SUPPLEMENTAL_ACTION_PRIORITY.setupOrFreshness,
      reason: envelope.latestPacketFreshness.reason || "Last-run packet is stale.",
      command: "",
      triggeredBy: ["latestPacketFreshness"],
    };
  }
  if (
    envelope.experimentEconomics?.warnings?.some(
      (warning: any) => warning.code === "stale_progress",
    )
  ) {
    return {
      kind: "stale-packet",
      priority: SUPPLEMENTAL_ACTION_PRIORITY.setupOrFreshness,
      reason:
        envelope.experimentEconomics.warnings.find(
          (warning: any) => warning.code === "stale_progress",
        )?.recommendation || "Inspect stale packet progress before continuing.",
      command: "",
      triggeredBy: ["experimentEconomics", "progress"],
    };
  }
  return null;
}

function setupAction(envelope: LooseObject): LooseObject | null {
  const setupBlockers = Array.isArray(envelope.setupState?.blockers)
    ? envelope.setupState.blockers
    : [];
  if (setupBlockers.length || envelope.setupState?.stage === "needs-setup") {
    return {
      kind: "setup",
      priority: SUPPLEMENTAL_ACTION_PRIORITY.setupOrFreshness,
      reason:
        setupBlockers[0] ||
        envelope.setupState?.nextAction ||
        "Complete setup blockers before trusting another packet.",
      command: "",
      triggeredBy: ["setup"],
    };
  }
  return null;
}

function benchmarkCommandAction(envelope: LooseObject): LooseObject | null {
  if (envelope.setupState?.stage === "needs-benchmark-command") {
    return {
      kind: "benchmark-command",
      priority: SUPPLEMENTAL_ACTION_PRIORITY.setupOrFreshness,
      reason: envelope.setupState?.nextAction || "Add a repeatable benchmark command.",
      command: "",
      triggeredBy: ["setup", "benchmarkCommand"],
    };
  }
  return null;
}

function logDecisionAction(envelope: LooseObject): LooseObject | null {
  const salvage = firstDiagnosticSalvage(envelope.salvageCandidates);
  if (salvage) {
    return {
      kind: "partial-salvage",
      priority: SUPPLEMENTAL_ACTION_PRIORITY.pendingPacketDecision,
      reason: `Review partial result ${salvage.id} before rerunning an expensive packet.`,
      command: "",
      triggeredBy: ["partialResults"],
    };
  }
  if (envelope.latestPacketFreshness?.fresh === true) {
    return {
      kind: "log-decision",
      priority: SUPPLEMENTAL_ACTION_PRIORITY.pendingPacketDecision,
      reason: "Record the fresh last-run packet before starting another packet.",
      command: "",
      triggeredBy: ["latestPacketFreshness"],
    };
  }
  return null;
}

function segmentTransitionAction(envelope: LooseObject): LooseObject | null {
  if (envelope.contextDistillation?.required === true) {
    return {
      kind: "context-distillation",
      priority: SUPPLEMENTAL_ACTION_PRIORITY.contextDistillation,
      reason:
        envelope.contextDistillation.reason ||
        "Refresh a context capsule before running another packet.",
      command: envelope.contextDistillation.command || "",
      triggeredBy: envelope.contextDistillation.triggeredBy || ["contextDistillation"],
    };
  }
  if (envelope.segmentTransition?.required === true) {
    return {
      kind: "segment-transition",
      priority: SUPPLEMENTAL_ACTION_PRIORITY.segmentOrQualityGap,
      title: Array.isArray(envelope.segmentTransition.triggeredBy)
        ? envelope.segmentTransition.triggeredBy.includes("qualityRound")
          ? "Review completion state"
          : "Start a new segment"
        : "Start a new segment",
      reason:
        envelope.segmentTransition.nextAction ||
        "Resolve the active segment transition before continuing.",
      command: "",
      triggeredBy: envelope.segmentTransition.triggeredBy || ["segmentTransition"],
    };
  }
  return null;
}

function plateauAction(envelope: LooseObject): LooseObject | null {
  if (envelope.qualityRound?.active && envelope.qualityRound.done === false) {
    return {
      kind: "quality-gap",
      priority: SUPPLEMENTAL_ACTION_PRIORITY.segmentOrQualityGap,
      reason: `${envelope.qualityRound.open ?? "Open"} accepted quality gaps remain.`,
      command: "",
      triggeredBy: ["qualityRound"],
    };
  }
  const exhausted = envelope.experimentMemory?.exhaustedFamilies?.[0];
  const shelf = envelope.experimentMemory?.metricShelves?.[0];
  if (envelope.experimentMemory?.plateau?.detected || exhausted || shelf) {
    return {
      kind: "plateau-pivot",
      priority: SUPPLEMENTAL_ACTION_PRIORITY.plateauOrWatchdogOrCurrentTree,
      reason:
        exhausted?.requiredPrecondition ||
        shelf?.reason ||
        envelope.experimentMemory?.plateau?.recommendation ||
        "Pivot before repeating the same experiment family.",
      command: "",
      triggeredBy: exhausted ? ["experimentMemory", "exhaustedFamily"] : ["experimentMemory"],
    };
  }
  return null;
}

function watchdogAction(envelope: LooseObject): LooseObject | null {
  if (envelope.watchdog?.stale === true) {
    return {
      kind: "watchdog",
      priority: SUPPLEMENTAL_ACTION_PRIORITY.plateauOrWatchdogOrCurrentTree,
      reason:
        envelope.watchdog.recommendation ||
        "No progress signal has appeared within the watchdog window.",
      command: "",
      triggeredBy: ["watchdog"],
    };
  }
  return null;
}

function finalizationAction(envelope: LooseObject): LooseObject | null {
  const finalization = envelope.finalizationReadiness || {};
  const warnings = Array.isArray(finalization.warnings) ? finalization.warnings.map(String) : [];
  const nextAction = String(finalization.nextAction || "");
  if (
    finalization.actionCode === "current-tree-finalization" ||
    /finalize-current-tree/i.test(nextAction) ||
    warnings.some((warning: string) =>
      /Final tree coverage is missing|Excluded commits touch planned files/i.test(warning),
    )
  ) {
    return {
      kind: "current-tree-finalization",
      priority: SUPPLEMENTAL_ACTION_PRIORITY.plateauOrWatchdogOrCurrentTree,
      reason:
        nextAction ||
        "Use current-tree finalization because commit-level kept evidence does not describe the current branch tree cleanly.",
      command: "",
      triggeredBy: ["finalizationReadiness", "currentTree"],
    };
  }
  if (envelope.finalizationReadiness?.ready === true) {
    return {
      kind: "finalization",
      priority: SUPPLEMENTAL_ACTION_PRIORITY.finalizationReady,
      reason: envelope.finalizationReadiness.nextAction || "Finalize reviewable kept work.",
      command: "",
      triggeredBy: ["finalizationReadiness"],
    };
  }
  return null;
}

function baselineAction(_envelope: LooseObject): LooseObject | null {
  return null;
}

function nextPacketAction(envelope: LooseObject): LooseObject {
  return {
    kind: "next-packet",
    priority: SUPPLEMENTAL_ACTION_PRIORITY.nextPacket,
    reason: envelope.nextAction || "Run the next measured packet.",
    command: "",
    triggeredBy: ["continuation"],
  };
}

function firstEconomicsWarning(economics: any, code: string): any | null {
  return Array.isArray(economics?.warnings)
    ? economics.warnings.find((warning: any) => warning?.code === code) || null
    : null;
}

function firstWorkflowFriction(signals: any[], severity: string): any | null {
  return Array.isArray(signals)
    ? signals.find((signal) => signal?.severity === severity) || null
    : null;
}

function firstWorkflowFrictionByKind(signals: any[], kind: string): any | null {
  return Array.isArray(signals)
    ? signals.find((signal) => String(signal?.kind || "") === kind) || null
    : null;
}

function firstNonEmptyString(values: unknown): string {
  if (!Array.isArray(values)) return "";
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function sourceCleanliness(state: LooseObject): LooseObject | null {
  const cleanliness = state?.sourceCleanliness;
  return cleanliness && typeof cleanliness === "object" && !Array.isArray(cleanliness)
    ? (cleanliness as LooseObject)
    : null;
}

function firstDiagnosticSalvage(candidates: any[]): any | null {
  return Array.isArray(candidates)
    ? candidates.find((candidate) =>
        ["scored", "manual_review", "diagnostic"].includes(String(candidate?.status || "")),
      ) || null
    : null;
}

function buildGoalAdvice({
  finalization,
  qualityGap,
  scaffoldBlockers,
  state,
  warningDetails,
}: LooseObject): LooseObject {
  const goal = String(state?.config?.goal || "").trim();
  if (!goal) {
    return {
      present: false,
      objective: "",
      advice: "none",
      reason: "No durable Autoresearch goal is recorded in the active config.",
    };
  }
  const warningMessages = Array.isArray(warningDetails)
    ? warningDetails.map((warning: any) => warning?.message || warning?.code).filter(Boolean)
    : [];
  const qualityRound = qualityRoundState(qualityGap);
  const blockers = [...(scaffoldBlockers || []), ...warningMessages].filter(Boolean);
  let advice = "continue";
  let reason =
    "Continue from the decision envelope next action and require evidence before completion.";
  if (blockers.length) {
    advice = "consider_blocked";
    reason = "Resolve blockers before treating the goal as progressing or complete.";
  } else if (finalization?.ready === true) {
    advice = "review_completion";
    reason =
      "Finalization preview is ready; review whether the goal's acceptance criteria are truly satisfied.";
  } else if (qualityRound.active && qualityRound.done === true) {
    advice = "review_completion";
    reason =
      "The current quality-gap round is closed; decide whether the recorded goal needs another round before completion.";
  }
  return {
    present: true,
    objective: goal,
    advice,
    reason,
    blockers: blockers.slice(0, 8),
    completionPolicy:
      "Never treat iteration, tool, or token budget exhaustion as goal completion. Mark complete only after evidence satisfies the goal objective.",
  };
}

export function lastRunConfigSnapshot(config: LooseObject = {}) {
  return {
    name: config.name || null,
    metricName: config.metricName || "metric",
    metricUnit: config.metricUnit ?? "",
    bestDirection: config.bestDirection === "higher" ? "higher" : "lower",
  };
}

export function statusHash(value: unknown): string {
  return createHash("sha256")
    .update(String(value || ""), "utf8")
    .digest("hex");
}

export function normalizeScopedFileFingerprints(fingerprints: unknown): Record<string, string> {
  if (!fingerprints || typeof fingerprints !== "object" || Array.isArray(fingerprints)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(fingerprints)
      .filter(([key, value]) => key && value != null)
      .map(([key, value]) => [String(key).replace(/\\/g, "/"), String(value)])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function buildLastRunFreshnessSnapshot(workDir: string, context: LooseObject = {}) {
  const state = context.state || currentState(workDir);
  const snapshot: LooseObject = {
    segment: state.segment,
    config: context.configSnapshot || lastRunConfigSnapshot(state.config),
    currentRuns: state.current.length,
    totalRuns: state.results.length,
    nextRun: state.results.length + 1,
  };
  addSnapshotString(snapshot, "command", context.command);
  addSnapshotPath(snapshot, "cwd", context.cwd);
  addSnapshotPath(snapshot, "workingDir", context.workingDir);
  addSnapshotString(snapshot, "gitHead", context.gitHead);
  addSnapshotString(snapshot, "dirtyStatusHash", context.dirtyStatusHash);
  if (context.scopedFileFingerprints != null) {
    snapshot.scopedFileFingerprints = normalizeScopedFileFingerprints(
      context.scopedFileFingerprints,
    );
  }
  return snapshot;
}

export function lastRunPacketFreshness(
  workDir: string,
  packet: LooseObject,
  context: LooseObject = {},
) {
  const expected = packet?.history;
  if (!expected || typeof expected !== "object") {
    return {
      fresh: false,
      reason: "Last-run packet is missing history metadata. Run next again before logging.",
    };
  }
  const actual = buildLastRunFreshnessSnapshot(workDir, context);
  if (!Number.isFinite(Number(expected.nextRun))) {
    return {
      fresh: false,
      reason: "Last-run packet is missing history metadata. Run next again before logging.",
    };
  }
  if (Number.isFinite(Number(expected.segment)) && actual.segment !== Number(expected.segment)) {
    return {
      fresh: false,
      expectedSegment: Number(expected.segment),
      actualSegment: actual.segment,
      reason: `Last-run packet is stale: expected segment #${Number(expected.segment)}, but current segment is #${actual.segment}. Run next again before logging.`,
    };
  }
  if (!expected.config || typeof expected.config !== "object") {
    return {
      fresh: false,
      reason: "Last-run packet is missing config metadata. Run next again before logging.",
    };
  }
  if (JSON.stringify(expected.config) !== JSON.stringify(actual.config)) {
    return {
      fresh: false,
      expectedConfig: expected.config,
      actualConfig: actual.config,
      reason:
        "Last-run packet is stale: session config changed since the packet was created. Run next again before logging.",
    };
  }
  if (Number(expected.nextRun) !== actual.nextRun) {
    return {
      fresh: false,
      expectedNextRun: Number(expected.nextRun),
      actualNextRun: actual.nextRun,
      reason: `Last-run packet is stale: expected next log run #${Number(expected.nextRun)}, but current history would log #${actual.nextRun}. Run next again before logging.`,
    };
  }
  const contextualMismatch = firstFreshnessContextMismatch(expected, actual);
  if (contextualMismatch) return contextualMismatch;
  return {
    fresh: true,
    expectedNextRun: Number(expected.nextRun),
    actualNextRun: actual.nextRun,
    reason: "Last-run packet matches the current ledger.",
  };
}

export function assertFreshLastRunPacket(
  workDir: string,
  packet: LooseObject,
  context: LooseObject = {},
) {
  const freshness = lastRunPacketFreshness(workDir, packet, context);
  if (!freshness.fresh) throw new Error(freshness.reason);
  return freshness;
}

function addSnapshotString(snapshot: LooseObject, key: string, value: unknown): void {
  if (value != null && value !== "") snapshot[key] = String(value);
}

function addSnapshotPath(snapshot: LooseObject, key: string, value: unknown): void {
  if (value != null && value !== "") snapshot[key] = path.resolve(String(value));
}

function firstFreshnessContextMismatch(expected: LooseObject, actual: LooseObject) {
  for (const key of ["command", "cwd", "workingDir", "gitHead", "dirtyStatusHash"]) {
    if (!Object.hasOwn(expected, key)) continue;
    if (expected[key] !== actual[key]) {
      return {
        fresh: false,
        expectedValue: expected[key],
        actualValue: actual[key] ?? null,
        reason: `Last-run packet is stale: ${key} changed since the packet was created. Run next again before logging.`,
      };
    }
  }
  if (Object.hasOwn(expected, "scopedFileFingerprints")) {
    const expectedFingerprints = normalizeScopedFileFingerprints(expected.scopedFileFingerprints);
    const actualFingerprints = normalizeScopedFileFingerprints(actual.scopedFileFingerprints);
    if (JSON.stringify(expectedFingerprints) !== JSON.stringify(actualFingerprints)) {
      return {
        fresh: false,
        expectedValue: expectedFingerprints,
        actualValue: actualFingerprints,
        reason:
          "Last-run packet is stale: scoped file fingerprints changed since the packet was created. Run next again before logging.",
      };
    }
  }
  return null;
}

export function iterationLimitInfo(state: SessionState, runtimeConfig: LooseObject) {
  const budgetStatus = buildBudgetStatus({ state, runtimeConfig });
  const maxIterations = Number(runtimeConfig.maxIterations);
  if (!Number.isFinite(maxIterations) || maxIterations <= 0) {
    return {
      maxIterations: null,
      remainingIterations: null,
      limitReached: budgetStatus.exhausted,
      stopReason: budgetStatus.stopReason,
      budgetStatus,
    };
  }
  const max = Math.floor(maxIterations);
  const remaining = Math.max(0, max - state.current.length);
  const maxReached = state.current.length >= max;
  return {
    maxIterations: max,
    remainingIterations: remaining,
    limitReached: maxReached || budgetStatus.exhausted,
    stopReason: budgetStatus.stopReason || (maxReached ? `maxIterations reached (${max}).` : ""),
    budgetStatus,
  };
}

export function parseQualityGapItems(text: string) {
  const open: string[] = [];
  const closed: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s*\[([ xX])\]\s+(.+?)\s*$/);
    if (!match) continue;
    const item = match[2].trim();
    if (match[1].toLowerCase() === "x") closed.push(item);
    else open.push(item);
  }
  return { open, closed };
}

export function parseQualityGaps(text: string) {
  const items = parseQualityGapItems(text);
  return {
    open: items.open.length,
    closed: items.closed.length,
    total: items.open.length + items.closed.length,
  };
}

export function researchSlugFromArgs(args: LooseObject): string {
  return safeSlug(args.research_slug ?? args.researchSlug ?? args.slug ?? args.name ?? "research");
}

export function researchDirPath(workDir: string, slug: string): string {
  return path.join(workDir, RESEARCH_DIR, slug);
}
