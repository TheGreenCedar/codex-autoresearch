import { useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import { formatImprovement, formatMetric } from "../../model";
import type { DashboardReadout, RunMetricBreakdown } from "../../types";
import { getFocusableDialogElements } from "./focus";
import {
  formatChartAxisValue,
  formatMemoryValue,
  formatWeightedScoreValue,
  type ChartDatum,
} from "./shared";

export function ExperimentModal({
  point,
  readout,
  onClose,
}: {
  point: ChartDatum;
  readout: DashboardReadout;
  onClose: () => void;
}) {
  const breakdown = point.breakdown;
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  const requestClose = onClose;
  const onDialogKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      requestClose();
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
    <div className="modal-backdrop" role="presentation" onMouseDown={requestClose}>
      <section
        ref={dialogRef}
        className={`experiment-modal status-${point.status}`}
        data-status={point.status}
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
          onClick={requestClose}
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
            <strong>{formatChartAxisValue(point.chartPercent, "percent", readout)}</strong>
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
