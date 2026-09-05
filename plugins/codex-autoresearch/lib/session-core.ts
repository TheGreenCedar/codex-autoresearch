import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { buildEvidenceRegistry, isAcceptedCurrentRun } from "./evidence-registry.js";
import { buildBudgetStatus, packetBudgetUsage } from "./benchmark/budget-contract.js";
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
  sessionSegmentTimeline,
  loadSessionRecords,
  readJsonl,
  refreshSessionReadCacheForLedgerStamp,
  type SessionReadCache,
} from "./session-records.js";
import {
  AUTORESEARCH_RESEARCH_DIR,
  researchDirPathForSession,
  resolveSessionPaths,
} from "./session-paths.js";
import { isPathInside } from "./path-containment.js";

export {
  appendJsonl,
  appendJsonlEntries,
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
export const RESEARCH_DIR = AUTORESEARCH_RESEARCH_DIR;
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
  const configPath = resolveSessionPaths({ sessionCwd, workDir: sessionCwd }).configPath;
  if (!fs.existsSync(configPath)) return {};
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

export function resolveWorkDir(
  cwdArg?: string,
  options: { allowOutsideWorkdir?: boolean } = {},
): {
  sessionCwd: string;
  workDir: string;
  config: LooseObject;
  sessionPaths: ReturnType<typeof resolveSessionPaths>;
} {
  const sessionCwd = path.resolve(
    cwdArg || process.env.CODEX_AUTORESEARCH_WORKDIR || process.cwd(),
  );
  const config = readConfig(sessionCwd);
  const workDir = config.workingDir ? path.resolve(sessionCwd, config.workingDir) : sessionCwd;
  if (!isPathInside(sessionCwd, workDir) && options.allowOutsideWorkdir !== true) {
    throw new Error(
      `Configured working directory is outside --cwd: ${workDir}. Pass --allow-outside-workdir to authorize it explicitly.`,
    );
  }
  if (!fs.existsSync(workDir) || !fs.statSync(workDir).isDirectory()) {
    throw new Error(`Working directory does not exist: ${workDir}`);
  }
  return {
    sessionCwd,
    workDir,
    config,
    sessionPaths: resolveSessionPaths({ sessionCwd, workDir }),
  };
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
  const ratio = Math.abs(best - baseline) / mad;
  return Number.isFinite(ratio) ? ratio : null;
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
  const segmentTimeline = sessionSegmentTimeline(entries);
  for (const [index, entry] of entries.entries()) {
    if (entry.type === "config") {
      const previousConfig = config;
      const previousEntry = activeConfigEntry;
      const priorSegment = segment;
      const priorSegmentHadRuns = results.some(
        (run) => (run.segment ?? priorSegment) === priorSegment,
      );
      segment = segmentTimeline[index];
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
    confidenceStatistic: { kind: "movement-history-mad-ratio", isStatisticalConfidence: false },
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
  const packetsUsed = packetBudgetUsage(state.current);
  const remaining = Math.max(0, max - packetsUsed);
  const maxReached = packetsUsed >= max;
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
  return researchDirPathForSession(workDir, slug);
}
