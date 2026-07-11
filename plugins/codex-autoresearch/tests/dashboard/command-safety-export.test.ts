import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DASHBOARD_PAYLOAD_VERSION } from "../../dashboard/src/types.js";
import { buildDashboardViewModel } from "../../lib/dashboard-view-model.js";
import {
  DASHBOARD_TRANSPORT_ARRAY_LIMIT,
  DASHBOARD_TRANSPORT_MEMORY_LIST_LIMIT,
  compactDashboardTransportViewModel,
  dashboardHtml,
  readDashboardBuildAsset,
} from "../../lib/dashboard-transport.js";
import {
  DASHBOARD_COMMAND_FIELD_NAMES,
  DASHBOARD_COMMAND_KEY_ALIASES,
  collectDashboardCommandFields,
  dashboardCommandSafety,
  dashboardCommandMapKey,
  dashboardReadOnlyCommand,
  stripDashboardExportCommandFields,
  stripDashboardGuidanceCommandFields,
} from "../../lib/dashboard-command-safety.js";
import { resolvePackageRoot } from "../../lib/runtime-paths.js";
import { createDashboardHarness } from ".././helpers/dashboard.js";

const dashboard = createDashboardHarness();

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
  assert.equal(meta.payloadVersion, DASHBOARD_PAYLOAD_VERSION);
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

test("dashboard build stays within the shipped JavaScript and CSS budgets", () => {
  assert.ok(Buffer.byteLength(readDashboardBuildAsset("dashboard-app.js"), "utf8") <= 650 * 1024);
  assert.ok(Buffer.byteLength(readDashboardBuildAsset("dashboard-app.css"), "utf8") <= 50 * 1024);
});

test("dashboard test scripts build ignored dashboard assets once before dashboard tests", () => {
  const packageJson = JSON.parse(
    readFileSync(path.join(resolvePackageRoot(import.meta.url), "package.json"), "utf8"),
  );
  const scripts = packageJson.scripts || {};
  const compiledDashboardScript = String(scripts["test:compiled:dashboard"] || "");

  assert.doesNotMatch(compiledDashboardScript, /\bbuild:dashboard\b/);
  assert.match(compiledDashboardScript, /\bnode --test\b/);

  for (const [name, nextScript] of [
    ["test", "test:compiled"],
    ["test:dashboard", "test:compiled:dashboard"],
  ]) {
    const script = String(scripts[name] || "");

    assert.equal(
      script.split(/\s+/).filter((part) => part === "build:dashboard").length,
      1,
      `${name} must build generated dashboard assets exactly once.`,
    );
    assert.ok(
      script.indexOf("build:dashboard") < script.indexOf(nextScript),
      `${name} must build generated dashboard assets before running dashboard tests.`,
    );
  }

  const checkScript = readFileSync(
    path.join(resolvePackageRoot(import.meta.url), "scripts", "check.ts"),
    "utf8",
  );
  const runAllPhases = checkScript.slice(
    checkScript.indexOf("const ok ="),
    checkScript.indexOf("return ok ? 0 : 1;"),
  );
  assert.ok(
    runAllPhases.indexOf("runDashboardBuildWithParity") < runAllPhases.indexOf("runProductPhase"),
    "npm run check must prove dashboard build parity before compiled product tests.",
  );
  assert.ok(
    runAllPhases.indexOf("runProductPhase") < runAllPhases.indexOf("runPackageArtifactCheck"),
    "npm run check must keep package artifact/runtime smoke after product tests.",
  );
});
