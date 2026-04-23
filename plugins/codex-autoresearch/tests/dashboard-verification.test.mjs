import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { build as viteBuild } from "vite";
import { buildDashboardViewModel } from "../lib/dashboard-view-model.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, "..");
const dashboardTemplatePath = path.join(pluginRoot, "assets", "template.html");
const dashboardBuildPath = path.join(pluginRoot, "assets", "dashboard-build", "dashboard-app.js");
const dashboardCssPath = path.join(pluginRoot, "assets", "dashboard-build", "dashboard-app.css");
let tempBuildDir = "";
let dashboardAssets = null;

test.before(async () => {
  tempBuildDir = await mkdtemp(path.join(tmpdir(), "autoresearch-dashboard-test-"));
  await viteBuild({
    configFile: path.join(pluginRoot, "vite.dashboard.config.mjs"),
    logLevel: "silent",
    build: {
      outDir: tempBuildDir,
      emptyOutDir: true,
    },
  });
  dashboardAssets = {
    app: await readFile(path.join(tempBuildDir, "dashboard-app.js"), "utf8"),
    css: await readFile(path.join(tempBuildDir, "dashboard-app.css"), "utf8"),
  };
});

test.after(async () => {
  if (tempBuildDir) await rm(tempBuildDir, { recursive: true, force: true });
});

const runDashboard = async (entries, meta = {}, options = {}) => {
  const template = await readFile(dashboardTemplatePath, "utf8");
  const app = dashboardAssets?.app || await readFile(dashboardBuildPath, "utf8");
  const css = dashboardAssets?.css || await readFile(dashboardCssPath, "utf8");
  const html = template
    .replace("__AUTORESEARCH_DATA_PAYLOAD__", () => JSON.stringify(entries).replace(/</g, "\\u003c"))
    .replace("__AUTORESEARCH_META_PAYLOAD__", () => JSON.stringify(meta).replace(/</g, "\\u003c"))
    .replace("__AUTORESEARCH_DASHBOARD_CSS__", () => css)
    .replace("__AUTORESEARCH_DASHBOARD_APP__", () => app);
  const dom = new JSDOM(html, {
    pretendToBeVisual: true,
    runScripts: "dangerously",
    url: options.url || (meta.deliveryMode === "live-server" ? "http://127.0.0.1/" : "file:///autoresearch-dashboard.html"),
    beforeParse: options.beforeParse,
  });
  await waitForDashboardReady(dom.window);
  const getById = (id) => {
    const element = dom.window.document.getElementById(id);
    assert.ok(element, `Missing dashboard element: ${id}`);
    return element;
  };
  return { dom, getById };
};

async function waitForDashboardReady(window) {
  await waitFor(() => window.__AUTORESEARCH_DASHBOARD_READY__, "Dashboard React app did not finish rendering.");
}

async function waitFor(predicate, message) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 2000) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function setInputValue(window, element, value) {
  const prototype = element.tagName === "TEXTAREA"
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
  element.dispatchEvent(new window.Event("input", { bubbles: true }));
  element.dispatchEvent(new window.Event("change", { bubbles: true }));
}

test("dashboard DOM renders non-blank next action in operator rail", async () => {
  const entries = [
    { type: "config", name: "zero path", metricName: "seconds", bestDirection: "lower", metricUnit: "s" },
    {
      type: "run",
      run: 1,
      metric: 5.4,
      status: "keep",
      description: "Baseline baseline",
      asi: { next_action_hint: "Try reducing startup overhead." },
      confidence: 1,
    },
    {
      type: "run",
      run: 2,
      metric: 4.9,
      status: "discard",
      description: "Noisy baseline",
      confidence: 1,
    },
    {
      type: "run",
      run: 3,
      metric: 4.8,
      status: "keep",
      description: "Cache manifest",
      confidence: 1,
    },
  ];

  const { getById } = await runDashboard(entries, { commands: [] });
  const rail = getById("decision-rail").innerHTML;
  const nextActionDetail = getById("next-action-detail").textContent.trim();
  const nextActionTitle = getById("next-action-title").textContent.trim();

  assert.match(rail, /#1/);
  assert.match(rail, /Keep|Discard|crash|checks_failed/i);
  assert.notEqual(rail.includes("No decisions yet"), true);
  assert.match(nextActionTitle, /Next action/i);
  assert.equal(nextActionDetail, "Try reducing startup overhead.");
});

test("dashboard ledger and truth meter do not coerce unknown evidence to zero", async () => {
  const entries = [
    { type: "config", name: "unknown evidence", metricName: "seconds", bestDirection: "lower", metricUnit: "s" },
    {
      type: "run",
      run: 1,
      status: "crash",
      description: "Metricless failure",
      confidence: null,
      asi: { rollback_reason: "Benchmark crashed before reporting a metric." },
    },
  ];

  const { getById } = await runDashboard(entries, { commands: [] });
  const ledger = getById("ledger").textContent;
  assert.doesNotMatch(ledger, /0%/);
  assert.match(ledger, /-/);

  const truth = getById("research-truth-bar");
  assert.equal(truth.getAttribute("aria-valuenow"), null);
  assert.match(truth.getAttribute("aria-valuetext"), /unknown/i);
});

test("dashboard family/plateau display marks best row and zero-delta plateau clearly", async () => {
  const entries = [
    { type: "config", name: "plateau path", metricName: "seconds", bestDirection: "lower", metricUnit: "s" },
    {
      type: "run",
      run: 1,
      metric: 10,
      status: "keep",
      description: "Warm cache enabled",
      confidence: 1,
      asi: { hypothesis: "Baseline plateau." },
    },
    { type: "run", run: 2, metric: 12, status: "discard", description: "Increased batch size", confidence: 1 },
    { type: "run", run: 3, metric: 10, status: "keep", description: "Alternate cache key", confidence: 1 },
  ];

  const { getById } = await runDashboard(entries, { commands: [] });
  const ledgerHtml = getById("ledger-body").innerHTML;
  const readout = getById("best-kept-detail").textContent;

  assert.match(ledgerHtml, /best-row/);
  assert.match(ledgerHtml, /0%/);
  assert.match(ledgerHtml, /#3/);
  assert.match(readout, /Warm cache enabled/);
});

test("dashboard renders the run log as a virtualized top-of-page scroll area", async () => {
  const entries = [
    { type: "config", name: "long log path", metricName: "seconds", bestDirection: "lower", metricUnit: "s" },
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

  const { getById } = await runDashboard(entries, { commands: [] });
  const ledgerHtml = getById("ledger-body").innerHTML;
  const renderedRows = ledgerHtml.match(/ledger-row/g) || [];

  assert.equal(getById("ledger").hidden, false);
  assert.match(getById("ledger-note").textContent, /100 runs \/ newest first \/ showing 1-16/);
  assert.equal(renderedRows.length < 30, true);
  assert.match(getById("ledger-body").getAttribute("style"), /height: 8200px/);
  assert.match(ledgerHtml, /#100/);
  assert.doesNotMatch(ledgerHtml, /#1<\/div>/);
});

test("dashboard renders a generated Codex summary of history and plan", async () => {
  const entries = [
    { type: "config", name: "summary path", metricName: "seconds", bestDirection: "lower", metricUnit: "s" },
    { type: "run", run: 1, metric: 8, status: "keep", description: "Baseline", confidence: 1, asi: { hypothesis: "Baseline." } },
    { type: "run", run: 2, metric: 6, status: "keep", description: "Faster cache", confidence: 2, asi: { next_action_hint: "Stress the cache path." } },
    { type: "run", run: 3, metric: 7, status: "discard", description: "Noisy branch", confidence: 1, asi: { rollback_reason: "Regressed latency." } },
  ];

  const viewModel = buildDashboardViewModel({
    state: {
      config: { name: "summary path", metricName: "seconds", metricUnit: "s", bestDirection: "lower" },
      segment: 0,
      current: entries.filter((entry) => entry.type === "run"),
      baseline: 8,
      best: 6,
      confidence: 2,
    },
    finalizePreview: { ready: true, nextAction: "Preview finalization." },
    experimentMemory: { latestNextAction: "Stress the cache path." },
  });

  const { getById } = await runDashboard(entries, { viewModel, commands: [] });

  assert.match(getById("ai-summary-title").textContent, /Next move is ready/);
  assert.match(getById("ai-summary-happened").innerHTML, /3 runs/);
  assert.match(getById("ai-summary-plan").innerHTML, /Stress the cache path|finalization/i);
  assert.match(getById("ai-summary-source").textContent, /latest #3/);
});

test("dashboard handles zero and negative metrics without unsafe percent or sign artifacts", async () => {
  const entries = [
    { type: "config", name: "negative path", metricName: "delta", bestDirection: "lower", metricUnit: "" },
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

  const { getById } = await runDashboard(entries, { commands: [] });
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

test("dashboard clips crash runs out of the metric trajectory scale", async () => {
  const entries = [
    { type: "config", name: "crash clip path", metricName: "score", bestDirection: "higher", metricUnit: "points" },
    { type: "run", run: 1, metric: 100, status: "keep", description: "Baseline", confidence: 1 },
    { type: "run", run: 2, metric: 0, status: "crash", description: "Crashed packet", confidence: 1 },
    { type: "run", run: 3, metric: 104, status: "discard", description: "Measured regression", confidence: 1 },
    { type: "run", run: 4, metric: 106, status: "keep", description: "Recovered", confidence: 1 },
  ];

  const { getById } = await runDashboard(entries, { commands: [] });
  const chart = getById("trend-chart").innerHTML;
  const note = getById("chart-note").textContent;
  const summary = getById("trend-chart-summary").textContent;

  assert.match(note, /latest plotted/);
  assert.match(note, /clipped 1 crash/);
  assert.match(summary, /3 plotted runs out of 4 logged runs/);
  assert.match(summary, /1 crash run is clipped out of the chart scale/);
  assert.match(chart, /#4/);
  assert.doesNotMatch(chart, /#2/);
  assert.doesNotMatch(chart, /Infinity|NaN/);
});

test("dashboard does not let clipped crash metrics become best evidence", async () => {
  const entries = [
    { type: "config", name: "lower crash clip path", metricName: "seconds", bestDirection: "lower", metricUnit: "s" },
    { type: "run", run: 1, metric: 100, status: "keep", description: "Baseline", confidence: 1 },
    { type: "run", run: 2, metric: 0, status: "crash", description: "Crashed packet", confidence: 1 },
    { type: "run", run: 3, metric: 95, status: "keep", description: "Recovered", confidence: 1 },
  ];

  const { getById } = await runDashboard(entries, { commands: [] });
  const note = getById("chart-note").textContent;
  const summary = getById("trend-chart-summary").textContent;

  assert.equal(getById("best-value").textContent, "95s");
  assert.equal(getById("improvement-value").textContent, "+5.0%");
  assert.match(note, /Best 95s/);
  assert.doesNotMatch(note, /Best 0s/);
  assert.match(summary, /Best #3 at 95s/);
});

test("stale last-run handling remains visible in dashboard guidance", async () => {
  const staleReason = "Last-run packet is stale: expected next log run #2, but current history would log #3.";
  const viewModel = {
    experimentMemory: { latestNextAction: "Measure from live backend." },
    guidedSetup: { stage: "stale-last-run" },
    lastRun: {
      generatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      freshness: {
        fresh: false,
        reason: staleReason,
      },
    },
    nextBestAction: {
      kind: "stale-packet",
      title: "Replace the stale packet",
      detail: staleReason,
      utilityCopy: "Run a fresh packet before logging so old metrics cannot be reused.",
      command: "node scripts/autoresearch.mjs next --cwd .",
      source: "packet",
    },
    actionRail: [],
    readout: { nextAction: staleReason },
  };

  const entries = [
    { type: "config", name: "stale path", metricName: "seconds", bestDirection: "lower", metricUnit: "" },
    {
      type: "run",
      run: 1,
      metric: 10,
      status: "keep",
      description: "stable baseline",
      confidence: 1,
      asi: { next_action_hint: "Follow the stale metadata check." },
    },
  ];

  const { getById } = await runDashboard(entries, {
    deliveryMode: "live-server",
    liveActionsAvailable: true,
    viewModel,
    commands: [],
  });
  const staleTimestamp = Date.parse(viewModel.lastRun.generatedAt);
  assert.equal(Number.isFinite(staleTimestamp), true);
  assert.equal(staleTimestamp <= Date.now(), true);
  assert.equal(viewModel.guidedSetup.stage, "stale-last-run");
  assert.equal(viewModel.lastRun.freshness.fresh, false);
  assert.match(getById("next-action-detail").textContent, /Last-run packet is stale/);
  assert.equal(getById("decision-rail").innerHTML.includes("No decisions yet"), false);
});

test("dashboard mission control renders explicit log-decision controls", async () => {
  const viewModel = {
    missionControl: {
      activeStep: "log",
      staticFallback: "Serve locally for live actions.",
      steps: [
        { id: "setup", title: "Setup", state: "done", detail: "Session setup is readable.", command: "node scripts/autoresearch.mjs setup-plan --cwd .", safeAction: "setup-plan" },
        { id: "gaps", title: "Gap review", state: "ready", detail: "1 open / 4 total.", command: "node scripts/autoresearch.mjs gap-candidates --cwd .", safeAction: "gap-candidates" },
        { id: "log", title: "Log decision", state: "ready", detail: "Last packet is ready.", command: "node scripts/autoresearch.mjs log --cwd . --from-last --status keep --description \"Describe the kept change\"", mutates: true },
        { id: "finalize", title: "Finalize", state: "idle", detail: "Preview later.", command: "node scripts/autoresearch.mjs finalize-preview --cwd .", safeAction: "finalize-preview" },
      ],
      logDecision: {
        available: true,
        allowedStatuses: ["keep", "discard"],
        suggestedStatus: "keep",
        metric: 4.2,
        statusGuidance: "Keep if the evidence matches the diff.",
        defaultDescription: "Describe the kept change",
        asiTemplate: { evidence: "seconds=4.2", next_action_hint: "" },
        command: "node scripts/autoresearch.mjs log --cwd . --from-last --status keep --description \"Describe the kept change\"",
        commandsByStatus: {
          keep: "node scripts/autoresearch.mjs log --cwd . --from-last --status keep --description \"Describe the kept change\"",
          discard: "node scripts/autoresearch.mjs log --cwd . --from-last --status discard --description \"Describe the discarded change\"",
        },
      },
    },
  };
  const entries = [
    { type: "config", name: "mission path", metricName: "seconds", bestDirection: "lower", metricUnit: "s" },
    { type: "run", run: 1, metric: 5, status: "keep", description: "Baseline", confidence: 1 },
  ];

  const { getById } = await runDashboard(entries, {
    deliveryMode: "live-server",
    liveActionsAvailable: true,
    viewModel,
    commands: [],
  });

  assert.match(getById("mission-note").textContent, /Active: Log decision/);
  assert.match(getById("mission-control-grid").innerHTML, /Gap review/);
  assert.match(getById("mission-control-grid").innerHTML, /Log decision/);
  assert.match(getById("log-decision-status").innerHTML, /keep/);
  assert.equal(getById("log-decision-description").value, "Describe the kept change");
  assert.match(getById("log-decision-asi").value, /seconds=4\.2/);
  assert.equal(getById("run-log-decision").disabled, false);
});

test("dashboard explains that zero quality gaps still need a fresh research round", async () => {
  const viewModel = {
    qualityGap: {
      slug: "delight-study",
      open: 0,
      total: 3,
      roundGuidance: {
        metricScope: "quality_gap counts accepted checklist gaps.",
        requiredRefresh: "Before declaring completion, rerun the project-study prompt.",
      },
    },
  };
  const entries = [
    { type: "config", name: "round guidance", metricName: "quality_gap", bestDirection: "lower", metricUnit: "gaps" },
    { type: "run", run: 1, metric: 0, status: "keep", description: "Closed accepted gaps", confidence: 1 },
  ];

  const { getById } = await runDashboard(entries, { viewModel, commands: [] });

  assert.equal(getById("quality-gap-title").textContent, "0 open / 3 total");
  assert.match(getById("quality-gap-detail").textContent, /Accepted gaps closed/);
  assert.match(getById("quality-gap-detail").textContent, /rerun the project-study prompt/);
});

test("dashboard view model treats closed quality gaps as completion instead of another run", () => {
  const viewModel = buildDashboardViewModel({
    state: {
      config: {
        name: "closed gap path",
        metricName: "quality_gap",
        metricUnit: "gaps",
        bestDirection: "lower",
      },
      segment: 0,
      current: [
        {
          run: 1,
          metric: 0,
          status: "keep",
          description: "Closed accepted gaps",
          confidence: 1,
          asi: {
            next_action_hint: "Stop iteration: all accepted quality gaps are closed.",
          },
        },
      ],
      baseline: 0,
      best: 0,
      confidence: 1,
    },
    commands: [
      { label: "Next run", command: "node scripts/autoresearch.mjs next --cwd ." },
      { label: "Gap candidates", command: "node scripts/autoresearch.mjs gap-candidates --cwd . --research-slug closed-gap-path" },
      { label: "Export dashboard", command: "node scripts/autoresearch.mjs export --cwd ." },
    ],
    qualityGap: {
      slug: "closed-gap-path",
      open: 0,
      closed: 4,
      total: 4,
    },
    finalizePreview: {
      ready: false,
      warnings: ["Working tree is dirty."],
      nextAction: "Resolve warnings before finalizing.",
    },
    experimentMemory: {
      latestNextAction: "Stop iteration: all accepted quality gaps are closed.",
    },
  });

  assert.equal(viewModel.nextBestAction.kind, "complete");
  assert.equal(viewModel.nextBestAction.title, "Review completion state");
  assert.match(viewModel.nextBestAction.detail, /Stop iteration/);
  assert.doesNotMatch(viewModel.nextBestAction.title, /Run the next measured hypothesis/);
  assert.equal(viewModel.nextBestAction.primaryCommand.label, "Gaps");
  assert.equal(viewModel.missionControl.activeStep, "gaps");
});

test("dashboard view model emits trust, evidence, research truth, and finalization schema with unknown deltas", () => {
  const viewModel = buildDashboardViewModel({
    state: {
      config: {
        name: "empty evidence",
        metricName: "quality_gap",
        metricUnit: "gaps",
        bestDirection: "lower",
      },
      segment: 0,
      current: [],
      baseline: null,
      best: null,
      confidence: null,
    },
    settings: {
      deliveryMode: "static-export",
      pluginVersion: "0.test",
      sourceCwd: "C:/repo",
    },
    setupPlan: {
      missing: ["Benchmark command is missing."],
      warnings: [],
    },
    finalizePreview: null,
  });

  assert.equal(viewModel.trustState.mode, "static-export");
  assert.equal(viewModel.trustState.status, "needs-attention");
  assert.equal(viewModel.trustState.pluginVersion, "0.test");
  assert.equal(viewModel.trustState.sourceCwd, "C:/repo");
  assert.equal(viewModel.researchTruth.queryCount, null);
  assert.equal(viewModel.researchTruth.promotionGrade, null);
  assert.deepEqual(viewModel.researchTruth.suspiciousReasons, []);
  const delta = viewModel.evidenceChips.find((chip) => chip.label === "Delta");
  assert.equal(delta.value, "unknown");
  assert.doesNotMatch(delta.value, /0%/);
  assert.ok(viewModel.finalizationChecklist.some((item) => item.label === "Preview packet" && item.state === "unknown"));
});

test("dashboard view model marks perfect quality metrics suspicious without freshness, breadth, or promotion evidence", () => {
  const viewModel = buildDashboardViewModel({
    state: {
      config: {
        name: "perfect but thin",
        metricName: "quality_gap",
        metricUnit: "gaps",
        bestDirection: "lower",
      },
      segment: 0,
      current: [
        {
          run: 1,
          metric: 0,
          status: "keep",
          description: "Closed accepted gaps without verification breadth",
          confidence: 1,
          asi: {
            hypothesis: "Close all gaps.",
            evidence: "quality_gap=0",
          },
        },
      ],
      baseline: 0,
      best: 0,
      confidence: 1,
    },
    qualityGap: {
      slug: "thin-research",
      open: 0,
      closed: 3,
      total: 3,
    },
  });

  assert.match(viewModel.researchTruth.suspiciousReasons.join("\n"), /freshness evidence/);
  assert.match(viewModel.researchTruth.suspiciousReasons.join("\n"), /breadth evidence/);
  assert.match(viewModel.researchTruth.suspiciousReasons.join("\n"), /promotion-grade/);
  assert.equal(viewModel.evidenceChips.find((chip) => chip.label === "Research truth").value, "Suspicious");
});

test("dashboard view model clears suspicious-perfect reasons when breadth and promotion evidence are present", () => {
  const viewModel = buildDashboardViewModel({
    state: {
      config: {
        name: "promotion grade",
        metricName: "quality_gap",
        metricUnit: "gaps",
        bestDirection: "lower",
      },
      segment: 0,
      current: [
        {
          run: 1,
          metric: 0,
          status: "keep",
          description: "Promotion-grade gap closure",
          timestamp: Date.now(),
          confidence: 1,
        },
      ],
      baseline: 0,
      best: 0,
      confidence: 1,
    },
    settings: {
      generatedAt: new Date().toISOString(),
      researchTruth: {
        queryCount: 24,
        holdoutCount: 6,
        adversarialCount: 3,
        externalRepoCount: 2,
        promotionGrade: true,
      },
    },
    qualityGap: {
      slug: "verified-research",
      open: 0,
      closed: 4,
      total: 4,
    },
  });

  assert.equal(viewModel.researchTruth.queryCount, 24);
  assert.equal(viewModel.researchTruth.holdoutCount, 6);
  assert.equal(viewModel.researchTruth.adversarialCount, 3);
  assert.equal(viewModel.researchTruth.externalRepoCount, 2);
  assert.equal(viewModel.researchTruth.promotionGrade, true);
  assert.deepEqual(viewModel.researchTruth.suspiciousReasons, []);
});

test("dashboard view model accepts numeric promotion-grade metrics", () => {
  const viewModel = buildDashboardViewModel({
    state: {
      config: {
        name: "numeric promotion grade",
        metricName: "quality_gap",
        metricUnit: "gaps",
        bestDirection: "lower",
      },
      segment: 0,
      current: [
        {
          run: 1,
          metric: 0,
          status: "keep",
          description: "Promotion-grade metric output",
          timestamp: Date.now(),
          metrics: {
            queryCount: 12,
            promotionGrade: 1,
          },
          confidence: 1,
        },
      ],
      baseline: 0,
      best: 0,
      confidence: 1,
    },
    qualityGap: {
      slug: "numeric-promotion",
      open: 0,
      closed: 4,
      total: 4,
    },
  });

  assert.equal(viewModel.researchTruth.queryCount, 12);
  assert.equal(viewModel.researchTruth.promotionGrade, true);
  assert.deepEqual(viewModel.researchTruth.suspiciousReasons, []);
});

test("dashboard view model feeds dirty, corrupt, and stale state into trust and decision guidance", () => {
  const viewModel = buildDashboardViewModel({
    state: {
      config: {
        name: "trust warning",
        metricName: "seconds",
        metricUnit: "s",
        bestDirection: "lower",
      },
      segment: 0,
      current: [
        {
          run: 1,
          metric: 5,
          status: "keep",
          description: "Baseline",
          confidence: 1,
        },
      ],
      baseline: 5,
      best: 5,
      confidence: 1,
    },
    guidedSetup: {
      stage: "stale-last-run",
      nextAction: "Replace stale packet.",
      commands: { replaceLast: "node scripts/autoresearch.mjs next --cwd ." },
      lastRun: {
        freshness: {
          fresh: false,
          reason: "Last-run packet is stale: history changed.",
        },
      },
    },
    drift: {
      warnings: ["Cache drift warning."],
    },
    warnings: [
      "Git worktree is dirty; review unrelated changes before logging a keep result.",
      "Corrupt dashboard state was ignored.",
    ],
  });

  assert.equal(viewModel.trustState.status, "needs-attention");
  assert.match(viewModel.trustState.reasons.join("\n"), /dirty/);
  assert.match(viewModel.trustState.reasons.join("\n"), /Corrupt/);
  assert.match(viewModel.trustState.reasons.join("\n"), /stale/);
  assert.equal(viewModel.nextBestAction.kind, "stale-packet");
  assert.match(viewModel.nextBestAction.detail, /stale/);
});

test("dashboard distinguishes static snapshot controls from live actions", async () => {
  const viewModel = {
    nextBestAction: {
      kind: "finalize-preview",
      priority: "Review",
      title: "Preview finalization",
      detail: "Review the packet.",
      safeAction: "finalize-preview",
      command: "node scripts/autoresearch.mjs finalize-preview --cwd .",
    },
    missionControl: {
      activeStep: "finalize",
      steps: [
        { id: "finalize", title: "Finalize", state: "ready", detail: "Preview the packet.", command: "node scripts/autoresearch.mjs finalize-preview --cwd .", safeAction: "finalize-preview" },
      ],
      logDecision: { available: false, allowedStatuses: [], suggestedStatus: "", commandsByStatus: {} },
    },
  };
  const entries = [
    { type: "config", name: "static dashboard", metricName: "quality_gap", bestDirection: "lower", metricUnit: "gaps" },
    { type: "run", run: 1, metric: 0, status: "keep", description: "Closed gaps", confidence: 1 },
  ];

  const { getById } = await runDashboard(entries, {
    deliveryMode: "static-export",
    liveActionsAvailable: false,
    modeGuidance: {
      title: "Static snapshot",
      detail: "Read-only export. Use autoresearch serve for executable dashboard actions.",
    },
    viewModel,
    commands: [],
  });

  assert.equal(getById("live-title").textContent, "Static snapshot");
  assert.match(getById("live-detail").textContent, /Read-only export/);
  assert.equal(getById("trust-title").textContent, "Static read-only export");
  assert.match(getById("trust-detail").textContent, /Read-only export/);
  assert.match(getById("trust-cells").textContent, /No usable live mutation controls/);
  assert.equal(getById("refresh-now").hidden, true);
  assert.equal(getById("live-toggle").hidden, true);
  assert.doesNotMatch(getById("mission-control-grid").innerHTML, /mission-run|Serve to run/);
  assert.equal(getById("live-actions-panel").hidden, true);
  assert.equal(getById("log-status-field").hidden, true);
  assert.equal(getById("log-description-field").hidden, true);
  assert.equal(getById("log-asi-field").hidden, true);
  assert.equal(getById("run-log-decision").hidden, true);
});

test("dashboard keeps static exports read-only when served over HTTP", async () => {
  const entries = [
    { type: "config", name: "hosted static dashboard", metricName: "quality_gap", bestDirection: "lower", metricUnit: "gaps" },
    { type: "run", run: 1, metric: 0, status: "keep", description: "Closed gaps", confidence: 1 },
  ];

  const { getById, dom } = await runDashboard(entries, {
    deliveryMode: "static-export",
    liveActionsAvailable: false,
    modeGuidance: {
      title: "Static snapshot",
      detail: "Read-only export. Use autoresearch serve for executable dashboard actions.",
    },
    viewModel: {
      nextBestAction: { title: "Preview finalization", detail: "Review the packet.", safeAction: "finalize-preview" },
    },
  }, {
    url: "https://static.example/autoresearch-dashboard.html",
  });

  assert.equal(getById("live-title").textContent, "Static snapshot");
  assert.equal(getById("refresh-now").hidden, true);
  assert.equal(getById("live-toggle").hidden, true);
  assert.equal(getById("live-actions-panel").hidden, true);
  dom.window.close();
});

test("served dashboard keeps live action controls executable", async () => {
  const viewModel = {
    nextBestAction: {
      kind: "finalize-preview",
      priority: "Review",
      title: "Preview finalization",
      detail: "Review the packet.",
      safeAction: "finalize-preview",
      command: "node scripts/autoresearch.mjs finalize-preview --cwd .",
    },
  };
  const entries = [
    { type: "config", name: "served dashboard", metricName: "quality_gap", bestDirection: "lower", metricUnit: "gaps" },
    { type: "run", run: 1, metric: 0, status: "keep", description: "Closed gaps", confidence: 1 },
  ];

  const { getById } = await runDashboard(entries, {
    deliveryMode: "live-server",
    liveActionsAvailable: true,
    modeGuidance: {
      title: "Live dashboard",
      detail: "Served mode can refresh the view model and run guarded local actions.",
    },
    viewModel,
    commands: [],
  });

  assert.equal(getById("live-title").textContent, "Live dashboard");
  assert.equal(getById("trust-title").textContent, "Live local runboard");
  assert.match(getById("trust-cells").textContent, /Guarded local actions are enabled/);
  assert.equal(getById("refresh-now").textContent, "Refresh live data");
  assert.equal(getById("live-toggle").textContent, "Live off");
  assert.equal(getById("refresh-now").hidden, false);
  assert.equal(getById("live-toggle").hidden, false);
  assert.match(getById("action-note").textContent, /Guarded actions/);
  assert.equal(getById("live-actions-panel").hidden, false);
  assert.match(getById("mission-control-grid").innerHTML, /mission-run/);
  assert.match(getById("action-grid").textContent, /Preview finalization/);
});

test("dashboard consumes trust, truth, evidence chips, and finalization checklist fields", async () => {
  const viewModel = {
    trustState: {
      modeLabel: "Live evidence runboard",
      detail: "Local host with guarded action nonce.",
      actionState: "Safe actions only.",
      evidenceState: "2 runs plus finalize preview.",
      warnings: ["Doctor warning is visible."],
    },
    researchTruth: {
      title: "Truth pass complete",
      score: 1,
      open: 0,
      total: 3,
      source: "quality_gap",
      suspiciousPerfectWarning: "Zero gaps closes this accepted checklist only.",
    },
    evidenceChips: [
      { label: "Metric", value: "4.2s beats baseline", tone: "good" },
      { label: "ASI", value: "Evidence recorded", tone: "neutral" },
    ],
    finalizationChecklist: {
      ready: false,
      title: "Review packet gated",
      items: [
        { id: "evidence", label: "Evidence packet", detail: "Kept run has ASI.", state: "done" },
        { id: "warnings", label: "Warnings", detail: "Resolve dirty tree.", state: "blocked" },
      ],
    },
    nextBestAction: {
      priority: "Review",
      title: "Preview finalization",
      detail: "Read the evidence before packaging.",
      utilityCopy: "Safe preview only.",
      tone: "focus",
    },
  };
  const entries = [
    { type: "config", name: "trust fields", metricName: "seconds", bestDirection: "lower", metricUnit: "s" },
    { type: "run", run: 1, metric: 5, status: "keep", description: "Baseline", confidence: 1 },
    { type: "run", run: 2, metric: 4.2, status: "keep", description: "Improved", confidence: 2 },
  ];

  const { getById } = await runDashboard(entries, {
    deliveryMode: "live-server",
    liveActionsAvailable: true,
    viewModel,
  });

  assert.equal(getById("trust-title").textContent, "Live evidence runboard");
  assert.match(getById("trust-warnings").textContent, /Doctor warning/);
  assert.equal(getById("research-truth-title").textContent, "Truth pass complete");
  assert.equal(getById("research-truth-bar").getAttribute("aria-valuenow"), "100");
  assert.match(getById("suspicious-perfect-warning").textContent, /accepted checklist only/);
  assert.match(getById("decision-evidence-chips").textContent, /4\.2s beats baseline/);
  assert.match(getById("finalization-checklist-title").textContent, /Review packet gated/);
  assert.match(getById("finalization-checklist-items").textContent, /Resolve dirty tree/);
});

test("dashboard surfaces generated suspicious research reasons", async () => {
  const viewModel = {
    researchTruth: {
      title: "Thin perfect result",
      score: 1,
      open: 0,
      total: 3,
      suspiciousReasons: ["Perfect metrics have no breadth evidence."],
    },
  };
  const entries = [
    { type: "config", name: "suspicious reason", metricName: "quality_gap", bestDirection: "lower", metricUnit: "gaps" },
    { type: "run", run: 1, metric: 0, status: "keep", description: "Closed gaps", confidence: 1 },
  ];

  const { getById } = await runDashboard(entries, {
    deliveryMode: "live-server",
    liveActionsAvailable: true,
    viewModel,
  });

  assert.match(getById("suspicious-perfect-warning").textContent, /no breadth evidence/);
  assert.match(getById("decision-suspicious-perfect").textContent, /no breadth evidence/);
});

test("structured ASI editor serializes to the existing asi payload", async () => {
  const viewModel = {
    missionControl: {
      activeStep: "log",
      steps: [
        { id: "log", title: "Log decision", state: "ready", detail: "Last packet is ready." },
      ],
      logDecision: {
        available: true,
        allowedStatuses: ["keep"],
        suggestedStatus: "keep",
        defaultDescription: "Keep measured change",
        lastRunFingerprint: "fingerprint-1",
        asiTemplate: { evidence: "seconds=4.2" },
        commandsByStatus: {
          keep: "node scripts/autoresearch.mjs log --cwd . --from-last --status keep --description \"Keep measured change\"",
        },
      },
    },
  };
  const entries = [
    { type: "config", name: "asi path", metricName: "seconds", bestDirection: "lower", metricUnit: "s" },
    { type: "run", run: 1, metric: 5, status: "keep", description: "Baseline", confidence: 1 },
  ];
  const { getById, dom } = await runDashboard(entries, {
    deliveryMode: "live-server",
    liveActionsAvailable: true,
    actionNonce: "nonce-1",
    viewModel,
  }, {
    beforeParse(window) {
      window.__actionBodies = [];
      window.fetch = async (url, options = {}) => {
        if (String(url).includes("actions/log-keep")) {
          window.__actionBodies.push(JSON.parse(options.body || "{}"));
          return {
            ok: true,
            json: async () => ({
              ok: true,
              receipt: {
                ok: true,
                action: "log-keep",
                status: "completed",
                ledgerRun: 2,
                receiptId: "receipt-1",
                nextStep: "Logged run #2.",
              },
            }),
          };
        }
        if (String(url).includes("view-model")) return { ok: true, json: async () => viewModel };
        return { ok: true, text: async () => entries.map((entry) => JSON.stringify(entry)).join("\n") };
      };
    },
  });

  setInputValue(dom.window, getById("asi-hypothesis"), "Cache the manifest");
  setInputValue(dom.window, getById("asi-evidence"), "METRIC seconds=4.2");
  setInputValue(dom.window, getById("asi-next-action-hint"), "Stress the cached path.");
  getById("run-log-decision").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await waitFor(() => dom.window.__actionBodies.length === 1, "Log decision action was not called.");
  await waitFor(() => /Logged run #2/.test(getById("receipt-toast").textContent), "Receipt toast was not updated.");

  const [body] = dom.window.__actionBodies;
  assert.equal(body.confirm, "log-keep");
  assert.equal(body.lastRunFingerprint, "fingerprint-1");
  assert.deepEqual(body.asi, {
    hypothesis: "Cache the manifest",
    evidence: "METRIC seconds=4.2",
    next_action_hint: "Stress the cached path.",
  });
  dom.window.close();
});

test("dashboard exposes keyboard skip path through primary surfaces", async () => {
  const entries = [
    { type: "config", name: "keyboard path", metricName: "seconds", bestDirection: "lower", metricUnit: "s" },
    { type: "run", run: 1, metric: 5, status: "keep", description: "Baseline", confidence: 1 },
  ];
  const { dom } = await runDashboard(entries, {
    deliveryMode: "live-server",
    liveActionsAvailable: true,
    viewModel: {
      missionControl: {
        activeStep: "log",
        steps: [{ id: "log", title: "Log decision", state: "ready", detail: "Last packet is ready." }],
        logDecision: { available: true, allowedStatuses: ["keep"], suggestedStatus: "keep" },
      },
    },
  });
  const hrefs = [...dom.window.document.querySelectorAll(".skip-links a")].map((item) => item.getAttribute("href"));

  assert.deepEqual(hrefs, ["#decision-rail", "#mission-panel", "#log-decision-panel", "#action-receipt", "#trend-panel", "#ledger"]);
  for (const href of hrefs) {
    const target = dom.window.document.querySelector(href);
    assert.ok(target, `Missing skip target ${href}`);
    assert.equal(target.getAttribute("tabindex"), "-1", `${href} should be programmatically focusable`);
  }
  dom.window.close();
});

test("served dashboard live toggle starts automatic refresh", async () => {
  const entries = [
    { type: "config", name: "served dashboard", metricName: "quality_gap", bestDirection: "lower", metricUnit: "gaps" },
    { type: "run", run: 1, metric: 1, status: "keep", description: "Baseline", confidence: 1 },
  ];
  const viewModel = {
    summary: { segment: 0, baseline: 1, best: 1, confidence: 1 },
  };
  const { getById, dom } = await runDashboard(entries, {
    deliveryMode: "live-server",
    liveActionsAvailable: true,
    refreshMs: 1234,
    viewModel,
  }, {
    beforeParse(window) {
      window.__refreshFetches = [];
      window.fetch = async (url) => {
        window.__refreshFetches.push(String(url));
        if (String(url).includes("view-model")) {
          return { ok: true, json: async () => viewModel };
        }
        return { ok: true, text: async () => entries.map((entry) => JSON.stringify(entry)).join("\n") };
      };
      window.setInterval = (callback, ms) => {
        window.__liveInterval = { callback, ms };
        return 42;
      };
      window.clearInterval = (id) => {
        window.__clearedLiveInterval = id;
      };
    },
  });

  getById("live-toggle").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await waitFor(() => dom.window.__liveInterval, "Live toggle did not start an interval.");

  assert.equal(dom.window.__liveInterval.ms, 1234);
  await waitFor(() => dom.window.__refreshFetches.length >= 2, "Live toggle did not refresh immediately.");
  assert.deepEqual(dom.window.__refreshFetches.slice(0, 2), ["autoresearch.jsonl", "view-model.json"]);
  getById("live-toggle").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await waitFor(() => dom.window.__clearedLiveInterval === 42, "Live toggle did not clear the interval.");
  dom.window.close();
});

test("dashboard readout uses the selected segment baseline", async () => {
  const entries = [
    { type: "config", name: "first segment", metricName: "seconds", bestDirection: "lower", metricUnit: "s" },
    { type: "run", run: 1, metric: 10, status: "keep", description: "First baseline", confidence: 1 },
    { type: "run", run: 2, metric: 8, status: "keep", description: "First best", confidence: 2 },
    { type: "config", name: "second segment", metricName: "seconds", bestDirection: "lower", metricUnit: "s" },
    { type: "run", run: 1, metric: 100, status: "keep", description: "Second baseline", confidence: 1 },
    { type: "run", run: 2, metric: 90, status: "keep", description: "Second best", confidence: 2 },
  ];

  const { getById, dom } = await runDashboard(entries, {
    deliveryMode: "static-export",
    liveActionsAvailable: false,
    viewModel: {
      summary: { segment: 1, baseline: 100, best: 90, confidence: 2 },
    },
  });

  assert.equal(getById("baseline-value").textContent, "100s");
  const select = getById("segment-select");
  select.value = "0";
  select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await waitFor(() => getById("baseline-value").textContent === "10s", "Selected segment baseline did not update.");
  assert.equal(getById("best-value").textContent, "8s");
  dom.window.close();
});

test("dashboard decision rail shows newest runs first", async () => {
  const entries = [
    { type: "config", name: "recent rail", metricName: "score", bestDirection: "higher", metricUnit: "pt" },
    { type: "run", run: 1, metric: 1, status: "keep", description: "Run one", confidence: 1 },
    { type: "run", run: 2, metric: 2, status: "keep", description: "Run two", confidence: 1 },
    { type: "run", run: 3, metric: 3, status: "discard", description: "Run three", confidence: 1 },
    { type: "run", run: 4, metric: 4, status: "keep", description: "Run four", confidence: 1 },
    { type: "run", run: 5, metric: 5, status: "discard", description: "Run five", confidence: 1 },
    { type: "run", run: 6, metric: 6, status: "keep", description: "Run six", confidence: 1 },
  ];

  const { getById, dom } = await runDashboard(entries, {
    deliveryMode: "static-export",
    liveActionsAvailable: false,
  });

  const railText = getById("decision-rail").textContent;
  assert.match(railText, /#6/);
  assert.match(railText, /Run six/);
  assert.match(railText, /#5/);
  assert.doesNotMatch(railText, /Run one/);
  dom.window.close();
});
