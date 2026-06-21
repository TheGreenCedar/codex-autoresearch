import { JSDOM } from "jsdom";

export async function renderExportedDashboard(html) {
  const dom = new JSDOM(html, {
    pretendToBeVisual: true,
    runScripts: "dangerously",
    url: "file:///autoresearch-dashboard.html",
  });
  const started = Date.now();
  while (!dom.window.__AUTORESEARCH_DASHBOARD_READY__) {
    if (Date.now() - started > 2000)
      throw new Error("Dashboard React app did not finish rendering.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return dom;
}
