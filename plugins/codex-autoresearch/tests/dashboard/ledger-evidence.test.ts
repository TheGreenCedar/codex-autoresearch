import assert from "node:assert/strict";
import test from "node:test";
import { asiText } from "../../dashboard/src/model/asi.js";
import { type SessionRun } from "../../dashboard/src/types.js";
import {
  createDashboardHarness,
  dashboardConfigEntry,
  emptyCommandMeta,
  waitFor,
} from ".././helpers/dashboard.js";

const dashboard = createDashboardHarness();
const { runDashboard } = dashboard;

test.before(async () => {
  await dashboard.buildDashboardAssets();
});

test.after(async () => {
  await dashboard.cleanupBuildAssets();
});

test.afterEach(() => {
  dashboard.closeDashboardWindows();
});

test("dashboard styles latest rejected evidence as rejected, not kept", async () => {
  const entries = [
    dashboardConfigEntry({ name: "rejected latest", metricName: "score", bestDirection: "higher" }),
    {
      type: "run",
      run: 1,
      metric: 10,
      status: "keep",
      description: "Baseline",
      confidence: 1,
    },
    {
      type: "run",
      run: 2,
      metric: 10,
      status: "discard",
      description: "Rejected metric-neutral change",
      asi: {
        hypothesis: "Try a neutral ranker change.",
        evidence: "Prompt recall stayed flat.",
        rollback_reason: "No primary metric improvement.",
      },
      confidence: 1,
    },
  ];

  const { dom, getById } = await runDashboard(entries, emptyCommandMeta());
  const metricDetails = getById("metric-details");
  const dashboardCss = dom.window.document.querySelector("style")?.textContent || "";

  assert.equal(metricDetails.getAttribute("data-status"), "discard");
  assert.match(getById("metric-details-selected").textContent || "", /Rejected/);
  assert.match(dashboardCss, /\.latest-halo-ui\.discard/);
  assert.match(dashboardCss, /\.experiment-modal\.status-discard/);
  assert.ok(
    dashboardCss.lastIndexOf(".dark-theme .latest-halo-ui.discard") >
      dashboardCss.lastIndexOf(".dark-theme .latest-halo-ui {"),
    "Dark theme discard halo rule must outrank the generic dark halo.",
  );
  dom.window.close();
});

test("dashboard renders structured ASI evidence without object coercion", async () => {
  const structuredEvidence = [
    { label: "Command", detail: "node scripts/check.mjs" },
    { path: "reports/probe.json", line: 42 },
  ];
  const entries = [
    dashboardConfigEntry({ name: "structured evidence", metricName: "quality_gap" }),
    {
      type: "run",
      run: 1,
      metric: 0.444,
      status: "keep",
      description: "Structured evidence packet",
      asi: {
        hypothesis: { summary: "Derive exact probes from sidecar results." },
        evidence: structuredEvidence,
        next_action_hint: { title: "Next probe", detail: "Run exact command-derived probes." },
      },
      confidence: 1,
    },
  ];

  assert.equal(
    asiText({ asi: { evidence: structuredEvidence } } as unknown as SessionRun, ["evidence"]),
    "Command: node scripts/check.mjs; path=reports/probe.json, line=42",
  );

  const { dom } = await runDashboard(entries, emptyCommandMeta());
  const dashboardText = dom.window.document.querySelector("main")?.textContent || "";

  assert.match(dashboardText, /Command: node scripts\/check\.mjs/);
  assert.match(dashboardText, /path=reports\/probe\.json, line=42/);
  assert.match(dashboardText, /Next probe: Run exact command-derived probes/);
  assert.doesNotMatch(dashboardText, /\[object Object\]/);
  dom.window.close();
});

test("dashboard renders the full run log without blank scroll space", async () => {
  const entries = [
    dashboardConfigEntry({ name: "long log path", metricName: "seconds", metricUnit: "s" }),
    ...Array.from({ length: 100 }, (_, index) => ({
      type: "run",
      run: index + 1,
      metric: 100 - index,
      status: index % 5 === 0 ? "discard" : "keep",
      description: `Experiment ${index + 1}`,
      confidence: 1,
      asi: { hypothesis: `Hypothesis ${index + 1}` },
    })),
  ];

  const { getById } = await runDashboard(entries, emptyCommandMeta());
  const ledgerHtml = getById("ledger-body").innerHTML;
  const renderedRows = ledgerHtml.match(/ledger-row/g) || [];

  assert.equal(getById("ledger").hidden, false);
  assert.match(getById("ledger-note").textContent, /100 runs \/ newest first/);
  assert.equal(renderedRows.length, 100);
  assert.equal(getById("ledger-scroll").querySelector("table")?.tagName, "TABLE");
  assert.equal(getById("ledger-body").tagName, "TBODY");
  assert.match(ledgerHtml, /#100/);
  assert.match(ledgerHtml, /#1<\/td>/);
});

test("dashboard renders the newest 100 of 5,000 rows and loads older rows in batches", async () => {
  const entries = [
    dashboardConfigEntry({ name: "large ledger", metricName: "seconds", metricUnit: "s" }),
    ...Array.from({ length: 5_000 }, (_, index) => ({
      type: "run",
      run: index + 1,
      metric: null,
      status: "crash",
      description: `Run ${index + 1}`,
    })),
  ];
  const { dom, getById } = await runDashboard(entries, emptyCommandMeta());

  assert.equal(getById("ledger-body").querySelectorAll("tr").length, 100);
  assert.match(getById("ledger-note").textContent || "", /4900 older runs available/);
  const loadOlder = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === "Load 100 older",
  );
  assert.ok(loadOlder);
  loadOlder.click();
  await waitFor(
    () => getById("ledger-body").querySelectorAll("tr").length === 200,
    "Ledger did not load the next 100 older rows.",
  );
  assert.match(getById("ledger-note").textContent || "", /4800 older runs available/);
});

test("dashboard rejects malformed injected ledger entries", async () => {
  const { getById, queryById } = await runDashboard(
    [
      dashboardConfigEntry({ name: "malformed ledger", metricName: "seconds", metricUnit: "s" }),
      { type: "run", run: 1, metric: 5, status: "keep", description: "Valid" },
      { type: "run", run: 2, metric: 4, status: "not-a-status", description: "Invalid" },
    ],
    emptyCommandMeta({ ledgerBounds: { invalidLedgerEntryCount: 2 } }),
  );

  assert.match(getById("payload-failure-reason").textContent || "", /invalid status/);
  assert.equal(queryById("ledger-body"), null);
});

test("dashboard rejects unknown explicit ledger entry types before rendering evidence", async () => {
  const { getById, queryById } = await runDashboard(
    [
      dashboardConfigEntry({ name: "unknown ledger type", metricName: "seconds" }),
      { type: "event", message: "Not a supported Autoresearch ledger record" },
    ],
    emptyCommandMeta(),
  );

  assert.match(getById("payload-failure-reason").textContent || "", /invalid auxiliary/);
  assert.equal(queryById("ledger-body"), null);
});

test("dashboard labels bounded static export ledgers as partial", async () => {
  const entries = [
    dashboardConfigEntry({ name: "bounded export", metricName: "seconds", metricUnit: "s" }),
    ...Array.from({ length: 12 }, (_, index) => ({
      type: "run",
      run: index + 1,
      metric: 100 - index,
      status: "keep",
      description: `Experiment ${index + 1}`,
      confidence: 1,
    })),
  ];

  const { getById } = await runDashboard(
    entries,
    emptyCommandMeta({
      deliveryMode: "static-export",
      ledgerBounds: {
        truncated: true,
        omittedEntries: 101,
        maxEntries: 5000,
        summarySource: "full-ledger-stream",
      },
      viewModel: { summary: { segment: 0, runs: 113, kept: 110 } },
    }),
  );

  assert.match(
    getById("ledger-note").textContent,
    /12 runs \/ newest first \/ 101 older ledger entries omitted from snapshot \/ summary uses the full streamed ledger/,
  );
  assert.equal(getById("runs-value").textContent, "113 (110 kept)");
  assert.match(
    getById("ledger-scroll").querySelector("table")?.getAttribute("aria-label") || "",
    /12 shown, 101 older ledger entries omitted from snapshot/,
  );
});
