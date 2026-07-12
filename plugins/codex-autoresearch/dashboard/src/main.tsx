import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import "./styles.css";
import { Dashboard } from "./Dashboard";
import { bootstrapDashboardPayload, developmentShowcaseEnabled } from "./bootstrap";

const rootElement = document.getElementById("dashboard-root");

if (rootElement) {
  const bootstrap = bootstrapDashboardPayload(
    window.__AUTORESEARCH_DATA__,
    window.__AUTORESEARCH_META__,
    {
      developmentShowcase: developmentShowcaseEnabled(import.meta.env.DEV, window.location.search),
    },
  );
  const root = createRoot(rootElement);
  flushSync(() => {
    root.render(
      bootstrap.ok ? (
        <Dashboard initialEntries={bootstrap.entries} initialMeta={bootstrap.meta} />
      ) : (
        <PayloadUnavailable {...bootstrap.failure} />
      ),
    );
  });
  rootElement.dataset.dashboardState = bootstrap.ok ? "ready" : "payload-unavailable";
  window.__AUTORESEARCH_DASHBOARD_READY__ = true;
}

function PayloadUnavailable({
  mode,
  provenance,
  reason,
  recovery,
}: {
  mode: string;
  provenance: string;
  reason: string;
  recovery: string;
}) {
  return (
    <main className="payload-failure">
      <section
        className="payload-failure-card"
        role="alert"
        aria-live="assertive"
        aria-labelledby="payload-failure-title"
        aria-describedby="payload-failure-summary payload-failure-reason payload-failure-recovery"
      >
        <p className="eyebrow">Evidence Unavailable</p>
        <h1 id="payload-failure-title">Dashboard Payload Unavailable</h1>
        <p id="payload-failure-summary" className="payload-failure-summary">
          No session evidence is shown because the injected dashboard payload could not be trusted.
        </p>
        <dl className="payload-failure-facts">
          <div>
            <dt>Delivery Mode</dt>
            <dd>{mode}</dd>
          </div>
          <div>
            <dt>Payload Provenance</dt>
            <dd>{provenance}</dd>
          </div>
        </dl>
        <p id="payload-failure-reason" className="payload-failure-reason">
          {reason}
        </p>
        <div className="payload-failure-recovery">
          <h2>Recover This Readout</h2>
          <p id="payload-failure-recovery">{recovery}</p>
        </div>
      </section>
    </main>
  );
}
