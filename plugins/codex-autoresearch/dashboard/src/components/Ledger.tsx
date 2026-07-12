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

export const LEDGER_PAGE_SIZE = 20;

export function Ledger({ session, readout, ledgerBounds }: LedgerProps) {
  const newest = useMemo(() => [...session.runs].reverse(), [session.runs]);
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(newest.length / LEDGER_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  useEffect(() => setPage(0), [session.segment]);
  useEffect(() => setPage((stored) => Math.min(stored, pageCount - 1)), [pageCount]);
  const visibleRuns = newest.slice(
    currentPage * LEDGER_PAGE_SIZE,
    (currentPage + 1) * LEDGER_PAGE_SIZE,
  );
  const ledgerNote = ledgerNoteFor(
    visibleRuns.length,
    currentPage,
    pageCount,
    newest.length,
    ledgerBounds,
    readout.invalidLedgerEntryCount,
  );
  const tableLabel = tableLabelFor(
    visibleRuns.length,
    currentPage,
    pageCount,
    newest.length,
    ledgerBounds,
  );
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
            <colgroup>
              <col className="ledger-run-column" />
              <col className="ledger-status-column" />
              <col className="ledger-metric-column" />
              <col className="ledger-description-column" />
            </colgroup>
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
      {newest.length > LEDGER_PAGE_SIZE ? (
        <nav className="ledger-pagination" aria-label="Run ledger pages">
          <button
            type="button"
            className="tool-button subtle"
            aria-controls="ledger-body"
            disabled={currentPage === 0}
            aria-describedby="ledger-note"
            onClick={() => setPage((current) => Math.max(0, current - 1))}
          >
            Newer runs
          </button>
          <span aria-current="page">
            Page {currentPage + 1} of {pageCount}
          </span>
          <button
            type="button"
            className="tool-button subtle"
            aria-controls="ledger-body"
            disabled={currentPage >= pageCount - 1}
            aria-describedby="ledger-note"
            onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
          >
            Older runs
          </button>
        </nav>
      ) : null}
    </section>
  );
}

function ledgerNoteFor(
  visibleCount: number,
  page: number,
  pageCount: number,
  totalRuns: number,
  ledgerBounds?: LedgerBounds,
  invalidCount = 0,
): string {
  if (!visibleCount) return invalidSuffix("No runs logged yet", invalidCount);
  const omittedEntries = omittedLedgerEntries(ledgerBounds);
  const parts = [
    `${visibleCount} shown of ${totalRuns} ${runLabel(totalRuns)}`,
    `page ${page + 1} of ${pageCount}`,
    "newest first",
  ];
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
  page: number,
  pageCount: number,
  totalRuns: number,
  ledgerBounds?: LedgerBounds,
): string {
  const omittedEntries = omittedLedgerEntries(ledgerBounds);
  const parts = [
    `Run ledger, newest first, page ${page + 1} of ${pageCount}`,
    `${visibleCount} shown of ${totalRuns} ${runLabel(totalRuns)}`,
  ];
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
      <td className="ledger-cell run-index" data-label="Run">
        #{run.run}
      </td>
      <td className="ledger-cell" data-label="Status">
        <StatusPill status={run.status} />
        {best ? <span className="best-label">Best kept</span> : null}
      </td>
      <td className="ledger-cell metric-cell" data-label="Metric">
        <div className="metric-stack">
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
      </td>
      <td className="ledger-cell run-desc" data-label="Description and ASI">
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
