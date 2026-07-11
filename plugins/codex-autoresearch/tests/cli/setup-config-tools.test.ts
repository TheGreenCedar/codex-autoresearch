import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { quoteForShell } from "../helpers/process.js";

import { pluginRoot, runCli, withTempDir, git, setupFixture } from "../helpers/cli-test-context.js";

test("setup does not append elapsed metrics to explicit metric-emitting benchmarks", async () => {
  await withTempDir("setup-explicit-metric", async (dir) => {
    const benchmark = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=42')"`;
    const result = await runCli([
      "setup",
      "--cwd",
      dir,
      "--name",
      "explicit metric setup",
      "--metric-name",
      "seconds",
      "--benchmark-command",
      benchmark,
      "--commit-paths",
      "src,tests",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.ok(payload.checkpoint.paths.includes("autoresearch.md"));
    assert.ok(payload.checkpoint.paths.includes("autoresearch.config.json"));
    assert.ok(payload.checkpoint.paths.includes(".gitattributes"));
    assert.match(payload.checkpoint.commands.join("\n"), /git add --/);
    assert.equal(payload.benchmarkMode.printsMetric, true);
    assert.match(payload.benchmarkLintCommand, /benchmark-lint/);
    assert.deepEqual(
      payload.firstRunChecklist.map((step) => step.step),
      ["setup", "benchmark-lint", "doctor", "checkpoint", "baseline", "log"],
    );

    const scriptName = process.platform === "win32" ? "autoresearch.ps1" : "autoresearch.sh";
    const script = await readFile(path.join(dir, scriptName), "utf8");
    assert.match(script, /METRIC seconds=42/);
    assert.doesNotMatch(script, /Elapsed\.TotalSeconds|elapsed_seconds/);
    assert.doesNotMatch(script, /METRIC seconds=\{0\}|printf 'METRIC seconds/);

    const sessionDoc = await readFile(path.join(dir, "autoresearch.md"), "utf8");
    assert.match(sessionDoc, /`src`: in configured commit scope/);
    assert.match(sessionDoc, /`tests`: in configured commit scope/);
    assert.doesNotMatch(sessionDoc, /TBD: add files after initial inspection/);

    const attributes = await readFile(path.join(dir, ".gitattributes"), "utf8");
    assert.match(attributes, /autoresearch\.jsonl text eol=lf/);
    assert.match(attributes, /autoresearch\.md text eol=lf/);
    assert.match(attributes, /autoresearch\.ideas\.md text eol=lf/);
  });
});

test("ledger appends use LF on Windows-facing sessions", async () => {
  await withTempDir("ledger-lf", async (dir) => {
    await setupFixture(dir, { name: "lf" });
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Baseline",
    ]);
    const ledger = await readFile(path.join(dir, "autoresearch.jsonl"), "utf8");
    assert.doesNotMatch(ledger, /\r\n/);
    assert.match(ledger, /\n/);
  });
});

test("benchmark-inspect warns before suspicious full benchmark probes", async () => {
  await withTempDir("benchmark-inspect", async (dir) => {
    await setupFixture(dir, { name: "inspect", metricName: "score" });
    const command = `${quoteForShell(process.execPath)} -e "console.log('case-a')"`;
    const result = await runCli(["benchmark-inspect", "--cwd", dir, "--command", command]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ranCommand, true);
    assert.match(payload.outputPreview, /case-a/);
    assert.match(payload.hints.join("\n"), /METRIC score=<number>/);

    const suspicious = await runCli([
      "benchmark-inspect",
      "--cwd",
      dir,
      "--command",
      "CODESTORY_PIPELINE_LIST_CASES=1 node scripts/autoresearch-indexer-embedder-pipeline.mjs",
    ]);
    assert.equal(suspicious.code, 0, suspicious.stderr);
    const suspiciousPayload = JSON.parse(suspicious.stdout);
    assert.match(suspiciousPayload.warnings.join("\n"), /CODESTORY_EMBED_RESEARCH_LIST=1/);
  });
});

test("checks-inspect catches malformed cargo checks and broad failures", async () => {
  await withTempDir("checks-inspect", async (dir) => {
    const cargoShape = `${quoteForShell(process.execPath)} -e "console.error(\\"error: unexpected argument 'build_search_state' found\\\\n\\\\nUsage: cargo.exe test [OPTIONS] [TESTNAME] [-- [ARGS]...]\\"); process.exit(1)"`;
    const shapeResult = await runCli(["checks-inspect", "--cwd", dir, "--command", cargoShape]);
    assert.equal(shapeResult.code, 0, shapeResult.stderr);
    const shapePayload = JSON.parse(shapeResult.stdout);
    assert.equal(shapePayload.ok, false);
    assert.match(shapePayload.warnings.join("\n"), /Cargo rejected/);
    assert.match(shapePayload.nextAction, /Fix command-shape/);

    const broadFailure = `${quoteForShell(process.execPath)} -e "console.error(\\"test runtime::one ... FAILED\\\\ntest semantic::two ... FAILED\\"); process.exit(1)"`;
    const broadResult = await runCli(["checks-inspect", "--cwd", dir, "--command", broadFailure]);
    assert.equal(broadResult.code, 0, broadResult.stderr);
    const broadPayload = JSON.parse(broadResult.stdout);
    assert.deepEqual(broadPayload.failedTests, ["runtime::one", "semantic::two"]);
    assert.match(broadPayload.warnings.join("\n"), /2 tests failed/);
  });
});

test("promote-gate dry-runs and appends measurement gate metadata", async () => {
  await withTempDir("promote-gate", async (dir) => {
    await setupFixture(dir, { name: "gate", metricName: "score" });
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Baseline",
    ]);
    const dryRun = await runCli([
      "promote-gate",
      "--cwd",
      dir,
      "--reason",
      "move to 150 queries",
      "--query-count",
      "150",
      "--dry-run",
    ]);
    assert.equal(dryRun.code, 0, dryRun.stderr);
    const dryPayload = JSON.parse(dryRun.stdout);
    assert.equal(dryPayload.dryRun, true);
    assert.equal(dryPayload.entry.measurementGate.queryCount, 150);

    const confirmed = await runCli([
      "promote-gate",
      "--cwd",
      dir,
      "--reason",
      "move to 150 queries",
      "--gate-name",
      "150-query gate",
      "--query-count",
      "150",
      "--yes",
    ]);
    assert.equal(confirmed.code, 0, confirmed.stderr);
    const payload = JSON.parse(confirmed.stdout);
    assert.equal(payload.nextSegment, 1);
    assert.equal(payload.entry.measurementGate.name, "150-query gate");

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(JSON.parse(state.stdout).segment, 1);
  });
});

test("invalid iteration limits and negative extensions fail loudly", async () => {
  await withTempDir("invalid-iteration-limits", async (dir) => {
    const setup = await runCli([
      "setup",
      "--cwd",
      dir,
      "--name",
      "bad limit",
      "--metric-name",
      "seconds",
      "--max-iterations",
      "0",
    ]);
    assert.notEqual(setup.code, 0);
    assert.match(setup.stderr, /maxIterations must be a positive integer/);

    const fractionalSetup = await runCli([
      "setup",
      "--cwd",
      dir,
      "--name",
      "fractional limit",
      "--metric-name",
      "seconds",
      "--max-iterations",
      "1.5",
    ]);
    assert.notEqual(fractionalSetup.code, 0);
    assert.match(fractionalSetup.stderr, /maxIterations must be a positive integer/);

    await setupFixture(dir, { name: "config limit" });
    const config = await runCli(["config", "--cwd", dir, "--extend", "-1"]);
    assert.notEqual(config.code, 0);
    assert.match(config.stderr, /extend must be a non-negative integer/);

    const fractionalExtend = await runCli(["config", "--cwd", dir, "--extend", "1.5"]);
    assert.notEqual(fractionalExtend.code, 0);
    assert.match(fractionalExtend.stderr, /extend must be a non-negative integer/);
  });
});

test("config updates and clears guardrails and budgets", async () => {
  await withTempDir("config-clears-guardrails-budgets", async (dir) => {
    await setupFixture(dir, { name: "config clears" });

    const configured = await runCli([
      "config",
      "--cwd",
      dir,
      "--commit-paths",
      "src,tests",
      "--protected-benchmark-paths",
      "bench.mjs,fixtures",
      "--secondary-metric-constraints",
      "memory_mb <= baseline * 1.05",
      "--secondary-metric-constraint-mode",
      "blocking",
      "--packet-budget",
      "3",
      "--wall-clock-budget-seconds",
      "60",
      "--budget-note",
      "short cap",
    ]);
    assert.equal(configured.code, 0, configured.stderr);
    const configuredPayload = JSON.parse(configured.stdout);
    assert.deepEqual(configuredPayload.updates.commitPaths, ["src", "tests"]);
    assert.deepEqual(configuredPayload.updates.protectedBenchmarkPaths, ["bench.mjs", "fixtures"]);
    assert.equal(configuredPayload.updates.secondaryMetricConstraintMode, "blocking");
    assert.equal(configuredPayload.updates.secondaryMetricConstraints[0].mode, undefined);
    assert.equal(configuredPayload.updates.packetBudget, 3);
    assert.equal(configuredPayload.updates.wallClockBudgetSeconds, 60);
    assert.equal(configuredPayload.updates.budgetNote, "short cap");
    assert.match(configuredPayload.updates.budgetStartedAt, /^\d{4}-\d{2}-\d{2}T/);

    await new Promise((resolve) => setTimeout(resolve, 5));

    const resetBudget = await runCli([
      "config",
      "--cwd",
      dir,
      "--wall-clock-budget-seconds",
      "120",
    ]);
    assert.equal(resetBudget.code, 0, resetBudget.stderr);
    const resetPayload = JSON.parse(resetBudget.stdout);
    assert.equal(resetPayload.updates.wallClockBudgetSeconds, 120);
    assert.notEqual(
      resetPayload.updates.budgetStartedAt,
      configuredPayload.updates.budgetStartedAt,
    );

    await new Promise((resolve) => setTimeout(resolve, 5));

    const packetOnlyBudget = await runCli(["config", "--cwd", dir, "--packet-budget", "10"]);
    assert.equal(packetOnlyBudget.code, 0, packetOnlyBudget.stderr);
    const packetOnlyPayload = JSON.parse(packetOnlyBudget.stdout);
    assert.equal(packetOnlyPayload.updates.packetBudget, 10);
    assert.equal(packetOnlyPayload.updates.budgetStartedAt, undefined);
    const packetOnlyConfigFile = JSON.parse(
      await readFile(path.join(dir, "autoresearch.config.json"), "utf8"),
    );
    assert.equal(packetOnlyConfigFile.budgetStartedAt, resetPayload.updates.budgetStartedAt);

    const missingPacketBudget = await runCli(["config", "--cwd", dir, "--packet-budget"]);
    assert.notEqual(missingPacketBudget.code, 0);
    assert.match(missingPacketBudget.stderr, /packet-budget.*argument missing/i);

    const missingWallClockBudget = await runCli([
      "config",
      "--cwd",
      dir,
      "--wall-clock-budget-seconds",
    ]);
    assert.notEqual(missingWallClockBudget.code, 0);
    assert.match(missingWallClockBudget.stderr, /wall-clock-budget-seconds.*argument missing/i);

    const cleared = await runCli([
      "config",
      "--cwd",
      dir,
      "--commit-paths",
      "",
      "--protected-benchmark-paths",
      "",
      "--secondary-metric-constraints",
      "",
      "--packet-budget",
      "",
      "--wall-clock-budget-seconds",
      "",
      "--budget-note",
      "",
    ]);
    assert.equal(cleared.code, 0, cleared.stderr);
    const clearedPayload = JSON.parse(cleared.stdout);
    assert.deepEqual(clearedPayload.updates.commitPaths, []);
    assert.deepEqual(clearedPayload.updates.protectedBenchmarkPaths, []);
    assert.deepEqual(clearedPayload.updates.secondaryMetricConstraints, []);
    assert.equal(clearedPayload.updates.packetBudget, null);
    assert.equal(clearedPayload.updates.wallClockBudgetSeconds, null);
    assert.equal(clearedPayload.updates.budgetNote, "");
    assert.equal(clearedPayload.updates.budgetStartedAt, null);

    const configFile = JSON.parse(
      await readFile(path.join(dir, "autoresearch.config.json"), "utf8"),
    );
    assert.deepEqual(configFile.commitPaths, []);
    assert.deepEqual(configFile.protectedBenchmarkPaths, []);
    assert.deepEqual(configFile.secondaryMetricConstraints, []);
    assert.equal(configFile.packetBudget, null);
    assert.equal(configFile.wallClockBudgetSeconds, null);
    assert.equal(configFile.budgetNote, "");
    assert.equal(configFile.budgetStartedAt, null);
  });
});

test("log accepts ASI from a JSON file", async () => {
  await withTempDir("asi-file", async (dir) => {
    await setupFixture(dir, { name: "asi file" });
    await writeFile(
      path.join(dir, "asi.json"),
      JSON.stringify({
        hypothesis: "avoid shell quoting",
        evidence: "file parsed",
        next_action_hint: "continue",
      }),
      "utf8",
    );

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "3",
      "--status",
      "keep",
      "--description",
      "Baseline",
      "--asi-file",
      "asi.json",
    ]);
    assert.equal(result.code, 0, result.stderr);

    const ledger = (await readFile(path.join(dir, "autoresearch.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const run = ledger.find((entry) => entry.run === 1);
    assert.equal(run.asi.hypothesis, "avoid shell quoting");
    assert.equal(run.asi.evidence, "file parsed");
  });
});

test("log accepts ASI from --asi-json-file for PowerShell-safe logging", async () => {
  await withTempDir("asi-json-file", async (dir) => {
    await setupFixture(dir, { name: "asi json file" });
    await writeFile(
      path.join(dir, "asi.json"),
      JSON.stringify(
        {
          hypothesis: "avoid powershell quoting",
          evidence: 'file parsed with "quotes"',
          next_action_hint: "continue",
          windowsPath: "C:\\tmp\\asi.json",
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "3",
      "--status",
      "keep",
      "--description",
      "Baseline",
      "--asi-json-file",
      "asi.json",
    ]);
    assert.equal(result.code, 0, result.stderr);

    const ledger = (await readFile(path.join(dir, "autoresearch.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const run = ledger.find((entry) => entry.run === 1);
    assert.equal(run.asi.hypothesis, "avoid powershell quoting");
    assert.equal(run.asi.evidence, 'file parsed with "quotes"');
    assert.equal(run.asi.windowsPath, "C:\\tmp\\asi.json");

    const conflict = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "4",
      "--status",
      "keep",
      "--description",
      "Conflict",
      "--asi-json-file",
      "asi.json",
      "--asi",
      "{}",
    ]);
    assert.notEqual(conflict.code, 0);
    assert.match(conflict.stderr, /Use either --asi or --asi-json-file/);
  });
});

test("broad discard cleanup preserves deep research scratchpads", async () => {
  await withTempDir("preserve-research", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli([
      "research-setup",
      "--cwd",
      dir,
      "--slug",
      "study",
      "--goal",
      "Preserve research",
    ]);
    await writeFile(path.join(dir, "tracked.txt"), "experiment\n", "utf8");
    const gapsPath = path.join(dir, "autoresearch.research", "study", "quality-gaps.md");
    const dashboardPath = path.join(dir, "autoresearch-dashboard.html");
    const evidencePath = path.join(dir, "target", "autoresearch", "evidence.json");
    const cachePath = path.join(dir, ".autoresearch-cache", "packet.json");
    await writeFile(gapsPath, "- [ ] Preserve this scratchpad\n", "utf8");
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, '{"kept":true}\n', "utf8");
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, '{"cached":true}\n', "utf8");
    await writeFile(dashboardPath, "<!doctype html><title>Autoresearch</title>\n", "utf8");

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "discard",
      "--description",
      "Discard broad change",
      "--allow-dirty-revert",
    ]);
    assert.equal(result.code, 0, result.stderr);

    assert.equal(await readFile(path.join(dir, "tracked.txt"), "utf8"), "base\n");
    assert.equal(await readFile(gapsPath, "utf8"), "- [ ] Preserve this scratchpad\n");
    assert.equal(
      await readFile(dashboardPath, "utf8"),
      "<!doctype html><title>Autoresearch</title>\n",
    );
    assert.equal(await readFile(evidencePath, "utf8"), '{"kept":true}\n');
    assert.equal(await readFile(cachePath, "utf8"), '{"cached":true}\n');
  });
});

test("CLI parser accepts equals-form options", async () => {
  await withTempDir("equals-options", async (dir) => {
    const init = await setupFixture(dir, { name: "equals options" });
    assert.equal(init.code, 0, init.stderr);
    const state = await runCli(["state", `--cwd=${dir}`, "--json-full"]);
    assert.equal(state.code, 0, state.stderr);
    assert.equal(JSON.parse(state.stdout).config.metricName, "seconds");
  });
});

test("tool schemas expose guidance and output contracts", async () => {
  const [
    { toolSchemas },
    { validateToolContracts },
    {
      actionPolicyForTool,
      cliCommandForTool,
      toolMutates,
      toolNameForCliCommand,
      validateToolRegistry,
    },
  ] = await Promise.all([
    import("../../lib/tool-schemas.js"),
    import("../../lib/tool-contracts.js"),
    import("../../lib/tool-registry.js"),
  ]);
  const contractCheck = validateToolContracts(toolSchemas);
  assert.equal(contractCheck.ok, true, contractCheck.issues.join("\n"));
  const registryCheck = validateToolRegistry(toolSchemas);
  assert.equal(registryCheck.ok, true, JSON.stringify(registryCheck));

  const guided = toolSchemas.find((tool) => tool.name === "guided_setup");
  const run = toolSchemas.find((tool) => tool.name === "run_experiment");
  const next = toolSchemas.find((tool) => tool.name === "next_experiment");
  const doctor = toolSchemas.find((tool) => tool.name === "doctor_session");
  const benchmarkInspect = toolSchemas.find((tool) => tool.name === "benchmark_inspect");
  const benchmarkLint = toolSchemas.find((tool) => tool.name === "benchmark_lint");
  const checksInspect = toolSchemas.find((tool) => tool.name === "checks_inspect");
  const researchFanout = toolSchemas.find((tool) => tool.name === "research_fanout");
  const serve = toolSchemas.find((tool) => tool.name === "serve_dashboard");
  const readState = toolSchemas.find((tool) => tool.name === "read_state");
  const onboardingPacket = toolSchemas.find((tool) => tool.name === "onboarding_packet");
  const recommendNext = toolSchemas.find((tool) => tool.name === "recommend_next");
  const goalBridge = toolSchemas.find((tool) => tool.name === "codex_goal_bridge");
  const configureSession = toolSchemas.find((tool) => tool.name === "configure_session");
  const ledgerDoctor = toolSchemas.find((tool) => tool.name === "ledger_doctor");
  const startResearch = toolSchemas.find((tool) => tool.name === "start_research_loop");

  assert.ok(guided);
  assert.ok(run);
  assert.ok(benchmarkInspect);
  assert.ok(benchmarkLint);
  assert.ok(researchFanout);
  assert.ok(checksInspect);
  assert.ok(serve);
  assert.ok(readState);
  assert.ok(onboardingPacket);
  assert.ok(recommendNext);
  assert.ok(goalBridge);
  assert.ok(configureSession);
  assert.ok(ledgerDoctor);
  assert.ok(startResearch);
  assert.match(guided.description, /guided first-run or resume packet/);
  assert.equal(guided.outputSchema.type, "object");
  assert.equal(next.outputSchema.type, "object");
  assert.match(next.description, /preflight readout and benchmark/);
  assert.match(serve.description, /local live dashboard/);
  assert.equal(
    doctor.annotations.safety,
    "Read-only by default; mutating or process-starting options are explicit and session-locked.",
  );
  assert.equal(
    guided.annotations.safety,
    "Read-only by default; process-starting options are explicit and do not mutate or lock session state.",
  );
  assert.equal(guided.annotations.readOnlyHint, false);
  assert.equal(researchFanout.annotations.readOnlyHint, false);
  assert.equal(researchFanout.annotations.openWorldHint, false);
  assert.equal(guided.annotations.openWorldHint, true);
  assert.equal(startResearch.annotations.openWorldHint, true);
  assert.equal(next.annotations.readOnlyHint, false);
  assert.equal(next.annotations.openWorldHint, true);

  const richDoctor = toolSchemas.find((tool) => tool.name === "doctor_session");
  assert.equal(richDoctor.outputSchema.type, "object");
  assert.equal(guided.outputSchema.properties.workDir.type, "string");
  assert.equal(guided.inputSchema.properties.start_dashboard.type, "boolean");
  assert.equal(guided.inputSchema.properties.port.type, "number");
  assert.equal(configureSession.inputSchema.properties.clear_packet_budget.type, "boolean");
  assert.equal(configureSession.inputSchema.properties.clear_wall_clock_budget.type, "boolean");
  assert.equal(run.inputSchema.properties.allow_fixed_control_rerun.type, "boolean");
  assert.equal(next.inputSchema.properties.allow_fixed_control_rerun.type, "boolean");
  assert.equal(doctor.inputSchema.properties.allow_fixed_control_rerun.type, "boolean");
  assert.equal(benchmarkInspect.inputSchema.properties.allow_fixed_control_rerun.type, "boolean");
  assert.equal(benchmarkLint.inputSchema.properties.allow_fixed_control_rerun.type, "boolean");
  assert.equal(readState.inputSchema.properties.report.type, "boolean");
  assert.equal(readState.outputSchema.properties.report.type, "object");
  assert.equal(ledgerDoctor.inputSchema.properties.repair.type, "boolean");
  assert.equal(ledgerDoctor.inputSchema.properties.yes.type, "boolean");
  assert.equal(ledgerDoctor.outputSchema.properties.ledgerHealth.type, "object");
  assert.equal(ledgerDoctor.outputSchema.properties.backupPath.type, "string");
  assert.equal(readState.outputSchema.properties.dashboardHealth.type, "object");
  assert.equal(onboardingPacket.inputSchema.properties.operator_checklist, undefined);
  assert.equal(recommendNext.inputSchema.properties.operator_checklist.type, "boolean");
  assert.deepEqual(recommendNext.outputSchema.properties.action.type, ["string", "object"]);
  assert.deepEqual(recommendNext.outputSchema.properties.commands.type, ["array", "object"]);
  assert.equal(recommendNext.outputSchema.properties.laneLifecycle.type, "object");
  assert.equal(recommendNext.outputSchema.properties.packetDiagnostics.type, "object");
  assert.equal(guided.outputSchema.properties.commands.type, "object");
  assert.equal(goalBridge.outputSchema.properties.commands.type, "object");
  assert.equal(configureSession.outputSchema.properties.updates.type, "object");
  assert.equal(startResearch.outputSchema.properties.commands.type, "object");
  assert.equal(guided.outputSchema.properties.dashboard.type, "object");
  assert.equal(next.outputSchema.properties.parsedMetrics, undefined);
  assert.equal(next.outputSchema.properties.decision.type, "object");
  for (const field of [
    "continuation",
    "decision",
    "fullPacket",
    "history",
    "lastRunPath",
    "nextAction",
    "ok",
    "packetEvidence",
    "report",
    "run",
    "workDir",
  ]) {
    assert.ok(next.outputSchema.properties[field], `next schema should include ${field}`);
  }
  assert.equal(next.outputSchema.properties.code.type, "string");
  assert.equal(next.outputSchema.properties.loopContract.type, "object");
  assert.equal(next.outputSchema.properties.nextAction.type, "string");
  assert.equal(next.outputSchema.properties.clearingCondition.type, "string");
  assert.equal(next.outputSchema.properties.commandHint.type, "string");
  assert.equal(richDoctor.outputSchema.properties.state.type, "object");
  assert.equal(richDoctor.outputSchema.properties.git.type, "object");
  assert.equal(richDoctor.outputSchema.properties.benchmark.type, "object");
  assert.equal(richDoctor.outputSchema.properties.resolvedDecision.type, "object");
  assert.equal(richDoctor.outputSchema.properties.runtimeProvenance.type, "object");
  assert.equal(richDoctor.outputSchema.properties.decisionEnvelope, undefined);
  assert.equal(richDoctor.outputSchema.properties.sessionDecisionCapsule.type, "object");
  assert.equal(richDoctor.outputSchema.properties.scaffoldHealth.type, "object");
  assert.equal(richDoctor.outputSchema.properties.researchIntegrity.type, "object");
  assert.equal(richDoctor.outputSchema.properties.nextAction.type, "string");
  assert.equal(richDoctor.outputSchema.properties.continuation.type, "object");
  assert.equal(richDoctor.outputSchema.properties.explanation.type, "object");
  assert.equal(richDoctor.outputSchema.properties.issues.type, "array");
  assert.equal(richDoctor.outputSchema.properties.issues.items.type, "string");
  assert.equal(richDoctor.outputSchema.properties.warningDetails.type, "array");
  assert.equal(richDoctor.outputSchema.properties.warningDetails.items.type, "object");
  const qualityGap = toolSchemas.find((tool) => tool.name === "measure_quality_gap");
  assert.equal(qualityGap.outputSchema.properties.open.type, "number");
  assert.equal(qualityGap.outputSchema.properties.openItems.items.type, "string");
  for (const tool of toolSchemas) {
    for (const [field, schema] of Object.entries(tool.outputSchema.properties || {})) {
      assert.ok(schema.type, `${tool.name}.${field} should expose a concrete output type`);
      if (schema.type === "array") assert.ok(schema.items, `${tool.name}.${field} needs items`);
    }
  }
  assert.equal(
    richDoctor.annotations.safety,
    "Read-only by default; mutating or process-starting options are explicit and session-locked.",
  );
  assert.equal(richDoctor.annotations.readOnlyHint, false);
  assert.equal(richDoctor.annotations.openWorldHint, true);
  assert.match(
    String(richDoctor.annotations.unsafeCommandGate),
    /Tool-call custom command fields require allow_unsafe_command=true/,
  );
  for (const gatedToolName of [
    "setup_plan",
    "prompt_plan",
    "setup_session",
    "setup_research_session",
    "promote_gate",
  ]) {
    const gatedTool = toolSchemas.find((tool) => tool.name === gatedToolName);
    assert.match(
      String(gatedTool?.annotations.unsafeCommandGate),
      /Tool-call custom command fields require allow_unsafe_command=true/,
      `${gatedToolName} should advertise the same unsafe command gate it enforces`,
    );
  }
  assert.equal(cliCommandForTool("next_experiment"), "next");
  assert.equal(cliCommandForTool("research_fanout"), "research-fanout");
  assert.equal(cliCommandForTool("checks_inspect"), "checks-inspect");
  assert.equal(cliCommandForTool("ledger_doctor"), "ledger-doctor");
  assert.equal(toolNameForCliCommand("next"), "next_experiment");
  assert.equal(toolNameForCliCommand("research-fanout"), "research_fanout");
  assert.equal(toolNameForCliCommand("checks-inspect"), "checks_inspect");
  assert.equal(toolNameForCliCommand("ledger-doctor"), "ledger_doctor");
  assert.equal(toolMutates("next_experiment"), true);
  assert.equal(toolMutates("research_fanout"), false);
  assert.equal(actionPolicyForTool("research_fanout"), "read");
  assert.equal(actionPolicyForTool("research_fanout", { yes: true }), "state_mutation");
  assert.equal(toolMutates("ledger_doctor"), false);
  assert.equal(actionPolicyForTool("ledger_doctor"), "read");
  assert.equal(actionPolicyForTool("ledger_doctor", { repair: true, yes: true }), "artifact_write");
  assert.equal(toolMutates("read_state"), false);
});

test("table output types match representative runtime command maps", async () => {
  await withTempDir("tool-output-types", async (dir) => {
    await setupFixture(dir, { name: "tool output types" });
    const { toolSchemas } = await import("../../lib/tool-schemas.js");
    const guidedResult = await runCli(["guide", "--cwd", dir, "--compact"]);
    const configuredResult = await runCli(["config", "--cwd", dir, "--packet-budget", "2"]);
    assert.equal(guidedResult.code, 0, guidedResult.stderr);
    assert.equal(configuredResult.code, 0, configuredResult.stderr);

    const guidedPayload = JSON.parse(guidedResult.stdout);
    const configuredPayload = JSON.parse(configuredResult.stdout);
    const guidedSchema = toolSchemas.find((tool) => tool.name === "guided_setup");
    const configuredSchema = toolSchemas.find((tool) => tool.name === "configure_session");
    assert.ok(guidedSchema);
    assert.ok(configuredSchema);
    assert.equal(Array.isArray(guidedPayload.commands), false);
    assert.equal(typeof guidedPayload.commands, guidedSchema.outputSchema.properties.commands.type);
    assert.equal(Array.isArray(configuredPayload.updates), false);
    assert.equal(
      typeof configuredPayload.updates,
      configuredSchema.outputSchema.properties.updates.type,
    );
  });
});

test("CLI and tool argument normalization share runtime contracts", async () => {
  const {
    normalizeCliCommandArguments,
    normalizeRuntimeToolArguments,
    normalizeToolArguments,
    requireUnsafeCommandGate,
    validateToolArguments,
  } = await import("../../lib/tool-schemas.js");

  const toolArgs = validateToolArguments("setup_plan", {
    workingDir: "C:/repo",
    recipe: "node-test-runtime",
    metricName: "seconds",
    benchmarkCommand: "node bench.js",
    commitPaths: ["src"],
    allowUnsafeCommand: true,
  });
  assert.deepEqual(toolArgs, {
    working_dir: "C:/repo",
    recipe_id: "node-test-runtime",
    metric_name: "seconds",
    benchmark_command: "node bench.js",
    commit_paths: ["src"],
    allow_unsafe_command: true,
  });
  assert.deepEqual(normalizeRuntimeToolArguments("setup_plan", toolArgs), {
    cwd: "C:/repo",
    recipeId: "node-test-runtime",
    metricName: "seconds",
    benchmarkCommand: "node bench.js",
    commitPaths: ["src"],
    allow_unsafe_command: true,
  });
  const runArgs = validateToolArguments("run_experiment", {
    workingDir: "C:/repo",
    allowFixedControlRerun: true,
  });
  assert.deepEqual(runArgs, {
    working_dir: "C:/repo",
    allow_fixed_control_rerun: true,
  });
  assert.deepEqual(normalizeRuntimeToolArguments("run_experiment", runArgs), {
    cwd: "C:/repo",
    allowFixedControlRerun: true,
  });
  const nextArgs = validateToolArguments("next_experiment", {
    workingDir: "C:/repo",
    allowFixedControlRerun: true,
  });
  assert.deepEqual(nextArgs, {
    working_dir: "C:/repo",
    allow_fixed_control_rerun: true,
  });
  assert.deepEqual(normalizeRuntimeToolArguments("next_experiment", nextArgs), {
    cwd: "C:/repo",
    allowFixedControlRerun: true,
  });
  const doctorArgs = validateToolArguments("doctor_session", {
    workingDir: "C:/repo",
    allowFixedControlRerun: true,
    packetEnvMode: "inherit",
    revalidateCatalog: true,
  });
  assert.deepEqual(doctorArgs, {
    working_dir: "C:/repo",
    allow_fixed_control_rerun: true,
    packet_env_mode: "inherit",
    revalidate_catalog: true,
  });
  assert.deepEqual(normalizeRuntimeToolArguments("doctor_session", doctorArgs), {
    cwd: "C:/repo",
    allowFixedControlRerun: true,
    packetEnvMode: "inherit",
    revalidateCatalog: true,
  });
  const ledgerDoctorArgs = validateToolArguments("ledger_doctor", {
    workingDir: "C:/repo",
    json: true,
    repair: true,
    yes: true,
  });
  assert.deepEqual(ledgerDoctorArgs, {
    working_dir: "C:/repo",
    json: true,
    repair: true,
    yes: true,
  });
  assert.deepEqual(normalizeRuntimeToolArguments("ledger_doctor", ledgerDoctorArgs), {
    cwd: "C:/repo",
    json: true,
    repair: true,
    yes: true,
  });
  const benchmarkLintArgs = validateToolArguments("benchmark_lint", {
    workingDir: "C:/repo",
    allowFixedControlRerun: true,
  });
  assert.deepEqual(benchmarkLintArgs, {
    working_dir: "C:/repo",
    allow_fixed_control_rerun: true,
  });
  assert.deepEqual(normalizeRuntimeToolArguments("benchmark_lint", benchmarkLintArgs), {
    cwd: "C:/repo",
    allowFixedControlRerun: true,
  });
  const benchmarkInspectArgs = validateToolArguments("benchmark_inspect", {
    workingDir: "C:/repo",
    allowFixedControlRerun: true,
  });
  assert.deepEqual(benchmarkInspectArgs, {
    working_dir: "C:/repo",
    allow_fixed_control_rerun: true,
  });
  assert.deepEqual(normalizeRuntimeToolArguments("benchmark_inspect", benchmarkInspectArgs), {
    cwd: "C:/repo",
    allowFixedControlRerun: true,
  });
  assert.deepEqual(
    normalizeCliCommandArguments("setup-plan", {
      cwd: "C:/repo",
      recipe: "node-test-runtime",
      metricName: "seconds",
      benchmarkCommand: "node bench.js",
      commitPaths: ["src"],
    }),
    {
      cwd: "C:/repo",
      recipeId: "node-test-runtime",
      metricName: "seconds",
      benchmarkCommand: "node bench.js",
      commitPaths: ["src"],
    },
  );
  const setupSessionArgs = validateToolArguments("setup_session", {
    workingDir: "C:/repo",
    recipeId: "external-speed",
    catalog: "recipes.json",
    trustCatalog: true,
    allowUnsafeCommand: true,
  });
  assert.equal(setupSessionArgs.trust_catalog, true);
  assert.deepEqual(normalizeRuntimeToolArguments("setup_session", setupSessionArgs), {
    cwd: "C:/repo",
    recipeId: "external-speed",
    catalog: "recipes.json",
    trustCatalog: true,
    allow_unsafe_command: true,
  });
  const logArgs = validateToolArguments("log_experiment", {
    workingDir: "C:/repo",
    status: "keep",
    description: "ASI file",
    asiJsonFile: "asi.json",
  });
  assert.equal(logArgs.asi_json_file, "asi.json");
  assert.deepEqual(normalizeRuntimeToolArguments("log_experiment", logArgs), {
    cwd: "C:/repo",
    status: "keep",
    description: "ASI file",
    asiJsonFile: "asi.json",
  });
  const promptPlanArgs = validateToolArguments("prompt_plan", {
    workingDir: "C:/repo",
    prompt: "Optimize the external recipe.",
    recipeId: "external-speed",
    catalog: "recipes.json",
    trustCatalog: true,
    allowUnsafeCommand: true,
  });
  assert.equal(promptPlanArgs.trust_catalog, true);
  assert.deepEqual(normalizeRuntimeToolArguments("prompt_plan", promptPlanArgs), {
    cwd: "C:/repo",
    prompt: "Optimize the external recipe.",
    recipeId: "external-speed",
    catalog: "recipes.json",
    trustCatalog: true,
    allow_unsafe_command: true,
  });
  assert.throws(
    () => requireUnsafeCommandGate("setup_session", { catalog: "recipes.json" }),
    /allow_unsafe_command=true/,
  );
  assert.throws(
    () =>
      validateToolArguments("benchmark_lint", {
        workingDir: "C:/repo",
        command: "node bench.js",
      }),
    /allow_unsafe_command=true/,
  );
  assert.throws(
    () =>
      validateToolArguments("gap_candidates", {
        workingDir: "C:/repo",
        researchSlug: "study",
        modelCommand: "node model.js",
      }),
    /allow_unsafe_command=true/,
  );
  assert.throws(
    () =>
      validateToolArguments("lane_runner", {
        workingDir: "C:/repo",
        laneId: "read-only-scout",
        mode: "read_only_scout",
        command: "git status --short",
      }),
    /allow_unsafe_command=true/,
  );
  assert.doesNotThrow(() =>
    requireUnsafeCommandGate("prompt_plan", {
      catalog: "recipes.json",
      allow_unsafe_command: true,
    }),
  );
  assert.equal(normalizeToolArguments("clear_session", { yes: true }).confirm, true);

  const configArgs = validateToolArguments("configure_session", {
    workingDir: "C:/repo",
    clearPacketBudget: true,
    clearWallClockBudget: true,
  });
  assert.deepEqual(configArgs, {
    working_dir: "C:/repo",
    clear_packet_budget: true,
    clear_wall_clock_budget: true,
  });
  assert.deepEqual(normalizeRuntimeToolArguments("configure_session", configArgs), {
    cwd: "C:/repo",
    clearPacketBudget: true,
    clearWallClockBudget: true,
  });

  const laneRunnerArgs = validateToolArguments("lane_runner", {
    workingDir: "C:/repo",
    laneId: "read-only-scout",
    mode: "read_only_scout",
    command: "git status --short",
    allowUnsafeCommand: true,
    yes: true,
  });
  assert.deepEqual(normalizeRuntimeToolArguments("lane_runner", laneRunnerArgs), {
    cwd: "C:/repo",
    laneId: "read-only-scout",
    mode: "read_only_scout",
    command: "git status --short",
    allow_unsafe_command: true,
    yes: true,
  });

  const forensicsArgs = validateToolArguments("session_forensics", {
    workingDir: "C:/repo",
    sessionJsonl: "rollout.jsonl",
    researchSlug: "study",
    apply: true,
    allowSnippets: true,
    allowOutsideWorkdir: true,
    maxSnippets: 3,
    maxSnippetChars: 120,
    jsonFull: true,
    verbose: true,
  });
  assert.deepEqual(normalizeRuntimeToolArguments("session_forensics", forensicsArgs), {
    cwd: "C:/repo",
    sessionJsonl: "rollout.jsonl",
    researchSlug: "study",
    apply: true,
    allowSnippets: true,
    allowOutsideWorkdir: true,
    maxSnippets: 3,
    maxSnippetChars: 120,
    jsonFull: true,
    verbose: true,
  });

  const partialResultsArgs = validateToolArguments("partial_results", {
    workingDir: "C:/repo",
    fromLast: true,
    record: "rows=out/rows.json",
    description: "Salvage rows",
  });
  assert.deepEqual(normalizeRuntimeToolArguments("partial_results", partialResultsArgs), {
    cwd: "C:/repo",
    fromLast: true,
    record: "rows=out/rows.json",
    description: "Salvage rows",
  });

  const goalBridgeArgs = validateToolArguments("codex_goal_bridge", {
    workingDir: "C:/repo",
    codexGoalObjective: "Close the loop",
    codexGoalStatus: "active",
  });
  assert.deepEqual(normalizeRuntimeToolArguments("codex_goal_bridge", goalBridgeArgs), {
    cwd: "C:/repo",
    codexGoalObjective: "Close the loop",
    codexGoalStatus: "active",
  });
});

test("log rejects conflicting metrics inputs and invalid evidence status", async () => {
  await withTempDir("log-contract-edges", async (dir) => {
    await setupFixture(dir, { name: "log contract" });
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1')"`;
    const packet = await runCli(["next", "--cwd", dir, "--command", command]);
    assert.equal(packet.code, 0, packet.stderr);

    const metricsConflict = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "conflict",
      "--metrics",
      '{"seconds":1}',
      "--metrics-file",
      "metrics.json",
    ]);
    assert.notEqual(metricsConflict.code, 0);
    assert.match(metricsConflict.stderr, /either --metrics or --metrics-file/i);

    const invalidEvidence = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "bad evidence",
      "--evidence-status",
      "mystery",
    ]);
    assert.notEqual(invalidEvidence.code, 0);
    assert.match(invalidEvidence.stderr, /evidence-status/i);
  });
});

test("plugin manifest does not declare an MCP server", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
  );
  const pkg = JSON.parse(await readFile(path.join(pluginRoot, "package.json"), "utf8"));

  assert.equal(manifest.mcpServers, undefined);
  assert.equal(pkg.files.includes(".mcp.json"), false);
  await assert.rejects(access(path.join(pluginRoot, ".mcp.json")));
  await assert.rejects(access(path.join(pluginRoot, "scripts", "autoresearch-mcp.mjs")));
});

test("compatibility commands fail before mutation with exact migrations", async () => {
  await withTempDir("compatibility-migrations", async (dir) => {
    const initialized = await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "compatibility",
      "--metric-name",
      "seconds",
    ]);
    assert.equal(initialized.code, 1, initialized.stderr);
    assert.match(
      initialized.stderr,
      /init is a compatibility command scheduled for removal after 2026-10-01; migrate to setup/,
    );
    await assert.rejects(access(path.join(dir, "autoresearch.jsonl")));

    const marker = path.join(dir, "legacy-run-executed.txt");
    const command = `${quoteForShell(process.execPath)} -e ${quoteForShell(
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`,
    )}`;
    const ran = await runCli(["run", "--cwd", dir, "--command", command]);
    assert.equal(ran.code, 1, ran.stderr);
    assert.match(
      ran.stderr,
      /run is a compatibility command scheduled for removal after 2026-10-01; migrate measured packets to next/,
    );
    await assert.rejects(access(marker));

    const integrations = await runCli(["integrations", "list"]);
    assert.equal(integrations.code, 1, integrations.stderr);
    assert.match(
      integrations.stderr,
      /integrations is a compatibility command scheduled for removal after 2026-10-01; migrate catalog discovery and validation to recipes list\/show --catalog/,
    );
  });
});

test("metric names must match the METRIC parser grammar", async () => {
  await withTempDir("bad-metric-name", async (dir) => {
    const result = await runCli([
      "setup",
      "--cwd",
      dir,
      "--name",
      "bad metric",
      "--metric-name",
      "bad metric",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Metric name/);
  });
});
