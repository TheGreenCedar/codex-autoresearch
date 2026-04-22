import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { buildDashboardViewModel } from "../lib/dashboard-view-model.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, "..");
const dashboardTemplatePath = path.join(pluginRoot, "assets", "template.html");

const createDashboardElement = (id) => {
  return {
    id,
    textContent: "",
    innerHTML: "",
    className: "",
    hidden: false,
    disabled: false,
    onclick: null,
    onchange: null,
    dataset: {},
    value: "",
    setAttribute(name, value) {
      this[name] = String(value);
    },
    querySelectorAll() {
      return [];
    },
  };
};

const getDashboardElement = (elements, id) => {
  if (!elements.has(id)) {
    elements.set(id, createDashboardElement(id));
  }
  return elements.get(id);
};

const createDashboardDocument = (elements) => ({
  getElementById: (id) => getDashboardElement(elements, id),
});

const extractDashboardScript = (template) => {
  const match = template.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match?.[1], "Dashboard script block not found");
  return match[1];
};

const runDashboard = async (entries, meta = {}) => {
  const template = await readFile(dashboardTemplatePath, "utf8");
  const script = extractDashboardScript(template);
  const elements = new Map();
  const context = {
    console,
    document: createDashboardDocument(elements),
    location: { protocol: meta.deliveryMode === "live-server" ? "http:" : "file:" },
    __AUTORESEARCH_DATA__: entries,
    __AUTORESEARCH_META__: meta,
  };
  vm.createContext(context);
  vm.runInContext(script, context);
  const getById = (id) => getDashboardElement(elements, id);
  return { elements, getById };
};

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
  assert.match(getById("next-best-why").textContent, /Run the next measured hypothesis|Try reducing startup overhead/i);
  assert.match(getById("next-best-avoids").textContent, /Avoids/);
  assert.match(getById("next-best-proof").textContent, /evidence|logged packet|run/i);
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
  assert.match(delta, /0%/);
  assert.match(getById("next-action-detail").textContent, /Track stability/);
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
  assert.match(getById("next-best-title").textContent, /Replace the stale packet/);
  assert.match(getById("next-best-avoids").textContent, /old metric|stale/i);
  assert.match(getById("next-best-proof").textContent, /fresh next packet/i);
  assert.match(getById("next-action-detail").textContent, /Last-run packet is stale/);
  assert.equal(getById("decision-rail").innerHTML.includes("No decisions yet"), false);
});

test("dashboard mission control renders explicit log-decision controls", async () => {
  const viewModel = {
    missionControl: {
      activeStep: "log",
      staticFallback: "Commands remain copyable.",
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
  assert.equal(getById("refresh-now").hidden, true);
  assert.equal(getById("live-toggle").hidden, true);
  assert.equal(getById("run-next-best-action").hidden, true);
  assert.doesNotMatch(getById("mission-control-grid").innerHTML, /mission-run|Serve to run/);
  assert.equal(getById("live-actions-panel").hidden, true);
  assert.equal(getById("log-status-field").hidden, true);
  assert.equal(getById("log-description-field").hidden, true);
  assert.equal(getById("log-asi-field").hidden, true);
  assert.equal(getById("copy-log-command").hidden, true);
  assert.equal(getById("run-log-decision").hidden, true);
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
  assert.equal(getById("refresh-now").textContent, "Refresh live data");
  assert.equal(getById("live-toggle").textContent, "Live off");
  assert.equal(getById("refresh-now").hidden, false);
  assert.equal(getById("live-toggle").hidden, false);
  assert.match(getById("action-note").textContent, /Guarded actions/);
  assert.equal(getById("live-actions-panel").hidden, false);
  assert.equal(getById("run-next-best-action").disabled, false);
  assert.equal(getById("run-next-best-action").hidden, false);
  assert.equal(getById("run-next-best-action").textContent, "Finalize Preview");
});
