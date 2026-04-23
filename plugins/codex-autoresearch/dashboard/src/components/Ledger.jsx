import { useMemo } from "react";
import { LEDGER_ROW_HEIGHT, LEDGER_VISIBLE_ROWS, STATUS_LABELS } from "../constants.js";
import { asiPreview, formatDelta, formatMetric } from "../model.js";

export function Ledger({ session, readout }) {
  const newest = useMemo(() => [...session.runs].reverse(), [session.runs]);
  const rows = useMemo(() => newest.slice(0, LEDGER_VISIBLE_ROWS), [newest]);
  const totalHeight = Math.max(newest.length * LEDGER_ROW_HEIGHT, rows.length * LEDGER_ROW_HEIGHT);
  return (
    <section className="panel ledger-panel" id="ledger" aria-label="Run log" hidden={!session.runs.length}>
      <div className="panel-head">
        <div>
          <p className="eyebrow">Run log</p>
          <h2>Ledger, ASI</h2>
        </div>
        <span id="ledger-note" className="panel-note">
          {`${session.runs.length} runs / newest first / showing 1-${Math.min(LEDGER_VISIBLE_ROWS, session.runs.length)}`}
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
        <div id="ledger-body" role="rowgroup" style={{ height: `${totalHeight}px` }}>
          {rows.map((run, index) => {
            const best = readout.bestRun?.run === run.run && run.status === "keep";
            return (
              <div className={`ledger-row ${best ? "best-row" : ""}`} role="row" aria-rowindex={index + 2} style={{ top: `${index * LEDGER_ROW_HEIGHT}px` }} key={`${run.segment}-${run.run}`}>
                <div className="ledger-cell run-index" role="cell">#{run.run}</div>
                <div className="ledger-cell" role="cell"><StatusPill status={run.status} />{best ? <span className="best-label">Best kept</span> : null}</div>
                <div className="ledger-cell metric-cell" role="cell">
                  <strong>{formatMetric(run.metric, session.config.metricUnit)}</strong>
                  <span>{formatDelta(run.metric, readout.baseline, session.config.bestDirection)}</span>
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

function StatusPill({ status }) {
  return <span className={`status-pill ${status}`}>{STATUS_LABELS[status] || status || "Run"}</span>;
}
