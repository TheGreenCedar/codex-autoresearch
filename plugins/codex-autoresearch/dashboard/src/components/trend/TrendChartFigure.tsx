import { useEffect, useState } from "react";
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
import { STATUS_LABELS, STATUS_VALUES } from "../../constants";
import { formatDisplayTime } from "../../model";
import type { ChartModel, DashboardReadout } from "../../types";
import { chartPointAriaLabel, type ChartPointOpener } from "./focus";
import {
  formatChartAxisTickValue,
  formatChartAxisValue,
  isFiniteNumber,
  runEvidenceRows,
  STATUS_COLORS,
  type AxisMode,
  type ChartDatum,
  type SegmentedControlOption,
  type TrendChartState,
  type ValueMode,
} from "./shared";

export function ChartControls({
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

export function StatusLegend() {
  return (
    <div className="chart-legend" aria-label="Status legend">
      {STATUS_VALUES.map((status) => (
        <span key={status}>
          <i className={`legend-swatch ${status}`} />
          {STATUS_LABELS[status]}
        </span>
      ))}
    </div>
  );
}

export function ChartDataList({ chartData }: { chartData: ChartDatum[] }) {
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

export function TrendChartFigure({
  chart,
  chartData,
  chartHeight,
  chartState,
  onPointSelect,
  readout,
  valueMode,
}: {
  chart: ChartModel;
  chartData: ChartDatum[];
  chartHeight: number;
  chartState: TrendChartState;
  onPointSelect: (point: ChartDatum, opener: ChartPointOpener) => void;
  readout: DashboardReadout;
  valueMode: ValueMode;
}) {
  const { baselineLine, bestLine, timestampTicks, usesTimestampScale, xKey, yDomain, yKey } =
    chartState;
  const [selectedRunNumber, setSelectedRunNumber] = useState<number | null>(() =>
    initialSelectedRunNumber(chartData),
  );
  useEffect(() => {
    if (chartData.some((item) => item.runNumber === selectedRunNumber)) return;
    setSelectedRunNumber(initialSelectedRunNumber(chartData));
  }, [chartData, selectedRunNumber]);
  const selectedPoint =
    chartData.find((item) => item.runNumber === selectedRunNumber) || chartData.at(-1) || null;
  return (
    <figure
      id="trend-chart"
      className="chart-frame"
      aria-labelledby="trend-chart-title trend-chart-desc"
    >
      <figcaption id="trend-chart-title" className="sr-only">
        Baseline-normalized metric trend
      </figcaption>
      <p id="trend-chart-desc" className="sr-only">
        {chart.summary}
      </p>
      <p id="trend-chart-selected" className="sr-only" aria-live="polite">
        {selectedPoint
          ? `Selected chart point: ${selectedPoint.runLabel}, ${selectedPoint.statusLabel}, ${selectedPoint.metricDisplay}.`
          : "No chart point selected."}
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
            dot={
              <ChartDot
                chartData={chartData}
                onPreview={setSelectedRunNumber}
                onSelect={onPointSelect}
                selectedRunNumber={selectedRunNumber}
              />
            }
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
  );
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

function ChartDot({
  chartData = [],
  cx,
  cy,
  onPreview,
  payload,
  onSelect,
  selectedRunNumber = null,
}: {
  chartData?: ChartDatum[];
  cx?: number;
  cy?: number;
  onPreview?: (runNumber: number) => void;
  payload?: ChartDatum;
  onSelect?: (payload: ChartDatum, opener: ChartPointOpener) => void;
  selectedRunNumber?: number | null;
}) {
  const x = Number(cx);
  const y = Number(cy);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !payload) return null;
  const targetSize = payload.latest ? 44 : 40;
  const tabbable = isTabbableChartPoint(payload, selectedRunNumber);
  const selectAdjacentPoint = (direction: -1 | 1) => {
    const currentIndex = chartData.findIndex((item) => item.runNumber === payload.runNumber);
    const next = chartData[currentIndex + direction];
    if (!next) return;
    onPreview?.(next.runNumber);
    window.setTimeout(() => {
      const target = document.querySelector<HTMLButtonElement>(
        `[data-chart-run="${next.runNumber}"]`,
      );
      target?.focus();
    }, 0);
  };
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
        aria-describedby="trend-chart-selected"
        aria-label={chartPointAriaLabel(payload)}
        data-chart-run={payload.runNumber}
        tabIndex={tabbable ? 0 : -1}
        onClick={(event) => onSelect?.(payload, event.currentTarget)}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
            event.preventDefault();
            selectAdjacentPoint(-1);
          } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
            event.preventDefault();
            selectAdjacentPoint(1);
          }
        }}
      >
        {payload.latest && (
          <span className={`latest-halo-ui ${payload.status}`} aria-hidden="true" />
        )}
        <span
          className={`chart-point-dot ${payload.status}${payload.best ? " best" : ""}`}
          aria-hidden="true"
        />
      </button>
    </foreignObject>
  );
}

function initialSelectedRunNumber(chartData: ChartDatum[]) {
  return chartData.find((item) => item.latest)?.runNumber ?? chartData.at(-1)?.runNumber ?? null;
}

function isTabbableChartPoint(payload: ChartDatum, selectedRunNumber: number | null) {
  return (
    payload.runNumber === selectedRunNumber ||
    payload.latest ||
    payload.best ||
    payload.status === "discard" ||
    payload.status === "crash" ||
    payload.status === "checks_failed"
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
  const evidenceRows = runEvidenceRows(item);
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-header">
        <span>{item.runLabel}</span>
        <span className={`chart-tooltip-status ${item.status}`}>{item.statusLabel}</span>
      </div>
      <strong>{formatChartAxisValue(payload?.[0]?.value ?? null, valueMode, readout)}</strong>
      <p>{item.description}</p>

      {evidenceRows.length > 0 && (
        <div className="chart-tooltip-asi">
          {evidenceRows.map(([label, value]) => (
            <div className="chart-tooltip-asi-item" key={label}>
              <b>{label === "Next" ? "Next Action" : label}</b>
              {value}
            </div>
          ))}
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
