import { createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import { createInterface } from "node:readline";

import { isAcceptedCurrentRun } from "./evidence-registry.js";
import {
  DASHBOARD_LEDGER_MAX_ENTRIES,
  type DashboardLedgerBounds,
} from "./dashboard-ledger-bounds.js";
import {
  createProcessLifecycleAccumulator,
  type ProcessLifecycleProjection,
} from "./process-governor.js";
import { finiteMetric, isBaselineEligibleMetricRun, isPromotionGradeRun } from "./session-core.js";
import {
  jsonlPath,
  ledgerRecordIssue,
  parseJsonlRecord,
  type LedgerRecordIssue,
  type SessionRecord,
} from "./session-records.js";

type RunRecord = SessionRecord & {
  run?: number;
  metric?: unknown;
  status?: string;
  segment?: number;
  metrics?: Record<string, unknown>;
  asi?: Record<string, unknown>;
};

export { DASHBOARD_LEDGER_MAX_ENTRIES } from "./dashboard-ledger-bounds.js";
export const DASHBOARD_LEDGER_INVALID_SAMPLE_LIMIT = 20;

export interface DashboardLedgerLine {
  line: number;
  text: string;
  record: SessionRecord | null;
  issue: LedgerRecordIssue | null;
  segment: number;
}

export interface DashboardLedgerSummary {
  totalEntries: number;
  validEntries: number;
  runCount: number;
  currentRunCount: number;
  acceptedRunCount: number;
  measurementRunCount: number;
  failedRunCount: number;
  statusCounts: Record<string, number>;
  segment: number;
  config: Record<string, unknown>;
  activeConfigEntry: SessionRecord | null;
  previousConfigEntry: SessionRecord | null;
  metricSemanticsWarning: Record<string, unknown> | null;
  baseline: number | null;
  best: number | null;
  baselineRun: RunRecord | null;
  bestRun: RunRecord | null;
  latestRun: RunRecord | null;
  latestFailure: RunRecord | null;
  historicalBestRun: RunRecord | null;
  development: Record<string, unknown>;
  promotion: Record<string, unknown>;
  confidenceComplete: boolean;
}

export interface DashboardLedgerFold {
  entries: SessionRecord[];
  analysisRecords: SessionRecord[];
  lines: DashboardLedgerLine[];
  ledgerBounds: DashboardLedgerBounds;
  processLifecycleProjection: ProcessLifecycleProjection;
  summary: DashboardLedgerSummary;
}

interface MetricExtremes {
  min: RunRecord | null;
  max: RunRecord | null;
}

interface SegmentSummary {
  runCount: number;
  acceptedRunCount: number;
  measurementRunCount: number;
  failedRunCount: number;
  statusCounts: Record<string, number>;
  baselineRun: RunRecord | null;
  latestRun: RunRecord | null;
  latestFailure: RunRecord | null;
  accepted: MetricExtremes;
  promotion: MetricExtremes & {
    count: number;
    acceptedRunCount: number;
    baselineRun: RunRecord | null;
    latestRun: RunRecord | null;
  };
}

export async function foldDashboardLedger(
  workDir: string,
  maxEntries = DASHBOARD_LEDGER_MAX_ENTRIES,
): Promise<DashboardLedgerFold> {
  return foldDashboardLedgerFile(jsonlPath(workDir), maxEntries);
}

export async function foldDashboardLedgerFile(
  filePath: string,
  maxEntries = DASHBOARD_LEDGER_MAX_ENTRIES,
): Promise<DashboardLedgerFold> {
  const limit = Math.max(0, Math.floor(Number(maxEntries) || 0));
  const stats = await fsp
    .stat(filePath)
    .catch((error: unknown) => (isFileNotFound(error) ? null : Promise.reject(error)));
  if (!stats) return emptyDashboardLedgerFold(limit);

  const ring: Array<DashboardLedgerLine | undefined> = Array.from({ length: limit });
  let ringStart = 0;
  let ringSize = 0;
  let latestConfigBeforeRing: DashboardLedgerLine | null = null;
  let totalEntries = 0;
  let validEntries = 0;
  let sourceLine = 0;
  let segment = 0;
  let hasAnyRun = false;
  let activeConfigEntry: SessionRecord | null = null;
  let previousConfigEntry: SessionRecord | null = null;
  let config = defaultDashboardConfig();
  let metricSemanticsWarning: Record<string, unknown> | null = null;
  let current = emptySegmentSummary();
  const historicalAccepted: MetricExtremes = { min: null, max: null };
  const processLifecycle = createProcessLifecycleAccumulator();
  const invalidLedgerEntries: LedgerRecordIssue[] = [];
  let invalidLedgerEntryCount = 0;

  const pushLine = (line: DashboardLedgerLine) => {
    if (limit <= 0) return;
    if (ringSize < limit) {
      ring[(ringStart + ringSize) % limit] = line;
      ringSize += 1;
      return;
    }
    const removed = ring[ringStart];
    if (removed?.record?.type === "config") latestConfigBeforeRing = removed;
    ring[ringStart] = line;
    ringStart = (ringStart + 1) % limit;
  };

  const stream = createReadStream(filePath, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const rawLine of reader) {
      sourceLine += 1;
      const text = String(rawLine).trim();
      if (!text) continue;
      totalEntries += 1;
      let record: SessionRecord | null = null;
      let issue: LedgerRecordIssue | null = null;
      try {
        record = parseJsonlRecord(text, filePath, sourceLine);
        validEntries += 1;
      } catch (error) {
        issue = ledgerRecordIssue(error);
        if (!issue) throw error;
        invalidLedgerEntryCount += 1;
        if (invalidLedgerEntries.length < DASHBOARD_LEDGER_INVALID_SAMPLE_LIMIT) {
          invalidLedgerEntries.push(issue);
        }
      }

      if (record?.type === "config") {
        const previousConfig = config;
        const priorSegmentHadRuns = current.runCount > 0;
        if (hasAnyRun) {
          segment += 1;
          current = emptySegmentSummary();
        }
        previousConfigEntry = activeConfigEntry;
        config = dashboardConfigFromRecord(record, config);
        activeConfigEntry = { ...record, segment };
        metricSemanticsWarning =
          priorSegmentHadRuns &&
          previousConfigEntry &&
          metricSemanticsChanged(previousConfig, config)
            ? metricSemanticsChangeWarning(previousConfig, config, segment)
            : null;
      } else if (record?.run != null) {
        hasAnyRun = true;
        const run = normalizedRun(record, segment);
        if (run.segment === segment) updateSegmentSummary(current, run);
        if (isAcceptedCurrentRun(run)) updateExtremes(historicalAccepted, run);
      }
      if (record) processLifecycle.add(record);

      pushLine({ line: sourceLine, text, record, issue, segment });
    }
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
  } finally {
    reader.close();
    stream.destroy();
  }

  const rawTail = orderedRing(ring, ringStart, ringSize);
  const lines = retainGoverningConfig(rawTail, latestConfigBeforeRing, limit);
  const bestRun = extremeForDirection(current.accepted, config.bestDirection);
  const historicalBestRun = extremeForDirection(historicalAccepted, config.bestDirection);
  const promotionBestRun = extremeForDirection(current.promotion, config.bestDirection);
  const processLifecycleProjection = processLifecycle.snapshot();
  const entries = lines.flatMap((line) => (line.record ? [line.record] : []));
  const analysisRecords = boundedAnalysisRecords(lines, [
    activeConfigEntry,
    current.baselineRun,
    bestRun,
    current.latestFailure,
    current.latestRun,
    current.promotion.baselineRun,
    promotionBestRun,
    current.promotion.latestRun,
    ...processLifecycleProjection.records,
  ]);
  const ledgerBounds: DashboardLedgerBounds = {
    maxEntries: limit,
    omittedEntries: Math.max(0, totalEntries - lines.length),
    truncated: totalEntries > lines.length,
    totalEntries,
    validEntries,
    retainedEntries: lines.length,
    summarySource: "full-ledger-stream",
    retention: "newest-rows-plus-governing-config",
    ...(processLifecycleProjection.trackedIdentityCount
      ? { processLifecycleTrackedIdentities: processLifecycleProjection.trackedIdentityCount }
      : {}),
    ...(processLifecycleProjection.incomplete
      ? {
          processLifecycleProjectionIncomplete: true,
          processLifecycleOverflowCount: processLifecycleProjection.overflowCount,
        }
      : {}),
    ...(invalidLedgerEntryCount ? { invalidLedgerEntryCount, invalidLedgerEntries } : {}),
  };
  const confidenceComplete = ledgerBounds.truncated !== true;
  return {
    entries,
    analysisRecords,
    lines,
    ledgerBounds,
    processLifecycleProjection,
    summary: {
      totalEntries,
      validEntries,
      runCount: current.runCount,
      currentRunCount: current.runCount,
      acceptedRunCount: current.acceptedRunCount,
      measurementRunCount: current.measurementRunCount,
      failedRunCount: current.failedRunCount,
      statusCounts: current.statusCounts,
      segment,
      config,
      activeConfigEntry,
      previousConfigEntry,
      metricSemanticsWarning,
      baseline: finiteMetric(current.baselineRun?.metric),
      best: finiteMetric(bestRun?.metric),
      baselineRun: current.baselineRun,
      bestRun,
      latestRun: current.latestRun,
      latestFailure: current.latestFailure,
      historicalBestRun,
      development: evidenceTrackSummary(current, bestRun),
      promotion: promotionTrackSummary(current, promotionBestRun),
      confidenceComplete,
    },
  };
}

function emptyDashboardLedgerFold(maxEntries: number): DashboardLedgerFold {
  const current = emptySegmentSummary();
  const processLifecycleProjection = createProcessLifecycleAccumulator().snapshot();
  return {
    entries: [],
    analysisRecords: [],
    lines: [],
    ledgerBounds: {
      maxEntries,
      omittedEntries: 0,
      truncated: false,
      totalEntries: 0,
      validEntries: 0,
      retainedEntries: 0,
      summarySource: "full-ledger-stream",
      retention: "newest-rows-plus-governing-config",
    },
    processLifecycleProjection,
    summary: {
      totalEntries: 0,
      validEntries: 0,
      runCount: 0,
      currentRunCount: 0,
      acceptedRunCount: 0,
      measurementRunCount: 0,
      failedRunCount: 0,
      statusCounts: {},
      segment: 0,
      config: defaultDashboardConfig(),
      activeConfigEntry: null,
      previousConfigEntry: null,
      metricSemanticsWarning: null,
      baseline: null,
      best: null,
      baselineRun: null,
      bestRun: null,
      latestRun: null,
      latestFailure: null,
      historicalBestRun: null,
      development: evidenceTrackSummary(current, null),
      promotion: promotionTrackSummary(current, null),
      confidenceComplete: true,
    },
  };
}

function orderedRing(
  ring: Array<DashboardLedgerLine | undefined>,
  start: number,
  size: number,
): DashboardLedgerLine[] {
  const ordered: DashboardLedgerLine[] = [];
  for (let index = 0; index < size; index += 1) {
    const line = ring[(start + index) % ring.length];
    if (line) ordered.push(line);
  }
  return ordered;
}

function retainGoverningConfig(
  lines: DashboardLedgerLine[],
  latestConfigBeforeRing: DashboardLedgerLine | null,
  maxEntries: number,
): DashboardLedgerLine[] {
  if (maxEntries <= 1 || !latestConfigBeforeRing) return lines;
  const firstRun = lines.findIndex((line) => line.record?.run != null);
  if (firstRun < 0 || lines.slice(0, firstRun + 1).some((line) => line.record?.type === "config")) {
    return lines;
  }
  return [latestConfigBeforeRing, ...lines.slice(-(maxEntries - 1))];
}

function boundedAnalysisRecords(
  lines: DashboardLedgerLine[],
  governingRecords: Array<SessionRecord | RunRecord | null>,
): SessionRecord[] {
  const retainedRecords = lines.map((line) => {
    const record = line.record;
    if (record?.type === "process_lifecycle") return null;
    return record && (record.run != null || record.type === "config")
      ? ({ ...record, segment: record.segment ?? line.segment } as SessionRecord)
      : record;
  });
  const retainedKeys = new Set(
    retainedRecords
      .filter((record): record is SessionRecord => Boolean(record))
      .map(analysisRecordKey),
  );
  const extraKeys = new Set<string>();
  const extras = governingRecords.flatMap((record) => {
    if (!record) return [];
    const key = analysisRecordKey(record);
    if (retainedKeys.has(key) || extraKeys.has(key)) return [];
    extraKeys.add(key);
    return [record as SessionRecord];
  });
  return [
    ...extras,
    ...retainedRecords.filter((record): record is SessionRecord => Boolean(record)),
  ];
}

function analysisRecordKey(record: SessionRecord | RunRecord): string {
  if (record.type === "process_lifecycle") {
    const identity =
      record.identity && typeof record.identity === "object" && !Array.isArray(record.identity)
        ? record.identity
        : {};
    return `process_lifecycle:${identity.packetId || ""}:${identity.processId || ""}:${record.event || ""}:${record.at || ""}:${record.projectionIncomplete === true ? "incomplete" : ""}:${record.projectionInvalid === true ? `invalid-${record.invalidOrdinal || ""}` : ""}`;
  }
  return `${record.type || ""}:${record.segment ?? ""}:${record.run ?? ""}:${record.timestamp || ""}:${record.id || ""}`;
}

function emptySegmentSummary(): SegmentSummary {
  return {
    runCount: 0,
    acceptedRunCount: 0,
    measurementRunCount: 0,
    failedRunCount: 0,
    statusCounts: {},
    baselineRun: null,
    latestRun: null,
    latestFailure: null,
    accepted: { min: null, max: null },
    promotion: {
      min: null,
      max: null,
      count: 0,
      acceptedRunCount: 0,
      baselineRun: null,
      latestRun: null,
    },
  };
}

function updateSegmentSummary(summary: SegmentSummary, run: RunRecord): void {
  summary.runCount += 1;
  const status = String(run.status || "");
  summary.statusCounts[status] = (summary.statusCounts[status] || 0) + 1;
  if (status === "measure") summary.measurementRunCount += 1;
  if (["discard", "crash", "checks_failed"].includes(status)) {
    summary.failedRunCount += 1;
    summary.latestFailure = run;
  }
  if (!summary.baselineRun && isBaselineEligibleMetricRun(run)) summary.baselineRun = run;
  summary.latestRun = run;
  if (isAcceptedCurrentRun(run)) {
    summary.acceptedRunCount += 1;
    updateExtremes(summary.accepted, run);
  }
  if (isPromotionGradeRun(run)) {
    summary.promotion.count += 1;
    summary.promotion.latestRun = run;
    if (!summary.promotion.baselineRun && isBaselineEligibleMetricRun(run)) {
      summary.promotion.baselineRun = run;
    }
    if (isAcceptedCurrentRun(run)) {
      summary.promotion.acceptedRunCount += 1;
      updateExtremes(summary.promotion, run);
    }
  }
}

function updateExtremes(extremes: MetricExtremes, run: RunRecord): void {
  const metric = finiteMetric(run.metric);
  if (metric == null) return;
  if (finiteMetric(extremes.min?.metric) == null || metric < Number(extremes.min?.metric)) {
    extremes.min = run;
  }
  if (finiteMetric(extremes.max?.metric) == null || metric > Number(extremes.max?.metric)) {
    extremes.max = run;
  }
}

function extremeForDirection(extremes: MetricExtremes, direction: unknown): RunRecord | null {
  return direction === "higher" ? extremes.max : extremes.min;
}

function normalizedRun(record: SessionRecord, segment: number): RunRecord {
  const run: RunRecord = { ...record, segment: record.segment ?? segment };
  if (Object.hasOwn(record, "metric")) run.metric = finiteMetric(record.metric);
  return run;
}

function evidenceTrackSummary(summary: SegmentSummary, bestRun: RunRecord | null) {
  return {
    count: summary.runCount,
    kept: summary.acceptedRunCount,
    baseline: finiteMetric(summary.baselineRun?.metric),
    best: finiteMetric(bestRun?.metric),
    bestRun,
    latest: summary.latestRun,
  };
}

function promotionTrackSummary(summary: SegmentSummary, bestRun: RunRecord | null) {
  return {
    count: summary.promotion.count,
    kept: summary.promotion.acceptedRunCount,
    baseline: finiteMetric(summary.promotion.baselineRun?.metric),
    best: finiteMetric(bestRun?.metric),
    bestRun,
    latest: summary.promotion.latestRun,
  };
}

function defaultDashboardConfig(): Record<string, unknown> {
  return { name: null, goal: "", metricName: "metric", metricUnit: "", bestDirection: "lower" };
}

function dashboardConfigFromRecord(
  record: SessionRecord,
  previous: Record<string, unknown>,
): Record<string, unknown> {
  return {
    name: record.name || previous.name,
    goal: record.goal !== undefined ? String(record.goal || "").trim() : previous.goal,
    metricName: record.metricName || previous.metricName,
    metricUnit: record.metricUnit ?? previous.metricUnit,
    bestDirection: record.bestDirection === "higher" ? "higher" : "lower",
  };
}

function metricSemanticsChanged(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
): boolean {
  return (
    previous.metricName !== current.metricName ||
    previous.metricUnit !== current.metricUnit ||
    previous.bestDirection !== current.bestDirection
  );
}

function metricSemanticsChangeWarning(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
  segment: number,
): Record<string, unknown> {
  return {
    code: "metric_semantics_changed",
    severity: "warning",
    message:
      "Metric semantics changed; active segment and historical best may not be directly comparable.",
    previous: {
      metricName: previous.metricName,
      metricUnit: previous.metricUnit,
      bestDirection: previous.bestDirection,
    },
    current: {
      metricName: current.metricName,
      metricUnit: current.metricUnit,
      bestDirection: current.bestDirection,
    },
    segment,
  };
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
