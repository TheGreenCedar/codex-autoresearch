import { useMemo } from "react";
import { LEDGER_ROW_HEIGHT, STATUS_LABELS } from "../constants";
import { asiPreview, breakdownForRun, formatDelta, formatMetricValue } from "../model";
import type { DashboardReadout, SessionSegment } from "../types";

interface LedgerProps {
  session: SessionSegment;
  readout: DashboardReadout;
}

export function Ledger({ session, readout }: LedgerProps) {
  const newest = useMemo(() => [...session.runs].reverse(), [session.runs]);
  const totalHeight = Math.max(
    newest.length * LEDGER_ROW_HEIGHT,
    newest.length * LEDGER_ROW_HEIGHT,
  );
  return (
    <section
      className="panel ledger-panel"
      id="ledger"
      aria-label="Run log"
      hidden={!session.runs.length}
      tabIndex={-1}
    >
      <div className="panel-head">
        <div>
          <p className="eyebrow">Run log</p>
          <h2>Ledger, ASI</h2>
        </div>
        <span id="ledger-note" className="panel-note">
          {`${session.runs.length} runs / newest first`}
        </span>
      </div>
      <div
        className="ledger-scroll"
        id="ledger-scroll"
        role="table"
        aria-label={`Run ledger, newest first, ${session.runs.length} total runs`}
        aria-rowcount={session.runs.length + 1}
      >
        <div className="ledger-header" role="row">
          <span role="columnheader">Run</span>
          <span role="columnheader">Status</span>
          <span role="columnheader">Metric</span>
          <span role="columnheader">Description and ASI</span>
        </div>
        <div id="ledger-body" style={{ height: `${totalHeight}px` }}>
          {newest.map((run, index) => {
            const best = readout.bestRun?.run === run.run && run.status === "keep";
            const breakdown = breakdownForRun(run, readout.metricDefinition);
            return (
              <div
                className={`ledger-row ${best ? "best-row" : ""}`}
                role="row"
                aria-rowindex={index + 2}
                style={{ top: `${index * LEDGER_ROW_HEIGHT}px` }}
                key={`${run.segment}-${run.run}`}
              >
                <div className="ledger-cell run-index" role="cell">
                  #{run.run}
                </div>
                <div className="ledger-cell" role="cell">
                  <StatusPill status={run.status} />
                  {best ? <span className="best-label">Best kept</span> : null}
                </div>
                <div className="ledger-cell metric-cell" role="cell">
                  <strong>
                    {formatMetricValue(breakdown?.metricValue ?? null, readout.metricDefinition)}
                  </strong>
                  <span>
                    {formatDelta(
                      breakdown?.metricValue ?? null,
                      readout.baseline,
                      readout.metricDefinition.bestDirection,
                    )}
                  </span>
                </div>
                <div className="ledger-cell run-desc" role="cell">
                  <strong>{run.description || "No description"}</strong>
                  <span>{asiPreview(run)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className={`status-pill ${status}`}>{STATUS_LABELS[status] || status || "Run"}</span>
  );
}
