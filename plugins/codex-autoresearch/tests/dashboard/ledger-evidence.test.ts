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
  assert.match(dashboardCss, /\.chart-point\.discard/);
  assert.match(dashboardCss, /\.experiment-modal\.status-discard/);
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

test("dashboard pages the full run log without duplicate history markup", async () => {
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
  assert.match(getById("ledger-note").textContent, /20 shown of 100 runs \/ page 1 of 5/);
  assert.equal(renderedRows.length, 20);
  assert.equal(getById("ledger-scroll").querySelector("table")?.tagName, "TABLE");
  assert.equal(getById("ledger-body").tagName, "TBODY");
  assert.match(ledgerHtml, /#100/);
  assert.doesNotMatch(ledgerHtml, /#1<\/td>/);
  assert.equal(getById("ledger").querySelectorAll("table").length, 1);
});

test("dashboard renders 20 of 5,000 rows and pages to older runs", async () => {
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

  assert.equal(getById("ledger-body").querySelectorAll("tr").length, 20);
  assert.match(getById("ledger-note").textContent || "", /page 1 of 250/);
  const olderRuns = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === "Older runs",
  );
  assert.ok(olderRuns);
  olderRuns.click();
  await waitFor(
    () => getById("ledger-note").textContent?.includes("page 2 of 250") === true,
    "Ledger did not show the next 20 older rows.",
  );
  assert.equal(getById("ledger-body").querySelectorAll("tr").length, 20);
  assert.match(getById("ledger-body").textContent || "", /#4980/);
});

test("dashboard does not resurrect a stale page after same-segment shrink and regrowth", async () => {
  const entriesFor = (count: number) => [
    dashboardConfigEntry({ name: "resizing ledger", metricName: "seconds", metricUnit: "s" }),
    ...Array.from({ length: count }, (_, index) => ({
      type: "run",
      run: index + 1,
      metric: count - index,
      status: "keep",
      description: `Run ${index + 1}`,
    })),
  ];
  const payloads = [100, 25, 100].map((count) => ({
    ledgerEntries: entriesFor(count),
    ledgerBounds: { truncated: false, omittedEntries: 0, maxEntries: 5_000 },
    summary: { segment: 0, baseline: count, best: 1, runs: count },
  }));
  const { dom, getById } = await runDashboard(
    entriesFor(100),
    emptyCommandMeta({
      deliveryMode: "live-server",
      liveRefreshAvailable: true,
      liveActionsAvailable: false,
      refreshMs: 60_000,
      viewModel: payloads[0],
    }),
    {
      beforeParse(window) {
        window.__ledgerRefreshIndex = 0;
        window.fetch = async () => ({
          ok: true,
          json: async () => payloads[Math.min(window.__ledgerRefreshIndex++, 2)],
        });
        window.setInterval = () => 1;
        window.clearInterval = () => {};
      },
    },
  );
  const olderRuns = () =>
    [...dom.window.document.querySelectorAll<HTMLButtonElement>(".ledger-pagination button")].find(
      (button) => button.textContent?.trim() === "Older runs",
    );
  for (const page of [2, 3, 4]) {
    olderRuns()?.click();
    await waitFor(
      () => getById("ledger-note").textContent?.includes(`page ${page} of 5`) === true,
      `Ledger did not reach page ${page}.`,
    );
  }

  getById("refresh-now").click();
  await waitFor(
    () => getById("ledger-note").textContent?.includes("page 2 of 2") === true,
    "Ledger did not clamp after shrink.",
  );
  await waitFor(
    () => (getById("refresh-now") as HTMLButtonElement).disabled === false,
    "Shrink refresh did not settle.",
  );
  getById("refresh-now").click();
  await waitFor(
    () => getById("ledger-note").textContent?.includes("page 2 of 5") === true,
    "Ledger resurrected the stale page after regrowth.",
  );
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
  assert.equal(queryById("ledger-body") === null, true);
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
  assert.equal(queryById("ledger-body") === null, true);
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
    /12 shown of 12 runs \/ page 1 of 1 \/ newest first \/ 101 older ledger entries omitted from snapshot \/ summary uses the full streamed ledger/,
  );
  assert.equal(getById("runs-value").textContent, "113 (110 kept)");
  assert.match(
    getById("ledger-scroll").querySelector("table")?.getAttribute("aria-label") || "",
    /12 shown of 12 runs, 101 older ledger entries omitted from snapshot/,
  );
});
