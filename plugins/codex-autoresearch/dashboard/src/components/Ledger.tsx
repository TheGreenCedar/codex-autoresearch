import { useMemo } from "react";
import { STATUS_LABELS } from "../constants";
import { asiPreview, breakdownForRun, formatDelta, formatMetricValue } from "../model";
import type { DashboardReadout, RunStatus, SessionRun, SessionSegment } from "../types";

interface LedgerProps {
  session: SessionSegment;
  readout: DashboardReadout;
}

export function Ledger({ session, readout }: LedgerProps) {
  const newest = useMemo(() => [...session.runs].reverse(), [session.runs]);
  return (
    <section className="panel ledger-panel" id="ledger" aria-label="Run log" tabIndex={-1}>
      <div className="panel-head">
        <div>
          <p className="eyebrow">Run log</p>
          <h2>Ledger, ASI</h2>
        </div>
        <span id="ledger-note" className="panel-note">
          {session.runs.length
            ? `${session.runs.length} runs / newest first`
            : "No runs logged yet"}
        </span>
      </div>
      {session.runs.length ? (
        <div
          className="ledger-scroll"
          id="ledger-scroll"
        >
          <table aria-label={`Run ledger, newest first, ${session.runs.length} total runs`}>
            <thead className="ledger-header">
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Status</th>
                <th scope="col">Metric</th>
                <th scope="col">Description and ASI</th>
              </tr>
            </thead>
            <tbody id="ledger-body">
              {newest.map((run) => (
                <LedgerRow key={`${run.segment}-${run.run}`} run={run} readout={readout} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty ledger-empty" role="status">
          No ledger yet. First safe move: capture a baseline measurement.
        </div>
      )}
    </section>
  );
}

function LedgerRow({
  run,
  readout,
}: {
  run: SessionRun;
  readout: DashboardReadout;
}) {
  const best = readout.bestRun?.run === run.run && run.status === "keep";
  const breakdown = breakdownForRun(run, readout.metricDefinition);
  return (
    <tr className={`ledger-row ${best ? "best-row" : ""}`}>
      <td className="ledger-cell run-index">
        #{run.run}
      </td>
      <td className="ledger-cell">
        <StatusPill status={run.status} />
        {best ? <span className="best-label">Best kept</span> : null}
      </td>
      <td className="ledger-cell metric-cell">
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
      </td>
      <td className="ledger-cell run-desc">
        <strong>{run.description || "No description"}</strong>
        <span>{asiPreview(run)}</span>
      </td>
    </tr>
  );
}

function StatusPill({ status }: { status: RunStatus }) {
  return (
    <span className={`status-pill ${status}`}>{STATUS_LABELS[status] || status || "Run"}</span>
  );
}
