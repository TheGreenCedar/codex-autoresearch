import { useMemo } from "react";
import { STATUS_LABELS } from "../constants";
import { asiPreview, breakdownForRun, formatDelta, formatMetricValue } from "../model";
import type {
  DashboardReadout,
  LedgerBounds,
  RunStatus,
  SessionRun,
  SessionSegment,
} from "../types";

interface LedgerProps {
  session: SessionSegment;
  readout: DashboardReadout;
  ledgerBounds?: LedgerBounds;
}

export function Ledger({ session, readout, ledgerBounds }: LedgerProps) {
  const newest = useMemo(() => [...session.runs].reverse(), [session.runs]);
  const ledgerNote = ledgerNoteFor(session.runs.length, ledgerBounds);
  const tableLabel = tableLabelFor(session.runs.length, ledgerBounds);
  return (
    <section className="panel ledger-panel" id="ledger" aria-label="Run log" tabIndex={-1}>
      <div className="panel-head">
        <div>
          <p className="eyebrow">Run log</p>
          <h2>Ledger, ASI</h2>
        </div>
        <span id="ledger-note" className="panel-note">
          {ledgerNote}
        </span>
      </div>
      {session.runs.length ? (
        <div className="ledger-scroll" id="ledger-scroll">
          <table aria-label={tableLabel}>
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

function ledgerNoteFor(runCount: number, ledgerBounds?: LedgerBounds): string {
  if (!runCount) return "No runs logged yet";
  const omittedEntries = omittedLedgerEntries(ledgerBounds);
  if (ledgerBounds?.truncated === true && omittedEntries > 0) {
    return `${runCount} visible runs / newest first / ${omittedEntries} older ledger ${entryLabel(
      omittedEntries,
    )} omitted`;
  }
  return `${runCount} runs / newest first`;
}

function tableLabelFor(runCount: number, ledgerBounds?: LedgerBounds): string {
  const omittedEntries = omittedLedgerEntries(ledgerBounds);
  if (ledgerBounds?.truncated === true && omittedEntries > 0) {
    return `Run ledger, newest first, ${runCount} visible runs, ${omittedEntries} older ledger ${entryLabel(
      omittedEntries,
    )} omitted`;
  }
  return `Run ledger, newest first, ${runCount} total runs`;
}

function omittedLedgerEntries(ledgerBounds?: LedgerBounds): number {
  const value = Number(ledgerBounds?.omittedEntries);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function entryLabel(count: number): string {
  return count === 1 ? "entry" : "entries";
}

function LedgerRow({ run, readout }: { run: SessionRun; readout: DashboardReadout }) {
  const best = readout.bestRun?.run === run.run && run.status === "keep";
  const breakdown = breakdownForRun(run, readout.metricDefinition);
  return (
    <tr className={`ledger-row ${best ? "best-row" : ""}`}>
      <td className="ledger-cell run-index">#{run.run}</td>
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
