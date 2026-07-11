import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboardViewModel } from "../../lib/dashboard-view-model.js";
import { boundDashboardLedgerEntries } from "../../lib/dashboard-ledger-bounds.js";
import { dashboardCommandSafety } from "../../lib/dashboard-command-safety.js";
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

test("dashboard ledger bounder preserves governing config when there is room for a run", () => {
  const entries = [
    { type: "config", name: "old", metricName: "seconds" },
    { type: "run", run: 1, status: "measure", metric: 1 },
    { type: "run", run: 2, status: "measure", metric: 2 },
    { type: "config", name: "current", metricName: "quality" },
    ...Array.from({ length: 6 }, (_, index) => ({
      type: "run",
      run: index + 3,
      status: "keep",
      metric: index + 3,
    })),
  ];

  const bounded = boundDashboardLedgerEntries(entries, 5);

  assert.equal(bounded.truncated, true);
  assert.equal(bounded.maxEntries, 5);
  assert.equal(bounded.omittedEntries, 5);
  assert.equal(bounded.entries.length, 5);
  assert.equal(bounded.entries[0].type, "config");
  assert.equal(bounded.entries[0].name, "current");
  assert.equal(bounded.entries[1].run, 5);
  assert.equal(bounded.entries.at(-1)?.run, 8);
});

test("dashboard ledger bounder keeps latest ledger entry when cap is one", () => {
  const entries = [
    { type: "config", name: "tight", metricName: "seconds" },
    { type: "run", run: 1, status: "measure", metric: 1 },
    { type: "run", run: 2, status: "keep", metric: 2 },
  ];

  const bounded = boundDashboardLedgerEntries(entries, 1);

  assert.equal(bounded.truncated, true);
  assert.equal(bounded.maxEntries, 1);
  assert.equal(bounded.omittedEntries, 2);
  assert.deepEqual(bounded.entries, [{ type: "run", run: 2, status: "keep", metric: 2 }]);
});

test("dashboard action rail uses blocker metadata instead of next fallback", () => {
  const viewModel = buildDashboardViewModel({
    state: {
      config: {
        name: "metadata fallback",
        metricName: "score",
        bestDirection: "higher",
      },
      current: [],
      decisionEnvelope: {
        canonicalNextAction: {
          kind: "gate-quality",
          priority: 3,
          reason: "Configure an independent checks gate before another packet.",
          command: "",
        },
      },
    },
    settings: {},
    commands: [
      { label: "Next run", command: "node scripts/autoresearch.mjs next --cwd C:/repo" },
      { label: "Doctor", command: "node scripts/autoresearch.mjs doctor --cwd C:/repo" },
    ],
  } as any);

  assert.equal(viewModel.nextBestAction.kind, "gate-quality");
  assert.equal(viewModel.nextBestAction.packetBrake, true);
  assert.equal(
    viewModel.nextBestAction.primaryCommand.command,
    "node scripts/autoresearch.mjs doctor --cwd C:/repo",
  );
  assert.doesNotMatch(viewModel.nextBestAction.primaryCommand.command, /\bnext\b/);
});

test("dashboard view model keeps only copyable readout commands", () => {
  const viewModel = buildDashboardViewModel({
    state: {
      config: {
        name: "generated commands",
        metricName: "score",
        bestDirection: "higher",
      },
      current: [],
    },
    settings: {},
    commands: [
      { label: "Serve dashboard", command: "node scripts/autoresearch.mjs serve --cwd C:/repo" },
      { label: "Export dashboard", command: "node scripts/autoresearch.mjs export --cwd C:/repo" },
      {
        label: "Doctor",
        command: "node scripts/autoresearch.mjs doctor --cwd C:/repo --check-benchmark",
      },
      {
        label: "Benchmark lint",
        command: "node scripts/autoresearch.mjs benchmark-lint --cwd C:/repo",
      },
      {
        label: "Benchmark separator",
        command: "node scripts/autoresearch.mjs benchmark-lint --cwd C:/repo -- node evil.js",
      },
      { label: "Bare state", command: "state --cwd C:/repo" },
      { label: "State", command: "node scripts/autoresearch.mjs state --cwd C:/repo --report" },
      {
        label: "Quality gap",
        command: "node scripts/autoresearch.mjs quality-gap --cwd C:/repo --research-slug study",
      },
      {
        label: "New segment",
        command: "node scripts/autoresearch.mjs new-segment --cwd C:/repo --dry-run",
      },
    ],
  } as any);

  assert.deepEqual(
    viewModel.commands.map((command) => command.label),
    ["State", "Quality gap", "New segment"],
  );
  for (const command of viewModel.commands) {
    assert.equal(dashboardCommandSafety(command.command).safe, true, command.command);
  }
});

test("dashboard signals Product proof when claim coverage blocks release readiness", () => {
  const model = buildDashboardViewModel({
    state: {
      config: {
        name: "claim coverage",
        metricName: "score",
        bestDirection: "higher",
      },
      current: [],
      productClaimCoverage: {
        productGradeReady: false,
        maturity: "needs-proof",
        missingRequiredProof: ["No screenshot handoff proof."],
        blockers: ["Claim coverage is missing dashboard handoff evidence."],
      },
    },
    settings: {},
  } as any);

  assert.equal(model.productClaimCoverage.productGradeReady, false);
  assert.match(JSON.stringify(model.signals), /Product proof missing|claim coverage/i);
});

test("dashboard renders proof signals below the chart", async () => {
  const { dom, getById } = await runDashboard(
    [
      dashboardConfigEntry({ name: "signal order", metricName: "seconds", metricUnit: "s" }),
      { type: "run", run: 1, metric: 5, status: "keep", description: "Baseline" },
    ],
    emptyCommandMeta(),
    chartLayoutOptions(),
  );
  const chart = getById("trend-panel");
  const signals = getById("v2-release-signals");

  assert.ok(
    chart.compareDocumentPosition(signals) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    "signal strip should render only after the chart panel",
  );
});

test("dashboard exposes one chart Tab stop and arrow keys move it", async () => {
  const { dom, getById } = await runDashboard(
    [
      dashboardConfigEntry({ name: "chart focus", metricName: "seconds", metricUnit: "s" }),
      { type: "run", run: 1, metric: 5, status: "keep", description: "Baseline" },
      { type: "run", run: 2, metric: 4, status: "discard", description: "Rejected" },
      { type: "run", run: 3, metric: 3, status: "keep", description: "Latest" },
    ],
    emptyCommandMeta(),
    chartLayoutOptions(),
  );
  const chart = getById("trend-chart");
  await waitFor(
    () => chart.querySelectorAll(".chart-point-button").length === 3,
    "Chart points did not render.",
  );
  const points = [...chart.querySelectorAll<HTMLButtonElement>(".chart-point-button")];
  const tabbable = points.filter((point) => point.tabIndex === 0);

  assert.equal(tabbable.length, 1);
  assert.equal(tabbable[0]?.dataset.chartRun, "3");
  tabbable[0]?.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
  );
  await waitFor(
    () => dom.window.document.activeElement?.getAttribute("data-chart-run") === "2",
    "ArrowLeft did not move chart focus to the previous point.",
  );
  assert.equal(points.filter((point) => point.tabIndex === 0).length, 1);
  assert.equal(points.find((point) => point.tabIndex === 0)?.dataset.chartRun, "2");
});

test("dashboard ledger uses native table semantics", async () => {
  const { getById } = await runDashboard(
    [
      dashboardConfigEntry({ name: "ledger semantics", metricName: "seconds", metricUnit: "s" }),
      { type: "run", run: 1, metric: 5, status: "keep", description: "Baseline" },
    ],
    emptyCommandMeta(),
  );
  const table = getById("ledger-scroll").querySelector("table");

  assert.equal(table?.tagName, "TABLE");
  assert.equal(table?.querySelector("thead")?.tagName, "THEAD");
  assert.equal(getById("ledger-body").tagName, "TBODY");
  assert.equal(table?.querySelector("tr.ledger-row")?.tagName, "TR");
  assert.equal(table?.querySelector("[role=table],[role=row],[role=cell]") == null, true);
  assert.equal(table?.querySelectorAll("colgroup col").length, 4);
  assert.ok(table?.querySelector(".metric-stack"));
});

test("dashboard segment transition command matches its safe action metadata", () => {
  const viewModel = buildDashboardViewModel({
    state: {
      config: {
        name: "segment transition",
        metricName: "score",
        bestDirection: "higher",
      },
      current: [],
      decisionEnvelope: {
        canonicalNextAction: {
          kind: "segment-transition",
          priority: 7,
          reason: "Start a new segment before another packet.",
          command: "",
        },
      },
    },
    settings: {},
    commands: [
      { label: "Next run", command: "node scripts/autoresearch.mjs next --cwd C:/repo" },
      {
        label: "New segment",
        command: "node scripts/autoresearch.mjs new-segment --cwd C:/repo --dry-run",
      },
      {
        label: "Gap candidates",
        command: "node scripts/autoresearch.mjs gap-candidates --cwd C:/repo --research-slug study",
      },
    ],
  } as any);

  assert.equal(viewModel.nextBestAction.kind, "segment-transition");
  assert.equal(viewModel.nextBestAction.safeAction, "new-segment");
  assert.equal(viewModel.nextBestAction.primaryCommand.label, "Segment");
  assert.match(viewModel.nextBestAction.primaryCommand.command, /\bnew-segment\b/);
  assert.doesNotMatch(viewModel.nextBestAction.primaryCommand.command, /\bgap-candidates\b/);
});

test("dashboard current-tree finalization explains proof without packet fallback", () => {
  const viewModel = buildDashboardViewModel({
    state: {
      config: {
        name: "current tree finalization",
        metricName: "score",
        bestDirection: "higher",
      },
      current: [
        {
          run: 1,
          metric: 10,
          status: "keep",
          description: "Kept baseline",
          confidence: 1,
        },
      ],
      baseline: 10,
      best: 10,
      decisionEnvelope: {
        canonicalNextAction: {
          kind: "current-tree-finalization",
          priority: 5,
          reason:
            "Use finalize-current-tree because commit-level kept evidence does not describe the current branch tree cleanly.",
          command: "",
        },
      },
    },
    settings: {},
    finalizePreview: {
      ready: false,
      nextAction:
        "Use finalize-current-tree because commit-level kept evidence does not describe the current branch tree cleanly.",
    },
    commands: [
      {
        label: "Finalize preview",
        command: "node scripts/autoresearch.mjs finalize-preview --cwd C:/repo",
      },
    ],
  } as any);

  assert.equal(viewModel.nextBestAction.kind, "current-tree-finalization");
  assert.match(viewModel.nextBestAction.explanation.proof, /finalize-current-tree/);
  assert.match(viewModel.nextBestAction.explanation.avoids, /current branch tree/);
  assert.doesNotMatch(
    viewModel.nextBestAction.explanation.proof,
    /next (?:run|packet) produces evidence/i,
  );
  assert.match(viewModel.decisionReceipt.proof, /current non-session diff/);
});

test("dashboard DOM renders non-blank next action in operator rail", async () => {
  const entries = [
    dashboardConfigEntry({ name: "zero path", metricName: "seconds", metricUnit: "s" }),
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

  const { getById } = await runDashboard(entries, emptyCommandMeta());
  const rail = getById("decision-rail").innerHTML;
  const nextActionDetail = getById("next-action-detail").textContent.trim();
  const nextActionTitle = getById("next-action-title").textContent.trim();
  const metricDetails = getById("metric-details");

  assert.match(rail, /Cache manifest|Noisy baseline|startup overhead/i);
  assert.notEqual(rail.includes("No decisions yet"), true);
  assert.ok(nextActionTitle.length > 0);
  assert.doesNotMatch(nextActionTitle, /No decisions yet/i);
  assert.equal(nextActionDetail, "Try reducing startup overhead.");
  assert.equal(getById("metric-details-title").textContent, "Selected run evidence");
  assert.equal(metricDetails.contains(getById("metric-construction")), true);
  assert.equal(getById("metric-construction-status").textContent, "Formula missing");
  assert.match(getById("metric-construction-formula").textContent, /Formula not configured/);
  assert.match(getById("metric-construction-formula").textContent, /METRIC seconds=<number>/);
  assert.match(getById("metric-fallback-note").textContent, /Metric metadata is incomplete/);
  assert.match(getById("metric-detail-primary").textContent, /METRIC seconds=4\.8s/);
});

test("dashboard renders a generated Codex summary of history and plan", async () => {
  const entries = [
    {
      type: "config",
      name: "summary path",
      metricName: "seconds",
      bestDirection: "lower",
      metricUnit: "s",
    },
    {
      type: "run",
      run: 1,
      metric: 8,
      status: "keep",
      description: "Baseline",
      confidence: 1,
      asi: { hypothesis: "Baseline." },
    },
    {
      type: "run",
      run: 2,
      metric: 6,
      status: "keep",
      description: "Faster cache",
      confidence: 2,
      asi: { next_action_hint: "Stress the cache path." },
    },
    {
      type: "run",
      run: 3,
      metric: 7,
      status: "discard",
      description: "Noisy branch",
      confidence: 1,
      asi: { rollback_reason: "Regressed latency." },
    },
  ];

  const viewModel = buildDashboardViewModel({
    state: {
      config: {
        name: "summary path",
        metricName: "seconds",
        metricUnit: "s",
        bestDirection: "lower",
      },
      segment: 0,
      current: entries.filter((entry) => entry.type === "run"),
      baseline: 8,
      best: 6,
      confidence: 2,
    },
    finalizePreview: { ready: true, nextAction: "Preview finalization." },
    experimentMemory: { latestNextAction: "Stress the cache path." },
  });

  const { getById } = await runDashboard(entries, emptyCommandMeta({ viewModel }));

  assert.match(getById("ai-summary-title").textContent, /Next move is ready/);
  assert.match(getById("ai-summary-happened").innerHTML, /3 runs/);
  assert.match(getById("ai-summary-plan").innerHTML, /Stress the cache path|finalization/i);
  assert.match(getById("ai-summary-source").textContent, /latest #3/);
});

test("dashboard view model and rail expose the authoritative decision envelope", async () => {
  const entries = [
    dashboardConfigEntry({ name: "envelope path", metricName: "seconds", metricUnit: "s" }),
    {
      type: "run",
      run: 1,
      metric: 9,
      status: "keep",
      description: "Baseline anchor",
    },
    {
      type: "run",
      run: 2,
      metric: 8.8,
      status: "measure",
      description: "Trend-only probe",
      asi: { evidence: "Measured variance only." },
    },
  ];
  const viewModel = buildDashboardViewModel({
    state: {
      config: {
        name: "envelope path",
        metricName: "seconds",
        metricUnit: "s",
        bestDirection: "lower",
      },
      segment: 0,
      current: entries.filter((entry) => entry.type === "run"),
      baseline: 9,
      best: 9,
      confidence: 1,
      decisionEnvelope: {
        activeSegment: { segment: 0, runs: 2, baseline: 9, best: 9 },
        latestPacketFreshness: {
          fresh: false,
          reason: "Last-run packet is stale: history changed.",
          expectedNextRun: 2,
          actualNextRun: 3,
        },
        scaffoldHealth: { ok: true, status: "ok", blockers: [] },
        finalizationReadiness: { available: true, ready: true, nextAction: "Preview." },
        nextAction: "Preview finalization after replacing stale packet.",
      },
    },
    finalizePreview: { ready: true, nextAction: "Preview." },
  });

  assert.equal(viewModel.nextBestAction.kind, "stale-packet");
  assert.equal(viewModel.decisionEnvelopeSummary.kind, "stale-packet");
  assert.equal(viewModel.summary.measured, 1);
  assert.equal(viewModel.summary.failed, 0);
  assert.match(viewModel.readout.measurementRuns[0].description, /Trend-only/);

  const { getById } = await runDashboard(entries, emptyCommandMeta({ viewModel }));
  assert.match(getById("decision-envelope-summary").textContent, /Replace the stale packet/);
  assert.match(getById("decision-rail").textContent, /Last-run packet is stale/);
  assert.doesNotMatch(getById("v2-release-signals").textContent || "", /Last-run packet is stale/);
  assert.match(getById("ledger-body").textContent, /Measurement/);
  assert.doesNotMatch(getById("recent-failure-detail").textContent, /Trend-only/);
});

test("dashboard view model warns after a watchdog no-progress window", () => {
  const now = Date.UTC(2026, 4, 26, 12, 0, 0);
  const old = now - 10 * 60 * 60 * 1000;
  const viewModel = buildDashboardViewModel({
    state: {
      config: {
        name: "watchdog path",
        metricName: "seconds",
        metricUnit: "s",
        bestDirection: "lower",
        watchdogNoProgressHours: 8,
      },
      segment: 0,
      current: [
        {
          run: 1,
          metric: 10,
          status: "keep",
          description: "Baseline",
          timestamp: old,
          segment: 0,
          metrics: {},
          asi: {},
        },
        {
          run: 2,
          metric: 10,
          status: "discard",
          description: "No movement",
          timestamp: old + 60_000,
          segment: 0,
          metrics: {},
          asi: {},
        },
      ],
      baseline: 10,
      best: 10,
      confidence: null,
    },
    settings: {
      deliveryMode: "live-server",
      generatedAt: new Date(now).toISOString(),
      now,
      sourceCwd: "C:/repo/watchdog",
      pluginVersion: "0.test",
    },
  });

  assert.equal(viewModel.watchdogSummary.stale, true);
  assert.equal(viewModel.decisionEnvelope.watchdog.stale, true);
  assert.equal(viewModel.decisionEnvelopeSummary.kind, "watchdog");
  assert.match(viewModel.nextBestAction.detail, /Intervene|finalize|rescope/i);
  assert.equal(viewModel.nextBestAction.safeAction, "state");
  assert.notEqual(viewModel.nextBestAction.safeAction, "next");
  assert.doesNotMatch(String(viewModel.nextBestAction.command || ""), /\bnext\b/);
  assert.match(viewModel.processHygiene.warnings.join("\n"), /Intervene|quiet/i);
});

test("dashboard view model exposes finalization pressure before more packets accumulate", () => {
  const now = Date.UTC(2026, 4, 26, 12, 0, 0);
  const runs = [1, 2, 3].map((run) => ({
    run,
    metric: 10 - run,
    status: "keep",
    description: `Kept ${run}`,
    timestamp: now - run * 60_000,
    segment: 0,
    commit: `abc${run}`,
    metrics: {},
    asi: {},
  }));
  const viewModel = buildDashboardViewModel({
    state: {
      config: {
        name: "pressure path",
        metricName: "seconds",
        metricUnit: "s",
        bestDirection: "lower",
      },
      segment: 0,
      current: runs,
      baseline: 9,
      best: 7,
      confidence: 1,
    },
    settings: {
      deliveryMode: "static-export",
      generatedAt: new Date(now).toISOString(),
      now,
      sourceCwd: "C:/repo/pressure",
      pluginVersion: "0.test",
    },
    finalizePreview: {
      ready: false,
      groups: [],
      warnings: ["Final tree has unreviewed backlog."],
      nextAction: "Run finalize-preview before more packets.",
    },
  });

  assert.equal(viewModel.finalizationPressure.status, "high");
  assert.match(
    viewModel.processHygiene.warnings.join("\n"),
    /Static export is a snapshot and cannot prove current runtime freshness/i,
  );
  assert.match(viewModel.finalizationPressure.recommendation, /finalize-preview|rescope/i);
  assert.ok(
    viewModel.finalizationChecklist.some(
      (item) => item.label === "Finalization pressure" && item.state === "blocked",
    ),
  );
});

test("dashboard keeps rejected keep evidence out of best and finalization pressure", () => {
  const viewModel = buildDashboardViewModel({
    state: {
      config: {
        name: "rejected keep",
        metricName: "score",
        bestDirection: "lower",
      },
      segment: 0,
      current: [
        {
          run: 1,
          metric: 10,
          status: "keep",
          evidenceStatus: "accepted",
          description: "Accepted keep",
        },
        {
          run: 2,
          metric: 1,
          status: "keep",
          evidenceStatus: "rejected",
          description: "Rejected keep",
        },
      ],
      baseline: 10,
      best: 10,
      confidence: 1,
    },
    settings: { deliveryMode: "static-export" },
  });

  assert.equal(viewModel.readout.bestKept?.run, 1);
  assert.equal(viewModel.readout.bestKept?.metric, 10);
  assert.equal(viewModel.finalizationPressure.keptCount, 1);
  assert.doesNotMatch(JSON.stringify(viewModel.nextBestAction), /Rejected keep/);
});

test("dashboard readout keeps rejected keeps out of visible best surfaces", async () => {
  const entries = [
    {
      type: "config",
      name: "rejected keep UI",
      metricName: "score",
      bestDirection: "lower",
    },
    {
      type: "run",
      run: 1,
      metric: 10,
      status: "keep",
      evidenceStatus: "accepted",
      description: "Accepted keep",
      confidence: 1,
    },
    {
      type: "run",
      run: 2,
      metric: 1,
      status: "keep",
      evidenceStatus: "rejected",
      description: "Rejected keep",
      confidence: 1,
    },
  ];

  const { dom, getById } = await runDashboard(entries, emptyCommandMeta());
  const bestRows = [...dom.window.document.querySelectorAll(".ledger-row.best-row")];

  assert.equal(getById("best-value").textContent, "10");
  assert.equal(bestRows.length, 1);
  assert.match(bestRows[0].textContent || "", /#1/);
  assert.doesNotMatch(bestRows[0].textContent || "", /#2/);
  assert.match(getById("decision-rail").textContent || "", /Best result so farAccepted keep/);
  assert.doesNotMatch(
    getById("decision-rail").textContent || "",
    /Best result so farRejected keep/,
  );
});
