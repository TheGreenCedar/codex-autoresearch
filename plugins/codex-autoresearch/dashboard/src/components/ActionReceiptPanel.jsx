import { actionLabel } from "../model.js";

export function ActionReceiptPanel({ receipt }) {
  if (!receipt) return null;
  const ok = receipt.ok !== false && receipt.status !== "failed" && receipt.status !== "timed_out";
  const title = ok ? `${actionLabel(receipt.action)} completed` : `${actionLabel(receipt.action)} needs attention`;
  const detail = receipt.nextStep || receipt.stderrSummary || receipt.stdoutSummary || "No action details were returned.";
  return (
    <section className={`panel receipt-panel ${ok ? "ok" : "error"}`} id="action-receipt" aria-label="Latest action receipt" aria-live={ok ? "polite" : "assertive"}>
      <div className="panel-head">
        <div>
          <p className="eyebrow">Action receipt</p>
          <h2>{title}</h2>
        </div>
        <span className="panel-note">{receipt.durationMs != null ? `${receipt.durationMs} ms` : receipt.status || ""}</span>
      </div>
      <p className="receipt-detail">{detail}</p>
      <dl className="receipt-grid">
        <div>
          <dt>Action</dt>
          <dd>{receipt.action || "unknown"}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{receipt.status || (ok ? "completed" : "failed")}</dd>
        </div>
        {receipt.ledgerRun ? (
          <div>
            <dt>Ledger</dt>
            <dd><a href="#ledger">Run #{receipt.ledgerRun}</a></dd>
          </div>
        ) : null}
        {receipt.lastRunCleared != null ? (
          <div>
            <dt>Packet</dt>
            <dd>{receipt.lastRunCleared ? "Cleared" : "Still present"}</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}
