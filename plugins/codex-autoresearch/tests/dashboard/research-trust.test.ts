import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboardViewModel } from "../../lib/dashboard-view-model.js";
import { PLUGIN_VERSION } from "../../lib/plugin-version.js";
import { createDashboardHarness, emptyCommandMeta, waitFor } from ".././helpers/dashboard.js";

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

test("stale last-run handling remains visible in dashboard guidance", async () => {
  const staleReason =
    "Last-run packet is stale: expected next log run #2, but current history would log #3.";
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
    {
      type: "config",
      name: "stale path",
      metricName: "seconds",
      bestDirection: "lower",
      metricUnit: "",
    },
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
    liveRefreshAvailable: true,
    liveActionsAvailable: false,
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

test("dashboard copy buttons expose the current URL and next CLI command", async () => {
  const writes = [];
  const viewModel = {
    nextBestAction: {
      title: "Replace the stale packet",
      detail: "Run a fresh packet before logging.",
      command: "node scripts/autoresearch.mjs next --cwd .",
    },
  };
  const entries = [
    {
      type: "config",
      name: "copy affordances",
      metricName: "seconds",
      bestDirection: "lower",
      metricUnit: "s",
    },
    { type: "run", run: 1, metric: 5, status: "keep", description: "Baseline", confidence: 1 },
  ];

  const { getById, dom } = await runDashboard(
    entries,
    {
      deliveryMode: "live-server",
      liveRefreshAvailable: true,
      liveActionsAvailable: false,
      liveUrl: "http://127.0.0.1:61234/",
      viewModel,
      commands: [],
    },
    {
      beforeParse(window) {
        Object.defineProperty(window.navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async (value) => {
              writes.push(value);
            },
          },
        });
      },
    },
  );

  getById("copy-dashboard-url").click();
  await waitFor(() => writes.length === 1, "Copy URL button did not write the dashboard URL.");
  assert.deepEqual(writes, ["http://127.0.0.1:61234/"]);
  await waitFor(
    () => getById("copy-dashboard-url-status").hidden === false,
    "Copy URL status did not become visible.",
  );
  dom.window.close();
});

test("dashboard promotes Codex brief and session memory instead of command controls", async () => {
  const viewModel = {
    aiSummary: {
      title: "Codex handoff",
      happened: ["Run #1 created the baseline."],
      plan: ["Compare the next hypothesis against the baseline."],
      source: "test model",
    },
    experimentMemory: {
      plateau: { detected: false },
      lanePortfolio: [
        {
          id: "cache",
          title: "Cache path",
          status: "ready",
          nextActionHint: "Test manifest cache reuse.",
        },
      ],
    },
  };
  const entries = [
    {
      type: "config",
      name: "mission path",
      metricName: "seconds",
      bestDirection: "lower",
      metricUnit: "s",
    },
    { type: "run", run: 1, metric: 5, status: "keep", description: "Baseline", confidence: 1 },
  ];

  const { getById, queryById } = await runDashboard(
    entries,
    {
      deliveryMode: "live-server",
      liveRefreshAvailable: true,
      liveActionsAvailable: false,
      viewModel,
      commands: [],
    },
    { url: "http://127.0.0.1/?view=audit" },
  );

  assert.match(getById("codex-brief").textContent, /Run #1 created the baseline/);
  assert.match(getById("strategy-memory").textContent, /Test manifest cache reuse/);
  assert.equal(queryById("mission-control-grid"), null);
  assert.equal(queryById("log-decision-panel"), null);
  assert.equal(queryById("action-receipt"), null);
  assert.equal(queryById("live-actions-panel"), null);
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
    {
      type: "config",
      name: "round guidance",
      metricName: "quality_gap",
      bestDirection: "lower",
      metricUnit: "gaps",
    },
    {
      type: "run",
      run: 1,
      metric: 0,
      status: "keep",
      description: "Closed accepted gaps",
      confidence: 1,
    },
  ];

  const { getById } = await runDashboard(entries, emptyCommandMeta({ viewModel }), {
    url: "file:///autoresearch-dashboard.html?view=audit",
  });

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
      {
        label: "Gap candidates",
        command:
          "node scripts/autoresearch.mjs gap-candidates --cwd . --research-slug closed-gap-path",
      },
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

  assert.equal(viewModel.nextBestAction.kind, "segment-transition");
  assert.equal(viewModel.nextBestAction.title, "Review completion state");
  assert.match(viewModel.nextBestAction.detail, /quality round is closed/);
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
    warnings: [
      "Working tree is dirty.",
      "Corrupt autoresearch.jsonl.",
      "Last-run packet is stale.",
    ],
  });

  assert.equal(viewModel.trustState.mode, "static-export");
  assert.equal(viewModel.trustState.status, "needs-attention");
  assert.equal(viewModel.trustState.pluginVersion, "0.test");
  assert.equal(viewModel.trustState.sourceCwd, "C:/repo");
  assert.equal(viewModel.researchTruth.queryCount, null);
  assert.equal(viewModel.researchTruth.promotionGrade, null);
  assert.equal(viewModel.evidenceReadout.label, "blocked");
  assert.match(viewModel.proofGaps.map((gap) => gap.detail).join("\n"), /Benchmark command/);
  assert.match(
    viewModel.proofGaps.map((gap) => gap.nextAction).join("\n"),
    /setup|doctor|dashboard/i,
  );
  assert.deepEqual(viewModel.researchTruth.suspiciousReasons, []);
  const delta = viewModel.evidenceChips.find((chip) => chip.label === "Delta");
  assert.equal(delta.value, "unknown");
  assert.doesNotMatch(delta.value, /0%/);
  assert.ok(
    viewModel.finalizationChecklist.some(
      (item) => item.label === "Preview packet" && item.state === "unknown",
    ),
  );
});

test("dashboard renders actual trust reasons with friendly mode labels", async () => {
  const entries = [
    {
      type: "config",
      name: "trust reasons",
      metricName: "quality_gap",
      bestDirection: "lower",
      metricUnit: "gaps",
    },
  ];
  const viewModel = buildDashboardViewModel({
    state: {
      config: {
        name: "trust reasons",
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
    warnings: [
      "Working tree is dirty.",
      "Corrupt autoresearch.jsonl.",
      "Last-run packet is stale.",
    ],
  });

  const { dom, queryById } = await runDashboard(entries, {
    deliveryMode: "static-export",
    liveActionsAvailable: false,
    viewModel,
    commands: [],
  });

  assert.equal(queryById("trust-strip"), null);
  assert.equal(dom.window.document.getElementById("trust-warnings"), null);
  assert.match(viewModel.trustState.reasons.join("\n"), /Working tree is dirty/);
  assert.match(viewModel.trustState.reasons.join("\n"), /Corrupt autoresearch\.jsonl/);
  assert.match(viewModel.trustState.reasons.join("\n"), /Last-run packet is stale/);
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
  assert.equal(
    viewModel.evidenceChips.find((chip) => chip.label === "Research truth").value,
    "Suspicious",
  );
});

test("dashboard view model treats perfect secondary metrics as suspicious", () => {
  const viewModel = buildDashboardViewModel({
    state: {
      config: {
        name: "perfect secondary",
        metricName: "score",
        metricUnit: "points",
        bestDirection: "higher",
      },
      segment: 0,
      current: [
        {
          run: 1,
          metric: 1,
          status: "keep",
          description: "Thin perfect score",
          metrics: {
            mrr_at_10: 1,
            hit_at_1: 1,
            quality_component: 1,
          },
        },
      ],
      baseline: 1,
      best: 1,
      confidence: null,
    },
  });

  const reasons = viewModel.researchTruth.suspiciousReasons.join("\n");
  assert.match(reasons, /mrr_at_10/);
  assert.match(reasons, /hit_at_1/);
  assert.match(reasons, /quality_component/);
  assert.match(reasons, /promotion-grade/);
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
      ok: false,
      local: { version: PLUGIN_VERSION },
      installed: {
        available: true,
        version: "0.5.1",
        path: "C:/Users/alber/.codex/plugins/cache/thegreencedar-autoresearch/codex-autoresearch/0.5.1",
      },
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
  assert.equal(viewModel.trustState.runtimeDrift.sourceVersion, PLUGIN_VERSION);
  assert.equal(viewModel.trustState.runtimeDrift.installedVersion, "0.5.1");
  assert.equal(viewModel.nextBestAction.kind, "stale-packet");
  assert.match(viewModel.nextBestAction.detail, /stale/);
});
