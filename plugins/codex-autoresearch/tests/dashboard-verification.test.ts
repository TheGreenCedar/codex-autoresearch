import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildChart, DASHBOARD_CHART_MAX_POINTS } from "../dashboard/src/model/chart.js";
import { formatCompactMetricTick } from "../dashboard/src/model/formatting.js";
import { buildReadout } from "../dashboard/src/model/readout.js";
import { asiText } from "../dashboard/src/model/asi.js";
import type { SessionRun } from "../dashboard/src/types.js";
import {
  buildActionRail,
  buildDashboardViewModel,
  buildTrustState,
} from "../lib/dashboard-view-model.js";
import {
  DASHBOARD_TRANSPORT_ARRAY_LIMIT,
  DASHBOARD_TRANSPORT_MEMORY_LIST_LIMIT,
  compactDashboardTransportViewModel,
  dashboardHtml,
  readDashboardBuildAsset,
} from "../lib/dashboard-transport.js";
import { boundDashboardLedgerEntries } from "../lib/dashboard-ledger-bounds.js";
import {
  DASHBOARD_COMMAND_FIELD_NAMES,
  DASHBOARD_COMMAND_KEY_ALIASES,
  collectDashboardCommandFields,
  dashboardCommandSafety,
  dashboardCommandMapKey,
  dashboardReadOnlyCommand,
  stripDashboardExportCommandFields,
  stripDashboardGuidanceCommandFields,
} from "../lib/dashboard-command-safety.js";
import { PLUGIN_VERSION } from "../lib/plugin-version.js";
import { resolvePackageRoot } from "../lib/runtime-paths.js";
import { LIVE_LEDGER_MAX_ENTRIES, serveAutoresearch } from "../lib/live-server.js";
import {
  createDashboardHarness,
  dashboardConfigEntry,
  emptyCommandMeta,
  waitFor,
} from "./helpers/dashboard.js";

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

test("dashboard chart does not attach an omitted best value to the first visible run", () => {
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

  assert.equal(readout.best, 1);
  assert.equal(readout.bestRun, null);
  assert.match(chart.summary, /Best value 1s is outside the visible ledger window/);
  assert.doesNotMatch(chart.summary, /Best #102 at 1s/);
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

test("dashboard command safety accepts read-only autoresearch commands", () => {
  const packageLauncher = path.join(
    resolvePackageRoot(import.meta.url),
    "scripts",
    "autoresearch.mjs",
  );
  const packageDistLauncher = path.join(
    resolvePackageRoot(import.meta.url),
    "dist",
    "scripts",
    "autoresearch.mjs",
  );
  const commands = [
    "node scripts/autoresearch.mjs doctor --cwd C:/repo --explain",
    "node ./scripts/autoresearch.mjs state --cwd C:/repo",
    `node "${packageLauncher}" state --cwd C:/repo`,
    `node "${packageDistLauncher}" state --cwd C:/repo`,
    "node scripts/autoresearch.mjs state --cwd C:/repo",
    "node scripts/autoresearch.mjs state --cwd C:/repo --report",
    "node scripts/autoresearch.mjs recommend-next --cwd C:/repo --compact",
    "node scripts/autoresearch.mjs finalize-preview --cwd C:/repo",
    "node scripts/autoresearch.mjs setup-plan --cwd C:/repo",
    'node scripts/autoresearch.mjs benchmark-lint --cwd "C:/Repo (demo)" --sample "METRIC seconds=1"',
    "node scripts/autoresearch.mjs benchmark-inspect --cwd C:/repo",
    "node scripts/autoresearch.mjs checks-inspect --cwd C:/repo",
    "node scripts/autoresearch.mjs partial-results --cwd C:/repo --from-last",
    "node scripts/autoresearch.mjs quality-gap --cwd C:/repo --research-slug study",
    "node scripts/autoresearch.mjs gap-candidates --cwd C:/repo --research-slug study",
    "node scripts/autoresearch.mjs gap-candidates --cwd C:/repo --apply=false",
    "node scripts/autoresearch.mjs new-segment --cwd C:/repo --dry-run",
    "node scripts/autoresearch.mjs promote-gate --cwd C:/repo --reason review --dry-run",
  ];

  for (const command of commands) {
    assert.equal(dashboardReadOnlyCommand(command), command, command);
  }
});

test("dashboard command safety rejects mutating autoresearch commands", () => {
  const commands = [
    "node scripts/autoresearch.mjs doctor --cwd C:/repo --check-benchmark",
    "node scripts/autoresearch.mjs serve --cwd C:/repo",
    "node scripts/autoresearch.mjs export --cwd C:/repo",
    "node scripts/autoresearch.mjs benchmark-lint --cwd C:/repo",
    "node scripts/autoresearch.mjs benchmark-lint --cwd C:/repo --command-file bench.cmd",
    "node scripts/autoresearch.mjs benchmark-lint --cwd C:/repo -- node evil.js",
    "node scripts/autoresearch.mjs next --cwd C:/repo",
    "node scripts/autoresearch.mjs log --cwd C:/repo --from-last --status keep",
    "node scripts/autoresearch.mjs setup --cwd C:/repo --benchmark-command npm-test",
    "node scripts/autoresearch.mjs run --cwd C:/repo",
    "node scripts/autoresearch.mjs config --cwd C:/repo --extend 5",
    "node scripts/autoresearch.mjs clear --cwd C:/repo --yes",
    "node scripts/autoresearch.mjs finalize-current-tree --cwd C:/repo",
    "node scripts/autoresearch.mjs gap-candidates --cwd C:/repo --apply",
    "node scripts/autoresearch.mjs partial-results --cwd C:/repo --record candidate-1",
    "node scripts/autoresearch.mjs integrations sync-recipes --catalog recipes.json",
    "node scripts/autoresearch.mjs integrations --subcommand sync-recipes --catalog recipes.json",
    "node scripts/autoresearch.mjs integrations --subcommand=sync-recipes --catalog recipes.json",
    "node scripts/autoresearch.mjs integrations Sync-Recipes --catalog recipes.json",
    "node scripts/autoresearch.mjs new-segment --cwd C:/repo --yes",
    "node scripts/autoresearch.mjs promote-gate --cwd C:/repo --reason review",
    "git status --short",
  ];

  for (const command of commands) {
    assert.equal(dashboardReadOnlyCommand(command), "", command);
  }
});

test("dashboard command safety rejects bare autoresearch subcommands", () => {
  const commands = [
    'doctor --cwd "C:/A&B"',
    'doctor --cwd "C:/Repo (demo)"',
    "doctor --cwd C:/repo",
    "state --cwd C:/repo",
    "benchmark-lint --cwd C:/repo --sample 'METRIC seconds=1'",
    "integrations --subcommand sync-recipes",
    "integrations --subcommand=sync-recipes",
    "integrations Sync-Recipes",
  ];

  for (const command of commands) {
    const result = dashboardCommandSafety(command);
    assert.equal(result.safe, false, command);
    assert.equal(result.commandName, "", command);
    assert.equal(dashboardReadOnlyCommand(command), "", command);
  }
});

test("dashboard command safety rejects unsafe executables before autoresearch script", () => {
  const commands = [
    "rm scripts/autoresearch.mjs doctor",
    "git scripts/autoresearch.mjs doctor",
    "python scripts/autoresearch.mjs doctor",
  ];

  for (const command of commands) {
    const result = dashboardCommandSafety(command);
    assert.equal(result.safe, false, command);
    assert.equal(result.commandName, "", command);
    assert.equal(dashboardReadOnlyCommand(command), "", command);
  }
});

test("dashboard command safety rejects non-plugin autoresearch launcher lookalikes", () => {
  const commands = [
    "node autoresearch.mjs state --cwd C:/repo --report",
    "node C:/tmp/autoresearch.mjs state --cwd C:/repo --report",
    "node C:/tmp/scripts/autoresearch.mjs state --cwd C:/repo --report",
    "node C:/tmp/not-scripts/autoresearch.mjs state --cwd C:/repo --report",
    "node C:/malicious/scripts/autoresearch.mjs finalize-preview --cwd C:/repo",
    "node ../scripts/autoresearch.mjs state --cwd C:/repo --report",
    "node ../malicious/scripts/autoresearch.mjs state --cwd C:/repo --report",
    "node tmp/scripts/autoresearch.mjs state --cwd C:/repo --report",
    "node ./tmp/scripts/autoresearch.mjs state --cwd C:/repo --report",
    "node scripts/autoresearch.mjs.bak state --cwd C:/repo --report",
    "node scripts/not-autoresearch.mjs state --cwd C:/repo --report",
  ];

  for (const command of commands) {
    const result = dashboardCommandSafety(command);
    assert.equal(result.safe, false, command);
    assert.equal(result.commandName, "", command);
    assert.equal(dashboardReadOnlyCommand(command), "", command);
  }
});

test("dashboard command safety accepts generated package launcher paths", () => {
  const packageLauncher = path.join(
    resolvePackageRoot(import.meta.url),
    "scripts",
    "autoresearch.mjs",
  );
  const command = `node "${packageLauncher}" state --cwd "C:\\work\\repo" --report`;
  const result = dashboardCommandSafety(command);

  assert.equal(result.safe, true, result.reason);
  assert.equal(result.commandName, "state");
  assert.equal(dashboardReadOnlyCommand(command), command);
});

test("dashboard command safety rejects shell-chained safe prefixes", () => {
  const commands = [
    "doctor && next",
    "doctor; clear --yes",
    "doctor | next",
    "gap-candidates --apply=false && next",
  ];

  for (const command of commands) {
    assert.equal(dashboardReadOnlyCommand(command), "", command);
  }
});

test("dashboard command safety treats Windows backslashes as literal before quotes", () => {
  const command = String.raw`node scripts/autoresearch.mjs state --cwd "C:\tmp\" & node scripts/autoresearch.mjs serve --cwd .`;
  const result = dashboardCommandSafety(command);

  assert.equal(result.safe, false);
  assert.match(result.reason, /shell operator &/);
  assert.equal(dashboardReadOnlyCommand(command), "");
});

test("dashboard command safety rejects shell substitution and redirection", () => {
  const commands = [
    'doctor --cwd "$(node scripts/autoresearch.mjs clear --cwd . --yes)"',
    "doctor --cwd `node scripts/autoresearch.mjs clear --cwd . --yes`",
    "node scripts/autoresearch.mjs doctor --cwd (node scripts/autoresearch.mjs clear --cwd . --yes)",
    "doctor --cwd C:/repo > out.txt",
    "doctor --cwd C:/repo >> out.txt",
    "doctor --cwd C:/repo 2> out.txt",
    "doctor --cwd C:/repo < input.txt",
  ];

  for (const command of commands) {
    const result = dashboardCommandSafety(command);
    assert.equal(result.safe, false, command);
    assert.equal(result.commandName, "", command);
    assert.equal(dashboardReadOnlyCommand(command), "", command);
  }
});

test("dashboard command safety rejects embedded process command flags", () => {
  const commands = [
    'node scripts/autoresearch.mjs checks-inspect --cwd C:/repo --command "node evil.js"',
    'node scripts/autoresearch.mjs benchmark-inspect --cwd C:/repo --command "node evil.js"',
    'node scripts/autoresearch.mjs benchmark-lint --cwd C:/repo --command "node evil.js"',
    'node scripts/autoresearch.mjs doctor --cwd C:/repo --command "node evil.js"',
    'node scripts/autoresearch.mjs doctor --cwd C:/repo --checks-command "node evil.js"',
    'node scripts/autoresearch.mjs checks-inspect --cwd C:/repo --checksCommand "node --version"',
    'node scripts/autoresearch.mjs gap-candidates --cwd C:/repo --research-slug study --model-command "node --version"',
    'node scripts/autoresearch.mjs promote-gate --cwd C:/repo --reason review --dry-run --benchmark-command "node evil.js"',
    'node scripts/autoresearch.mjs promote-gate --cwd C:/repo --reason review --dry-run --benchmark_command "node evil.js"',
    'node scripts/autoresearch.mjs new-segment --cwd C:/repo --dry-run --benchmarkCommand "node evil.js"',
  ];

  for (const command of commands) {
    const result = dashboardCommandSafety(command);
    assert.equal(result.safe, false, command);
    assert.notEqual(result.commandName, "", command);
    assert.equal(dashboardReadOnlyCommand(command), "", command);
  }
});

test("dashboard command scrubbers and leak collector share canonical taxonomy", () => {
  const payload = {
    command: "node scripts/autoresearch.mjs next --cwd C:/repo",
    cleanupCommand: "git stash push --include-untracked -- autoresearch.jsonl",
    commands: {
      keepLast: "node scripts/autoresearch.mjs log --cwd C:/repo --from-last --status keep",
      doctor: "node scripts/autoresearch.mjs doctor --cwd C:/repo",
    },
    nested: {
      detail: "Review the current state.",
      primaryCommand: {
        label: "Next",
        command: "node scripts/autoresearch.mjs next --cwd C:/repo",
      },
    },
    setup: {
      status: "needs-setup",
      recommendedRecipe: {
        id: "node-test",
        label: "Node test",
        benchmarkCommand: "node C:/private/repo/bench.mjs --token sk-demo",
        checksCommand: "npm test -- --token sk-demo",
      },
      commandAuthority: {
        status: "custom",
        benchmarkCommand: "node C:/private/repo/bench.mjs --token sk-demo",
        checksCommand: "npm test -- --token sk-demo",
      },
    },
    sourceCwd: "C:/repo",
    summary: "No command here.",
  };

  assert.equal(
    dashboardCommandMapKey("liveDashboard"),
    DASHBOARD_COMMAND_KEY_ALIASES.liveDashboard,
  );
  assert.equal(dashboardCommandMapKey("newSegmentDryRun"), "new segment");
  assert.equal(dashboardCommandMapKey("state"), "state");
  assert.equal(DASHBOARD_COMMAND_FIELD_NAMES.has("replaceLast"), true);
  assert.equal(DASHBOARD_COMMAND_FIELD_NAMES.has("finalizeCurrentTree"), true);
  assert.equal(DASHBOARD_COMMAND_FIELD_NAMES.has("benchmarkCommand"), true);
  assert.equal(DASHBOARD_COMMAND_FIELD_NAMES.has("checksCommand"), true);
  assert.equal(DASHBOARD_COMMAND_FIELD_NAMES.has("commandAuthority"), true);
  assert.equal(DASHBOARD_COMMAND_FIELD_NAMES.has("cleanupCommand"), true);
  assert.equal(DASHBOARD_COMMAND_FIELD_NAMES.has("suggestedCommand"), true);
  assert.equal(DASHBOARD_COMMAND_FIELD_NAMES.has("planOutput"), true);
  assert.deepEqual(stripDashboardGuidanceCommandFields(payload), {
    nested: { detail: "Review the current state." },
    setup: {
      status: "needs-setup",
      recommendedRecipe: {
        id: "node-test",
        label: "Node test",
      },
    },
    sourceCwd: "C:/repo",
    summary: "No command here.",
  });
  assert.deepEqual(stripDashboardExportCommandFields(payload), {
    nested: { detail: "Review the current state." },
    setup: {
      status: "needs-setup",
      recommendedRecipe: {
        id: "node-test",
        label: "Node test",
      },
    },
    summary: "No command here.",
  });
  assert.deepEqual(collectDashboardCommandFields(payload), [
    "node scripts/autoresearch.mjs next --cwd C:/repo",
    "git stash push --include-untracked -- autoresearch.jsonl",
    "node scripts/autoresearch.mjs log --cwd C:/repo --from-last --status keep",
    "node scripts/autoresearch.mjs doctor --cwd C:/repo",
    "Next",
    "node scripts/autoresearch.mjs next --cwd C:/repo",
    "node C:/private/repo/bench.mjs --token sk-demo",
    "npm test -- --token sk-demo",
    "custom",
    "node C:/private/repo/bench.mjs --token sk-demo",
    "npm test -- --token sk-demo",
  ]);
});

test("static dashboard export strips setup and recipe command fields", () => {
  const benchmarkCommand = "node C:/Users/alber/private/bench.mjs --token sk-demo-secret";
  const checksCommand = "npm test -- --secret sk-demo-secret";
  const html = dashboardHtml(
    [
      {
        type: "config",
        name: "Static export setup",
        metricName: "score",
        bestDirection: "higher",
        benchmarkCommand,
        checksCommand,
      },
      {
        type: "state",
        setup: {
          label: "Benchmark setup",
          status: "needs-checks",
          recommendedRecipe: {
            id: "node-test",
            name: "Node test",
            status: "recommended",
            benchmarkCommand,
            checksCommand,
          },
          commandAuthority: {
            status: "custom",
            benchmarkCommand,
            checksCommand,
          },
        },
      },
    ],
    {
      deliveryMode: "static-export",
      viewModel: {
        setup: {
          label: "Benchmark setup",
          status: "needs-checks",
          recommendedRecipe: {
            id: "node-test",
            name: "Node test",
            status: "recommended",
            benchmarkCommand,
            checksCommand,
          },
          commandAuthority: {
            status: "custom",
            benchmarkCommand,
            checksCommand,
          },
        },
      },
    },
  );
  const dataMatch = html.match(
    /window\.__AUTORESEARCH_DATA__ = ([\s\S]*?);\nwindow\.__AUTORESEARCH_META__/,
  );
  const metaMatch = html.match(/window\.__AUTORESEARCH_META__ = ([\s\S]*?);\n<\/script>/);
  assert.ok(dataMatch);
  assert.ok(metaMatch);
  const data = JSON.parse(dataMatch[1]);
  const meta = JSON.parse(metaMatch[1]);
  const serialized = JSON.stringify({ data, meta });

  assert.doesNotMatch(serialized, /benchmarkCommand|checksCommand|commandAuthority/);
  assert.doesNotMatch(serialized, /sk-demo-secret|private\/bench|C:\\/);
  assert.equal(data[1].setup.label, "Benchmark setup");
  assert.equal(data[1].setup.status, "needs-checks");
  assert.equal(data[1].setup.recommendedRecipe.id, "node-test");
  assert.equal(data[1].setup.recommendedRecipe.name, "Node test");
  assert.equal(data[1].setup.recommendedRecipe.status, "recommended");
  assert.equal(meta.viewModel.setup.label, "Benchmark setup");
  assert.equal(meta.viewModel.setup.status, "needs-checks");
  assert.equal(meta.viewModel.setup.recommendedRecipe.id, "node-test");
  assert.equal(meta.viewModel.setup.recommendedRecipe.name, "Node test");
  assert.equal(meta.viewModel.setup.recommendedRecipe.status, "recommended");
});

test("dashboard finalization preview strips executable command-shaped fields", () => {
  const viewModel = buildDashboardViewModel({
    state: {
      config: {
        name: "finalization sanitizer",
        metricName: "seconds",
        bestDirection: "lower",
      },
      current: [],
    },
    settings: {},
    finalizePreview: {
      ready: true,
      nextAction: "Preview finalization readiness.",
      warnings: ["Review final branch grouping."],
      suggestedCommand: "node scripts/finalize-autoresearch.mjs plan --cwd C:/repo",
      suggestedCommands: {
        finalizerPlan: {
          argv: ["node", "scripts/finalize-autoresearch.mjs", "plan", "--cwd", "C:/repo"],
          display: "node scripts/finalize-autoresearch.mjs plan --cwd C:/repo",
          mutates: false,
        },
      },
      command: "node scripts/autoresearch.mjs finalize-current-tree --cwd C:/repo",
      commandsByStatus: {
        ready: "node scripts/autoresearch.mjs finalize-current-tree --cwd C:/repo",
      },
      liveAction: "node scripts/autoresearch.mjs finalize-current-tree --cwd C:/repo",
      planOutput: "C:/repo/autoresearch.research/finalizer-plan.json",
    },
  });

  const serialized = JSON.stringify(viewModel);
  assert.doesNotMatch(
    serialized,
    /suggestedCommand|suggestedCommands|commandsByStatus|liveAction|argv|planOutput/,
  );
  assert.doesNotMatch(serialized, /finalize-autoresearch|finalize-current-tree/);
  assert.match(serialized, /Preview finalization readiness/);
});

test("dashboard transport view model caps large memory arrays", () => {
  const oversized = Array.from(
    { length: DASHBOARD_TRANSPORT_MEMORY_LIST_LIMIT + 5 },
    (_, index) => ({ id: index }),
  );
  const viewModel = compactDashboardTransportViewModel({
    experimentMemory: {
      kept: oversized,
      rejected: oversized,
      nextActions: oversized,
      missingAsiDetails: oversized,
      families: oversized,
      metricShelves: oversized,
      exhaustedFamilies: oversized,
      lanePortfolio: oversized,
    },
    portfolio: {
      families: oversized,
      lanes: oversized,
    },
    partialResults: {
      candidates: oversized,
      skippedArtifacts: oversized,
    },
    decisionEnvelope: {
      state: {
        current: oversized.map((item, index) => ({
          ...item,
          run: index + 1,
          metric: index + 1,
          status: "measure",
        })),
      },
      workflowFriction: oversized,
    },
    transportBounds: {
      ledger: true,
    },
  });

  assert.equal(viewModel.transportBounds.memoryListLimit, DASHBOARD_TRANSPORT_MEMORY_LIST_LIMIT);
  assert.equal(viewModel.transportBounds.arrayLimit, DASHBOARD_TRANSPORT_ARRAY_LIMIT);
  assert.equal(viewModel.transportBounds.ledger, true);
  assert.equal(viewModel.experimentMemory.kept.length, DASHBOARD_TRANSPORT_MEMORY_LIST_LIMIT);
  assert.equal(viewModel.experimentMemory.kept[0].id, 5);
  assert.equal(viewModel.experimentMemory.rejected[0].id, 5);
  assert.equal(viewModel.experimentMemory.nextActions[0].id, 5);
  assert.equal(viewModel.experimentMemory.missingAsiDetails[0].id, 5);
  assert.equal(viewModel.experimentMemory.families.length, DASHBOARD_TRANSPORT_MEMORY_LIST_LIMIT);
  assert.equal(viewModel.experimentMemory.families[0].id, 0);
  assert.equal(viewModel.experimentMemory.lanePortfolio[0].id, 0);
  assert.equal(viewModel.portfolio.families[0].id, 0);
  assert.equal(viewModel.partialResults.candidates[0].id, 0);
  assert.equal(viewModel.decisionEnvelope.state.current.length, DASHBOARD_TRANSPORT_ARRAY_LIMIT);
  assert.equal(viewModel.decisionEnvelope.state.current[0].run, 6);
  assert.equal(viewModel.decisionEnvelope.workflowFriction.length, DASHBOARD_TRANSPORT_ARRAY_LIMIT);
  assert.equal(viewModel.decisionEnvelope.workflowFriction[0].id, 0);
});

test("source checkout reports missing dashboard build assets with build guidance", async () => {
  const missingBuildDir = await mkdtemp(path.join(tmpdir(), "autoresearch-missing-dashboard-"));
  await rm(missingBuildDir, { recursive: true, force: true });

  assert.throws(
    () =>
      readDashboardBuildAsset("dashboard-app.js", {
        buildDir: missingBuildDir,
        pluginRoot: "C:\\repo\\plugins\\codex-autoresearch",
      }),
    /Dashboard build asset is missing: .* Run npm run build:dashboard from C:\\repo\\plugins\\codex-autoresearch\./,
  );
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

test("dashboard source keeps proof signals below the chart", () => {
  const dashboardSource = readFileSync(
    path.join(resolvePackageRoot(import.meta.url), "dashboard", "src", "Dashboard.tsx"),
    "utf8",
  );

  assert.doesNotMatch(dashboardSource, /proofSignalsFirst/);
  assert.doesNotMatch(dashboardSource, /SignalStrip[^>]+priority/);
  assert.ok(
    dashboardSource.indexOf("<TrendPanel") <
      dashboardSource.indexOf("<SignalStrip view={view} viewModel={viewModel} />"),
    "signal strip should render only after the chart panel",
  );
});

test("dashboard source keeps chart tab stops to selected and evidence-critical points", () => {
  const chartSource = readFileSync(
    path.join(
      resolvePackageRoot(import.meta.url),
      "dashboard",
      "src",
      "components",
      "trend",
      "TrendChartFigure.tsx",
    ),
    "utf8",
  );

  assert.match(chartSource, /tabIndex=\{tabbable \? 0 : -1\}/);
  assert.match(chartSource, /onKeyDown=\{\(event\) =>/);
  assert.match(chartSource, /payload\.runNumber === selectedRunNumber/);
  assert.match(chartSource, /payload\.latest/);
  assert.match(chartSource, /payload\.best/);
  assert.match(chartSource, /payload\.status === "discard"/);
  assert.match(chartSource, /payload\.status === "crash"/);
  assert.match(chartSource, /payload\.status === "checks_failed"/);
});

test("dashboard ledger source uses native table semantics", () => {
  const ledgerSource = readFileSync(
    path.join(resolvePackageRoot(import.meta.url), "dashboard", "src", "components", "Ledger.tsx"),
    "utf8",
  );

  assert.match(ledgerSource, /<table aria-label=\{/);
  assert.match(ledgerSource, /<thead className="ledger-header">/);
  assert.match(ledgerSource, /<tbody id="ledger-body">/);
  assert.match(ledgerSource, /<tr className=\{`ledger-row/);
  assert.doesNotMatch(ledgerSource, /role="table"|role="row"|role="cell"/);
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

test("dashboard chart does not place interactive point buttons under an image role", async () => {
  const entries = [
    dashboardConfigEntry({ name: "chart semantics", metricName: "seconds", metricUnit: "s" }),
    { type: "run", run: 1, metric: 5, status: "keep", description: "Baseline", confidence: 1 },
    { type: "run", run: 2, metric: 4, status: "keep", description: "Improved", confidence: 2 },
  ];

  const { dom, getById } = await runDashboard(entries, emptyCommandMeta());
  const chart = getById("trend-chart");
  const buttons = [...dom.window.document.querySelectorAll(".chart-point-button")];
  const chartSource = readFileSync(
    path.join(
      resolvePackageRoot(import.meta.url),
      "dashboard",
      "src",
      "components",
      "trend",
      "TrendChartFigure.tsx",
    ),
    "utf8",
  );

  assert.equal(chart.getAttribute("role"), null);
  assert.equal(chart.getAttribute("aria-labelledby"), "trend-chart-title trend-chart-desc");
  assert.match(
    getById("chart-keyboard-help").textContent || "",
    /arrow keys move through history/i,
  );
  assert.match(chartSource, /className="chart-point-button"/);
  assert.match(chartSource, /aria-current=\{payload\.runNumber === selectedRunNumber/);
  assert.doesNotMatch(chartSource, /aria-describedby="trend-chart-selected chart-keyboard-help"/);
  for (const button of buttons) {
    assert.equal(button.closest('[role="img"]'), null);
    assert.equal(button.getAttribute("aria-describedby"), "chart-keyboard-help");
    assert.doesNotMatch(button.getAttribute("aria-describedby") || "", /trend-chart-selected/);
    assert.match(button.getAttribute("aria-label") || "", /Open details for run/);
  }
  assert.match(getById("trend-chart-selected").textContent || "", /Selected chart point:/);
  dom.window.close();
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
  assert.equal(staticDashboard.dom.window.document.querySelector(".side-status .live-dot"), null);
  assert.match(
    staticDashboard.dom.window.document.querySelector(".side-status")?.textContent || "",
    /Static/,
  );
  staticDashboard.dom.window.close();

  const demoDashboard = await runDashboard(entries, {
    deliveryMode: "static-export",
    liveActionsAvailable: false,
    showcaseMode: true,
  });
  assert.ok(demoDashboard.dom.window.document.querySelector(".side-status .status-dot"));
  assert.equal(demoDashboard.dom.window.document.querySelector(".side-status .live-dot"), null);
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
  assert.equal(liveDashboard.dom.window.document.querySelector(".side-status .status-dot"), null);
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
      ledgerBounds: { truncated: true, omittedEntries: 101, maxEntries: 5000 },
    }),
  );

  assert.match(
    getById("ledger-note").textContent,
    /12 visible runs \/ newest first \/ 101 older ledger entries omitted/,
  );
  assert.match(
    getById("ledger-scroll").querySelector("table")?.getAttribute("aria-label") || "",
    /12 visible runs, 101 older ledger entries omitted/,
  );
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
  assert.match(getById("decision-envelope-summary").textContent, /1 measurement/);
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

  const { dom, getById } = await runDashboard(entries, emptyCommandMeta(), {
    beforeParse(window) {
      window.ResizeObserver = class {
        callback: ResizeObserverCallback;

        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
        }

        observe(target: Element) {
          this.callback([
            {
              target,
              contentRect: {
                width: 960,
                height: 350,
                top: 0,
                left: 0,
                bottom: 350,
                right: 960,
                x: 0,
                y: 0,
              },
            },
          ]);
        }

        disconnect() {}
        unobserve() {}
      };

      window.HTMLElement.prototype.getBoundingClientRect = function () {
        return {
          width: 960,
          height: 350,
          top: 0,
          left: 0,
          bottom: 350,
          right: 960,
          x: 0,
          y: 0,
          toJSON() {
            return this;
          },
        };
      };
    },
  });
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

test("dashboard action rail prioritizes stale packets before normal next actions", () => {
  const rail = buildActionRail({
    current: [
      {
        run: 1,
        metric: 5,
        status: "keep",
        description: "Baseline",
        confidence: 1,
        asi: { next_action_hint: "Try a cache branch." },
      },
    ],
    bestKept: { run: 1, metric: 5, status: "keep", description: "Baseline" },
    latestFailure: null,
    nextAction: "Try a cache branch.",
    setupPlan: { defaultBenchmarkCommandReady: true },
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
    commands: [{ label: "Next run", command: "node scripts/autoresearch.mjs next --cwd ." }],
  });

  assert.equal(rail[0].kind, "stale-packet");
  assert.equal(rail[0].priority, "Critical");
  assert.match(rail[0].detail, /stale/);
  assert.match(rail[0].explanation.avoids, /old metric/);
});

test("dashboard view model strips packet and log commands from decision states", () => {
  const cases = [
    {
      name: "pending log",
      expectedKind: "log-decision",
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
      expectedKind: "stale-packet",
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
    });

    assert.equal(viewModel.nextBestAction.kind, item.expectedKind);
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

test("dashboard action rail marks governance actions as packet brakes", () => {
  const brakeKinds = [
    "context-distillation",
    "lane-cleanup",
    "runtime-provenance",
    "packet-diagnostic",
    "workflow-friction",
    "finalization",
    "stale-packet",
    "setup",
    "benchmark-command",
    "log-decision",
    "segment-transition",
    "watchdog",
  ];

  for (const kind of brakeKinds) {
    const rail = buildActionRail({
      current: [],
      bestKept: null,
      latestFailure: null,
      nextAction: "",
      decisionEnvelopeSummary: {
        kind,
        priority: "Critical",
        title: kind,
        detail: "Resolve this governance action before spending another packet.",
      },
      commands: [{ label: "Next run", command: "node scripts/autoresearch.mjs next --cwd ." }],
    });

    assert.equal(rail[0].packetBrake, true, kind);
    assert.doesNotMatch(String(rail[0].command || ""), /\bnext\b/, kind);
  }
});

test("dashboard decision envelope priority ladder is stable across competing signals", () => {
  const run = { run: 1, metric: 5, status: "keep", description: "Baseline" };
  const baseState = {
    config: {
      name: "priority ladder",
      metricName: "seconds",
      metricUnit: "s",
      bestDirection: "lower",
    },
    segment: 0,
    current: [run],
    baseline: 5,
    best: 5,
    confidence: null,
  };
  const lastRun = {
    freshness: { fresh: true, reason: "Last-run packet matches the current ledger." },
    suggestedStatus: "measure",
  };
  const cases = [
    {
      name: "stale packet outranks setup",
      expected: "stale-packet",
      context: {
        guidedSetup: {
          stage: "needs-setup",
          nextAction: "Complete setup.",
          lastRun: { freshness: { fresh: false, reason: "Last-run packet is stale." } },
        },
      },
    },
    {
      name: "fresh log decision outranks setup repair",
      expected: "log-decision",
      context: {
        guidedSetup: {
          stage: "needs-setup",
          nextAction: "Complete setup.",
          lastRun,
        },
      },
    },
    {
      name: "fresh log decision outranks benchmark repair",
      expected: "log-decision",
      context: {
        guidedSetup: {
          stage: "needs-benchmark-command",
          nextAction: "Add a benchmark command.",
          lastRun,
        },
      },
    },
    {
      name: "fresh log decision outranks segment transition",
      expected: "log-decision",
      context: {
        guidedSetup: {
          stage: "needs-log-decision",
          lastRun,
          state: { limit: { limitReached: true, remainingIterations: 0 } },
        },
      },
    },
    {
      name: "segment transition outranks plateau",
      expected: "segment-transition",
      context: {
        guidedSetup: {
          stage: "limit-reached",
          nextAction: "Start a new segment.",
        },
        experimentMemory: {
          plateau: { detected: true, recommendation: "Scout a distant lane." },
        },
      },
    },
    {
      name: "finalization readiness outranks plateau packet drift",
      expected: "finalization",
      context: {
        experimentMemory: {
          plateau: { detected: true, recommendation: "Scout a distant lane." },
        },
        finalizePreview: { ready: true, nextAction: "Preview finalization." },
      },
    },
    {
      name: "finalization readiness wins after active blockers",
      expected: "finalization",
      context: {
        finalizePreview: { ready: true, nextAction: "Preview finalization." },
      },
    },
  ];

  for (const item of cases) {
    const viewModel = buildDashboardViewModel({
      state: baseState,
      commands: [{ label: "Next run", command: "node scripts/autoresearch.mjs next --cwd ." }],
      ...item.context,
    });
    assert.equal(viewModel.nextBestAction.kind, item.expected, item.name);
    assert.equal(viewModel.decisionEnvelopeSummary.kind, item.expected, item.name);
  }
});

test("dashboard surfaces exhausted packet budget as a rescope blocker", () => {
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
  });

  assert.equal(viewModel.decisionEnvelope.budgetStatus.exhausted, true);
  assert.equal(viewModel.decisionEnvelope.segmentTransition.triggeredBy[0], "budget");
  assert.equal(viewModel.decisionEnvelopeSummary.kind, "segment-transition");
  assert.match(viewModel.nextBestAction.detail, /Budget exhausted/);
  assert.doesNotMatch(viewModel.nextBestAction.detail, /complete/i);
});

test("dashboard action rail treats finalization readiness as the next decision after active blockers", () => {
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
  });

  assert.equal(viewModel.nextBestAction.kind, "finalization");
  assert.match(viewModel.nextBestAction.detail, /Preview finalization/);
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
  assert.equal(queryById("live-region"), null);
  assert.equal(queryById("trust-strip"), null);
  assert.equal(getById("refresh-now").hidden, true);
  assert.equal(getById("live-toggle").hidden, true);
  assert.equal(queryById("mission-control-grid"), null);
  assert.equal(queryById("live-actions-panel"), null);
  assert.equal(queryById("log-decision-panel"), null);
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
  assert.equal(queryById("live-region"), null);
  assert.equal(getById("refresh-now").hidden, true);
  assert.equal(getById("live-toggle").hidden, true);
  assert.equal(queryById("live-actions-panel"), null);
  assert.equal(queryById("next-command-copy"), null);
  assert.equal(queryById("decision-next-command"), null);
  assert.equal(dom.window.document.querySelector(".mission-command"), null);
  dom.window.close();
});

test("showcase dashboard presents the demo as live while keeping diagnostics in the model", async () => {
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
    deliveryMode: "static-export",
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
  assert.equal(queryById("live-region"), null);
  assert.equal(getById("refresh-now").hidden, true);
  assert.equal(getById("live-toggle").hidden, true);
  assert.equal(queryById("trust-strip"), null);
  assert.equal(
    getById("next-action-detail").textContent,
    "Check memory footprint before keeping the path.",
  );
  assert.equal(getById("decision-evidence-chips").textContent.includes("Needs attention"), false);
  assert.equal(queryById("live-actions-panel"), null);
});

test("served dashboard exposes live refresh but no command-center controls", async () => {
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
  assert.equal(queryById("trust-strip"), null);
  assert.equal(getById("refresh-now").textContent, "Refresh Readout");
  assert.equal(getById("live-toggle").textContent, "Pause Refresh");
  assert.equal(getById("live-toggle").getAttribute("aria-pressed"), "true");
  assert.equal(getById("refresh-now").hidden, false);
  assert.equal(getById("live-toggle").hidden, false);
  assert.equal(queryById("action-note"), null);
  assert.equal(queryById("live-actions-panel"), null);
  assert.equal(queryById("mission-control-grid"), null);
  assert.equal(queryById("action-grid"), null);
  assert.equal(getById("mission-control").querySelector(".mission-command"), null);
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

  assert.equal(queryById("trust-strip"), null);
  assert.equal(dom.window.document.getElementById("trust-warnings"), null);
  assert.equal(getById("research-truth-title").textContent, "Truth pass complete");
  assert.equal(getById("research-truth-bar").getAttribute("aria-valuenow"), "100");
  assert.equal(dom.window.document.getElementById("suspicious-perfect-warning"), null);
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

test("dashboard keeps the chart first while rendering v2 readiness signals", async () => {
  const viewModel = {
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
    assert.equal(signalStrip.querySelectorAll(".signal-item").length, 4);
    assert.doesNotMatch(signalStrip.textContent || "", /Repeat the best packet/);
    assert.match(decision.textContent || "", /Repeat the best packet/);
    assert.match(signalStrip.textContent, /2 current \/ 1 provisional \/ 1 audit-only/);
    assert.match(signalStrip.textContent, /1 active \/ 0 done/);
    assert.equal(signalStrip.querySelector("button"), null);
    assert.ok(
      chart.compareDocumentPosition(decision) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
      "decision rail should render after the chart",
    );
    assert.ok(
      details.compareDocumentPosition(decision) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
      "decision rail should render after metric details, outside the chart panel",
    );
    assert.ok(
      decision.compareDocumentPosition(signalStrip) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
      "readiness signals should render after the decision rail",
    );
    if (view === "operate") {
      assert.equal(queryById("workspace-grid"), null);
      assert.equal(queryById("strategy-memory"), null);
    } else {
      assert.ok(getById("strategy-memory"));
    }
  }
});

test("mobile audit dashboard keeps next action below chart content", async () => {
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

  assert.equal(dom.window.document.getElementById("mobile-next-action"), null);
  assert.equal(signalStrip.querySelector("button"), null);
  assert.match(decision.textContent || "", /Preview finalization/);
  assert.match(decision.textContent || "", /Do not run another packet/);
  assert.doesNotMatch(signalStrip.textContent || "", /Preview finalization/);
  assert.doesNotMatch(signalStrip.textContent || "", /Do not run another packet/);
  assert.ok(
    chart.compareDocumentPosition(decision) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    "decision rail should appear after chart content in audit DOM order",
  );
  assert.ok(
    decision.compareDocumentPosition(signalStrip) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    "readiness signals should stay below the decision rail",
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
  assert.match(
    extractCssBlock(css, ".chart-point-button:focus-visible .chart-point-dot"),
    /0 0 0 6px var\(--amber-dark\)/,
  );
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

  assert.equal(dom.window.document.getElementById("suspicious-perfect-warning"), null);
  assert.equal(dom.window.document.getElementById("decision-suspicious-perfect"), null);
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
  assert.deepEqual(hrefs, [
    "#trend-panel",
    "#decision-rail",
    "#codex-brief",
    "#strategy-memory",
    "#ledger",
  ]);
  const sideLabels = [...dom.window.document.querySelectorAll(".side-nav a")].map((item) =>
    item.textContent?.trim(),
  );
  assert.deepEqual(sideLabels, ["1Metric", "2Move", "3Brief", "4Ledger"]);
  const sideAriaLabels = [...dom.window.document.querySelectorAll(".side-nav a")].map((item) =>
    item.getAttribute("aria-label"),
  );
  assert.deepEqual(sideAriaLabels, [
    "Dashboard section: Metric",
    "Dashboard section: Move",
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
  assert.equal(dom.window.document.querySelector(".masthead"), null);
  const decisionRail = dom.window.document.getElementById("decision-rail");
  const trendPanel = dom.window.document.getElementById("trend-panel");
  const scoreStrip = dom.window.document.querySelector(".score-strip");
  assert.ok(decisionRail);
  assert.equal(
    dom.window.document.getElementById("next-action-title")?.textContent,
    "Do this first",
  );
  assert.equal(dom.window.document.getElementById("decision-next-command"), null);
  assert.ok(trendPanel);
  assert.ok(scoreStrip);
  assert.equal(
    Boolean(
      trendPanel.compareDocumentPosition(decisionRail) &
      dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    ),
    true,
    "Operate view should show the Packet trend before the next action.",
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
  assert.equal(dom.window.document.getElementById("ledger-scroll"), null);

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
  assert.equal(skipLabels[0], "Packet trend");
  assert.equal(skipLabels.includes("Run chart"), false);
  dom.window.close();
});

test("served dashboard live refresh starts by default and can be stopped", async () => {
  const entries = [
    {
      type: "config",
      name: "served dashboard",
      metricName: "quality_gap",
      bestDirection: "lower",
      metricUnit: "gaps",
    },
    { type: "run", run: 1, metric: 1, status: "keep", description: "Baseline", confidence: 1 },
  ];
  const viewModel = {
    summary: { segment: 0, baseline: 1, best: 1, confidence: 1 },
  };
  const refreshedEntries = [
    ...entries,
    { type: "run", run: 2, metric: 0, status: "keep", description: "Improved", confidence: 2 },
  ];
  const liveViewModel = {
    summary: { segment: 0, baseline: 1, best: 0, confidence: 2, runs: 2 },
    ledgerEntries: refreshedEntries,
    ledgerBounds: { truncated: true, omittedEntries: 25, maxEntries: 5000 },
  };
  const { getById, dom } = await runDashboard(
    entries,
    {
      deliveryMode: "live-server",
      liveRefreshAvailable: true,
      liveActionsAvailable: false,
      refreshMs: 1234,
      viewModel,
    },
    {
      beforeParse(window) {
        window.__refreshFetches = [];
        window.__liveIntervalCalls = 0;
        window.__clearedLiveIntervals = [];
        window.fetch = async (url) => {
          window.__refreshFetches.push(String(url));
          if (String(url).includes("view-model")) {
            return { ok: true, json: async () => liveViewModel };
          }
          return {
            ok: false,
            status: 404,
            statusText: "Not Found",
            text: async () => "",
          };
        };
        window.setInterval = (callback, ms) => {
          window.__liveIntervalCalls += 1;
          window.__liveInterval = { callback, id: window.__liveIntervalCalls, ms };
          return window.__liveIntervalCalls;
        };
        window.clearInterval = (id) => {
          window.__clearedLiveIntervals.push(id);
          window.__clearedLiveInterval = id;
        };
      },
    },
  );

  await waitFor(
    () => dom.window.__liveInterval,
    "Live dashboard did not start refresh automatically.",
  );

  assert.equal(dom.window.__liveInterval.ms, 1234);
  await waitFor(
    () => dom.window.__refreshFetches.length >= 1,
    "Live dashboard did not refresh immediately.",
  );
  await waitFor(
    () => getById("runs-value").textContent === "2 (2 kept)",
    "Live dashboard did not refresh from embedded view-model entries.",
  );
  assert.match(
    getById("ledger-note").textContent,
    /2 visible runs \/ newest first \/ 25 older ledger entries omitted/,
  );
  assert.deepEqual(dom.window.__refreshFetches, ["view-model.json"]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(dom.window.__liveIntervalCalls, 1);
  assert.equal(dom.window.__refreshFetches.length, 1);
  assert.deepEqual(dom.window.__clearedLiveIntervals, []);

  getById("live-toggle").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await waitFor(
    () => dom.window.__clearedLiveInterval === 1,
    "Live toggle did not clear the interval.",
  );
  dom.window.close();
});

test("served dashboard empty bootstrap renders live view-model instead of demo data", async () => {
  const liveEntries = [
    {
      type: "config",
      name: "package live session",
      metricName: "quality_gap",
      bestDirection: "lower",
      metricUnit: "gaps",
    },
    {
      type: "run",
      run: 1,
      metric: 0,
      status: "keep",
      description: "Package gate passed",
      confidence: 4,
    },
  ];
  const liveViewModel = {
    summary: { segment: 0, baseline: 0, best: 0, confidence: 4, runs: 1 },
    ledgerEntries: liveEntries,
    ledgerBounds: { truncated: false, omittedEntries: 0, maxEntries: 5000 },
  };
  const { getById, dom } = await runDashboard(
    [],
    {
      deliveryMode: "live-server",
      liveRefreshAvailable: true,
      liveActionsAvailable: false,
      refreshMs: 60000,
      viewModel: {},
    },
    {
      beforeParse(window) {
        window.__refreshFetches = [];
        window.fetch = async (url) => {
          window.__refreshFetches.push(String(url));
          return { ok: true, json: async () => liveViewModel };
        };
        window.setInterval = () => 1;
        window.clearInterval = () => {};
      },
    },
  );

  await waitFor(
    () => getById("runs-value").textContent === "1 (1 kept)",
    "Live dashboard kept demo data after fetching view-model entries.",
  );
  assert.match(
    dom.window.document.querySelector(".toolbar-session strong")?.textContent || "",
    /package live session/i,
  );
  assert.deepEqual(dom.window.__refreshFetches, ["view-model.json"]);
  dom.window.close();
});

test("live dashboard view model reports ledger bounds when entries are capped", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "autoresearch-live-bounds-"));
  const server = await serveAutoresearch({
    cwd: dir,
    port: 0,
    viewModelCacheTtlMs: 60_000,
    pluginVersion: "0.test",
    dashboardHtml: async () => "<!doctype html><title>bounds</title>",
    viewModel: async () => ({ summary: { runs: LIVE_LEDGER_MAX_ENTRIES + 3 } }),
  });

  try {
    const lines = [
      JSON.stringify({ type: "config", name: "bounds", metricName: "seconds" }),
      ...Array.from({ length: LIVE_LEDGER_MAX_ENTRIES + 3 }, (_, index) =>
        JSON.stringify({ type: "run", run: index + 1, status: "keep", metric: index + 1 }),
      ),
      "",
    ];
    await writeFile(path.join(dir, "autoresearch.jsonl"), lines.join("\n"), "utf8");

    const snapshot = await fetch(`${server.url}view-model.json`).then((res) => res.json());

    assert.equal(snapshot.ledgerEntries.length, LIVE_LEDGER_MAX_ENTRIES);
    assert.deepEqual(snapshot.ledgerBounds, {
      maxEntries: LIVE_LEDGER_MAX_ENTRIES,
      omittedEntries: 4,
      truncated: true,
    });
    assert.equal(snapshot.ledgerEntries[0].type, "config");
    assert.equal(snapshot.ledgerEntries[1].run, 5);
  } finally {
    server.server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("live dashboard ledger bounds count omitted raw ledger history before parsing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "autoresearch-live-raw-bounds-"));
  const malformedLineCount = 6_000;
  const runCount = LIVE_LEDGER_MAX_ENTRIES + 3;
  const server = await serveAutoresearch({
    cwd: dir,
    port: 0,
    viewModelCacheTtlMs: 60_000,
    pluginVersion: "0.test",
    dashboardHtml: async () => "<!doctype html><title>raw bounds</title>",
    viewModel: async () => ({ summary: { runs: runCount } }),
  });

  try {
    const lines = [
      ...Array.from({ length: malformedLineCount }, (_, index) => `{malformed-${index}`),
      JSON.stringify({ type: "config", name: "raw bounds", metricName: "seconds" }),
      ...Array.from({ length: runCount }, (_, index) =>
        JSON.stringify({ type: "run", run: index + 1, status: "keep", metric: index + 1 }),
      ),
      "",
    ];
    await writeFile(path.join(dir, "autoresearch.jsonl"), lines.join("\n"), "utf8");

    const snapshot = await fetch(`${server.url}view-model.json`).then((res) => res.json());

    assert.equal(snapshot.ledgerEntries.length, LIVE_LEDGER_MAX_ENTRIES);
    assert.deepEqual(snapshot.ledgerBounds, {
      maxEntries: LIVE_LEDGER_MAX_ENTRIES,
      omittedEntries: malformedLineCount + 4,
      truncated: true,
    });
    assert.equal(snapshot.ledgerEntries[0].type, "config");
    assert.equal(snapshot.ledgerEntries[1].run, 5);
  } finally {
    server.server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("live dashboard ledger bounds preserve governing config by position", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "autoresearch-live-duplicate-config-"));
  const runCount = LIVE_LEDGER_MAX_ENTRIES + 3;
  const server = await serveAutoresearch({
    cwd: dir,
    port: 0,
    viewModelCacheTtlMs: 60_000,
    pluginVersion: "0.test",
    dashboardHtml: async () => "<!doctype html><title>duplicate config</title>",
    viewModel: async () => ({ summary: { runs: runCount } }),
  });

  try {
    const configLine = JSON.stringify({
      type: "config",
      name: "duplicate config",
      metricName: "seconds",
    });
    const runLines = Array.from({ length: runCount }, (_, index) =>
      JSON.stringify({ type: "run", run: index + 1, status: "keep", metric: index + 1 }),
    );
    const lines = [configLine, ...runLines.slice(0, 10), configLine, ...runLines.slice(10), ""];
    await writeFile(path.join(dir, "autoresearch.jsonl"), lines.join("\n"), "utf8");

    const snapshot = await fetch(`${server.url}view-model.json`).then((res) => res.json());

    assert.equal(snapshot.ledgerEntries.length, LIVE_LEDGER_MAX_ENTRIES);
    assert.deepEqual(snapshot.ledgerBounds, {
      maxEntries: LIVE_LEDGER_MAX_ENTRIES,
      omittedEntries: 5,
      truncated: true,
    });
    assert.equal(snapshot.ledgerEntries[0].type, "config");
    assert.equal(snapshot.ledgerEntries[1].run, 6);
  } finally {
    server.server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("live dashboard view model cache invalidates on session state changes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "autoresearch-live-cache-"));
  let recomputes = 0;
  const server = await serveAutoresearch({
    cwd: dir,
    port: 0,
    viewModelCacheTtlMs: 60_000,
    pluginVersion: "0.test",
    dashboardHtml: async () => "<!doctype html><title>cache</title>",
    viewModel: async () => {
      recomputes += 1;
      return { summary: { runs: recomputes } };
    },
  });

  try {
    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      [
        JSON.stringify({ type: "config", name: "cache", metricName: "seconds" }),
        JSON.stringify({ type: "run", run: 1, status: "keep", metric: 1 }),
        "",
      ].join("\n"),
      "utf8",
    );

    const first = await fetch(`${server.url}view-model.json`).then((res) => res.json());
    const second = await fetch(`${server.url}view-model.json`).then((res) => res.json());

    assert.equal(first.summary.runs, 1);
    assert.equal(second.summary.runs, 1);
    assert.equal(recomputes, 1);

    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      [
        JSON.stringify({ type: "config", name: "cache", metricName: "seconds" }),
        JSON.stringify({ type: "run", run: 1, status: "keep", metric: 1 }),
        JSON.stringify({ type: "run", run: 2, status: "keep", metric: 0.5 }),
        "",
      ].join("\n"),
      "utf8",
    );

    const third = await fetch(`${server.url}view-model.json`).then((res) => res.json());

    assert.equal(third.summary.runs, 2);
    assert.equal(recomputes, 2);
    assert.equal(third.ledgerEntries.length, 3);
  } finally {
    server.server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("live dashboard view model cache starts its ttl after slow recomputes finish", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "autoresearch-live-cache-slow-"));
  let recomputes = 0;
  const server = await serveAutoresearch({
    cwd: dir,
    port: 0,
    viewModelCacheTtlMs: 25,
    pluginVersion: "0.test",
    dashboardHtml: async () => "<!doctype html><title>slow cache</title>",
    viewModel: async () => {
      recomputes += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { summary: { runs: recomputes } };
    },
  });

  try {
    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      [
        JSON.stringify({ type: "config", name: "slow cache", metricName: "seconds" }),
        JSON.stringify({ type: "run", run: 1, status: "keep", metric: 1 }),
        "",
      ].join("\n"),
      "utf8",
    );

    const first = await fetch(`${server.url}view-model.json`).then((res) => res.json());
    const second = await fetch(`${server.url}view-model.json`).then((res) => res.json());

    assert.equal(first.summary.runs, 1);
    assert.equal(second.summary.runs, 1);
    assert.equal(recomputes, 1);
  } finally {
    server.server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("live dashboard view model cache coalesces concurrent refreshes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "autoresearch-live-cache-concurrent-"));
  let recomputes = 0;
  const server = await serveAutoresearch({
    cwd: dir,
    port: 0,
    viewModelCacheTtlMs: 60_000,
    pluginVersion: "0.test",
    dashboardHtml: async () => "<!doctype html><title>concurrent cache</title>",
    viewModel: async () => {
      recomputes += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { summary: { runs: recomputes } };
    },
  });

  try {
    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      [
        JSON.stringify({ type: "config", name: "concurrent cache", metricName: "seconds" }),
        JSON.stringify({ type: "run", run: 1, status: "keep", metric: 1 }),
        "",
      ].join("\n"),
      "utf8",
    );

    const [first, second] = await Promise.all([
      fetch(`${server.url}view-model.json`).then((res) => res.json()),
      fetch(`${server.url}view-model.json`).then((res) => res.json()),
    ]);

    assert.equal(first.summary.runs, 1);
    assert.equal(second.summary.runs, 1);
    assert.equal(recomputes, 1);
  } finally {
    server.server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("live dashboard view model cache retries stale mid-refresh snapshots", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "autoresearch-live-cache-race-"));
  let recomputes = 0;
  const server = await serveAutoresearch({
    cwd: dir,
    port: 0,
    viewModelCacheTtlMs: 60_000,
    pluginVersion: "0.test",
    dashboardHtml: async () => "<!doctype html><title>cache race</title>",
    viewModel: async () => {
      recomputes += 1;
      if (recomputes === 1) {
        await appendFile(
          path.join(dir, "autoresearch.jsonl"),
          `${JSON.stringify({ type: "run", run: 2, status: "keep", metric: 0.5 })}\n`,
          "utf8",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { summary: { runs: recomputes } };
    },
  });

  try {
    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      [
        JSON.stringify({ type: "config", name: "cache race", metricName: "seconds" }),
        JSON.stringify({ type: "run", run: 1, status: "keep", metric: 1 }),
        "",
      ].join("\n"),
      "utf8",
    );

    const first = await fetch(`${server.url}view-model.json`).then((res) => res.json());
    const second = await fetch(`${server.url}view-model.json`).then((res) => res.json());

    assert.equal(first.summary.runs, 2);
    assert.equal(first.ledgerEntries.length, 3);
    assert.equal(second.summary.runs, 2);
    assert.equal(recomputes, 2);
  } finally {
    server.server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("live dashboard view model returns retry when refresh keeps changing files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "autoresearch-live-cache-retry-"));
  let recomputes = 0;
  const server = await serveAutoresearch({
    cwd: dir,
    port: 0,
    viewModelCacheTtlMs: 60_000,
    pluginVersion: "0.test",
    dashboardHtml: async () => "<!doctype html><title>cache retry</title>",
    viewModel: async () => {
      recomputes += 1;
      if (recomputes <= 2) {
        await appendFile(
          path.join(dir, "autoresearch.jsonl"),
          `${JSON.stringify({
            type: "run",
            run: recomputes + 1,
            status: "keep",
            metric: recomputes,
          })}\n`,
          "utf8",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { summary: { runs: recomputes } };
    },
  });

  try {
    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      [
        JSON.stringify({ type: "config", name: "cache retry", metricName: "seconds" }),
        JSON.stringify({ type: "run", run: 1, status: "keep", metric: 1 }),
        "",
      ].join("\n"),
      "utf8",
    );

    const retryResponse = await fetch(`${server.url}view-model.json`);
    const retryPayload = await retryResponse.json();
    const recovered = await fetch(`${server.url}view-model.json`).then((res) => res.json());

    assert.equal(retryResponse.status, 409);
    assert.equal(retryPayload.code, "live_view_model_changed_during_refresh");
    assert.equal(retryPayload.retryable, true);
    assert.equal(recomputes, 3);
    assert.equal(recovered.summary.runs, 3);
    assert.equal(recovered.ledgerEntries.length, 4);
  } finally {
    server.server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("served dashboard ignores stale live refresh responses that resolve out of order", async () => {
  const entries = [
    {
      type: "config",
      name: "served dashboard",
      metricName: "quality_gap",
      bestDirection: "lower",
      metricUnit: "gaps",
    },
    { type: "run", run: 1, metric: 2, status: "keep", description: "Baseline", confidence: 1 },
  ];
  const staleEntries = [
    ...entries,
    { type: "run", run: 2, metric: 1, status: "keep", description: "Older", confidence: 2 },
  ];
  const latestEntries = [
    ...staleEntries,
    { type: "run", run: 3, metric: 0, status: "keep", description: "Latest", confidence: 3 },
  ];
  const staleViewModel = {
    summary: { segment: 0, baseline: 2, best: 1, confidence: 2, runs: 2 },
    ledgerEntries: staleEntries,
  };
  const latestViewModel = {
    summary: { segment: 0, baseline: 2, best: 0, confidence: 3, runs: 3 },
    ledgerEntries: latestEntries,
  };
  const { getById, dom } = await runDashboard(
    entries,
    {
      deliveryMode: "live-server",
      liveRefreshAvailable: true,
      liveActionsAvailable: false,
      refreshMs: 60000,
      viewModel: { summary: { segment: 0, baseline: 2, best: 2, confidence: 1 } },
    },
    {
      beforeParse(window) {
        window.__refreshFetches = [];
        window.__refreshResolvers = {};
        window.fetch = async (url) => {
          const requestNumber = window.__refreshFetches.push(String(url));
          const viewModel = requestNumber === 1 ? staleViewModel : latestViewModel;
          return new Promise((resolve) => {
            window.__refreshResolvers[requestNumber] = () =>
              resolve({ ok: true, json: async () => viewModel });
          });
        };
        window.setInterval = (callback, ms) => {
          window.__liveInterval = { callback, id: 1, ms };
          return 1;
        };
        window.clearInterval = () => {};
      },
    },
  );

  await waitFor(() => dom.window.__refreshResolvers?.[1], "Initial live refresh did not start.");
  getById("refresh-now").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await waitFor(() => dom.window.__refreshResolvers?.[2], "Manual live refresh did not start.");

  dom.window.__refreshResolvers[2]();
  await waitFor(
    () => getById("runs-value").textContent === "3 (3 kept)",
    "Latest refresh response did not update the dashboard.",
  );
  dom.window.__refreshResolvers[1]();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(getById("runs-value").textContent, "3 (3 kept)");
  assert.deepEqual(dom.window.__refreshFetches, ["view-model.json", "view-model.json"]);
  dom.window.close();
});

test("served dashboard retries retryable live refresh conflicts before reporting failure", async () => {
  const entries = [
    {
      type: "config",
      name: "served dashboard",
      metricName: "quality_gap",
      bestDirection: "lower",
      metricUnit: "gaps",
    },
    { type: "run", run: 1, metric: 1, status: "keep", description: "Baseline", confidence: 1 },
  ];
  const refreshedEntries = [
    ...entries,
    {
      type: "run",
      run: 2,
      metric: 0,
      status: "keep",
      description: "Retry recovered",
      confidence: 2,
    },
  ];
  const liveViewModel = {
    summary: { segment: 0, baseline: 1, best: 0, confidence: 2, runs: 2 },
    ledgerEntries: refreshedEntries,
  };
  const { getById, dom } = await runDashboard(
    entries,
    {
      deliveryMode: "live-server",
      liveRefreshAvailable: true,
      liveActionsAvailable: false,
      refreshMs: 60000,
      viewModel: { summary: { segment: 0, baseline: 1, best: 1, confidence: 1 } },
    },
    {
      beforeParse(window) {
        window.__refreshFetches = [];
        window.fetch = async (url) => {
          const requestNumber = window.__refreshFetches.push(String(url));
          if (requestNumber === 1) {
            return {
              ok: false,
              status: 409,
              statusText: "Conflict",
              json: async () => ({
                ok: false,
                code: "live_view_model_changed_during_refresh",
                retryable: true,
                message:
                  "Session files changed while the live dashboard readout was refreshing. Retry to avoid a mixed ledger/readout snapshot.",
              }),
            };
          }
          return { ok: true, json: async () => liveViewModel };
        };
        window.setInterval = () => 42;
        window.clearInterval = () => {};
      },
    },
  );

  await waitFor(
    () => getById("runs-value").textContent === "2 (2 kept)",
    "Live dashboard did not retry a retryable view-model conflict.",
  );
  assert.deepEqual(dom.window.__refreshFetches, ["view-model.json", "view-model.json"]);
  assert.doesNotMatch(getById("live-title").textContent || "", /failed/i);
  assert.doesNotMatch(getById("live-detail").textContent || "", /409|Conflict/i);
  dom.window.close();
});

test("served dashboard live refresh reports endpoint failures without success", async () => {
  const entries = [
    {
      type: "config",
      name: "served dashboard",
      metricName: "quality_gap",
      bestDirection: "lower",
      metricUnit: "gaps",
    },
    { type: "run", run: 1, metric: 1, status: "keep", description: "Baseline", confidence: 1 },
  ];
  const viewModel = {
    summary: { segment: 0, baseline: 1, best: 1, confidence: 1 },
  };
  const { getById, dom } = await runDashboard(
    entries,
    {
      deliveryMode: "live-server",
      liveRefreshAvailable: true,
      liveActionsAvailable: false,
      refreshMs: 1234,
      viewModel,
    },
    {
      beforeParse(window) {
        window.fetch = async (url) => {
          if (String(url).includes("view-model")) {
            return { ok: false, status: 500, statusText: "Internal Server Error" };
          }
          return {
            ok: true,
            text: async () => entries.map((entry) => JSON.stringify(entry)).join("\n"),
          };
        };
        window.setInterval = () => 42;
        window.clearInterval = () => {};
      },
    },
  );

  await waitFor(
    () => /failed/i.test(getById("live-title").textContent || ""),
    "Live refresh failure was not announced.",
  );
  assert.match(getById("live-detail").textContent || "", /view-model\.json returned HTTP 500/);
  assert.doesNotMatch(getById("live-title").textContent || "", /refreshed/i);
  dom.window.close();
});

test("dashboard readout uses the selected segment baseline", async () => {
  const entries = [
    {
      type: "config",
      name: "first segment",
      metricName: "seconds",
      bestDirection: "lower",
      metricUnit: "s",
    },
    {
      type: "run",
      run: 1,
      metric: 10,
      status: "keep",
      description: "First baseline",
      confidence: 1,
    },
    { type: "run", run: 2, metric: 8, status: "keep", description: "First best", confidence: 2 },
    {
      type: "config",
      name: "second segment",
      metricName: "seconds",
      bestDirection: "lower",
      metricUnit: "s",
    },
    {
      type: "run",
      run: 1,
      metric: 100,
      status: "keep",
      description: "Second baseline",
      confidence: 1,
    },
    { type: "run", run: 2, metric: 90, status: "keep", description: "Second best", confidence: 2 },
  ];

  const { getById, queryById, dom } = await runDashboard(entries, {
    deliveryMode: "static-export",
    liveActionsAvailable: false,
    viewModel: {
      summary: { segment: 1, baseline: 100, best: 90, confidence: 2 },
    },
  });

  assert.equal(getById("baseline-value").textContent, "100s");
  assert.equal(queryById("segment-tab-0"), null);
  const select = getById("segment-select") as HTMLSelectElement;
  assert.equal(select.value, "1");
  assert.match(select.options[0]?.textContent || "", /S1 - first segment/);
  assert.match(select.options[1]?.textContent || "", /S2 - second segment/);
  select.value = "0";
  select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await waitFor(
    () => getById("baseline-value").textContent === "10s",
    "Selected segment baseline did not update.",
  );
  assert.equal(getById("best-value").textContent, "8s");
  assert.match(getById("segment-summary").textContent || "", /first segment/);
  select.value = "1";
  select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await waitFor(
    () => getById("baseline-value").textContent === "100s",
    "Second segment selection did not update.",
  );
  assert.match(getById("segment-summary").textContent || "", /second segment/);
  dom.window.close();
});

test("dashboard defaults to audit view and can switch to operate", async () => {
  const entries = [
    dashboardConfigEntry({ name: "audit default", metricName: "seconds", metricUnit: "s" }),
    { type: "run", run: 1, metric: 5, status: "keep", description: "Baseline", confidence: 1 },
  ];

  const { getById, queryById, dom } = await runDashboard(entries, {
    deliveryMode: "live-server",
    liveRefreshAvailable: true,
    liveActionsAvailable: false,
    viewModel: {},
    commands: [],
  });
  const toggle = getById("view-toggle") as HTMLButtonElement;

  assert.equal(toggle.getAttribute("aria-pressed"), "true");
  assert.ok(getById("workspace-grid"));
  assert.ok(getById("research-truth-meter"));
  assert.ok(getById("strategy-memory"));
  assert.ok(getById("codex-brief"));

  toggle.click();
  await waitFor(
    () => queryById("workspace-grid") == null,
    "Operate view did not collapse audit context.",
  );
  assert.equal(queryById("research-truth-meter"), null);
  assert.equal(queryById("strategy-memory"), null);
  assert.equal(toggle.getAttribute("aria-pressed"), "false");
  assert.match(dom.window.location.search, /view=operate/);
  dom.window.close();
});

test("dashboard restores audit view and chart preferences from the URL", async () => {
  const entries = [
    dashboardConfigEntry({ name: "url state", metricName: "seconds", metricUnit: "s" }),
    { type: "run", run: 1, metric: 5, status: "keep", description: "Baseline", confidence: 1 },
    { type: "run", run: 2, metric: 4, status: "keep", description: "Improved", confidence: 2 },
  ];

  const { getById, dom } = await runDashboard(entries, emptyCommandMeta(), {
    url: "file:///autoresearch-dashboard.html?view=audit&value=percent",
  });

  assert.ok(getById("workspace-grid"));
  assert.equal(getById("view-toggle").getAttribute("aria-pressed"), "true");
  const percentButtons = Array.from(dom.window.document.querySelectorAll("button")).filter(
    (button) => button.getAttribute("aria-pressed") === "true",
  );
  assert.ok(
    percentButtons.some((button) => /%|percent/i.test(button.textContent || "")),
    "Percent value mode was not restored from the URL.",
  );
  dom.window.close();
});

test("dashboard decision rail shows newest runs first", async () => {
  const entries = [
    {
      type: "config",
      name: "recent rail",
      metricName: "score",
      bestDirection: "higher",
      metricUnit: "pt",
    },
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

  const ledgerHtml = getById("ledger-body").innerHTML;
  assert.match(ledgerHtml, /#6/);
  assert.match(ledgerHtml, /Run six/);
  assert.match(ledgerHtml, /#5/);
  assert.ok(
    ledgerHtml.indexOf("#6") < ledgerHtml.indexOf("#1"),
    "Ledger should list newest runs before older runs.",
  );
  dom.window.close();
});

function assertNoMutatingDashboardCommands(value: unknown) {
  const commands = collectDashboardCommandFields(value).join("\n");
  assert.doesNotMatch(commands, /(?:^|\s)(?:next|log)(?:\s|$)/i);
  assert.doesNotMatch(commands, /--status\s+(?:keep|discard)\b/i);
  assert.doesNotMatch(commands, /\b(?:serve|export|benchmark-lint)\b/i);
  assert.doesNotMatch(commands, /--check-benchmark\b/i);
  assert.doesNotMatch(commands, /\s--\s+\S/i);
}

function cssHexVariables(css: string) {
  const root = extractCssBlock(css, ":root");
  const variables = new Map<string, string>();
  for (const match of root.matchAll(/(--[\w-]+):\s*(#[\da-fA-F]{6})\s*;/g)) {
    variables.set(match[1]!, match[2]!);
  }
  return variables;
}

function requiredCssVariable(variables: ReadonlyMap<string, string>, name: string) {
  const value = variables.get(name);
  assert.ok(value, `Missing CSS variable ${name}`);
  return value;
}

function assertContrastAtLeast(
  foreground: string,
  background: string,
  minimum: number,
  label: string,
) {
  const ratio = contrastRatio(foreground, background);
  assert.ok(ratio >= minimum, `${label} contrast ${ratio.toFixed(2)} is below ${minimum}`);
}

function contrastRatio(foreground: string, background: string) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(hex: string) {
  const [redChannel, greenChannel, blueChannel] = hexToRgb(hex);
  const red = relativeColorChannel(redChannel);
  const green = relativeColorChannel(greenChannel);
  const blue = relativeColorChannel(blueChannel);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function relativeColorChannel(channel: number) {
  const normalized = channel / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  assert.match(value, /^[\da-fA-F]{6}$/);
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function extractCssBlock(css: string, marker: string) {
  const start = css.indexOf(marker);
  assert.notEqual(start, -1, `Missing CSS marker: ${marker}`);
  const open = css.indexOf("{", start);
  assert.notEqual(open, -1, `Missing CSS block for marker: ${marker}`);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    const char = css[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, index);
    }
  }
  throw new Error(`Unclosed CSS block for marker: ${marker}`);
}
