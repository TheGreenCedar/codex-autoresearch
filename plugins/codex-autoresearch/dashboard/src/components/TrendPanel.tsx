import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  LabelList,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Activity } from "lucide-react";
import { STATUS_LABELS, STATUS_VALUES } from "../constants";
import {
  breakdownForRun,
  buildChart,
  chartPercentValue,
  formatChartPercentValue,
  formatDisplayTime,
  formatCompactMetricTick,
  formatImprovement,
  formatMetric,
  formatMetricValue,
  improvementPercent,
} from "../model";
import type { ChartModel, DashboardReadout, RunMetricBreakdown, SessionSegment } from "../types";
import { useUrlParam } from "../hooks/useUrlState";

const VALUE_MODES = ["value", "percent"] as const;
const AXIS_MODES = ["iteration", "timestamp"] as const;

const STATUS_COLORS: Record<string, string> = {
  keep: "#2BA8A2",
  discard: "#EF6C4A",
  crash: "#253936",
  checks_failed: "#FFD23F",
};

type ValueMode = "value" | "percent";
type AxisMode = "iteration" | "timestamp";
type ChartPointOpener = HTMLElement | SVGElement | null;
type MetricConstructionItem = { label: string; value: string; detail: string; id: string };
type SegmentedControlOption<T extends string> = readonly [T, string];

const FOCUSABLE_DIALOG_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

interface TrendPanelProps {
  session: SessionSegment;
  readout: DashboardReadout;
  detailsDefaultOpen?: boolean;
  chartHeight?: number;
}

interface ChartDatum {
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
  best: boolean;
  latest: boolean;
  heldMetric: boolean;
  label: string;
  breakdown: RunMetricBreakdown | null;
}

export function TrendPanel({
  session,
  readout,
  detailsDefaultOpen = true,
  chartHeight = 350,
}: TrendPanelProps) {
  const [valueModeParam, setValueMode] = useUrlParam("value", VALUE_MODES, "value");
  const [axisModeParam, setAxisMode] = useUrlParam("axis", AXIS_MODES, "iteration");
  const valueMode = valueModeParam as ValueMode;
  const axisMode = axisModeParam as AxisMode;
  const [selectedPoint, setSelectedPoint] = useState<ChartDatum | null>(null);
  const modalOpenerRef = useRef<ChartPointOpener>(null);
  const chart = useMemo(() => buildChart(session, readout), [readout, session]);
  const chartData = useMemo(() => buildChartData(chart, readout), [chart, readout]);
  const chartState = useMemo(
    () => buildTrendChartState({ axisMode, chart, chartData, readout, valueMode }),
    [axisMode, chart, chartData, readout, valueMode],
  );
  const detailPoint = selectedPoint || chartData.at(-1) || null;
  const { baselineLine, bestLine, timestampTicks, usesTimestampScale, xKey, yDomain, yKey } =
    chartState;
  const openPoint = (point: ChartDatum, opener: ChartPointOpener) => {
    modalOpenerRef.current = opener;
    setSelectedPoint(point);
  };
  const closePoint = () => {
    setSelectedPoint(null);
    window.setTimeout(() => modalOpenerRef.current?.focus(), 0);
  };
  return (
    <section
      className="panel trend-panel"
      id="trend-panel"
      aria-label="Metric trajectory"
      tabIndex={-1}
    >
      <div className="panel-head">
        <div>
          <p className="eyebrow">
            <Activity aria-hidden="true" size={14} />
            Metric trajectory
          </p>
          <h2>Run chart</h2>
        </div>
        <ChartControls
          axisMode={axisMode}
          metricDefinition={readout.metricDefinition}
          setAxisMode={setAxisMode}
          setValueMode={setValueMode}
          valueMode={valueMode}
        />
        <span id="chart-note" className="panel-note">
          {chart.note}
        </span>
      </div>

      <div className="chart-legend" aria-label="Status legend">
        {STATUS_VALUES.map((status) => (
          <span key={status}>
            <i className={`legend-swatch ${status}`} />
            {STATUS_LABELS[status]}
          </span>
        ))}
      </div>

      <figure
        id="trend-chart"
        className="chart-frame"
        role="img"
        aria-labelledby="trend-chart-title trend-chart-desc"
      >
        <figcaption id="trend-chart-title" className="sr-only">
          Baseline-normalized metric trend
        </figcaption>
        <p id="trend-chart-desc" className="sr-only">
          {chart.summary}
        </p>
        <ResponsiveContainer width="100%" height={chartHeight}>
          <ComposedChart data={chartData} margin={{ top: 18, right: 28, bottom: 8, left: 12 }}>
            <defs>
              <linearGradient id="trendAreaGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--graph)" stopOpacity={0.22} />
                <stop offset="95%" stopColor="var(--graph)" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="trendAreaGradientDark" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--graph)" stopOpacity={0.38} />
                <stop offset="95%" stopColor="var(--graph)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--line)" strokeDasharray="6 8" />
            <XAxis
              dataKey={xKey}
              type={usesTimestampScale ? "number" : "category"}
              scale={usesTimestampScale ? "time" : undefined}
              domain={usesTimestampScale ? ["dataMin", "dataMax"] : undefined}
              padding={usesTimestampScale ? { left: 20, right: 28 } : undefined}
              ticks={usesTimestampScale ? timestampTicks : undefined}
              tickFormatter={
                usesTimestampScale ? (value) => formatDisplayTime(Number(value)) : undefined
              }
              interval={usesTimestampScale ? 0 : "preserveStartEnd"}
              minTickGap={usesTimestampScale ? 32 : 8}
              tickMargin={10}
              tickLine={false}
              axisLine={false}
              tick={{ fill: "var(--muted)", fontSize: 12, fontWeight: 800 }}
            />
            <YAxis
              width={74}
              domain={yDomain}
              tickCount={5}
              tickFormatter={(value) =>
                formatChartAxisTickValue(Number(value), valueMode, readout, chart.domain)
              }
              tickMargin={8}
              tickLine={false}
              axisLine={false}
              tick={{ fill: "var(--muted)", fontSize: 12, fontWeight: 800 }}
            />
            {valueMode === "value" && chart.winZoneBounds && (
              <ReferenceArea
                className="win-zone"
                y1={chart.winZoneBounds.y1}
                y2={chart.winZoneBounds.y2}
                strokeOpacity={0}
              />
            )}
            {baselineLine != null && (
              <ReferenceLine
                className="baseline-line"
                y={baselineLine}
                stroke="var(--coral)"
                strokeDasharray="8 8"
                strokeWidth={2}
              />
            )}
            {bestLine != null && (
              <ReferenceLine
                className="best-line"
                y={bestLine}
                stroke="var(--amber-dark)"
                strokeDasharray="4 6"
                strokeWidth={3}
              />
            )}
            <Tooltip
              content={<ChartTooltip valueMode={valueMode} readout={readout} />}
              cursor={{ stroke: "var(--teal)", strokeWidth: 2, strokeDasharray: "4 6" }}
            />
            <Area
              className="trendArea"
              type="monotone"
              dataKey={yKey}
              fill="url(#trendAreaGradient)"
              stroke="none"
              isAnimationActive={false}
            />
            <Line
              className="linePath"
              type="monotone"
              dataKey={yKey}
              isAnimationActive={false}
              stroke="var(--graph)"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={5}
              dot={<ChartDot onSelect={openPoint} />}
              activeDot={<ChartActiveDot />}
            >
              <LabelList content={<ChartLabel valueMode={valueMode} readout={readout} />} />
            </Line>
          </ComposedChart>
        </ResponsiveContainer>
        <div className="chartRunTicks" aria-hidden="true">
          {chartData.map((item) => (
            <span key={`tick-${item.runNumber}`} />
          ))}
        </div>
        <div className="chart-point-labels" aria-hidden="true">
          {chartData.map((item) => (
            <span key={`label-${item.runNumber}`}>{item.label}</span>
          ))}
        </div>
      </figure>

      <p id="trend-chart-summary" className="sr-summary">
        {chart.summary}
      </p>
      <ChartDataList chartData={chartData} />

      {detailsDefaultOpen ? (
        <MetricDetails readout={readout} session={session} point={detailPoint} />
      ) : (
        <details className="metric-details-disclosure">
          <summary>How this metric is computed</summary>
          <MetricDetails readout={readout} session={session} point={detailPoint} />
        </details>
      )}

      {selectedPoint && (
        <ExperimentModal
          point={selectedPoint}
          valueMode={valueMode}
          readout={readout}
          onClose={closePoint}
        />
      )}
    </section>
  );
}

function ChartControls({
  axisMode,
  metricDefinition,
  setAxisMode,
  setValueMode,
  valueMode,
}: {
  axisMode: AxisMode;
  metricDefinition: DashboardReadout["metricDefinition"];
  setAxisMode: (value: AxisMode) => void;
  setValueMode: (value: ValueMode) => void;
  valueMode: ValueMode;
}) {
  return (
    <div className="chart-controls" aria-label="Chart display controls">
      <SegmentedControl
        label="Value"
        value={valueMode}
        options={[
          ["value", metricDefinition.valueLabel],
          ["percent", metricDefinition.percentLabel],
        ]}
        onChange={setValueMode}
      />
      <SegmentedControl
        label="X-axis"
        value={axisMode}
        options={[
          ["iteration", "Iteration"],
          ["timestamp", "Timestamp"],
        ]}
        onChange={setAxisMode}
      />
    </div>
  );
}

function ChartDataList({ chartData }: { chartData: ChartDatum[] }) {
  return (
    <ul className="chart-data-list sr-only" aria-label="Chart data points">
      {chartData.map((item) => (
        <li key={`data-${item.runNumber}`}>
          {item.runLabel}: {item.statusLabel}, {item.metricDisplay}, {item.description}
          {item.heldMetric ? ", crash held at nearest successful metric" : ""}
          {item.best ? ", best kept" : ""}
          {item.latest ? ", latest" : ""}
        </li>
      ))}
    </ul>
  );
}

function MetricConstruction({
  readout,
  session,
}: {
  readout: DashboardReadout;
  session: SessionSegment;
}) {
  const items = metricConstructionItems(readout, session);
  const status = metricConstructionStatus(readout);
  return (
    <section
      className="metric-construction"
      id="metric-construction"
      aria-label="Metric construction"
    >
      <div className="metric-construction-head">
        <span>Metric construction</span>
        <strong id="metric-construction-status">{status}</strong>
      </div>
      <dl className="metric-construction-grid">
        {items.map((item) => (
          <div className="metric-construction-card" key={item.id}>
            <dt>{item.label}</dt>
            <dd id={item.id}>
              <strong>{item.value}</strong>
              <small>{item.detail}</small>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function metricConstructionStatus(readout: DashboardReadout): string {
  if (readout.metricDefinition.mode === "weighted_cost") return "Weighted formula";
  return readout.metricDefinition.formulaConfigured ? "Configured formula" : "Formula missing";
}

function metricConstructionItems(
  readout: DashboardReadout,
  session: SessionSegment,
): MetricConstructionItem[] {
  const definition = readout.metricDefinition;
  const metricName = definition.metricName;
  const secondaryKeys = secondaryMetricKeysForSession(session, metricName);
  if (definition.mode === "weighted_cost") {
    return [
      {
        id: "metric-construction-formula",
        label: "Formula",
        value: definition.formulaInline,
        detail: `time_score = primary metric / baseline; memory_score = ${definition.memoryKey} / baseline.`,
      },
      {
        id: "metric-construction-components",
        label: "Components",
        value: `primary metric + ${definition.memoryKey}`,
        detail: `Weights are normalized to time ${definition.weights.time} and memory ${definition.weights.memory}.`,
      },
      {
        id: "metric-construction-direction",
        label: "Decision rule",
        value: directionLabel(definition.bestDirection),
        detail: "Lower weighted score means the combined time and memory cost improved.",
      },
    ];
  }
  return [
    {
      id: "metric-construction-formula",
      label: definition.formulaConfigured ? "Formula" : "Formula status",
      value: definition.formulaConfigured ? definition.formulaInline : "Formula not configured",
      detail: definition.formulaConfigured
        ? `Source: ${definition.formulaSource}.`
        : `Chart reads the benchmark's primary output only: METRIC ${metricName}=<number>.`,
    },
    {
      id: "metric-construction-inputs",
      label: "Inputs detected",
      value: secondaryKeys.length
        ? `primary: ${metricName}; secondary: ${secondaryKeys.join(", ")}`
        : `primary: ${metricName}`,
      detail: secondaryKeys.length
        ? "Secondary metrics are evidence only unless the configured formula references them."
        : "No secondary METRIC fields were logged in this segment.",
    },
    {
      id: "metric-construction-direction",
      label: "Decision rule",
      value: directionLabel(definition.bestDirection),
      detail: "Autoresearch compares finite primary values inside the selected segment.",
    },
  ];
}

function secondaryMetricKeysForSession(session: SessionSegment, metricName: string): string[] {
  const keys = new Set<string>();
  for (const run of session.runs) {
    for (const [key, value] of Object.entries(run.metrics || {})) {
      if (key !== metricName && isFiniteNumber(value)) keys.add(key);
    }
  }
  return Array.from(keys).sort();
}

function directionLabel(direction: string): string {
  return direction === "higher" ? "Higher is better" : "Lower is better";
}

function buildTrendChartState({
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

function chartBaselineLine(chart: ChartModel, readout: DashboardReadout, valueMode: ValueMode) {
  if (valueMode !== "percent") return chart.baselineValue;
  return isWeightedMetric(readout) ? 100 : 0;
}

function chartBestLine(chart: ChartModel, readout: DashboardReadout, valueMode: ValueMode) {
  if (valueMode !== "percent") return chart.bestValue;
  return chartPercentForMetric(readout.best, readout);
}

function buildChartData(chart: ChartModel, readout: DashboardReadout): ChartDatum[] {
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
      hypothesis: String(point.run.asi?.hypothesis || ""),
      evidence: String(point.run.asi?.evidence || ""),
      rollbackReason: String(point.run.asi?.rollback_reason || point.run.asi?.rollbackReason || ""),
      nextActionHint: String(point.run.asi?.next_action_hint || point.run.asi?.nextAction || ""),
      timestamp: point.run.timestamp,
      best: point.best,
      latest: point.latest,
      heldMetric: point.heldMetric,
      label: `#${point.run.run} ${metricDisplay} ${point.run.status}`,
      breakdown,
    };
  });
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

function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: SegmentedControlOption<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented-control">
      <span>{label}</span>
      <div role="group" aria-label={label}>
        {options.map(([id, text]) => (
          <button
            key={id}
            type="button"
            className={value === id ? "active" : ""}
            aria-pressed={value === id}
            onClick={() => onChange(id)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

function isFiniteNumber(value: unknown): value is number {
  return Number.isFinite(value);
}

function ChartDot({
  cx,
  cy,
  payload,
  onSelect,
}: {
  cx?: number;
  cy?: number;
  payload?: ChartDatum;
  onSelect?: (payload: ChartDatum, opener: ChartPointOpener) => void;
}) {
  const x = Number(cx);
  const y = Number(cy);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !payload) return null;
  const targetSize = payload.latest ? 30 : 24;
  return (
    <foreignObject
      className="chart-point-wrap"
      x={x - targetSize / 2}
      y={y - targetSize / 2}
      width={targetSize}
      height={targetSize}
    >
      <button
        type="button"
        className="chart-point-button"
        aria-haspopup="dialog"
        aria-label={`Open details for run ${payload.runNumber}`}
        onClick={(event) => onSelect?.(payload, event.currentTarget)}
      >
        {payload.latest && <span className="latest-halo-ui" aria-hidden="true" />}
        <span
          className={`chart-point-dot ${payload.status}${payload.best ? " best" : ""}`}
          aria-hidden="true"
        />
      </button>
    </foreignObject>
  );
}

function ChartActiveDot({ cx, cy, payload }: { cx?: number; cy?: number; payload?: ChartDatum }) {
  if (!isFiniteNumber(cx) || !isFiniteNumber(cy) || !payload) return null;
  const color = STATUS_COLORS[payload.status] || STATUS_COLORS.keep;
  return (
    <circle
      className={`chart-point active ${payload.status}`}
      cx={cx}
      cy={cy}
      r="10"
      fill={color}
    />
  );
}

function ChartLabel({
  x,
  y,
  value,
  payload,
  valueMode,
  readout,
}: {
  x?: number;
  y?: number;
  value?: number;
  payload?: ChartDatum;
  valueMode: ValueMode;
  readout: DashboardReadout;
}) {
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !payload?.latest) return null;
  return (
    <text className="chart-value-label" x={x} y={y - 18} textAnchor="middle">
      {formatChartAxisValue(value ?? null, valueMode, readout)}
    </text>
  );
}

function ChartTooltip({
  active,
  payload,
  valueMode,
  readout,
}: {
  active?: boolean;
  payload?: Array<{ value?: number; payload?: ChartDatum }>;
  valueMode: ValueMode;
  readout: DashboardReadout;
}) {
  const item = payload?.[0]?.payload;
  if (!active || !item) return null;
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-header">
        <span>{item.runLabel}</span>
        <span className={`chart-tooltip-status ${item.status}`}>{item.statusLabel}</span>
      </div>
      <strong>{formatChartAxisValue(payload?.[0]?.value ?? null, valueMode, readout)}</strong>
      <p>{item.description}</p>

      {(item.hypothesis || item.evidence || item.nextActionHint) && (
        <div className="chart-tooltip-asi">
          {item.hypothesis && (
            <div className="chart-tooltip-asi-item">
              <b>Hypothesis</b>
              {item.hypothesis}
            </div>
          )}
          {item.evidence && (
            <div className="chart-tooltip-asi-item">
              <b>Evidence</b>
              {item.evidence}
            </div>
          )}
          {item.nextActionHint && (
            <div className="chart-tooltip-asi-item">
              <b>Next Action</b>
              {item.nextActionHint}
            </div>
          )}
        </div>
      )}
      {item.heldMetric && (
        <p style={{ marginTop: "4px", fontSize: "10px", fontStyle: "italic" }}>
          Plotted at nearest successful metric level
        </p>
      )}
    </div>
  );
}

function ExperimentModal({
  point,
  valueMode,
  readout,
  onClose,
}: {
  point: ChartDatum;
  valueMode: ValueMode;
  readout: DashboardReadout;
  onClose: () => void;
}) {
  const breakdown = point.breakdown;
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  const onDialogKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = getFocusableDialogElements(dialogRef.current);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="experiment-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="experiment-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onDialogKeyDown}
      >
        <button
          ref={closeRef}
          className="modal-close"
          type="button"
          aria-label="Close experiment details"
          onClick={onClose}
        >
          {"\u00d7"}
        </button>
        <p className="eyebrow">
          {point.statusLabel} / {point.timestampLabel || "no timestamp"}
        </p>
        <h2 id="experiment-modal-title">Run #{point.runNumber}</h2>
        <div className="experiment-metrics">
          <div>
            <span>{readout.metricDefinition.valueLabel}</span>
            <strong>{point.metricDisplay}</strong>
          </div>
          <div>
            <span>Improvement</span>
            <strong>{formatImprovement(breakdown?.improvement ?? null)}</strong>
          </div>
          <div>
            <span>{readout.metricDefinition.percentLabel}</span>
            <strong>
              {formatChartAxisValue(
                valueMode === "percent" ? point.chartPercent : point.metric,
                valueMode,
                readout,
              )}
            </strong>
          </div>
        </div>
        <dl className="experiment-detail-list">
          <div>
            <dt>Experiment</dt>
            <dd>{point.description}</dd>
          </div>
          {point.heldMetric && (
            <div>
              <dt>Chart placement</dt>
              <dd>Crash plotted at the nearest successful metric level.</dd>
            </div>
          )}
          {point.hypothesis && (
            <div>
              <dt>What was tried</dt>
              <dd>{point.hypothesis}</dd>
            </div>
          )}
          {point.evidence && (
            <div>
              <dt>Evidence</dt>
              <dd>{point.evidence}</dd>
            </div>
          )}
          <WeightedExperimentMetrics readout={readout} breakdown={breakdown} />
          {point.rollbackReason && (
            <div>
              <dt>Rollback reason</dt>
              <dd>{point.rollbackReason}</dd>
            </div>
          )}
          {point.nextActionHint && (
            <div>
              <dt>Next action</dt>
              <dd>{point.nextActionHint}</dd>
            </div>
          )}
        </dl>
      </section>
    </div>
  );
}

function getFocusableDialogElements(dialog: HTMLElement | null): HTMLElement[] {
  return Array.from(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE_DIALOG_SELECTOR) || []).filter(
    (item) => !item.hasAttribute("disabled") && !item.getAttribute("aria-hidden"),
  );
}

function WeightedExperimentMetrics({
  readout,
  breakdown,
}: {
  readout: DashboardReadout;
  breakdown: RunMetricBreakdown | null;
}) {
  if (!breakdown || readout.metricDefinition.mode !== "weighted_cost") return null;
  return (
    <>
      <div>
        <dt>Time</dt>
        <dd>
          {formatMetric(breakdown.timeValue, "s")} / score{" "}
          {formatWeightedScoreValue(breakdown.timeScore, readout)}
        </dd>
      </div>
      <div>
        <dt>Memory</dt>
        <dd>
          {formatMemoryValue(breakdown.memoryValue)} / score{" "}
          {formatWeightedScoreValue(breakdown.memoryScore, readout)}
        </dd>
      </div>
    </>
  );
}

function MetricDetails({
  readout,
  session,
  point,
}: {
  readout: DashboardReadout;
  session: SessionSegment;
  point: ChartDatum | null;
}) {
  const breakdown = point?.breakdown || undefined;
  return (
    <section className="metric-details-panel" id="metric-details" aria-label="Metric details">
      <div className="metric-details-summary">
        <span className="metric-details-summary-copy">
          <span className="eyebrow">Metric details</span>
          <strong id="metric-details-title">
            {readout.metricDefinition.mode === "weighted_cost"
              ? "Selected score evidence"
              : "Selected run evidence"}
          </strong>
        </span>
        <span className="panel-note" id="metric-details-selected">
          {point ? `Run #${point.runNumber} / ${point.statusLabel}` : "No run selected"}
        </span>
      </div>
      <div className="metric-details-body">
        <p className="metric-details-copy" id="metric-details-copy">
          {metricDetailsCopy(readout, point)}
        </p>
        <MetricConstruction readout={readout} session={session} />
        {readout.metricDefinition.fallbackNote && (
          <p className="form-error metric-fallback-note" id="metric-fallback-note">
            {readout.metricDefinition.fallbackNote}
          </p>
        )}
        <MetricEvidenceList readout={readout} point={point} breakdown={breakdown} />
        <MetricBreakdownList readout={readout} breakdown={breakdown} />
      </div>
    </section>
  );
}

function metricDetailsCopy(readout: DashboardReadout, point: ChartDatum | null) {
  const selected = point ? `Selected run #${point.runNumber} is ${point.statusLabel}. ` : "";
  if (
    !readout.metricDefinition.formulaConfigured &&
    readout.metricDefinition.mode !== "weighted_cost"
  ) {
    return `${selected}No configured formula explains how ${readout.metricDefinition.metricName} is calculated; this view can only show the primary benchmark output and the secondary metrics that were logged beside it.`;
  }
  return `${selected}Benchmark output and supporting evidence for the plotted point.`;
}

function MetricBreakdownList({
  readout,
  breakdown,
}: {
  readout: DashboardReadout;
  breakdown?: RunMetricBreakdown;
}) {
  if (readout.metricDefinition.mode === "weighted_cost") {
    return <WeightedMetricBreakdownList readout={readout} breakdown={breakdown} />;
  }
  return <PrimaryMetricBreakdownList readout={readout} breakdown={breakdown} />;
}

function MetricEvidenceList({
  readout,
  point,
  breakdown,
}: {
  readout: DashboardReadout;
  point: ChartDatum | null;
  breakdown?: RunMetricBreakdown;
}) {
  const secondary = secondaryMetricEntries(point, readout);
  const warnings = metricEvidenceWarnings(readout, point, secondary);
  return (
    <dl className="metric-evidence-list">
      <div>
        <dt>Benchmark output</dt>
        <dd id="metric-detail-primary-value">{primaryMetricExpression(readout, breakdown)}</dd>
      </div>
      <div>
        <dt>Selected run</dt>
        <dd>{point ? `Run #${point.runNumber} / ${point.statusLabel}` : "No run selected"}</dd>
      </div>
      <div>
        <dt>Secondary output</dt>
        <dd id="metric-detail-secondary">
          {secondary.length
            ? secondary.map(([key, value]) => `${key} = ${formatMetric(value, "")}`).join(", ")
            : "No secondary metrics"}
        </dd>
      </div>
      {point?.hypothesis && (
        <div>
          <dt>Hypothesis</dt>
          <dd>{point.hypothesis}</dd>
        </div>
      )}
      {point?.evidence && (
        <div>
          <dt>Evidence</dt>
          <dd>{point.evidence}</dd>
        </div>
      )}
      {point?.rollbackReason && (
        <div>
          <dt>Rollback</dt>
          <dd>{point.rollbackReason}</dd>
        </div>
      )}
      {point?.nextActionHint && (
        <div>
          <dt>Next action</dt>
          <dd>{point.nextActionHint}</dd>
        </div>
      )}
      {warnings.length ? (
        <div>
          <dt>Warnings</dt>
          <dd id="metric-detail-warnings">{warnings.join(" ")}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function primaryMetricExpression(
  readout: DashboardReadout,
  breakdown?: RunMetricBreakdown,
): string {
  const value = formatMetricValue(breakdown?.metricValue ?? null, readout.metricDefinition);
  return `METRIC ${readout.metricDefinition.metricName}=${value}`;
}

function secondaryMetricEntries(
  point: ChartDatum | null,
  readout: DashboardReadout,
): Array<[string, number]> {
  if (!point?.breakdown?.run.metrics) return [];
  return Object.entries(point.breakdown.run.metrics)
    .filter(([key, value]) => key !== readout.metricDefinition.metricName && isFiniteNumber(value))
    .map(([key, value]) => [key, Number(value)]);
}

function metricEvidenceWarnings(
  readout: DashboardReadout,
  point: ChartDatum | null,
  secondary: Array<[string, number]>,
) {
  return [
    readout.metricDefinition.formulaConfigured
      ? ""
      : `No configured formula explains how ${readout.metricDefinition.metricName} is calculated.`,
    readout.baselineRun ? "" : "No baseline run.",
    secondary.length ? "" : "No secondary metrics.",
    point?.heldMetric ? "Chart value is held at nearest successful metric." : "",
  ].filter(Boolean);
}

function WeightedMetricBreakdownList({
  readout,
  breakdown,
}: {
  readout: DashboardReadout;
  breakdown?: RunMetricBreakdown;
}) {
  const timeScore = formatWeightedScoreValue(breakdown?.timeScore ?? null, readout);
  const memoryScore = formatWeightedScoreValue(breakdown?.memoryScore ?? null, readout);
  return (
    <dl className="metric-detail-list">
      <div>
        <dt>Time component</dt>
        <dd id="metric-detail-time">
          {formatMetric(breakdown?.timeValue ?? null, "s")} /{" "}
          {formatMetric(readout.metricDefinition.baselineTime, "s")} = {timeScore}
        </dd>
      </div>
      <div>
        <dt>Memory component</dt>
        <dd id="metric-detail-memory">
          {formatMemoryValue(breakdown?.memoryValue ?? null)} /{" "}
          {formatMemoryValue(readout.metricDefinition.baselineMemory)} = {memoryScore}
        </dd>
      </div>
      <div>
        <dt>Weighted score</dt>
        <dd id="metric-detail-equation">
          (0.7 * {timeScore}) + (0.3 * {memoryScore}) ={" "}
          {formatMetricValue(breakdown?.metricValue ?? null, readout.metricDefinition)}
        </dd>
      </div>
    </dl>
  );
}

function PrimaryMetricBreakdownList({
  readout,
  breakdown,
}: {
  readout: DashboardReadout;
  breakdown?: RunMetricBreakdown;
}) {
  return (
    <dl className="metric-detail-list">
      <div>
        <dt>Plotted expression</dt>
        <dd id="metric-detail-primary">{primaryMetricExpression(readout, breakdown)}</dd>
      </div>
      <div>
        <dt>Formula source</dt>
        <dd id="metric-detail-formula-source">{readout.metricDefinition.formulaSource}</dd>
      </div>
      <div>
        <dt>Formula detail</dt>
        <dd id="metric-detail-formula">{readout.metricDefinition.formulaDetails}</dd>
      </div>
    </dl>
  );
}

function formatChartAxisValue(
  value: number | null | undefined,
  valueMode: ValueMode,
  readout: DashboardReadout,
): string {
  if (valueMode === "percent") return formatChartPercentValue(value, readout.metricDefinition);
  return formatMetricValue(value, readout.metricDefinition);
}

function formatChartAxisTickValue(
  value: number | null | undefined,
  valueMode: ValueMode,
  readout: DashboardReadout,
  domain: [number, number] | null,
): string {
  if (valueMode === "percent") return formatChartPercentValue(value, readout.metricDefinition);
  return formatCompactMetricTick(value, readout.metricDefinition.displayUnit, domain);
}

function formatWeightedScoreValue(value: number | null | undefined, readout: DashboardReadout) {
  return formatMetricValue(value, {
    ...readout.metricDefinition,
    mode: "weighted_cost",
  });
}

function formatMemoryValue(value: number | null | undefined): string {
  return formatMetric(value, " MB");
}
