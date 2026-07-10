import assert from "node:assert/strict";
import test from "node:test";
import { buildChart, DASHBOARD_CHART_MAX_POINTS } from "../../dashboard/src/model/chart.js";
import { formatCompactMetricTick } from "../../dashboard/src/model/formatting.js";
import { normalizeEntries } from "../../dashboard/src/model/entries.js";
import { buildReadout } from "../../dashboard/src/model/readout.js";
import { type SessionRun } from "../../dashboard/src/types.js";
import {
  createDashboardHarness,
  dashboardConfigEntry,
  emptyCommandMeta,
  waitFor,
} from ".././helpers/dashboard.js";
import { chartLayoutOptions } from "./test-helpers.js";

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

test("dashboard chart downsamples long histories while preserving anchor points", () => {
  const runs: SessionRun[] = Array.from(
    { length: DASHBOARD_CHART_MAX_POINTS + 75 },
    (_, index) => ({
      run: index + 1,
      metric: index + 1,
      status: "keep",
      description: `Run ${index + 1}`,
      metrics: {},
      asi: {},
      segment: 0,
    }),
  );
  const bestRun = runs[250]!;
  const chart = buildChart(
    {
      segment: 0,
      config: { metricName: "seconds", metricUnit: "s", bestDirection: "lower" },
      runs,
    },
    {
      baseline: 1,
      baselineRun: runs[0],
      best: bestRun.metric,
      bestRun,
      latestPlottedRun: runs.at(-1) || null,
      latestFailure: null,
      nextAction: "Continue.",
      confidence: null,
      confidenceText: "",
      improvement: null,
      recentRuns: runs.slice(-4),
      plottedRuns: runs,
      invalidLedgerEntryCount: 0,
      metricDefinition: {
        requestedMode: "raw",
        mode: "raw",
        metricName: "seconds",
        displayUnit: "s",
        bestDirection: "lower",
        valueLabel: "Real value",
        percentLabel: "Percent",
        weights: { time: 0.7, memory: 0.3 },
        memoryKey: "memory_mb",
        formulaInline: "",
        formulaDetails: "",
        formulaSource: "",
        formulaConfigured: false,
        fallbackNote: "",
        baselineMetric: 1,
        baselineTime: 1,
        baselineMemory: null,
      },
    },
  );

  assert.ok(chart.points.length <= DASHBOARD_CHART_MAX_POINTS);
  assert.equal(chart.points[0].run.run, 1);
  assert.equal(chart.points.at(-1)?.run.run, runs.length);
  assert.ok(chart.points.some((point) => point.run === bestRun));
});

test("dashboard summary cannot override the best accepted visible keep", () => {
  const runs: SessionRun[] = Array.from({ length: 4 }, (_, index) => ({
    run: index + 102,
    metric: index + 102,
    status: "keep",
    description: `Visible run ${index + 102}`,
    metrics: {},
    asi: {},
    segment: 0,
  }));
  const session = {
    segment: 0,
    config: { metricName: "seconds", metricUnit: "s", bestDirection: "lower" },
    runs,
  };
  const readout = buildReadout(session, {
    summary: { segment: 0, baseline: 101, best: 1, runs: 105 },
  });
  const chart = buildChart(session, readout);

  assert.equal(readout.best, 102);
  assert.equal(readout.bestRun?.run, 102);
  assert.match(chart.summary, /Best #102 at 102s/);
});

test("dashboard uses measure 10 as the raw and weighted baseline before keep 8", () => {
  const runs: SessionRun[] = [
    {
      run: 1,
      metric: 10,
      status: "measure",
      description: "Baseline measure",
      metrics: { memory_mb: 100 },
      asi: {},
      segment: 0,
    },
    {
      run: 2,
      metric: 8,
      status: "keep",
      description: "Accepted improvement",
      metrics: { memory_mb: 100 },
      asi: {},
      segment: 0,
    },
    {
      run: 3,
      metric: 6,
      status: "discard",
      description: "Rejected shortcut",
      metrics: { memory_mb: 100 },
      asi: {},
      segment: 0,
    },
  ];
  const summary = { summary: { segment: 0, baseline: 10, best: 6 } };
  const raw = buildReadout(
    {
      segment: 0,
      config: { metricName: "seconds", metricUnit: "s", bestDirection: "lower" },
      runs,
    },
    summary,
  );
  const weighted = buildReadout(
    {
      segment: 0,
      config: {
        metricName: "seconds",
        metricUnit: "s",
        bestDirection: "lower",
        metricDefinition: { mode: "weighted_cost", weights: { time: 0.7, memory: 0.3 } },
      },
      runs,
    },
    summary,
  );

  assert.equal(raw.baseline, 10);
  assert.equal(raw.baselineRun?.status, "measure");
  assert.equal(raw.best, 8);
  assert.equal(raw.bestRun?.status, "keep");
  assert.equal(weighted.baseline, 1);
  assert.equal(weighted.baselineRun?.status, "measure");
  assert.equal(weighted.best, 0.86);
  assert.equal(weighted.bestRun?.status, "keep");
});

test("dashboard ledger normalization skips malformed rows without expanding segment arrays", () => {
  const normalized = normalizeEntries([
    dashboardConfigEntry({ name: "hostile ledger", metricName: "score" }),
    { type: "run", run: 1, metric: 1, status: "keep", segment: 5_000_000 },
    { type: "run", run: 2, metric: 2, status: "unknown" },
    { type: "run", run: 3, metric: 3, status: "keep", segment: -1 },
    { type: "run", run: 4, metric: 4, status: "keep", segment: 1.5 },
    { type: "run", run: 5, metric: 5, status: "keep", segment: Number.MAX_SAFE_INTEGER + 1 },
    { type: "run", run: 6, metric: 6 },
    { type: "event", message: "Legitimate non-run ledger record" },
  ] as any);

  assert.deepEqual(
    normalized.segments.map((segment) => segment.segment),
    [0, 5_000_000],
  );
  assert.equal(normalized.latestSegment, 5_000_000);
  assert.equal(normalized.segments.at(-1)?.runs.length, 1);
  assert.equal(normalized.invalidLedgerEntryCount, 5);

  const maxed = normalizeEntries([
    dashboardConfigEntry({ name: "max segment", metricName: "score" }),
    { type: "run", run: 1, metric: 1, status: "keep", segment: Number.MAX_SAFE_INTEGER },
    dashboardConfigEntry({ name: "cannot advance", metricName: "score" }),
  ] as any);
  assert.deepEqual(
    maxed.segments.map((segment) => segment.segment),
    [0, Number.MAX_SAFE_INTEGER],
  );
  assert.equal(maxed.invalidLedgerEntryCount, 1);
});

test("dashboard chart crash copy distinguishes visible crashes from plotted crashes", () => {
  const runs: SessionRun[] = Array.from({ length: 1000 }, (_, index) => {
    const run = index + 1;
    const crash = run % 5 === 0;
    return {
      run,
      metric: crash ? null : run,
      status: crash ? "crash" : "keep",
      description: `${crash ? "Crash" : "Keep"} ${run}`,
      metrics: {},
      asi: {},
      segment: 0,
    };
  });
  const session = {
    segment: 0,
    config: { metricName: "seconds", metricUnit: "s", bestDirection: "lower" },
    runs,
  };
  const readout = buildReadout(session);
  const chart = buildChart(session, readout);

  assert.match(chart.summary, /200 crash runs in visible history; \d+ plotted after downsampling/);
  assert.doesNotMatch(chart.summary, /200 crash runs are plotted/);
});

test("dashboard chart handles very large histories without spread limits", () => {
  const runCount = 150_000;
  const runs: SessionRun[] = Array.from({ length: runCount }, (_, index) => ({
    run: index + 1,
    metric: index + 1,
    status: "keep",
    description: `Run ${index + 1}`,
    metrics: {},
    asi: {},
    segment: 0,
  }));
  const bestRun = runs.at(-1)!;
  const chart = buildChart(
    {
      segment: 0,
      config: { metricName: "quality", metricUnit: "pts", bestDirection: "higher" },
      runs,
    },
    {
      baseline: 1,
      baselineRun: runs[0],
      best: bestRun.metric,
      bestRun,
      latestPlottedRun: bestRun,
      latestFailure: null,
      nextAction: "Continue.",
      confidence: null,
      confidenceText: "",
      improvement: null,
      recentRuns: runs.slice(-4),
      plottedRuns: runs,
      invalidLedgerEntryCount: 0,
      metricDefinition: {
        requestedMode: "raw",
        mode: "raw",
        metricName: "quality",
        displayUnit: "pts",
        bestDirection: "higher",
        valueLabel: "Real value",
        percentLabel: "Percent",
        weights: { time: 0.7, memory: 0.3 },
        memoryKey: "memory_mb",
        formulaInline: "",
        formulaDetails: "",
        formulaSource: "",
        formulaConfigured: false,
        fallbackNote: "",
        baselineMetric: 1,
        baselineTime: 1,
        baselineMemory: null,
      },
    },
  );

  assert.ok(chart.points.length <= DASHBOARD_CHART_MAX_POINTS);
  assert.equal(chart.points.at(-1)?.run.run, runCount);
  assert.match(chart.summary, /\d+ plotted runs out of 150000 logged runs/);
  assert.match(chart.note, /150000 finite measurements/);
});

test("dashboard weighted score readout uses configured metric weights", async () => {
  const entries = [
    {
      type: "config",
      name: "weighted path",
      metricName: "seconds",
      metricUnit: "s",
      bestDirection: "lower",
      metricMode: "weighted_cost",
      metricWeights: { time: 2, memory: 1 },
      metricMemoryKey: "memory_mb",
    },
    {
      type: "run",
      run: 1,
      metric: 10,
      status: "keep",
      description: "Baseline weighted cost",
      metrics: { memory_mb: 100 },
      confidence: 1,
    },
    {
      type: "run",
      run: 2,
      metric: 8,
      status: "keep",
      description: "Faster with more memory",
      metrics: { memory_mb: 120 },
      confidence: 1,
    },
  ];

  const { getById } = await runDashboard(entries, emptyCommandMeta());

  assert.equal(getById("metric-construction-status").textContent, "Weighted formula");
  assert.match(
    getById("metric-construction-formula").textContent,
    /score = 0\.67 \* time_score \+ 0\.33 \* memory_score/,
  );
  assert.match(getById("metric-construction-components").textContent, /time 0\.67/);
  assert.match(getById("metric-construction-components").textContent, /memory 0\.33/);
  assert.match(getById("metric-detail-equation").textContent, /\(0\.67 \* 0\.80\)/);
  assert.match(getById("metric-detail-equation").textContent, /\(0\.33 \* 1\.20\)/);
});

test("dashboard ledger and truth meter do not coerce unknown evidence to zero", async () => {
  const entries = [
    dashboardConfigEntry({ name: "unknown evidence", metricName: "seconds", metricUnit: "s" }),
    {
      type: "run",
      run: 1,
      status: "crash",
      description: "Metricless failure",
      confidence: null,
      asi: { rollback_reason: "Benchmark crashed before reporting a metric." },
    },
  ];

  const { getById } = await runDashboard(entries, emptyCommandMeta(), {
    url: "file:///autoresearch-dashboard.html?view=audit",
  });
  const ledger = getById("ledger").textContent;
  assert.doesNotMatch(ledger, /0%/);
  assert.match(ledger, /-/);

  const truth = getById("research-truth-bar");
  assert.equal(truth.getAttribute("aria-valuenow"), null);
  assert.match(truth.getAttribute("aria-valuetext"), /unknown/i);
});

test("dashboard family/plateau display marks best row and zero-delta plateau clearly", async () => {
  const entries = [
    dashboardConfigEntry({ name: "plateau path", metricName: "seconds", metricUnit: "s" }),
    {
      type: "run",
      run: 1,
      metric: 10,
      status: "keep",
      description: "Warm cache enabled",
      confidence: 1,
      asi: { hypothesis: "Baseline plateau." },
    },
    {
      type: "run",
      run: 2,
      metric: 12,
      status: "discard",
      description: "Increased batch size",
      confidence: 1,
    },
    {
      type: "run",
      run: 3,
      metric: 10,
      status: "keep",
      description: "Alternate cache key",
      confidence: 1,
    },
  ];

  const { getById } = await runDashboard(entries, emptyCommandMeta());
  const ledgerHtml = getById("ledger-body").innerHTML;
  const readout = getById("best-kept-detail").textContent;

  assert.match(ledgerHtml, /best-row/);
  assert.match(ledgerHtml, /0%/);
  assert.match(ledgerHtml, /#3/);
  assert.match(readout, /Warm cache enabled/);
});

test("dashboard handles zero and negative metrics without unsafe percent or sign artifacts", async () => {
  const entries = [
    {
      type: "config",
      name: "negative path",
      metricName: "delta",
      bestDirection: "lower",
      metricUnit: "",
    },
    {
      type: "run",
      run: 1,
      metric: 0,
      status: "keep",
      description: "Zero baseline",
      confidence: 1,
    },
    {
      type: "run",
      run: 2,
      metric: -2,
      status: "keep",
      description: "Crosses below zero",
      confidence: 1,
      asi: { next_action_hint: "Track stability after crossing baseline." },
    },
    {
      type: "run",
      run: 3,
      metric: -2,
      status: "discard",
      description: "Plateau below zero",
      confidence: 1,
    },
  ];

  const { getById } = await runDashboard(entries, emptyCommandMeta());
  const chart = getById("trend-chart").innerHTML;
  const improvement = getById("improvement-value").textContent;
  const baseline = getById("baseline-value").textContent;
  const best = getById("best-value").textContent;
  const delta = getById("ledger-body").innerHTML;

  assert.equal(improvement, "-");
  assert.equal(baseline, "0");
  assert.equal(best, "-2");
  assert.match(chart, /-2/);
  assert.doesNotMatch(chart, /Infinity|NaN/);
  assert.doesNotMatch(delta, /Infinity|NaN/);
  assert.match(delta, />-</);
  assert.match(getById("next-action-detail").textContent, /Track stability/);
});

test("dashboard holds crash runs at the nearest successful metric level", async () => {
  const entries = [
    {
      type: "config",
      name: "crash clip path",
      metricName: "score",
      bestDirection: "higher",
      metricUnit: "points",
    },
    { type: "run", run: 1, metric: 100, status: "keep", description: "Baseline", confidence: 1 },
    {
      type: "run",
      run: 2,
      metric: 0,
      status: "crash",
      description: "Crashed packet",
      confidence: 1,
    },
    {
      type: "run",
      run: 3,
      metric: 104,
      status: "discard",
      description: "Measured regression",
      confidence: 1,
    },
    { type: "run", run: 4, metric: 106, status: "keep", description: "Recovered", confidence: 1 },
  ];

  const { getById } = await runDashboard(entries, emptyCommandMeta());
  const chart = getById("trend-chart").innerHTML;
  const note = getById("chart-note").textContent;
  const summary = getById("trend-chart-summary").textContent;

  assert.match(note, /3 finite measurements; crashes held out of best evidence\./);
  assert.match(note, /crashes held out of best evidence/);
  assert.match(summary, /4 plotted runs out of 4 logged runs/);
  assert.match(summary, /1 crash run is plotted at the nearest successful metric level/);
  assert.match(chart, /#4/);
  assert.match(chart, /#2/);
  assert.doesNotMatch(chart, /Infinity|NaN/);
});

test("dashboard chart note does not mention crashes when all plotted runs are finite", async () => {
  const entries = [
    {
      type: "config",
      name: "finite packet trend",
      metricName: "seconds",
      bestDirection: "lower",
      metricUnit: "s",
    },
    { type: "run", run: 1, metric: 100, status: "keep", description: "Baseline", confidence: 1 },
    { type: "run", run: 2, metric: 95, status: "keep", description: "Improved", confidence: 1 },
    { type: "run", run: 3, metric: 97, status: "discard", description: "Slower", confidence: 1 },
  ];

  const { getById } = await runDashboard(entries, emptyCommandMeta());
  const note = getById("chart-note").textContent || "";

  assert.equal(note, "3 finite measurements.");
  assert.doesNotMatch(note, /crash/i);
});

test("dashboard does not label raw score metrics as baseline time", async () => {
  const entries = [
    {
      type: "config",
      name: "raw score path",
      metricName: "pipeline_score",
      bestDirection: "higher",
      metricUnit: "points",
    },
    {
      type: "run",
      run: 1,
      metric: 873608.88442,
      status: "keep",
      description: "Baseline",
      confidence: 1,
    },
  ];

  const { queryById, getById } = await runDashboard(entries, emptyCommandMeta());

  assert.equal(queryById("metric-detail-baseline-time"), null);
  assert.equal(queryById("metric-detail-baseline-value"), null);
  assert.match(getById("metric-construction-inputs").textContent, /primary: pipeline_score/);
  assert.match(getById("metric-detail-primary").textContent || "", /873608.88points/);
});

test("dashboard renders formatted x-axis labels when timestamp mode is enabled", async () => {
  const entries = [
    {
      type: "config",
      name: "timestamp axis path",
      metricName: "score",
      bestDirection: "lower",
      metricUnit: "",
    },
    ...Array.from({ length: 8 }, (_, index) => ({
      type: "run",
      run: index + 1,
      metric: 10 - index * 0.4,
      status: index % 3 === 0 ? "keep" : "discard",
      description: `Run ${index + 1}`,
      confidence: 1,
      timestamp:
        index % 2 === 0
          ? Date.UTC(2026, 3, 23, 14, index * 9, 0)
          : new Date(Date.UTC(2026, 3, 23, 14, index * 9, 0)).toISOString(),
    })),
  ];

  const { dom, getById } = await runDashboard(entries, emptyCommandMeta(), chartLayoutOptions());
  const buttons = Array.from(dom.window.document.querySelectorAll("button"));
  const timestampButton = buttons.find((button) => button.textContent?.trim() === "Timestamp");
  assert.ok(timestampButton, "Missing timestamp axis toggle");

  timestampButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await waitFor(
    () => timestampButton.getAttribute("aria-pressed") === "true",
    "Timestamp axis toggle did not activate.",
  );

  const axisText = Array.from(
    getById("trend-chart").querySelectorAll(".recharts-cartesian-axis-tick-value"),
  )
    .map((node) => node.textContent?.trim() || "")
    .filter(Boolean);
  const timestampLikeLabels = axisText.filter((label) => label.includes(":"));
  const chartButton = getById("trend-chart").querySelector(".chart-point-button");

  assert.ok(
    timestampLikeLabels.length >= 4,
    `Expected timestamp labels in x-axis ticks, saw: ${axisText.join(", ")}`,
  );
  assert.equal(chartButton?.tagName.toLowerCase(), "button");
  assert.equal(chartButton?.getAttribute("aria-haspopup"), "dialog");
  assert.match(chartButton?.getAttribute("aria-label") || "", /Open details for run/);
});

test("dashboard formats large raw y-axis labels compactly", () => {
  const labels = [873376.79, 882198.78, 891020.77].map((value) =>
    formatCompactMetricTick(value, "score", [873376.79, 891020.77]),
  );

  assert.deepEqual(labels, ["873k", "882k", "891k"]);
});

test("dashboard holds leading crash runs at the next successful metric level", async () => {
  const entries = [
    {
      type: "config",
      name: "leading crash path",
      metricName: "seconds",
      bestDirection: "lower",
      metricUnit: "s",
    },
    { type: "run", run: 1, status: "crash", description: "Crashed before metric", confidence: 1 },
    {
      type: "run",
      run: 2,
      metric: 12,
      status: "keep",
      description: "Baseline recovered",
      confidence: 1,
    },
    { type: "run", run: 3, metric: 10, status: "keep", description: "Improved", confidence: 1 },
  ];

  const { getById } = await runDashboard(entries, emptyCommandMeta());
  const chart = getById("trend-chart").innerHTML;
  const summary = getById("trend-chart-summary").textContent;

  assert.match(summary, /3 plotted runs out of 3 logged runs/);
  assert.match(summary, /1 crash run is plotted at the nearest successful metric level/);
  assert.match(chart, /#1/);
  assert.match(chart, /#2/);
  assert.doesNotMatch(chart, /Infinity|NaN/);
});

test("dashboard does not let held crash metrics become best evidence", async () => {
  const entries = [
    {
      type: "config",
      name: "lower crash clip path",
      metricName: "seconds",
      bestDirection: "lower",
      metricUnit: "s",
    },
    { type: "run", run: 1, metric: 100, status: "keep", description: "Baseline", confidence: 1 },
    {
      type: "run",
      run: 2,
      metric: 0,
      status: "crash",
      description: "Crashed packet",
      confidence: 1,
    },
    { type: "run", run: 3, metric: 95, status: "keep", description: "Recovered", confidence: 1 },
  ];

  const { getById } = await runDashboard(entries, emptyCommandMeta());
  const note = getById("chart-note").textContent;
  const summary = getById("trend-chart-summary").textContent;

  assert.equal(getById("best-value").textContent, "95s");
  assert.equal(getById("improvement-value").textContent, "+5.0%");
  assert.match(note, /2 finite measurements; crashes held out of best evidence\./);
  assert.doesNotMatch(note, /Best 0s/);
  assert.match(summary, /Best #3 at 95s/);
});

test("dashboard explains one-run metric evidence instead of generic formula copy", async () => {
  const entries = [
    dashboardConfigEntry({
      name: "one run quality",
      metricName: "quality_gap",
      metricUnit: "gaps",
    }),
    {
      type: "run",
      run: 34,
      metric: 7,
      status: "keep",
      description: "Only packet in segment",
      metrics: { quality_total: 12, quality_closed: 5 },
      asi: {
        hypothesis: "Close accepted quality gaps.",
        evidence: "Seven gaps remain after the packet.",
        next_action_hint: "Run the next quality gap packet.",
      },
      confidence: 1,
    },
  ];

  const { getById } = await runDashboard(entries, emptyCommandMeta());

  assert.match(getById("chart-note").textContent, /No trend yet/);
  assert.match(getById("trend-chart-summary").textContent, /No trend or comparison exists yet/);
  assert.equal(getById("metric-construction-status").textContent, "Formula missing");
  assert.match(getById("metric-construction-formula").textContent, /METRIC quality_gap=<number>/);
  assert.match(getById("metric-construction-inputs").textContent, /quality_total/);
  assert.match(getById("metric-construction-inputs").textContent, /quality_closed/);
  assert.equal(getById("metric-details-title").textContent, "Selected run evidence");
  assert.match(getById("metric-detail-primary-value").textContent, /METRIC quality_gap=7gaps/);
  assert.match(getById("metric-detail-secondary").textContent, /quality_total = 12/);
  assert.match(getById("metric-detail-secondary").textContent, /quality_closed = 5/);
  assert.match(getById("metric-detail-warnings").textContent, /No configured formula explains/);
});
