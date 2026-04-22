import { useMemo } from "react";
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
import { STATUS_LABELS, STATUS_VALUES } from "../constants.js";
import { buildChart, formatChartRunValue } from "../model.js";

const STATUS_COLORS = {
  keep: "#2BA8A2",
  discard: "#EF6C4A",
  crash: "#253936",
  checks_failed: "#FFD23F",
};

export function TrendPanel({ session, readout }) {
  const chart = useMemo(() => buildChart(session, readout), [readout, session]);
  const chartData = useMemo(() => chart.points.map((point) => ({
    runLabel: `#${point.run.run}`,
    runNumber: point.run.run,
    metric: point.run.metric,
    status: point.run.status,
    statusLabel: STATUS_LABELS[point.run.status] || point.run.status || "Run",
    description: point.run.description || "No description",
    best: point.best,
    latest: point.latest,
    label: `#${point.run.run} ${formatChartRunValue(point.run.metric, session.config.metricUnit)} ${point.run.status}`,
  })), [chart.points, session.config.metricUnit]);
  return (
    <section className="panel trend-panel" id="trend-panel" aria-label="Metric trajectory">
      <div className="panel-head">
        <div>
          <p className="eyebrow"><Activity aria-hidden="true" size={14} />Metric trajectory</p>
          <h2>Run chart</h2>
        </div>
        <span id="chart-note" className="panel-note">{chart.note}</span>
      </div>
      <div className="chart-legend" aria-label="Status legend">
        {STATUS_VALUES.map((status) => (
          <span key={status}><i className={`legend-swatch ${status}`} />{STATUS_LABELS[status]}</span>
        ))}
      </div>
      <figure id="trend-chart" className="chart-frame" role="img" aria-labelledby="trend-chart-title trend-chart-desc">
        <figcaption id="trend-chart-title" className="sr-only">Baseline-normalized metric trend</figcaption>
        <p id="trend-chart-desc" className="sr-only">{chart.summary}</p>
        <ResponsiveContainer width="100%" height={350}>
          <LineChart data={chartData} margin={{ top: 18, right: 24, bottom: 8, left: 6 }}>
            <CartesianGrid vertical={false} stroke="#A8D8D4" strokeDasharray="6 8" />
            <XAxis dataKey="runLabel" tickLine={false} axisLine={false} tick={{ fill: "#1E8C86", fontSize: 12, fontWeight: 800 }} />
            <YAxis
              width={58}
              domain={chart.domain || ["auto", "auto"]}
              tickFormatter={(value) => formatChartRunValue(value, session.config.metricUnit)}
              tickLine={false}
              axisLine={false}
              tick={{ fill: "#1E8C86", fontSize: 12, fontWeight: 800 }}
            />
            {chart.winZoneBounds && (
              <ReferenceArea className="win-zone" y1={chart.winZoneBounds.y1} y2={chart.winZoneBounds.y2} strokeOpacity={0} />
            )}
            {chart.baselineValue != null && (
              <ReferenceLine className="baseline-line" y={chart.baselineValue} stroke="#D45233" strokeDasharray="8 8" strokeWidth={2} />
            )}
            {chart.bestValue != null && (
              <ReferenceLine className="best-line" y={chart.bestValue} stroke="#FFD23F" strokeDasharray="4 6" strokeWidth={3} />
            )}
            <Tooltip content={<ChartTooltip unit={session.config.metricUnit} />} cursor={{ stroke: "#3CC4BD", strokeWidth: 2, strokeDasharray: "4 6" }} />
            <Line
              className="linePath"
              type="monotone"
              dataKey="metric"
              isAnimationActive={false}
              stroke="#1E8C86"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={5}
              dot={<ChartDot />}
              activeDot={<ChartActiveDot />}
            >
              <LabelList content={<ChartLabel unit={session.config.metricUnit} />} />
            </Line>
          </LineChart>
        </ResponsiveContainer>
        <div className="chartRunTicks" aria-hidden="true">
          {chartData.map((item) => <span key={`tick-${item.runNumber}`} />)}
        </div>
        <div className="chart-point-labels" aria-hidden="true">
          {chartData.map((item) => <span key={`label-${item.runNumber}`}>{item.label}</span>)}
        </div>
      </figure>
      <p id="trend-chart-summary" className="sr-summary">{chart.summary}</p>
    </section>
  );
}

function ChartDot({ cx, cy, payload }) {
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  const color = STATUS_COLORS[payload.status] || STATUS_COLORS.keep;
  return (
    <g className="chart-point-wrap">
      {payload.latest && <circle className="latest-halo" cx={cx} cy={cy} r="15" />}
      <circle className={`chart-point ${payload.status}`} cx={cx} cy={cy} r={payload.best ? 8 : 6} fill={color} />
    </g>
  );
}

function ChartActiveDot({ cx, cy, payload }) {
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  const color = STATUS_COLORS[payload.status] || STATUS_COLORS.keep;
  return <circle className={`chart-point active ${payload.status}`} cx={cx} cy={cy} r="10" fill={color} />;
}

function ChartLabel({ x, y, value, payload, unit }) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !payload?.latest) return null;
  return (
    <text className="chart-value-label" x={x} y={y - 18} textAnchor="middle">
      {formatChartRunValue(value, unit)}
    </text>
  );
}

function ChartTooltip({ active, payload, unit }) {
  const item = payload?.[0]?.payload;
  if (!active || !item) return null;
  return (
    <div className="chart-tooltip">
      <span>{item.runLabel} / {item.statusLabel}</span>
      <strong>{formatChartRunValue(item.metric, unit)}</strong>
      <p>{item.description}</p>
    </div>
  );
}
