import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, "..");
const dashboardTemplatePath = path.join(pluginRoot, "assets", "template.html");

const createDashboardElement = (id) => {
  return {
    id,
    textContent: "",
    innerHTML: "",
    className: "",
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

  const { getById } = await runDashboard(entries, { viewModel, commands: [] });
  const staleTimestamp = Date.parse(viewModel.lastRun.generatedAt);
  assert.equal(Number.isFinite(staleTimestamp), true);
  assert.equal(staleTimestamp <= Date.now(), true);
  assert.equal(viewModel.guidedSetup.stage, "stale-last-run");
  assert.equal(viewModel.lastRun.freshness.fresh, false);
  assert.match(getById("next-best-title").textContent, /Replace the stale packet/);
  assert.match(getById("next-action-detail").textContent, /Last-run packet is stale/);
  assert.equal(getById("decision-rail").innerHTML.includes("No decisions yet"), false);
});
