import { useMemo, useState } from "react";
import {
  CartesianGrid,
  LabelList,
  Line,
  LineChart,
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
  formatImprovement,
  formatMetric,
  formatMetricValue,
  formatPercentOfBaseline,
  improvementPercent,
} from "../model";
import type { ChartModel, DashboardReadout, RunMetricBreakdown, SessionSegment } from "../types";

const STATUS_COLORS: Record<string, string> = {
  keep: "#2BA8A2",
  discard: "#EF6C4A",
  crash: "#253936",
  checks_failed: "#FFD23F",
};

type ValueMode = "value" | "percent";
type AxisMode = "iteration" | "timestamp";

interface TrendPanelProps {
  session: SessionSegment;
  readout: DashboardReadout;
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
  timestamp?: string;
  best: boolean;
  latest: boolean;
  heldMetric: boolean;
  label: string;
  breakdown: RunMetricBreakdown | null;
}

export function TrendPanel({ session, readout }: TrendPanelProps) {
  const [valueMode, setValueMode] = useState<ValueMode>("value");
  const [axisMode, setAxisMode] = useState<AxisMode>("iteration");
  const [selectedPoint, setSelectedPoint] = useState<ChartDatum | null>(null);
  const chart = useMemo(() => buildChart(session, readout), [readout, session]);
  const chartData = useMemo(() => buildChartData(chart, readout), [chart, readout]);
  const timestampTicks = useMemo(() => buildTimestampTicks(chartData), [chartData]);
  const usesTimestampScale = axisMode === "timestamp" && timestampTicks.length >= 2;
  const yKey = valueMode === "percent" ? "chartPercent" : "metric";
  const xKey = usesTimestampScale
    ? "timestampValue"
    : axisMode === "timestamp"
      ? "timestampLabel"
      : "runLabel";
  const yDomain = valueMode === "percent" ? ["auto", "auto"] : chart.domain || ["auto", "auto"];
  const baselineLine =
    valueMode === "percent"
      ? readout.metricDefinition.mode === "weighted_cost"
        ? 100
        : 0
      : chart.baselineValue;
  const bestLine =
    valueMode === "percent"
      ? readout.metricDefinition.mode === "weighted_cost"
        ? chartPercentValue(readout.best, readout.metricDefinition)
        : improvementPercent(readout.baseline, readout.best, readout.metricDefinition.bestDirection)
      : chart.bestValue;
  const detailPoint = selectedPoint || chartData.at(-1) || null;
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
        <div className="chart-controls" aria-label="Chart display controls">
          <SegmentedControl
            label="Value"
            value={valueMode}
            options={[
              ["value", readout.metricDefinition.valueLabel],
              ["percent", readout.metricDefinition.percentLabel],
            ]}
            onChange={(nextValue) => setValueMode(nextValue as ValueMode)}
          />
          <SegmentedControl
            label="X-axis"
            value={axisMode}
            options={[
              ["iteration", "Iteration"],
              ["timestamp", "Timestamp"],
            ]}
            onChange={(nextValue) => setAxisMode(nextValue as AxisMode)}
          />
        </div>
        <span id="chart-note" className="panel-note">
          {chart.note}
        </span>
      </div>

      <div className="metric-summary-row">
        <p className="metric-formula" id="metric-formula">
          <strong>Metric formula</strong>
          <span>{readout.metricDefinition.formulaInline}</span>
        </p>
        <div className="chart-legend" aria-label="Status legend">
          {STATUS_VALUES.map((status) => (
            <span key={status}>
              <i className={`legend-swatch ${status}`} />
              {STATUS_LABELS[status]}
            </span>
          ))}
        </div>
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
        <ResponsiveContainer width="100%" height={350}>
          <LineChart data={chartData} margin={{ top: 18, right: 32, bottom: 8, left: 8 }}>
            <CartesianGrid vertical={false} stroke="#A8D8D4" strokeDasharray="6 8" />
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
              tick={{ fill: "#1E8C86", fontSize: 12, fontWeight: 800 }}
            />
            <YAxis
              width={58}
              domain={yDomain}
              tickFormatter={(value) => formatChartAxisValue(Number(value), valueMode, readout)}
              tickLine={false}
              axisLine={false}
              tick={{ fill: "#1E8C86", fontSize: 12, fontWeight: 800 }}
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
                stroke="#D45233"
                strokeDasharray="8 8"
                strokeWidth={2}
              />
            )}
            {bestLine != null && (
              <ReferenceLine
                className="best-line"
                y={bestLine}
                stroke="#FFD23F"
                strokeDasharray="4 6"
                strokeWidth={3}
              />
            )}
            <Tooltip
              content={<ChartTooltip valueMode={valueMode} readout={readout} />}
              cursor={{ stroke: "#3CC4BD", strokeWidth: 2, strokeDasharray: "4 6" }}
            />
            <Line
              className="linePath"
              type="monotone"
              dataKey={yKey}
              isAnimationActive={false}
              stroke="#1E8C86"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={5}
              dot={<ChartDot onSelect={setSelectedPoint} />}
              activeDot={<ChartActiveDot />}
            >
              <LabelList content={<ChartLabel valueMode={valueMode} readout={readout} />} />
            </Line>
          </LineChart>
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

      <MetricDetails readout={readout} point={detailPoint} />

      {selectedPoint && (
        <ExperimentModal
          point={selectedPoint}
          valueMode={valueMode}
          readout={readout}
          onClose={() => setSelectedPoint(null)}
        />
      )}
    </section>
  );
}

function buildChartData(chart: ChartModel, readout: DashboardReadout): ChartDatum[] {
  return chart.points.map((point) => {
    const breakdown = breakdownForRun(point.run, readout.metricDefinition);
    const chartPercent =
      readout.metricDefinition.mode === "weighted_cost"
        ? chartPercentValue(point.chartMetric, readout.metricDefinition)
        : improvementPercent(
            readout.baseline,
            point.chartMetric,
            readout.metricDefinition.bestDirection,
          );
    return {
      runLabel: `#${point.run.run}`,
      timestampLabel: formatDisplayTime(point.run.timestamp),
      timestampValue: toTimestampValue(point.run.timestamp),
      runNumber: point.run.run,
      metric: point.chartMetric,
      chartPercent,
      rawMetric: point.run.metric,
      metricDisplay: point.heldMetric
        ? `${formatMetricValue(point.chartMetric, readout.metricDefinition)} (held)`
        : formatMetricValue(point.chartMetric, readout.metricDefinition),
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
      label: `#${point.run.run} ${formatMetricValue(point.chartMetric, readout.metricDefinition)} ${point.run.status}`,
      breakdown,
    };
  });
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

function toTimestampValue(value: string | undefined): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function SegmentedControl({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
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

function ChartDot({
  cx,
  cy,
  payload,
  onSelect,
}: {
  cx?: number;
  cy?: number;
  payload?: ChartDatum;
  onSelect?: (payload: ChartDatum) => void;
}) {
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !payload) return null;
  const color = STATUS_COLORS[payload.status] || STATUS_COLORS.keep;
  return (
    <g
      className="chart-point-wrap"
      tabIndex={0}
      focusable="true"
      aria-label={`Open details for run ${payload.runNumber}`}
      onClick={() => onSelect?.(payload)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect?.(payload);
        }
      }}
    >
      <title>{`Open details for run ${payload.runNumber}`}</title>
      {payload.latest && <circle className="latest-halo" cx={cx} cy={cy} r="15" />}
      <circle
        className={`chart-point ${payload.status}`}
        cx={cx}
        cy={cy}
        r={payload.best ? 8 : 6}
        fill={color}
      />
    </g>
  );
}

function ChartActiveDot({ cx, cy, payload }: { cx?: number; cy?: number; payload?: ChartDatum }) {
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !payload) return null;
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
  if (!Number.isFinite(x) || !Number.isFinite(y) || !payload?.latest) return null;
  return (
    <text className="chart-value-label" x={x} y={(y as number) - 18} textAnchor="middle">
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
      <span>
        {item.runLabel} / {item.statusLabel}
      </span>
      <strong>{formatChartAxisValue(payload?.[0]?.value ?? null, valueMode, readout)}</strong>
      <p>{item.description}</p>
      {item.heldMetric && (
        <p>
          <b>Chart placement:</b> held at nearest successful metric level.
        </p>
      )}
      {item.hypothesis && (
        <p>
          <b>Tried:</b> {item.hypothesis}
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
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="experiment-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="experiment-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          className="modal-close"
          type="button"
          aria-label="Close experiment details"
          onClick={onClose}
        >
          x
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
          {breakdown && (
            <>
              <div>
                <dt>Time</dt>
                <dd>
                  {formatMetric(breakdown.timeValue, "s")} / score{" "}
                  {formatMetricValue(breakdown.timeScore, {
                    ...readout.metricDefinition,
                    mode: "weighted_cost",
                  })}
                </dd>
              </div>
              <div>
                <dt>Memory</dt>
                <dd>
                  {formatMemoryValue(breakdown.memoryValue)} / score{" "}
                  {formatMetricValue(breakdown.memoryScore, {
                    ...readout.metricDefinition,
                    mode: "weighted_cost",
                  })}
                </dd>
              </div>
            </>
          )}
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

function MetricDetails({
  readout,
  point,
}: {
  readout: DashboardReadout;
  point: ChartDatum | null;
}) {
  const breakdown = point?.breakdown;
  return (
    <section className="metric-details-panel" id="metric-details" aria-label="Metric details">
      <div className="panel-head panel-head-tight">
        <div>
          <p className="eyebrow">Metric details</p>
          <h3 id="metric-details-title">
            {readout.metricDefinition.mode === "weighted_cost"
              ? "Weighted score breakdown"
              : "Primary metric breakdown"}
          </h3>
        </div>
        <span className="panel-note" id="metric-details-selected">
          {point ? `Run #${point.runNumber} / ${point.statusLabel}` : "No run selected"}
        </span>
      </div>
      <p className="metric-details-copy" id="metric-details-copy">
        {readout.metricDefinition.formulaDetails}
      </p>
      {readout.metricDefinition.fallbackNote && (
        <p className="form-error metric-fallback-note" id="metric-fallback-note">
          {readout.metricDefinition.fallbackNote}
        </p>
      )}
      <div className="metric-details-grid">
        <div className="metric-detail-card">
          <span>Baseline time</span>
          <strong id="metric-detail-baseline-time">
            {formatMetric(readout.metricDefinition.baselineTime, "s")}
          </strong>
        </div>
        <div className="metric-detail-card">
          <span>Baseline memory</span>
          <strong id="metric-detail-baseline-memory">
            {formatMemoryValue(readout.metricDefinition.baselineMemory)}
          </strong>
        </div>
        <div className="metric-detail-card">
          <span>{readout.metricDefinition.valueLabel}</span>
          <strong id="metric-detail-score">
            {formatMetricValue(breakdown?.metricValue ?? null, readout.metricDefinition)}
          </strong>
        </div>
        <div className="metric-detail-card">
          <span>{readout.metricDefinition.percentLabel}</span>
          <strong id="metric-detail-percent">
            {readout.metricDefinition.mode === "weighted_cost"
              ? formatPercentOfBaseline(breakdown?.chartPercentValue ?? null)
              : formatImprovement(breakdown?.improvement ?? null)}
          </strong>
        </div>
      </div>
      {readout.metricDefinition.mode === "weighted_cost" ? (
        <dl className="metric-detail-list">
          <div>
            <dt>Time component</dt>
            <dd id="metric-detail-time">
              {formatMetric(breakdown?.timeValue ?? null, "s")} /{" "}
              {formatMetric(readout.metricDefinition.baselineTime, "s")} ={" "}
              {formatMetricValue(breakdown?.timeScore ?? null, {
                ...readout.metricDefinition,
                mode: "weighted_cost",
              })}
            </dd>
          </div>
          <div>
            <dt>Memory component</dt>
            <dd id="metric-detail-memory">
              {formatMemoryValue(breakdown?.memoryValue ?? null)} /{" "}
              {formatMemoryValue(readout.metricDefinition.baselineMemory)} ={" "}
              {formatMetricValue(breakdown?.memoryScore ?? null, {
                ...readout.metricDefinition,
                mode: "weighted_cost",
              })}
            </dd>
          </div>
          <div>
            <dt>Weighted score</dt>
            <dd id="metric-detail-equation">
              (0.7 *{" "}
              {formatMetricValue(breakdown?.timeScore ?? null, {
                ...readout.metricDefinition,
                mode: "weighted_cost",
              })}
              ) + (0.3 *{" "}
              {formatMetricValue(breakdown?.memoryScore ?? null, {
                ...readout.metricDefinition,
                mode: "weighted_cost",
              })}
              ) = {formatMetricValue(breakdown?.metricValue ?? null, readout.metricDefinition)}
            </dd>
          </div>
        </dl>
      ) : (
        <dl className="metric-detail-list">
          <div>
            <dt>Primary metric</dt>
            <dd id="metric-detail-primary">
              {formatMetricValue(breakdown?.metricValue ?? null, readout.metricDefinition)}
            </dd>
          </div>
          <div>
            <dt>Improvement</dt>
            <dd id="metric-detail-improvement">
              {formatImprovement(breakdown?.improvement ?? null)}
            </dd>
          </div>
        </dl>
      )}
    </section>
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

function formatMemoryValue(value: number | null | undefined): string {
  return formatMetric(value, " MB");
}
