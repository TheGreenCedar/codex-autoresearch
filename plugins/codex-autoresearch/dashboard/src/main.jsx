import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import "./styles.css";
import { Dashboard } from "./Dashboard.jsx";
import { DEMO_ENTRIES, DEMO_META } from "./demoData.js";

const rootElement = document.getElementById("dashboard-root");

if (rootElement) {
  const initialEntries = Array.isArray(window.__AUTORESEARCH_DATA__) ? window.__AUTORESEARCH_DATA__ : DEMO_ENTRIES;
  const initialMeta = window.__AUTORESEARCH_META__ || DEMO_META;
  const root = createRoot(rootElement);
  flushSync(() => {
    root.render(<Dashboard initialEntries={initialEntries} initialMeta={initialMeta} />);
  });
  window.__AUTORESEARCH_DASHBOARD_READY__ = true;
}
