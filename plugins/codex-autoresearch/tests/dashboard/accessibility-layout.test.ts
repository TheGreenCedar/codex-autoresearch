import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { resolvePackageRoot } from "../../lib/runtime-paths.js";
import {
  createDashboardHarness,
  dashboardConfigEntry,
  emptyCommandMeta,
  waitFor,
} from ".././helpers/dashboard.js";
import {
  chartLayoutOptions,
  cssHexVariables,
  requiredCssVariable,
  assertContrastAtLeast,
  extractCssBlock,
} from "./test-helpers.js";

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

test("dashboard chart exposes one range while keeping the plotted SVG decorative", async () => {
  const entries = [
    dashboardConfigEntry({ name: "chart semantics", metricName: "seconds", metricUnit: "s" }),
    { type: "run", run: 1, metric: 5, status: "keep", description: "Baseline", confidence: 1 },
    { type: "run", run: 2, metric: 4, status: "keep", description: "Improved", confidence: 2 },
  ];

  const { dom, getById } = await runDashboard(entries, emptyCommandMeta(), chartLayoutOptions());
  const chart = getById("trend-chart");
  await waitFor(
    () => chart.querySelector("#trend-chart-range") != null,
    "Chart range did not render.",
  );
  const range = chart.querySelector<HTMLInputElement>("#trend-chart-range");

  assert.ok(range);
  assert.equal(chart.getAttribute("role"), null);
  assert.equal(chart.getAttribute("aria-labelledby"), "trend-chart-title trend-chart-desc");
  assert.match(getById("chart-keyboard-help").textContent || "", /slider to move/i);
  assert.equal(chart.querySelectorAll(".chart-point-button, .chart-data-list").length, 0);
  assert.equal(chart.querySelectorAll('input[type="range"]').length, 1);
  assert.equal(chart.querySelector(".chart-visual")?.getAttribute("aria-hidden"), "true");
  assert.equal(range.getAttribute("aria-describedby"), "chart-keyboard-help trend-chart-desc");
  assert.equal(range.getAttribute("aria-haspopup"), "dialog");
  assert.match(range.getAttribute("aria-valuetext") || "", /run 2/i);
  assert.equal(chart.querySelectorAll(".chart-open-details").length, 1);
  dom.window.close();
});

test("dashboard restores chart focus after the experiment modal unmounts", async () => {
  const { dom } = await runDashboard(
    [
      dashboardConfigEntry({ name: "modal focus", metricName: "seconds", metricUnit: "s" }),
      { type: "run", run: 1, metric: 5, status: "keep", description: "Baseline" },
      { type: "run", run: 2, metric: 4, status: "keep", description: "Improved" },
    ],
    emptyCommandMeta(),
    chartLayoutOptions(),
  );
  await waitFor(
    () => dom.window.document.querySelector("#trend-chart-range") != null,
    "Chart range did not render.",
  );
  const opener = dom.window.document.querySelector<HTMLInputElement>("#trend-chart-range");
  assert.ok(opener);
  const openerRun = opener.dataset.chartRun;
  opener.focus();
  opener.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await waitFor(
    () => dom.window.document.activeElement?.classList.contains("modal-close") === true,
    "Modal close button did not receive focus.",
  );
  const percentValue = dom.window.document.querySelector(
    ".experiment-metrics > div:last-child strong",
  )?.textContent;
  assert.match(percentValue || "", /%$/);
  assert.doesNotMatch(percentValue || "", /s$/);
  dom.window.document.querySelector<HTMLButtonElement>(".modal-close")?.click();
  await waitFor(
    () => dom.window.document.querySelector('[role="dialog"]') == null,
    "Experiment modal did not unmount.",
  );
  await waitFor(
    () => dom.window.document.activeElement?.getAttribute("data-chart-run") === openerRun,
    "Chart range did not regain focus.",
  );
});

test("dashboard side rail distinguishes live and static status affordances", async () => {
  const entries = [
    dashboardConfigEntry({ name: "side rail status", metricName: "seconds", metricUnit: "s" }),
    { type: "run", run: 1, metric: 5, status: "keep", description: "Baseline", confidence: 1 },
  ];

  const staticDashboard = await runDashboard(entries, {
    deliveryMode: "static-export",
    liveActionsAvailable: false,
  });
  assert.ok(staticDashboard.dom.window.document.querySelector(".side-status .status-dot"));
  assert.equal(
    staticDashboard.dom.window.document.querySelector(".side-status .live-dot") === null,
    true,
  );
  assert.match(
    staticDashboard.dom.window.document.querySelector(".side-status")?.textContent || "",
    /Static/,
  );
  staticDashboard.dom.window.close();

  const demoDashboard = await runDashboard(entries, {
    deliveryMode: "showcase",
    liveActionsAvailable: false,
    showcaseMode: true,
  });
  assert.ok(demoDashboard.dom.window.document.querySelector(".side-status .status-dot"));
  assert.equal(
    demoDashboard.dom.window.document.querySelector(".side-status .live-dot") === null,
    true,
  );
  assert.match(
    demoDashboard.dom.window.document.querySelector(".side-status")?.textContent || "",
    /Demo/,
  );
  demoDashboard.dom.window.close();

  const liveDashboard = await runDashboard(entries, {
    deliveryMode: "live-server",
    liveRefreshAvailable: true,
    liveActionsAvailable: false,
  });
  assert.ok(liveDashboard.dom.window.document.querySelector(".side-status .live-dot"));
  assert.equal(
    liveDashboard.dom.window.document.querySelector(".side-status .status-dot") === null,
    true,
  );
  assert.match(
    liveDashboard.dom.window.document.querySelector(".side-status")?.textContent || "",
    /Live/,
  );
  liveDashboard.dom.window.close();
});

test("dashboard static status marker does not inherit live animation", () => {
  const css = readFileSync(
    path.join(resolvePackageRoot(import.meta.url), "dashboard", "src", "styles.css"),
    "utf8",
  );

  assert.match(css, /\.live-dot\s*\{[^}]*animation:\s*pulse-glow/s);
  assert.doesNotMatch(extractCssBlock(css, ".status-dot"), /animation:/);
});

test("dashboard responsive styles keep readiness strip two-up until mobile", () => {
  const css = readFileSync(
    path.join(resolvePackageRoot(import.meta.url), "dashboard", "src", "styles.css"),
    "utf8",
  );
  const tabletBlock = extractCssBlock(css, "@media (max-width: 1080px)");
  const mobileBlock = extractCssBlock(css, "@media (max-width: 720px)");

  assert.match(
    tabletBlock,
    /\.dashboard-toolbar,[\s\S]*?\.signal-strip,[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
  );
  assert.doesNotMatch(
    tabletBlock,
    /\.metric-evidence-list,[\s\S]*?\.signal-strip,[\s\S]*?grid-template-columns:\s*1fr/,
  );
  assert.match(
    mobileBlock,
    /\.toolbar-controls,[\s\S]*?\.signal-strip\s*\{[\s\S]*?grid-template-columns:\s*1fr/,
  );
});

test("dashboard contrast tokens cover reported a11y targets", () => {
  const css = readFileSync(
    path.join(resolvePackageRoot(import.meta.url), "dashboard", "src", "styles.css"),
    "utf8",
  );
  const variables = cssHexVariables(css);
  const tealDark = requiredCssVariable(variables, "--teal-dark");
  const amberDark = requiredCssVariable(variables, "--amber-dark");

  assertContrastAtLeast(tealDark, "#ffffff", 4.5, "active segmented control");
  assertContrastAtLeast(amberDark, "#f5e6c2", 4.5, "warning evidence pill text");
  assertContrastAtLeast(amberDark, "#ffffff", 3, "amber non-text indicators");
  assert.match(
    extractCssBlock(css, ".segmented-control button.active"),
    /background:\s*var\(--teal-dark\)/,
  );
  assert.match(
    extractCssBlock(css, ".evidence-chip.evidence-suspicious"),
    /border-left-color:\s*var\(--amber-dark\)/,
  );
  assert.match(
    extractCssBlock(css, ".strategy-lane-card .status-pill.warn"),
    /border-color:\s*var\(--amber-dark\)/,
  );
  assert.match(
    extractCssBlock(css, ".legend-swatch.checks_failed"),
    /background:\s*var\(--amber-dark\)/,
  );
  assert.match(css, /input:focus-visible[\s\S]*outline:\s*3px solid var\(--focus\)/);
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
    {
      type: "config",
      name: "suspicious reason",
      metricName: "quality_gap",
      bestDirection: "lower",
      metricUnit: "gaps",
    },
    { type: "run", run: 1, metric: 0, status: "keep", description: "Closed gaps", confidence: 1 },
  ];

  const { dom } = await runDashboard(entries, {
    deliveryMode: "live-server",
    liveRefreshAvailable: true,
    liveActionsAvailable: false,
    viewModel,
  });

  assert.equal(dom.window.document.getElementById("suspicious-perfect-warning") === null, true);
  assert.equal(dom.window.document.getElementById("decision-suspicious-perfect") === null, true);
  assert.match(String(viewModel.researchTruth.suspiciousReasons[0]), /no breadth evidence/);
});

test("dashboard exposes keyboard skip path through primary surfaces", async () => {
  const entries = [
    {
      type: "config",
      name: "keyboard path",
      metricName: "seconds",
      bestDirection: "lower",
      metricUnit: "s",
    },
    { type: "run", run: 1, metric: 5, status: "keep", description: "Baseline", confidence: 1 },
  ];
  const { dom } = await runDashboard(entries, {
    deliveryMode: "live-server",
    liveRefreshAvailable: true,
    liveActionsAvailable: false,
    viewModel: {
      missionControl: {
        activeStep: "log",
        steps: [
          { id: "log", title: "Log decision", state: "ready", detail: "Last packet is ready." },
        ],
        logDecision: { available: true, allowedStatuses: ["keep"], suggestedStatus: "keep" },
      },
    },
  });
  const hrefs = [...dom.window.document.querySelectorAll(".skip-links a")].map((item) =>
    item.getAttribute("href"),
  );
  assert.deepEqual(hrefs, ["#decision-rail", "#trend-panel", "#codex-brief", "#ledger"]);
  const sideLabels = [...dom.window.document.querySelectorAll(".side-nav a")].map((item) =>
    item.textContent?.trim(),
  );
  assert.deepEqual(sideLabels, ["1Move", "2Metric", "3Brief", "4Ledger"]);
  const sideAriaLabels = [...dom.window.document.querySelectorAll(".side-nav a")].map((item) =>
    item.getAttribute("aria-label"),
  );
  assert.deepEqual(sideAriaLabels, [
    "Dashboard section: Move",
    "Dashboard section: Metric",
    "Dashboard section: Brief",
    "Dashboard section: Ledger",
  ]);
  assert.equal(
    [...dom.window.document.querySelectorAll(".side-nav .nav-icon")].every(
      (item) => item.getAttribute("aria-hidden") === "true",
    ),
    true,
  );
  assert.ok(dom.window.document.getElementById("dashboard-toolbar"));
  assert.equal(dom.window.document.querySelector(".masthead") === null, true);
  const decisionRail = dom.window.document.getElementById("decision-rail");
  const trendPanel = dom.window.document.getElementById("trend-panel");
  const scoreStrip = dom.window.document.querySelector(".score-strip");
  assert.ok(decisionRail);
  assert.equal(
    dom.window.document.getElementById("next-action-title")?.textContent,
    "Do this first",
  );
  assert.ok(dom.window.document.getElementById("decision-next-command"));
  assert.ok(trendPanel);
  assert.ok(scoreStrip);
  assert.equal(
    Boolean(
      decisionRail.compareDocumentPosition(trendPanel) &
      dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    ),
    true,
    "Operate view should show the next action before the Packet trend.",
  );
  assert.equal(
    Boolean(
      trendPanel.compareDocumentPosition(scoreStrip) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    ),
    true,
    "Operate view should show the Packet trend before the score strip.",
  );
  for (const href of hrefs) {
    const target = dom.window.document.querySelector(href);
    assert.ok(target, `Missing skip target ${href}`);
    assert.equal(
      target.getAttribute("tabindex"),
      "-1",
      `${href} should be programmatically focusable`,
    );
  }
  dom.window.close();
});

test("static audit dashboard renders decision rail before session context", async () => {
  const entries = [
    {
      type: "config",
      name: "static audit order",
      metricName: "seconds",
      bestDirection: "lower",
      metricUnit: "s",
    },
    { type: "run", run: 1, metric: 5, status: "keep", description: "Baseline", confidence: 1 },
  ];
  const { dom } = await runDashboard(entries, emptyCommandMeta(), {
    query: "?view=audit",
  });
  const trend = dom.window.document.querySelector("#trend-panel");
  const decision = dom.window.document.querySelector("#decision-rail");
  const brief = dom.window.document.querySelector("#codex-brief");

  assert.ok(trend, "trend panel should exist");
  assert.ok(decision, "decision rail should exist");
  assert.ok(brief, "codex brief should exist");
  assert.ok(
    decision.compareDocumentPosition(brief) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    "decision rail should appear before Codex brief in static audit view",
  );
  dom.window.close();
});

test("run toast announces status changes", async () => {
  const entries = [
    {
      type: "config",
      name: "toast a11y",
      metricName: "seconds",
      bestDirection: "lower",
      metricUnit: "s",
    },
    { type: "run", run: 1, metric: 5, status: "keep", description: "Baseline", confidence: 1 },
  ];
  const { dom } = await runDashboard(entries, {
    deliveryMode: "live-server",
    liveRefreshAvailable: true,
    liveActionsAvailable: false,
    viewModel: {},
  });
  const toastContainer = dom.window.document.querySelector(".toast-container");
  assert.ok(toastContainer, "toast container should render after latest run");
  assert.equal(toastContainer.getAttribute("aria-live"), "polite");
  assert.equal(toastContainer.getAttribute("role"), "status");
  dom.window.close();
});

test("empty chart state and theme toggle stay accessible", async () => {
  const entries = [
    {
      type: "config",
      name: "empty chart a11y",
      metricName: "seconds",
      bestDirection: "lower",
      metricUnit: "s",
    },
  ];
  const { dom, getById } = await runDashboard(entries, emptyCommandMeta());
  const chart = getById("trend-chart");
  const emptyState = chart.querySelector(".chart-empty-state");
  const chartDescription = dom.window.document.getElementById("trend-chart-desc");
  const themeIcon = getById("theme-toggle").querySelector("svg");

  assert.ok(emptyState, "zero-run chart should render a visible empty state");
  assert.match(emptyState.textContent || "", /No finite plotted metrics yet/);
  assert.match(emptyState.textContent || "", /Waiting for numeric evidence/);
  assert.equal(emptyState.getAttribute("aria-hidden"), "true");
  assert.match(chartDescription?.textContent || "", /No finite plotted metrics yet/);
  assert.equal(themeIcon?.getAttribute("aria-hidden"), "true");
  assert.equal(themeIcon?.getAttribute("focusable"), "false");
  dom.window.close();
});

test("dashboard keeps navigation targets visible when the ledger is empty", async () => {
  const entries = [
    {
      type: "config",
      name: "empty ledger",
      metricName: "seconds",
      bestDirection: "lower",
      metricUnit: "s",
    },
  ];
  const { dom } = await runDashboard(entries, {
    deliveryMode: "live-server",
    liveRefreshAvailable: true,
    liveActionsAvailable: false,
    viewModel: {},
  });

  const ledger = dom.window.document.getElementById("ledger");
  assert.ok(ledger);
  assert.equal(ledger.hasAttribute("hidden"), false);
  assert.equal(ledger.getAttribute("tabindex"), "-1");
  assert.match(ledger.textContent || "", /No runs logged yet/);
  assert.equal(
    dom.window.document.querySelector(".ledger-empty")?.textContent?.trim(),
    "No ledger yet. First safe move: capture a baseline measurement.",
  );
  assert.equal(dom.window.document.getElementById("ledger-scroll") === null, true);

  const links = [
    ...dom.window.document.querySelectorAll(".skip-links a, .side-nav a"),
  ] as HTMLAnchorElement[];
  for (const link of links) {
    const href = link.getAttribute("href") || "";
    const target = dom.window.document.querySelector(href);
    assert.ok(target, `Missing dashboard nav target ${href}`);
    assert.equal(target.hasAttribute("hidden"), false, `${href} should be visible`);
    assert.equal(target.closest("[hidden]"), null, `${href} should not be inside hidden content`);
  }
  dom.window.close();
});

test("dashboard uses calm read-only and empty-ledger copy", async () => {
  const entries = [
    {
      type: "config",
      name: "empty session",
      metricName: "seconds",
      bestDirection: "lower",
      metricUnit: "s",
    },
  ];
  const { dom } = await runDashboard(entries, emptyCommandMeta(), {
    query: "?view=operate",
  });
  const skipLabels = [...dom.window.document.querySelectorAll(".skip-links a")].map((item) =>
    item.textContent?.trim(),
  );
  const ledgerEmpty = dom.window.document.querySelector(".ledger-empty");
  assert.match(dom.window.document.body.textContent || "", /Readout only\. CLI does the work\./);
  assert.equal(
    ledgerEmpty?.textContent?.trim(),
    "No ledger yet. First safe move: capture a baseline measurement.",
  );
  assert.equal(skipLabels[0], "Next action");
  assert.equal(skipLabels.includes("Run chart"), false);
  dom.window.close();
});
