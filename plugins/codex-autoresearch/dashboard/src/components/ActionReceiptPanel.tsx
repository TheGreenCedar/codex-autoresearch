import type { ReactNode } from "react";
import { actionLabel } from "../model";
import type { ActionReceipt } from "../types";

interface ReceiptDetail {
  label: string;
  value: ReactNode;
}

export function ActionReceiptPanel({ receipt }: { receipt?: ActionReceipt | null }) {
  const empty = !receipt;
  const ok =
    empty ||
    (receipt.ok !== false && receipt.status !== "failed" && receipt.status !== "timed_out");
  const title = empty
    ? "No receipt yet"
    : ok
      ? `${actionLabel(receipt.action)} completed`
      : `${actionLabel(receipt.action)} needs attention`;
  const detail = empty
    ? "Run a guarded live action to see the command receipt here."
    : receipt.nextStep ||
      receipt.stderrSummary ||
      receipt.stdoutSummary ||
      "No action details were returned.";
  const details = empty ? [] : receiptDetails(receipt, ok);
  return (
    <section
      className={`panel receipt-panel ${empty ? "empty-receipt" : ok ? "ok" : "error"}`}
      id="action-receipt"
      aria-label="Latest action receipt"
      aria-live={ok ? "polite" : "assertive"}
      tabIndex={-1}
    >
      <div className={`receipt-toast ${empty ? "idle" : ok ? "ok" : "error"}`} id="receipt-toast">
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      <div className="panel-head">
        <div>
          <p className="eyebrow">Action receipt</p>
          <h2>{title}</h2>
        </div>
        <span className="panel-note">
          {empty
            ? "Waiting"
            : receipt.durationMs != null
              ? `${receipt.durationMs} ms`
              : receipt.status || ""}
        </span>
      </div>
      <p className="receipt-detail">{detail}</p>
      <dl className="receipt-grid">
        {details.map((item) => (
          <div key={item.label}>
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
      </dl>
      <details className="receipt-full" id="action-receipt-details" hidden={empty}>
        <summary>Full receipt</summary>
        <pre>{JSON.stringify(receipt || {}, null, 2)}</pre>
      </details>
    </section>
  );
}

function receiptDetails(receipt: ActionReceipt, ok: boolean): ReceiptDetail[] {
  const items: ReceiptDetail[] = [
    { label: "Action", value: receipt.action || "unknown" },
    { label: "Status", value: receipt.status || (ok ? "completed" : "failed") },
  ];
  if (receipt.ledgerRun)
    items.push({ label: "Ledger", value: <a href="#ledger">Run #{receipt.ledgerRun}</a> });
  if (receipt.lastRunCleared != null)
    items.push({ label: "Packet", value: receipt.lastRunCleared ? "Cleared" : "Still present" });
  if (receipt.command) items.push({ label: "Command", value: receipt.command });
  if (receipt.receiptId) items.push({ label: "Receipt", value: receipt.receiptId });
  return items;
}
