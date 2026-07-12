import { STATUS_LABELS } from "../../constants";
import {
  breakdownForRun,
  chartPercentValue,
  formatChartPercentValue,
  formatCompactMetricTick,
  formatDisplayTime,
  formatMetric,
  formatMetricValue,
  improvementPercent,
} from "../../model";
import { formatAsiValue } from "../../model/asi";
import { sampleTimeline } from "../../model/timeline-sampling";
import type { ChartModel, DashboardReadout, RunMetricBreakdown } from "../../types";

export const VALUE_MODES = ["value", "percent"] as const;
export const AXIS_MODES = ["iteration", "timestamp"] as const;

export type ValueMode = "value" | "percent";
export type AxisMode = "iteration" | "timestamp";
export type SegmentedControlOption<T extends string> = readonly [T, string];
export type MetricConstructionItem = { label: string; value: string; detail: string; id: string };
export type TrendChartState = ReturnType<typeof buildTrendChartState>;

export const MOBILE_CHART_MAX_POINTS = 10;
export const DESKTOP_CHART_MAX_POINTS = 48;
const CHART_POINT_MIN_GAP = 56;

export const STATUS_COLORS: Record<string, string> = {
  keep: "#2BA8A2",
  discard: "#EF6C4A",
  crash: "#253936",
  checks_failed: "#7B5200",
};

export interface ChartDatum {
  runLabel: string;
  timestampLabel: string;
  timestampValue: number | null;
  runNumber: number;
  metric: number;
  chartPercent: number | null;
  rawMetric: number | null;
  metricDisplay: string;
  status: string;
  statusLabel: string;
  description: string;
  hypothesis: string;
  evidence: string;
  rollbackReason: string;
  nextActionHint: string;
  timestamp?: string | number;
  baseline: boolean;
  best: boolean;
  latest: boolean;
  heldMetric: boolean;
  breakdown: RunMetricBreakdown | null;
}

export function buildTrendChartState({
  axisMode,
  chart,
  chartData,
  readout,
  valueMode,
}: {
  axisMode: AxisMode;
  chart: ChartModel;
  chartData: ChartDatum[];
  readout: DashboardReadout;
  valueMode: ValueMode;
}) {
  const timestampTicks = buildTimestampTicks(chartData);
  const usesTimestampScale = axisMode === "timestamp" && timestampTicks.length >= 2;
  const yKey = valueMode === "percent" ? "chartPercent" : "metric";
  const xKey = usesTimestampScale
    ? "timestampValue"
    : axisMode === "timestamp"
      ? "timestampLabel"
      : "runLabel";
  const yDomain = valueMode === "percent" ? ["auto", "auto"] : chart.domain || ["auto", "auto"];
  return {
    baselineLine: chartBaselineLine(chart, readout, valueMode),
    bestLine: chartBestLine(chart, readout, valueMode),
    timestampTicks,
    usesTimestampScale,
    xKey,
    yDomain,
    yKey,
  };
}

export function buildChartData(chart: ChartModel, readout: DashboardReadout): ChartDatum[] {
  return chart.points.map((point) => {
    const breakdown = breakdownForRun(point.run, readout.metricDefinition);
    const chartPercent = chartPercentForMetric(point.chartMetric, readout);
    const metricDisplay = formatMetricValue(point.chartMetric, readout.metricDefinition);
    return {
      runLabel: `#${point.run.run}`,
      timestampLabel: formatDisplayTime(point.run.timestamp),
      timestampValue: toTimestampValue(point.run.timestamp),
      runNumber: point.run.run,
      metric: point.chartMetric,
      chartPercent,
      rawMetric: point.run.metric,
      metricDisplay: point.heldMetric ? `${metricDisplay} (held)` : metricDisplay,
      status: point.run.status,
      statusLabel: STATUS_LABELS[point.run.status] || point.run.status || "Run",
      description: point.run.description || "No description",
      hypothesis: formatAsiValue(point.run.asi?.hypothesis),
      evidence: formatAsiValue(point.run.asi?.evidence),
      rollbackReason:
        formatAsiValue(point.run.asi?.rollback_reason) ||
        formatAsiValue(point.run.asi?.rollbackReason),
      nextActionHint:
        formatAsiValue(point.run.asi?.next_action_hint) ||
        formatAsiValue(point.run.asi?.nextAction),
      timestamp: point.run.timestamp,
      baseline: readout.baselineRun?.run === point.run.run,
      best: point.best,
      latest: point.latest,
      heldMetric: point.heldMetric,
      breakdown,
    };
  });
}

export function chartPointBudget(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return MOBILE_CHART_MAX_POINTS;
  return Math.min(
    DESKTOP_CHART_MAX_POINTS,
    Math.max(MOBILE_CHART_MAX_POINTS, Math.floor(width / CHART_POINT_MIN_GAP)),
  );
}

export function sampleTrendChartData(
  chartData: ChartDatum[],
  maxItems: number,
  selectedRunNumber: number | null,
): ChartDatum[] {
  return sampleTimeline(chartData, {
    anchors: [
      chartData.find((point) => point.baseline),
      chartData.find((point) => point.best),
      chartData.find((point) => point.latest),
    ],
    key: (point) => point.runNumber,
    maxItems,
    selectedKey: selectedRunNumber,
    status: (point) => point.status,
  });
}

export function runEvidenceRows(point: ChartDatum | null): Array<[string, string]> {
  if (!point) return [];
  const rows: Array<[string, string]> = [
    ["Hypothesis", point.hypothesis],
    ["Evidence", point.evidence],
    ["Rollback", point.rollbackReason],
    ["Next", point.nextActionHint],
  ];
  return rows.filter(([, value]) => Boolean(value));
}

export function isFiniteNumber(value: unknown): value is number {
  return Number.isFinite(value);
}

export function formatChartAxisValue(
  value: number | null | undefined,
  valueMode: ValueMode,
  readout: DashboardReadout,
): string {
  if (valueMode === "percent") return formatChartPercentValue(value, readout.metricDefinition);
  return formatMetricValue(value, readout.metricDefinition);
}

export function formatChartAxisTickValue(
  value: number | null | undefined,
  valueMode: ValueMode,
  readout: DashboardReadout,
  domain: [number, number] | null,
): string {
  if (valueMode === "percent") return formatChartPercentValue(value, readout.metricDefinition);
  return formatCompactMetricTick(value, readout.metricDefinition.displayUnit, domain);
}

export function formatWeightedScoreValue(
  value: number | null | undefined,
  readout: DashboardReadout,
) {
  return formatMetricValue(value, {
    ...readout.metricDefinition,
    mode: "weighted_cost",
  });
}

export function formatMemoryValue(value: number | null | undefined): string {
  return formatMetric(value, " MB");
}

export function primaryMetricExpression(
  readout: DashboardReadout,
  breakdown?: RunMetricBreakdown,
): string {
  const value = formatMetricValue(breakdown?.metricValue ?? null, readout.metricDefinition);
  return `METRIC ${readout.metricDefinition.metricName}=${value}`;
}

function chartBaselineLine(chart: ChartModel, readout: DashboardReadout, valueMode: ValueMode) {
  if (valueMode !== "percent") return chart.baselineValue;
  return isWeightedMetric(readout) ? 100 : 0;
}

function chartBestLine(chart: ChartModel, readout: DashboardReadout, valueMode: ValueMode) {
  if (valueMode !== "percent") return chart.bestValue;
  return chartPercentForMetric(readout.best, readout);
}

function isWeightedMetric(readout: DashboardReadout): boolean {
  return readout.metricDefinition.mode === "weighted_cost";
}

function chartPercentForMetric(value: number | null, readout: DashboardReadout): number | null {
  if (isWeightedMetric(readout)) return chartPercentValue(value, readout.metricDefinition);
  return improvementPercent(readout.baseline, value, readout.metricDefinition.bestDirection);
}

function buildTimestampTicks(chartData: ChartDatum[]): number[] {
  const values = chartData
    .map((point) => point.timestampValue)
    .filter((value): value is number => Number.isFinite(value));
  if (values.length <= 6) return values;
  const lastIndex = values.length - 1;
  const ticks = Array.from({ length: 6 }, (_, index) => {
    const pointIndex = Math.round((index * lastIndex) / 5);
    return values[pointIndex];
  });
  return Array.from(new Set(ticks));
}

function toTimestampValue(value: string | number | undefined): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}
