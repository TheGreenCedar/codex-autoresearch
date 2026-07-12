import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function dashboardHtml() {
  const template = await readFile(path.join(pluginRoot, "assets", "template.html"), "utf8");
  const css = await readFile(
    path.join(pluginRoot, "assets", "dashboard-build", "dashboard-app.css"),
    "utf8",
  );
  const app = await readFile(
    path.join(pluginRoot, "assets", "dashboard-build", "dashboard-app.js"),
    "utf8",
  );
  const entries = [
    {
      type: "config",
      name: "browser dashboard smoke",
      metricName: "seconds",
      bestDirection: "lower",
      metricUnit: "s",
    },
    ...Array.from({ length: 5_000 }, (_, index) => ({
      type: "run",
      run: index + 1,
      metric: 5_002 - (index + 1),
      status: index === 0 ? "measure" : index % 11 === 0 ? "discard" : "keep",
      description: `Run ${index + 1}`,
      confidence: Math.min(5, Math.floor(index / 1_000) + 1),
    })),
  ];
  const liveEntries = [
    ...entries,
    {
      type: "run",
      run: 5_001,
      metric: 1,
      status: "keep",
      description: "Live refreshed run 5001",
      confidence: 5,
    },
  ];
  const meta = {
    payloadVersion: 1,
    deliveryMode: "live-server",
    liveRefreshAvailable: true,
    liveActionsAvailable: false,
    refreshMs: 60_000,
    commands: [],
    viewModel: dashboardViewModel(),
  };
  const html = dashboardDocument(template, entries, meta, css, app);
  const staticHtml = dashboardDocument(
    template,
    entries,
    {
      payloadVersion: 1,
      deliveryMode: "static-export",
      liveRefreshAvailable: false,
      commands: [],
      viewModel: dashboardViewModel(),
    },
    css,
    app,
  );
  const smallHtml = dashboardDocument(
    template,
    entries.slice(0, 101),
    {
      payloadVersion: 1,
      deliveryMode: "live-server",
      liveRefreshAvailable: true,
      liveActionsAvailable: false,
      refreshMs: 60_000,
      commands: [],
      viewModel: dashboardViewModel(),
    },
    css,
    app,
  );
  const failureHtml = template
    .replace(
      /<script>\s*window\.__AUTORESEARCH_DATA__ = __AUTORESEARCH_DATA_PAYLOAD__;\s*window\.__AUTORESEARCH_META__ = __AUTORESEARCH_META_PAYLOAD__;\s*<\/script>/,
      "",
    )
    .replace("__AUTORESEARCH_DASHBOARD_CSS__", () => css)
    .replace("__AUTORESEARCH_DASHBOARD_APP__", () => app);
  const livePayload = {
    payloadVersion: 1,
    ledgerEntries: liveEntries,
    ledgerBounds: { truncated: false, omittedEntries: 0, maxEntries: 5_001 },
    summary: { segment: 0, baseline: 5_001, best: 1, runs: 5_001 },
    ...dashboardViewModel(),
  };
  return {
    failureHtml,
    html,
    livePayloadBytes: Buffer.byteLength(JSON.stringify(livePayload)),
    smallHtml,
    staticHtml,
    livePayload,
  };
}

export async function serveHtml(html, failureHtml, livePayload) {
  let liveRequestCount = 0;
  const server = http.createServer((request, response) => {
    if (request.url === "/" || request.url === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.url === "/payload-missing.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(failureHtml);
      return;
    }
    if (request.url === "/view-model.json") {
      liveRequestCount += 1;
      if (liveRequestCount === 2) {
        setTimeout(() => {
          response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify(livePayload));
        }, 300);
        return;
      }
      if (liveRequestCount >= 3) {
        response.writeHead(503, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ message: "Fixture refresh failed.", retryable: false }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(livePayload));
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function dashboardDocument(template, entries, meta, css, app) {
  return template
    .replace("__AUTORESEARCH_DATA_PAYLOAD__", () =>
      JSON.stringify(entries).replaceAll("<", "\\u003c"),
    )
    .replace("__AUTORESEARCH_META_PAYLOAD__", () => JSON.stringify(meta).replaceAll("<", "\\u003c"))
    .replace("__AUTORESEARCH_DASHBOARD_CSS__", () => css)
    .replace("__AUTORESEARCH_DASHBOARD_APP__", () => app);
}

function dashboardViewModel() {
  return {
    decisionEnvelope: {
      resolvedStatus: "blocked",
      strongestBlocker: "Promotion proof is missing.",
    },
    decisionEnvelopeSummary: {
      kind: "gate-quality",
      title: "Repeat the best packet",
      detail: "Confirm the kept path before promotion.",
      command: "node scripts/autoresearch.mjs state --cwd . --compact",
    },
    nextBestAction: {
      title: "Repeat the best packet",
      detail: "Confirm the kept path before promotion.",
    },
    evidenceReadout: { label: "promotion_eligible", title: "Promotion eligible", promotable: true },
    evidenceLedger: {
      counts: { accepted: 4_500, provisional: 1, rejected: 500, superseded: 0 },
      acceptedCurrent: 4_500,
    },
    finalizationPressure: { status: "medium", recommendation: "Repeat first." },
    watchdogSummary: { status: "tracking", recommendation: "Continue from the decision." },
  };
}
