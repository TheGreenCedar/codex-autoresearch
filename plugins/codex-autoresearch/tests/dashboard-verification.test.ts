import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { formatCompactMetricTick } from "../dashboard/src/model/formatting.js";
import { asiText } from "../dashboard/src/model/asi.js";
import type { SessionRun } from "../dashboard/src/types.js";
import {
  buildActionRail,
  buildDashboardViewModel,
  buildTrustState,
} from "../lib/dashboard-view-model.js";
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

test("dashboard command safety accepts generated Windows launcher paths", () => {
  const command = String.raw`node "C:\\Users\\alber\\source\\repos\\autoresearch\\plugins\\codex-autoresearch\\scripts\\autoresearch.mjs" state --cwd "C:\\work\\repo" --report`;
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
  assert.equal(DASHBOARD_COMMAND_FIELD_NAMES.has("cleanupCommand"), true);
  assert.deepEqual(stripDashboardGuidanceCommandFields(payload), {
    nested: { detail: "Review the current state." },
    sourceCwd: "C:/repo",
    summary: "No command here.",
  });
  assert.deepEqual(stripDashboardExportCommandFields(payload), {
    nested: { detail: "Review the current state." },
    summary: "No command here.",
  });
  assert.deepEqual(collectDashboardCommandFields(payload), [
    "node scripts/autoresearch.mjs next --cwd C:/repo",
    "git stash push --include-untracked -- autoresearch.jsonl",
    "node scripts/autoresearch.mjs log --cwd C:/repo --from-last --status keep",
    "node scripts/autoresearch.mjs doctor --cwd C:/repo",
    "Next",
    "node scripts/autoresearch.mjs next --cwd C:/repo",
  ]);
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
  assert.match(getById("ledger-body").getAttribute("style"), /height: 8200px/);
  assert.match(ledgerHtml, /#100/);
  assert.match(ledgerHtml, /#1<\/div>/);
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
  assert.match(getById("v2-release-signals").textContent, /Do not run another packet/);
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

  assert.match(note, /Trend ready: 3 finite metric runs/);
  assert.match(note, /1 crash held/);
  assert.match(summary, /4 plotted runs out of 4 logged runs/);
  assert.match(summary, /1 crash run is plotted at the nearest successful metric level/);
  assert.match(chart, /#4/);
  assert.match(chart, /#2/);
  assert.doesNotMatch(chart, /Infinity|NaN/);
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
  assert.match(note, /Trend ready: 2 finite metric runs/);
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
  assert.equal(getById("refresh-now").textContent, "Refresh live data");
  assert.equal(getById("live-toggle").textContent, "Auto-refresh on");
  assert.equal(getById("refresh-now").hidden, false);
  assert.equal(getById("live-toggle").hidden, false);
  assert.equal(queryById("action-note"), null);
  assert.equal(queryById("live-actions-panel"), null);
  assert.equal(queryById("mission-control-grid"), null);
  assert.equal(queryById("action-grid"), null);
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
    const details = getById("metric-details");

    assert.equal(signalStrip.getAttribute("aria-label"), "Run readiness signals");
    assert.equal(signalStrip.querySelectorAll(".signal-item").length, 5);
    assert.match(signalStrip.textContent, /Repeat the best packet/);
    assert.match(signalStrip.textContent, /2 current \/ 1 provisional \/ 1 audit-only/);
    assert.match(signalStrip.textContent, /1 active \/ 0 done/);
    assert.equal(signalStrip.querySelector("button"), null);
    assert.ok(
      chart.compareDocumentPosition(signalStrip) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
      "signal strip should render after the chart",
    );
    assert.ok(
      signalStrip.compareDocumentPosition(details) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
      "signal strip should render before metric details",
    );
    if (view === "operate") {
      assert.equal(queryById("workspace-grid"), null);
      assert.equal(queryById("strategy-memory"), null);
    } else {
      assert.ok(getById("strategy-memory"));
    }
  }
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
    /\.toolbar-controls,[\s\S]*?\.signal-strip,[\s\S]*?grid-template-columns:\s*1fr/,
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
  assert.ok(dom.window.document.getElementById("dashboard-toolbar"));
  assert.equal(dom.window.document.querySelector(".masthead"), null);
  const decisionRail = dom.window.document.getElementById("decision-rail");
  const trendPanel = dom.window.document.getElementById("trend-panel");
  const scoreStrip = dom.window.document.querySelector(".score-strip");
  assert.ok(decisionRail);
  assert.ok(trendPanel);
  assert.ok(scoreStrip);
  assert.equal(
    Boolean(
      trendPanel.compareDocumentPosition(decisionRail) &
      dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    ),
    true,
    "Operate view should show the run chart before the next action.",
  );
  assert.equal(
    Boolean(
      trendPanel.compareDocumentPosition(scoreStrip) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    ),
    true,
    "Operate view should show the run chart before the score strip.",
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
            return { ok: true, json: async () => viewModel };
          }
          return {
            ok: true,
            text: async () => entries.map((entry) => JSON.stringify(entry)).join("\n"),
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
    () => dom.window.__refreshFetches.length >= 2,
    "Live dashboard did not refresh immediately.",
  );
  assert.deepEqual(dom.window.__refreshFetches.slice(0, 2), [
    "autoresearch.jsonl",
    "view-model.json",
  ]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(dom.window.__liveIntervalCalls, 1);
  assert.equal(dom.window.__refreshFetches.length, 2);
  assert.deepEqual(dom.window.__clearedLiveIntervals, []);

  getById("live-toggle").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await waitFor(
    () => dom.window.__clearedLiveInterval === 1,
    "Live toggle did not clear the interval.",
  );
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
