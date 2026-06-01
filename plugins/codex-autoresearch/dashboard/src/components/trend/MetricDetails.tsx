import { directionLabel, formatMetric, formatMetricValue } from "../../model";
import type { DashboardReadout, RunMetricBreakdown, SessionSegment } from "../../types";
import {
  formatMemoryValue,
  formatWeightedScoreValue,
  isFiniteNumber,
  primaryMetricExpression,
  runEvidenceRows,
  type ChartDatum,
  type MetricConstructionItem,
} from "./shared";

export function MetricDetails({
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
    <section
      className={`metric-details-panel status-${point?.status || "none"}`}
      data-status={point?.status || "none"}
      id="metric-details"
      aria-label="Metric details"
    >
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
  const evidenceRows = runEvidenceRows(point);
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
      {evidenceRows.map(([label, value]) => (
        <div key={label}>
          <dt>{label === "Next" ? "Next action" : label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
      {warnings.length ? (
        <div>
          <dt>Warnings</dt>
          <dd id="metric-detail-warnings">{warnings.join(" ")}</dd>
        </div>
      ) : null}
    </dl>
  );
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
  const weights = readout.metricDefinition.weights;
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
          ({weights.time} * {timeScore}) + ({weights.memory} * {memoryScore}) ={" "}
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
