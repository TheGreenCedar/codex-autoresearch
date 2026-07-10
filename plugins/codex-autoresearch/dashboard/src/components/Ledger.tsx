import { useEffect, useMemo, useState } from "react";
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
  const [visibleCount, setVisibleCount] = useState(100);
  useEffect(() => setVisibleCount(100), [session.segment]);
  const visibleRuns = newest.slice(0, visibleCount);
  const locallyHidden = Math.max(0, newest.length - visibleRuns.length);
  const ledgerNote = ledgerNoteFor(
    visibleRuns.length,
    locallyHidden,
    ledgerBounds,
    readout.invalidLedgerEntryCount,
  );
  const tableLabel = tableLabelFor(visibleRuns.length, locallyHidden, ledgerBounds);
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
              {visibleRuns.map((run) => (
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
      {locallyHidden > 0 ? (
        <div className="ledger-load-more">
          <button
            type="button"
            className="tool-button subtle"
            aria-describedby="ledger-note"
            onClick={() => setVisibleCount((count) => count + 100)}
          >
            Load {Math.min(100, locallyHidden)} older
          </button>
        </div>
      ) : null}
    </section>
  );
}

function ledgerNoteFor(
  visibleCount: number,
  locallyHidden: number,
  ledgerBounds?: LedgerBounds,
  invalidCount = 0,
): string {
  if (!visibleCount) return invalidSuffix("No runs logged yet", invalidCount);
  const omittedEntries = omittedLedgerEntries(ledgerBounds);
  const parts = [`${visibleCount} ${locallyHidden ? "shown" : "runs"}`, "newest first"];
  if (locallyHidden > 0) parts.push(`${locallyHidden} older ${runLabel(locallyHidden)} available`);
  if (ledgerBounds?.truncated === true && omittedEntries > 0) {
    parts.push(
      `${omittedEntries} older ledger ${entryLabel(omittedEntries)} omitted from snapshot`,
    );
  }
  if (ledgerBounds?.summarySource === "full-ledger-stream") {
    parts.push("summary uses the full streamed ledger");
  }
  return invalidSuffix(parts.join(" / "), invalidCount);
}

function tableLabelFor(
  visibleCount: number,
  locallyHidden: number,
  ledgerBounds?: LedgerBounds,
): string {
  const omittedEntries = omittedLedgerEntries(ledgerBounds);
  const parts = [`Run ledger, newest first, ${visibleCount} shown`];
  if (locallyHidden > 0) parts.push(`${locallyHidden} older ${runLabel(locallyHidden)} available`);
  if (ledgerBounds?.truncated === true && omittedEntries > 0) {
    parts.push(
      `${omittedEntries} older ledger ${entryLabel(omittedEntries)} omitted from snapshot`,
    );
  }
  return parts.join(", ");
}

function omittedLedgerEntries(ledgerBounds?: LedgerBounds): number {
  const value = Number(ledgerBounds?.omittedEntries);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function entryLabel(count: number): string {
  return count === 1 ? "entry" : "entries";
}

function runLabel(count: number): string {
  return count === 1 ? "run" : "runs";
}

function invalidSuffix(text: string, invalidCount: number): string {
  return invalidCount > 0
    ? `${text} / ${invalidCount} invalid ledger ${entryLabel(invalidCount)} ignored`
    : text;
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
