import { recordFrom } from "../model";

export function OutcomeSummary({
  projection,
  audit,
}: {
  projection: Record<string, unknown>;
  audit: Record<string, unknown> | null;
}) {
  const remaining = recordFrom(projection.remaining);
  const delivery = recordFrom(projection.delivery);
  const unresolved = Array.isArray(projection.unresolvedCriteria)
    ? projection.unresolvedCriteria
    : [];
  const allowance = (value: unknown, unit: string) =>
    typeof value === "number" ? `${Math.round(value * 10) / 10} ${unit}` : `No ${unit} ceiling`;
  const records = audit && Array.isArray(audit.executions) ? audit.executions.map(recordFrom) : [];
  const evidence = audit && Array.isArray(audit.evidence) ? audit.evidence.map(recordFrom) : [];
  return (
    <section
      className="outcome-summary"
      aria-label="Governed outcome"
      data-outcome-status={String(projection.status)}
    >
      <p className="eyebrow">Outcome</p>
      <h3 id="outcome-objective">{String(projection.objective)}</h3>
      <dl className="operator-decision-summary">
        <div>
          <dt>State</dt>
          <dd id="outcome-status">{String(projection.status)}</dd>
        </div>
        <div>
          <dt>Current question</dt>
          <dd id="outcome-question">
            {projection.question ? String(projection.question) : "No active investigation"}
          </dd>
        </div>
        <div>
          <dt>Remaining allowance</dt>
          <dd id="outcome-allowance">
            {allowance(remaining.actions, "actions")} ·{" "}
            {allowance(remaining.executionSeconds, "seconds")}
            {remaining.deadline ? ` · Deadline ${String(remaining.deadline)}` : ""}
          </dd>
        </div>
        <div>
          <dt>Unresolved criteria</dt>
          <dd id="outcome-unresolved">
            {unresolved.length ? unresolved.map(String).join(", ") : "All criteria covered"}
          </dd>
        </div>
        <div>
          <dt>Delivery</dt>
          <dd id="outcome-delivery">
            {String(delivery.endpoint)} · {String(delivery.status)}
          </dd>
        </div>
        {Number(remaining.unknownExecutions) > 0 ? (
          <div>
            <dt>Unknown exposure</dt>
            <dd>Reconcile {String(remaining.unknownExecutions)} existing execution(s).</dd>
          </div>
        ) : null}
      </dl>
      {audit ? (
        <details className="decision-details" open>
          <summary>Investigation evidence</summary>
          <div className="outcome-records" role="region" aria-label="Execution receipts">
            <table>
              <thead>
                <tr>
                  <th>Execution</th>
                  <th>Status</th>
                  <th>Validity</th>
                  <th>Movement</th>
                  <th>Attainment</th>
                  <th>Consumption</th>
                </tr>
              </thead>
              <tbody>
                {records.map((receipt) => {
                  const result = recordFrom(receipt.result);
                  return (
                    <tr key={String(receipt.id)}>
                      <td>{String(receipt.id)}</td>
                      <td>{String(receipt.status)}</td>
                      <td>{String(result.validity ?? "unknown")}</td>
                      <td>{String(result.movement ?? "unknown")}</td>
                      <td>{String(result.attainment ?? "unknown")}</td>
                      <td>{String(receipt.consumptionSource)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ul>
            {evidence.map((entry) => (
              <li key={String(entry.id)}>
                <strong>
                  {String(entry.criterionId)} · {String(entry.relation)}
                </strong>
                : {String(entry.text)}{" "}
                <span>({String(entry.historicalValidity)} historical evidence)</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
