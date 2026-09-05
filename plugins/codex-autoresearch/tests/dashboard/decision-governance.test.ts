import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  buildActionRail,
  buildDashboardViewModel,
  buildTrustState,
} from "../../lib/dashboard-view-model.js";
import { PLUGIN_VERSION } from "../../lib/plugin-version.js";
import { resolvePackageRoot } from "../../lib/runtime-paths.js";
import { createDashboardHarness, dashboardConfigEntry } from ".././helpers/dashboard.js";
import {
  assertNoMutatingDashboardCommands,
  dashboardDecisionPlanProjection,
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

test("dashboard action rail projects stale-packet recovery from the canonical plan", () => {
  const decisionPlanProjection = dashboardDecisionPlanProjection({
    actionKind: "replace-packet",
    actionReason: "Replace the stale packet before continuing.",
    blockerCode: "stale-packet",
    capabilityStatuses: { "run-packet": "recovery-only" },
    loopKind: "blocked",
    parentKind: "hand-back",
    phase: "packet",
  });
  const viewModel = buildDashboardViewModel({
    state: {
      config: {
        name: "stale packet",
        metricName: "seconds",
        metricUnit: "s",
        bestDirection: "lower",
      },
      segment: 0,
      current: [{ run: 1, metric: 5, status: "keep", description: "Baseline" }],
      baseline: 5,
      best: 5,
      decisionPlanProjection,
    },
    guidedSetup: {
      stage: "stale-last-run",
      nextAction: "Legacy guidance must not own the action.",
    },
    commands: [{ label: "Next run", command: "node scripts/autoresearch.mjs next --cwd ." }],
  } as any);

  assert.equal(decisionPlanProjection.capabilities["run-packet"], "recovery-only");
  assert.equal(decisionPlanProjection.loopDisposition.kind, "blocked");
  assert.equal(decisionPlanProjection.parentDisposition.kind, "hand-back");
  assert.equal(viewModel.actionRail[0].kind, "replace-packet");
  assert.equal(viewModel.actionRail[0].detail, "Replace the stale packet before continuing.");
  assert.equal(Object.hasOwn(viewModel.actionRail[0], "command"), false);
});

test("dashboard view model strips packet and log commands from decision states", () => {
  const cases = [
    {
      name: "pending log",
      expectedKind: "log-decision",
      projection: dashboardDecisionPlanProjection({
        actionKind: "log-decision",
        actionReason: "Log the pending packet before another run.",
        blockerCode: "pending-packet",
        capabilityStatuses: { "run-packet": "blocked" },
        loopKind: "blocked",
        parentKind: "hand-back",
        phase: "packet",
      }),
      guidedSetup: {
        stage: "needs-log-decision",
        nextAction: "Log the last packet with an allowed status before starting another run.",
        commands: {
          logLast:
            'node scripts/autoresearch.mjs log --cwd . --from-last --status keep --description "Describe"',
          keepLast:
            'node scripts/autoresearch.mjs log --cwd . --from-last --status keep --description "Keep"',
          discardLast:
            'node scripts/autoresearch.mjs log --cwd . --from-last --status discard --description "Discard"',
        },
        nextStep: {
          nextAction: {
            command:
              'node scripts/autoresearch.mjs log --cwd . --from-last --status keep --description "Describe"',
          },
        },
        lastRun: {
          allowedStatuses: ["keep", "discard"],
          suggestedStatus: "keep",
          freshness: { fresh: true, reason: "Packet is fresh." },
        },
      },
    },
    {
      name: "stale last-run",
      expectedKind: "replace-packet",
      projection: dashboardDecisionPlanProjection({
        actionKind: "replace-packet",
        actionReason: "Replace the stale packet before another run.",
        blockerCode: "stale-packet",
        capabilityStatuses: { "run-packet": "recovery-only" },
        loopKind: "blocked",
        parentKind: "hand-back",
        phase: "packet",
      }),
      guidedSetup: {
        stage: "stale-last-run",
        nextAction: "Last-run packet is stale.",
        commands: {
          replaceLast:
            'node scripts/autoresearch.mjs next --cwd . --command "node -e \\"console.log(\'METRIC seconds=3\')\\""',
          baseline: "node scripts/autoresearch.mjs next --cwd .",
        },
        nextStep: {
          nextAction: {
            command: "node scripts/autoresearch.mjs next --cwd . --compact",
          },
        },
        lastRun: {
          allowedStatuses: ["keep", "discard"],
          suggestedStatus: "keep",
          freshness: { fresh: false, reason: "Last-run packet is stale." },
        },
      },
    },
  ];

  for (const item of cases) {
    const viewModel = buildDashboardViewModel({
      state: {
        config: {
          name: item.name,
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
        decisionPlanProjection: item.projection,
      },
      setupPlan: {
        configured: true,
        defaultBenchmarkCommandReady: true,
        commands: { setup: "node scripts/autoresearch.mjs setup --cwd ." },
      },
      guidedSetup: item.guidedSetup,
      commands: [
        { label: "Next run", command: "node scripts/autoresearch.mjs next --cwd ." },
        {
          label: "Keep last",
          command:
            'node scripts/autoresearch.mjs log --cwd . --from-last --status keep --description "Keep"',
        },
        {
          label: "Discard last",
          command:
            'node scripts/autoresearch.mjs log --cwd . --from-last --status discard --description "Discard"',
        },
        { label: "Doctor", command: "node scripts/autoresearch.mjs doctor --cwd ." },
        {
          label: "Finalize preview",
          command: "node scripts/autoresearch.mjs finalize-preview --cwd .",
        },
      ],
    } as any);

    assert.equal(viewModel.nextBestAction.kind, item.expectedKind);
    assert.equal(viewModel.decisionPlanProjection.action.command, "");
    assert.equal(viewModel.decisionPlanProjection.loopDisposition.kind, "blocked");
    assert.equal(viewModel.decisionPlanProjection.parentDisposition.kind, "hand-back");
    assert.equal(viewModel.guidedSetup.commands, undefined);
    assert.equal(viewModel.missionControl.logDecision.commandsByStatus, undefined);
    assert.equal(viewModel.missionControl.logDecision.liveAction, undefined);
    assertNoMutatingDashboardCommands({
      nextBestAction: viewModel.nextBestAction,
      missionControl: viewModel.missionControl,
      guidedSetup: viewModel.guidedSetup,
    });
  }
});

test("dashboard treats a compatibility summary without canonical capability as unavailable", () => {
  const rail = buildActionRail({
    current: [],
    bestKept: null,
    latestFailure: null,
    nextAction: "",
    decisionEnvelopeSummary: {
      kind: "run-packet",
      priority: "Next",
      title: "Legacy packet guidance",
      detail: "This summary has no canonical run-packet capability.",
    },
    commands: [{ label: "Next run", command: "node scripts/autoresearch.mjs next --cwd ." }],
  });

  assert.equal(rail[0].kind, "decision-unavailable");
  assert.equal(rail[0].packetBrake, true);
  assert.equal(rail[0].source, "decision-plan");
  assert.doesNotMatch(String(rail[0].command || ""), /\bnext\b/);
});

test("dashboard uses the compiler projection instead of a local priority ladder", () => {
  const decisionPlanProjection = dashboardDecisionPlanProjection({
    actionKind: "configure-checks",
    actionReason: "Configure accepted checks before another packet.",
    blockerCode: "checks-required",
    capabilityStatuses: {
      "run-packet": "blocked",
      "authorize-keep": "blocked",
    },
    loopKind: "blocked",
    parentKind: "hand-back",
    phase: "setup",
  });
  const viewModel = buildDashboardViewModel({
    state: {
      config: {
        name: "canonical decision",
        metricName: "seconds",
        metricUnit: "s",
        bestDirection: "lower",
      },
      segment: 0,
      current: [{ run: 1, metric: 5, status: "keep", description: "Baseline" }],
      baseline: 5,
      best: 5,
      decisionPlanProjection,
      limit: { limitReached: true },
    },
    guidedSetup: {
      stage: "stale-last-run",
      nextAction: "Legacy stale-packet guidance.",
    },
    experimentMemory: {
      plateau: { detected: true, recommendation: "Legacy plateau guidance." },
    },
    finalizePreview: { ready: true, nextAction: "Legacy finalization guidance." },
    commands: [{ label: "Next run", command: "node scripts/autoresearch.mjs next --cwd ." }],
  } as any);

  assert.equal(decisionPlanProjection.capabilities["run-packet"], "blocked");
  assert.equal(decisionPlanProjection.capabilities["authorize-keep"], "blocked");
  assert.equal(decisionPlanProjection.loopDisposition.kind, "blocked");
  assert.equal(decisionPlanProjection.parentDisposition.kind, "hand-back");
  assert.equal(viewModel.nextBestAction.kind, "configure-checks");
  assert.equal(viewModel.decisionEnvelopeSummary.kind, "configure-checks");
  assert.equal(viewModel.nextBestAction.detail, "Configure accepted checks before another packet.");
});

test("dashboard projects exhausted packet budget as a capability-scoped pause", () => {
  const decisionPlanProjection = dashboardDecisionPlanProjection({
    actionKind: "pause-packets",
    actionReason: "Packet budget exhausted; hand control back before more packets.",
    blockerCode: "packet-budget-exhausted",
    capabilityStatuses: { "run-packet": "blocked" },
    loopKind: "pause",
    parentKind: "hand-back",
    phase: "paused",
  });
  const viewModel = buildDashboardViewModel({
    state: {
      config: {
        name: "budgeted run",
        metricName: "seconds",
        metricUnit: "s",
        bestDirection: "lower",
      },
      segment: 0,
      current: [{ run: 1, metric: 1, status: "keep", description: "Baseline" }],
      results: [{ run: 1, metric: 1, status: "keep", description: "Baseline" }],
      baseline: 1,
      best: 1,
      decisionPlanProjection,
      limit: {
        limitReached: true,
        budgetStatus: {
          configured: true,
          exhausted: true,
          packetBudget: 1,
          packetsUsed: 1,
          packetsRemaining: 0,
          stopReason: "Packet budget exhausted (1/1 packets used).",
          nextAction:
            "Budget exhausted; stop packet work and ask whether to extend, rescope, or start a new segment.",
        },
      },
    },
    commands: [
      { label: "Next run", command: "node scripts/autoresearch.mjs next --cwd ." },
      {
        label: "New segment",
        command: "node scripts/autoresearch.mjs new-segment --cwd . --dry-run",
      },
    ],
  } as any);

  assert.equal(decisionPlanProjection.capabilities["run-packet"], "blocked");
  assert.equal(decisionPlanProjection.capabilities["transition-segment"], "allowed");
  assert.equal(decisionPlanProjection.loopDisposition.kind, "pause");
  assert.equal(decisionPlanProjection.parentDisposition.kind, "hand-back");
  assert.equal(viewModel.decisionEnvelopeSummary.kind, "pause-packets");
  assert.match(viewModel.nextBestAction.detail, /Packet budget exhausted/);
  assert.equal(Object.hasOwn(viewModel.nextBestAction, "command"), false);
});

test("finalization readiness does not override the canonical dashboard action", () => {
  const decisionPlanProjection = dashboardDecisionPlanProjection({
    actionKind: "run-packet",
    actionReason: "Run the accepted holdout packet next.",
    loopKind: "continue",
    parentKind: "hand-back",
    phase: "packet",
  });
  const viewModel = buildDashboardViewModel({
    state: {
      config: {
        name: "active research",
        metricName: "score",
        metricUnit: "points",
        bestDirection: "higher",
      },
      segment: 0,
      current: [
        {
          run: 1,
          metric: 0.5,
          status: "keep",
          description: "Baseline",
          asi: { next_action_hint: "Run the holdout scorer packet next." },
        },
      ],
      baseline: 0.5,
      best: 0.5,
      confidence: null,
      decisionPlanProjection,
    },
    guidedSetup: {
      stage: "ready",
      state: { limit: { limitReached: false, remainingIterations: 3 } },
    },
    finalizePreview: {
      ready: true,
      nextAction: "Preview finalization.",
      warnings: [],
    },
    commands: [
      { label: "Next run", command: "node scripts/autoresearch.mjs next --cwd ." },
      {
        label: "Finalize preview",
        command: "node scripts/autoresearch.mjs finalize-preview --cwd .",
      },
    ],
  } as any);

  assert.equal(decisionPlanProjection.capabilities.finalize, "allowed");
  assert.equal(decisionPlanProjection.capabilities["run-packet"], "allowed");
  assert.equal(decisionPlanProjection.loopDisposition.kind, "continue");
  assert.equal(decisionPlanProjection.parentDisposition.kind, "hand-back");
  assert.equal(viewModel.nextBestAction.kind, "run-packet");
  assert.equal(viewModel.nextBestAction.detail, "Run the accepted holdout packet next.");
  assert.doesNotMatch(viewModel.nextBestAction.detail, /Preview finalization/);
});

test("dashboard trust builder separates read-only mode from decision blockers", () => {
  const clean = buildTrustState({
    state: {
      config: {
        name: "trust clean",
        metricName: "seconds",
        metricUnit: "s",
        bestDirection: "lower",
        pluginVersion: PLUGIN_VERSION,
      },
      current: [{ run: 1, metric: 5, status: "keep", description: "Baseline" }],
      baseline: 5,
      best: 5,
    },
    settings: {
      deliveryMode: "static-export",
      generatedAt: "2026-04-24T00:00:00.000Z",
      pluginVersion: PLUGIN_VERSION,
      sourceCwd: "C:/repo",
    },
  });

  assert.equal(clean.trustState.status, "read-only");
  assert.deepEqual(clean.decisionWarnings, []);
  assert.match(clean.trustState.reasons.join("\n"), /Static export/);

  const dirty = buildTrustState({
    state: {
      config: {
        name: "trust dirty",
        metricName: "seconds",
        metricUnit: "s",
        bestDirection: "lower",
      },
      current: [{ run: 1, metric: 5, status: "keep", description: "Baseline" }],
      baseline: 5,
      best: 5,
    },
    settings: { deliveryMode: "live-server", pluginVersion: PLUGIN_VERSION },
    warnings: ["Git worktree is dirty; review unrelated changes before logging a keep result."],
  });

  assert.equal(dirty.trustState.status, "needs-attention");
  assert.match(dirty.decisionWarnings.join("\n"), /dirty/);

  const commandBearing = buildTrustState({
    state: {
      config: {
        name: "trust command",
        metricName: "seconds",
        metricUnit: "s",
        bestDirection: "lower",
      },
      current: [
        {
          run: 1,
          metric: 5,
          status: "keep",
          description: "Baseline",
          commandExecutionBoundary: "not_sandboxed",
        },
      ],
      baseline: 5,
      best: 5,
    },
    settings: { deliveryMode: "live-server", pluginVersion: PLUGIN_VERSION },
  });

  assert.equal(commandBearing.trustState.status, "trusted");
  assert.equal(commandBearing.trustState.commandExecutionBoundary.mode, "not_sandboxed");
  assert.match(commandBearing.trustState.commandExecutionBoundary.note, /current user's/);
  assert.deepEqual(commandBearing.decisionWarnings, []);
});

test("dashboard distinguishes static snapshots from served readouts", async () => {
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
        {
          id: "finalize",
          title: "Finalize",
          state: "ready",
          detail: "Preview the packet.",
          command: "node scripts/autoresearch.mjs finalize-preview --cwd .",
          safeAction: "finalize-preview",
        },
      ],
      logDecision: {
        available: false,
        allowedStatuses: [],
        suggestedStatus: "",
        commandsByStatus: {},
      },
    },
  };
  const entries = [
    {
      type: "config",
      name: "static dashboard",
      metricName: "quality_gap",
      bestDirection: "lower",
      metricUnit: "gaps",
    },
    { type: "run", run: 1, metric: 0, status: "keep", description: "Closed gaps", confidence: 1 },
  ];

  const { getById, queryById } = await runDashboard(entries, {
    deliveryMode: "static-export",
    liveActionsAvailable: false,
    modeGuidance: {
      title: "Static snapshot",
      detail: "Read-only export. Serve the dashboard for fresh state.",
    },
    viewModel,
    commands: [],
  });

  assert.ok(getById("dashboard-toolbar"));
  assert.equal(queryById("live-region") === null, true);
  assert.equal(queryById("trust-strip") === null, true);
  assert.equal(getById("refresh-now").hidden, true);
  assert.equal(getById("live-toggle").hidden, true);
  assert.equal(queryById("mission-control-grid") === null, true);
  assert.equal(queryById("live-actions-panel") === null, true);
  assert.equal(queryById("log-decision-panel") === null, true);
});

test("dashboard keeps static exports read-only when served over HTTP", async () => {
  const entries = [
    {
      type: "config",
      name: "hosted static dashboard",
      metricName: "quality_gap",
      bestDirection: "lower",
      metricUnit: "gaps",
    },
    { type: "run", run: 1, metric: 0, status: "keep", description: "Closed gaps", confidence: 1 },
  ];

  const { getById, queryById, dom } = await runDashboard(
    entries,
    {
      deliveryMode: "static-export",
      liveActionsAvailable: false,
      modeGuidance: {
        title: "Static snapshot",
        detail: "Read-only export. Serve the dashboard for fresh state.",
      },
      viewModel: {
        decisionPlanProjection: dashboardDecisionPlanProjection({
          actionKind: "finalize",
          actionReason: "Preview finalization in the CLI.",
          loopKind: "continue",
          parentKind: "hand-back",
          phase: "finalization",
        }),
        nextBestAction: {
          title: "Preview finalization",
          detail: "Review the packet.",
          command: "node scripts/autoresearch.mjs finalize-preview --cwd .",
          safeAction: "finalize-preview",
        },
      },
    },
    {
      url: "https://static.example/autoresearch-dashboard.html",
    },
  );

  assert.ok(getById("dashboard-toolbar"));
  assert.equal(queryById("live-region") === null, true);
  assert.equal(getById("refresh-now").hidden, true);
  assert.equal(getById("live-toggle").hidden, true);
  assert.equal(queryById("live-actions-panel") === null, true);
  assert.equal(queryById("next-command-copy") === null, true);
  assert.equal(
    queryById("decision-next-command")?.textContent?.trim(),
    "Redacted here. Continue in the CLI.",
  );
  assert.doesNotMatch(queryById("decision-next-command")?.textContent || "", /finalize-preview/);
  assert.equal(dom.window.document.querySelector(".mission-command") === null, true);
  dom.window.close();
});

test("showcase dashboard labels explicit demo provenance while keeping diagnostics in the model", async () => {
  const entries = [
    {
      type: "config",
      name: "optimize my indexing pipeline's speed and memory footprint",
      metricName: "seconds",
      bestDirection: "lower",
      metricUnit: "s",
    },
    {
      type: "run",
      run: 1,
      metric: 10,
      status: "keep",
      description: "Baseline indexing pipeline",
      confidence: 1,
    },
    {
      type: "run",
      run: 2,
      metric: 8.4,
      status: "keep",
      description: "Reuse parsed manifests",
      confidence: 2,
    },
  ];

  const { getById, queryById } = await runDashboard(entries, {
    deliveryMode: "showcase",
    liveActionsAvailable: false,
    showcaseMode: true,
    modeGuidance: {
      title: "Demo Snapshot",
      detail: "100 embedded packets.",
    },
    viewModel: {
      warnings: [
        "Static read-only export.",
        "Git worktree is dirty; review unrelated changes before logging a keep result.",
      ],
      nextBestAction: {
        title: "Confirm indexing cache",
        detail: "Check memory footprint before keeping the path.",
      },
    },
  });

  assert.ok(getById("dashboard-toolbar"));
  assert.ok(getById("live-region"));
  assert.match(getById("live-detail").textContent || "", /Showcase provenance: explicit demo data/);
  assert.equal(getById("refresh-now").hidden, true);
  assert.equal(getById("live-toggle").hidden, true);
  assert.equal(queryById("trust-strip") === null, true);
  assert.equal(getById("side-mode-detail").textContent, "Showcase Data");
  assert.equal(
    getById("next-action-detail").textContent,
    "Check memory footprint before keeping the path.",
  );
  assert.equal(getById("decision-evidence-chips").textContent.includes("Needs attention"), false);
  assert.equal(queryById("live-actions-panel") === null, true);
});

test("served dashboard exposes live refresh but no command-center controls", async () => {
  const viewModel = {
    decisionPlanProjection: dashboardDecisionPlanProjection({
      actionKind: "finalize",
      actionReason: "Preview finalization in the CLI.",
      loopKind: "continue",
      parentKind: "hand-back",
      phase: "finalization",
    }),
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
        {
          id: "finalize",
          title: "Finalize",
          state: "ready",
          detail: "Review the packet.",
          primaryCommand: {
            label: "Preview",
            command: "node scripts/autoresearch.mjs finalize-preview --cwd .",
          },
          command: "node scripts/autoresearch.mjs log --cwd . --from-last --status keep",
        },
      ],
    },
  };
  const entries = [
    {
      type: "config",
      name: "served dashboard",
      metricName: "quality_gap",
      bestDirection: "lower",
      metricUnit: "gaps",
    },
    { type: "run", run: 1, metric: 0, status: "keep", description: "Closed gaps", confidence: 1 },
  ];

  const { getById, queryById } = await runDashboard(entries, {
    deliveryMode: "live-server",
    liveRefreshAvailable: true,
    liveActionsAvailable: false,
    modeGuidance: {
      title: "Live Readout",
      detail: "Served mode can refresh the view model; actions stay in CLI.",
    },
    viewModel,
    commands: [],
  });

  assert.ok(getById("dashboard-toolbar"));
  assert.equal(getById("live-title").textContent, "Live Readout");
  assert.match(getById("live-detail").textContent || "", /refresh the view model/);
  assert.equal(queryById("trust-strip") === null, true);
  assert.equal(getById("refresh-now").textContent, "Refresh Readout");
  assert.equal(getById("live-toggle").textContent, "Pause Refresh");
  assert.equal(getById("live-toggle").getAttribute("aria-pressed"), "true");
  assert.equal(getById("refresh-now").hidden, false);
  assert.equal(getById("live-toggle").hidden, false);
  assert.equal(queryById("action-note") === null, true);
  assert.equal(queryById("live-actions-panel") === null, true);
  assert.equal(queryById("mission-control-grid") === null, true);
  assert.equal(queryById("action-grid") === null, true);
  assert.equal(queryById("mission-control") === null, true);
  assert.equal(
    getById("decision-next-command").textContent?.trim(),
    "Redacted here. Continue in the CLI.",
  );
  assert.doesNotMatch(getById("decision-next-command").textContent || "", /finalize-preview/);
});

test("dashboard consumes trust, truth, evidence chips, and finalization checklist fields", async () => {
  const viewModel = {
    trustState: {
      modeLabel: "Live Readout",
      detail: "Local host with read-only refresh.",
      actionState: "CLI owns mutations.",
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
    evidenceReadout: {
      label: "exploratory",
      title: "Exploratory",
      promotable: false,
    },
    proofGaps: [
      {
        label: "Promotion proof",
        detail: "Repeat is missing.",
        nextAction: "Repeat the best packet before promotion.",
      },
    ],
    finalizationChecklist: {
      ready: false,
      title: "Review packet gated",
      items: [
        { id: "evidence", label: "Evidence packet", detail: "Kept run has ASI.", state: "done" },
        {
          id: "codex-notes",
          label: "Codex notes",
          detail: "Diagnostic details stay in the handoff.",
          state: "blocked",
        },
      ],
    },
    finalizationPressure: {
      status: "medium",
      recommendation: "Preview finalization after blocked notes are resolved.",
    },
    processHygiene: {
      status: "needs-attention",
      mode: "live-server",
      activeCwd: "C:/repo/with/a/very/long/path",
      pluginVersion: "2.4.0",
      duplicateServerDetection: "checked C:/repo/.autoresearch/servers.json",
      staleServerDetection: "checked C:/repo/.autoresearch/stale-server.json",
      warnings: ["Runtime cache fingerprint needs review."],
    },
    watchdogSummary: {
      status: "tracking",
      recommendation: "Continue from the decision envelope before retrying packets.",
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
    {
      type: "config",
      name: "trust fields",
      metricName: "seconds",
      bestDirection: "lower",
      metricUnit: "s",
    },
    { type: "run", run: 1, metric: 5, status: "keep", description: "Baseline", confidence: 1 },
    { type: "run", run: 2, metric: 4.2, status: "keep", description: "Improved", confidence: 2 },
  ];

  const { dom, getById, queryById } = await runDashboard(
    entries,
    {
      deliveryMode: "live-server",
      liveRefreshAvailable: true,
      liveActionsAvailable: false,
      viewModel,
    },
    { url: "http://127.0.0.1/?view=audit" },
  );

  assert.equal(queryById("trust-strip") === null, true);
  assert.equal(dom.window.document.getElementById("trust-warnings") === null, true);
  assert.equal(getById("research-truth-title").textContent, "Truth pass complete");
  assert.equal(getById("research-truth-bar").getAttribute("aria-valuenow"), "100");
  assert.equal(dom.window.document.getElementById("suspicious-perfect-warning") === null, true);
  assert.match(getById("decision-evidence-chips").textContent, /Exploratory/);
  assert.match(getById("decision-evidence-chips").textContent, /Repeat is missing/);
  assert.match(getById("decision-evidence-chips").textContent, /4\.2s beats baseline/);
  assert.match(getById("finalization-checklist-title").textContent, /Review packet gated/);
  assert.match(getById("finalization-checklist-items").textContent, /Diagnostic details stay/);
  assert.match(getById("v2-release-signals").textContent || "", /Preview gated/);
  assert.match(
    getById("v2-release-signals").textContent || "",
    /Preview blocked until gates clear/,
  );
  assert.doesNotMatch(getById("v2-release-signals").textContent || "", /Preview ready/);
  assert.match(getById("process-hygiene-detail").textContent || "", /Runtime cache fingerprint/);
  const provenance = getById("process-hygiene-detail").querySelector("details");
  assert.ok(provenance);
  assert.equal(provenance.open, false);
  assert.match(provenance.querySelector("summary")?.textContent || "", /Runtime provenance/);
  assert.match(provenance.textContent || "", /C:\/repo\/with\/a\/very\/long\/path/);
});

test("dashboard keeps one canonical decision first in operate and audit views", async () => {
  const decisionPlanProjection = dashboardDecisionPlanProjection({
    actionKind: "collect-evidence",
    actionReason: "Confirm the kept path before promotion.",
    blockerCode: "quality-evidence-required",
    capabilityStatuses: {
      "authorize-keep": "blocked",
      finalize: "blocked",
      "parent-final-answer": "blocked",
    },
    loopKind: "blocked",
    parentKind: "block-final-answer",
    phase: "direct-work",
  });
  const viewModel = {
    decisionPlanProjection,
    decisionEnvelopeSummary: {
      kind: "collect-evidence",
      title: "Repeat the best packet",
      detail: "Confirm the kept path before promotion.",
    },
    nextBestAction: {
      priority: "Next move",
      title: "Repeat the best packet",
      detail: "Confirm the kept path before promotion.",
    },
    evidenceReadout: { label: "promotion_eligible", title: "Promotion eligible", promotable: true },
    evidenceLedger: {
      counts: { accepted: 2, provisional: 1, rejected: 1, superseded: 0 },
      acceptedCurrent: 2,
    },
    parallelLanes: [
      {
        id: "scout",
        title: "Scout lane",
        status: "active",
        mode: "read_only_scout",
        evidenceStatus: "accepted",
        recommendation: "Repeat the winning packet.",
      },
    ],
    fanoutPlan: { status: "planned" },
    watchdogSummary: { status: "tracking", recommendation: "Continue from the decision envelope." },
    finalizationPressure: {
      status: "medium",
      recommendation: "Preview finalization soon.",
    },
    productClaimCoverage: {
      productGradeReady: false,
      missingRequiredProof: ["No screenshot proof."],
      blockers: ["Claim coverage is missing dashboard handoff evidence."],
    },
  };
  const entries = [
    dashboardConfigEntry({ name: "signal path", metricName: "seconds", metricUnit: "s" }),
    { type: "run", run: 1, metric: 5, status: "keep", description: "Baseline", confidence: 1 },
    { type: "run", run: 2, metric: 4.2, status: "keep", description: "Improved", confidence: 2 },
  ];
  const primaryReadouts = [];

  assert.equal(decisionPlanProjection.capabilities["parent-final-answer"], "blocked");
  assert.equal(decisionPlanProjection.loopDisposition.kind, "blocked");
  assert.equal(decisionPlanProjection.parentDisposition.kind, "block-final-answer");
  assert.equal(decisionPlanProjection.action.command, "");

  for (const view of ["audit", "operate"]) {
    const { dom, getById, queryById } = await runDashboard(
      entries,
      {
        deliveryMode: "live-server",
        liveRefreshAvailable: true,
        liveActionsAvailable: false,
        viewModel,
      },
      { url: `http://127.0.0.1/?view=${view}` },
    );
    const chart = getById("trend-chart");
    const signalStrip = getById("v2-release-signals");
    const decision = getById("decision-rail");
    const details = getById("metric-details");

    assert.equal(signalStrip.getAttribute("aria-label"), "Run readiness signals");
    assert.equal(signalStrip.querySelectorAll(".signal-item").length, view === "audit" ? 4 : 2);
    assert.doesNotMatch(signalStrip.textContent || "", /Repeat the best packet/);
    assert.match(decision.textContent || "", /Repeat the best packet/);
    assert.match(signalStrip.textContent, /2 current \/ 1 provisional \/ 1 audit-only/);
    if (view === "audit") assert.match(signalStrip.textContent, /1 active \/ 0 done/);
    else assert.doesNotMatch(signalStrip.textContent, /1 active \/ 0 done/);
    assert.equal(signalStrip.querySelector("button") === null, true);
    assert.equal(
      signalStrip.querySelectorAll("details.signal-item").length,
      view === "audit" ? 4 : 2,
    );
    assert.equal(signalStrip.querySelector(".signal-item[title]") === null, true);
    assert.ok(
      decision.compareDocumentPosition(chart) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
      "decision rail should render before the chart",
    );
    assert.ok(
      decision.compareDocumentPosition(details) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
      "decision rail should render before metric details, outside the chart panel",
    );
    assert.ok(
      chart.compareDocumentPosition(signalStrip) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
      "readiness signals should render after the chart",
    );
    primaryReadouts.push(
      ["decision-status", "decision-blocker", "next-action-detail", "decision-next-command"].map(
        (id) => getById(id).textContent?.trim(),
      ),
    );
    assert.equal(
      getById("decision-plan-decision-id").textContent,
      decisionPlanProjection.decisionId,
    );
    assert.equal(getById("decision-plan-phase").textContent, decisionPlanProjection.phase);
    assert.equal(getById("decision-plan-action-kind").textContent, "collect-evidence");
    assert.equal(getById("decision-plan-blocker-code").textContent, "quality-evidence-required");
    assert.equal(getById("decision-plan-parent-disposition").textContent, "block-final-answer");
    assert.equal(
      getById("decision-plan-contract-digest").textContent,
      decisionPlanProjection.contractDigest,
    );
    assert.equal(
      getById("decision-plan-evaluator-identity").textContent,
      decisionPlanProjection.evaluatorIdentity,
    );
    assert.doesNotMatch(decision.textContent || "", /finalize-preview|scripts\/autoresearch/i);
    if (view === "operate") {
      assert.equal(queryById("workspace-grid") === null, true);
      assert.equal(queryById("strategy-memory") === null, true);
    } else {
      assert.ok(getById("strategy-memory"));
    }
  }
  assert.deepEqual(primaryReadouts[0], primaryReadouts[1]);
  assert.deepEqual(primaryReadouts[0], [
    "Blocked",
    "quality-evidence-required",
    "Confirm the kept path before promotion.",
    "Redacted here. Continue in the CLI.",
  ]);
});

test("dashboard does not fabricate a blocked status from an unknown canonical decision", async () => {
  const entries = [
    dashboardConfigEntry({ name: "unknown decision", metricName: "seconds", metricUnit: "s" }),
    { type: "run", run: 1, metric: 5, status: "keep", description: "Baseline", confidence: 1 },
  ];
  const { getById } = await runDashboard(entries, {
    deliveryMode: "static-export",
    liveRefreshAvailable: false,
    viewModel: {
      decisionEnvelope: { resolvedStatus: "unknown" },
      decisionEnvelopeSummary: {
        kind: "finalize-preview",
        title: "Preview finalization",
        detail: "Review the accepted evidence before promotion.",
      },
    },
  });

  assert.equal(getById("decision-status").textContent, "Needs review");
  assert.equal(getById("decision-blocker").textContent, "No blocker reported.");
});

test("mobile audit dashboard keeps the canonical next action before chart content", async () => {
  const viewModel = {
    nextBestAction: {
      title: "Preview finalization",
      detail: "Do not run another packet",
      packetBrake: true,
    },
  };
  const entries = [
    dashboardConfigEntry({ name: "mobile next", metricName: "seconds", metricUnit: "s" }),
    { type: "run", run: 1, metric: 5, status: "keep", description: "Baseline", confidence: 1 },
  ];

  const { dom, getById } = await runDashboard(
    entries,
    {
      deliveryMode: "static-export",
      viewModel,
    },
    { url: "file:///autoresearch-dashboard.html?view=audit" },
  );
  const chart = getById("trend-chart");
  const signalStrip = getById("v2-release-signals");
  const decision = getById("decision-rail");
  const css = readFileSync(
    path.join(resolvePackageRoot(import.meta.url), "dashboard", "src", "styles.css"),
    "utf8",
  );

  assert.equal(dom.window.document.getElementById("mobile-next-action") === null, true);
  assert.equal(signalStrip.querySelector("button") === null, true);
  assert.match(decision.textContent || "", /Preview finalization/);
  assert.match(decision.textContent || "", /Do not run another packet/);
  assert.doesNotMatch(signalStrip.textContent || "", /Preview finalization/);
  assert.doesNotMatch(signalStrip.textContent || "", /Do not run another packet/);
  assert.ok(
    decision.compareDocumentPosition(chart) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    "decision rail should appear before chart content in audit DOM order",
  );
  assert.ok(
    chart.compareDocumentPosition(signalStrip) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    "readiness signals should stay below the chart",
  );
  assert.doesNotMatch(css, /\.mobile-next-action\b/);
  dom.window.close();
});

test("dashboard renders strategy lanes and evidence status classes", async () => {
  const viewModel = {
    evidenceChips: [
      { label: "Accepted", value: "Kept packet is current", evidenceStatus: "accepted" },
      { label: "Rejected", value: "Rollback evidence remains visible", evidenceStatus: "rejected" },
      {
        label: "Quarantined",
        value: "Artifact cannot promote",
        evidenceStatus: "quarantined",
      },
    ],
    evidenceReadout: { label: "exploratory", title: "Exploratory", promotable: false },
    parallelLanes: [
      {
        id: "read-only-scout",
        title: "Read-only scout",
        status: " completed ",
        mode: "read_only_scout",
        evidenceStatus: "accepted",
        nextActionHint: "Use the scout result for one measured packet.",
      },
      {
        id: "implementation-candidate",
        title: "Implementation candidate",
        status: "planned",
        mode: "implementation",
        evidenceStatus: "provisional",
        recommendation: "Isolate before mutating source.",
      },
    ],
    fanoutPlan: { status: "planned" },
  };
  const entries = [
    dashboardConfigEntry({ name: "lane path", metricName: "seconds", metricUnit: "s" }),
    { type: "run", run: 1, metric: 5, status: "keep", description: "Baseline", confidence: 1 },
    {
      type: "run",
      run: 2,
      metric: 5.2,
      status: "checks_failed",
      description: "Checks failed",
      confidence: 1,
    },
  ];

  const { dom, getById } = await runDashboard(
    entries,
    {
      deliveryMode: "live-server",
      liveRefreshAvailable: true,
      liveActionsAvailable: false,
      viewModel,
    },
    { url: "http://127.0.0.1/?view=audit" },
  );

  const lanes = getById("strategy-memory");
  assert.match(lanes.textContent, /Strategy lanes/);
  assert.match(lanes.textContent, /Read-only scout/);
  assert.match(lanes.textContent, /Implementation candidate/);
  assert.match(lanes.textContent, /1 active \/ 1 done/);
  assert.equal(lanes.querySelectorAll(".strategy-lane-card").length, 2);
  assert.equal(
    dom.window.document.querySelectorAll('[data-evidence-status="accepted"]').length >= 1,
    true,
  );
  assert.equal(
    dom.window.document.querySelectorAll('[data-evidence-status="rejected"]').length >= 1,
    true,
  );
  assert.equal(
    dom.window.document.querySelectorAll('[data-evidence-status="suspicious"]').length >= 1,
    true,
  );
  assert.ok(
    dom.window.document.querySelector('.segmented-control button.active[aria-pressed="true"]'),
  );
  assert.ok(dom.window.document.querySelector(".legend-swatch.checks_failed"));
});

test("dashboard reports completed-only lanes without inflating active readiness", async () => {
  const viewModel = {
    parallelLanes: [
      {
        id: "completed-lane",
        title: "Completed lane",
        status: "completed",
        mode: "read_only_scout",
        evidenceStatus: "accepted",
      },
      {
        id: "blocked-lane",
        title: "Blocked lane",
        status: " Blocked ",
        mode: "implementation",
        evidenceStatus: "quarantined",
      },
    ],
    fanoutPlan: { status: "paused" },
  };
  const entries = [
    dashboardConfigEntry({ name: "lane count path", metricName: "seconds", metricUnit: "s" }),
    { type: "run", run: 1, metric: 5, status: "keep", description: "Baseline", confidence: 1 },
  ];

  const { getById } = await runDashboard(
    entries,
    {
      deliveryMode: "live-server",
      liveRefreshAvailable: true,
      liveActionsAvailable: false,
      viewModel,
    },
    { url: "http://127.0.0.1/?view=audit" },
  );

  assert.match(getById("v2-release-signals").textContent, /0 active \/ 1 done/);
  assert.match(getById("strategy-memory").textContent, /0 active \/ 1 done/);
});
