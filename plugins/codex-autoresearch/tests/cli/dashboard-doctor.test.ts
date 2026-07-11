import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { redactCommandDisplay } from "../../lib/evidence-redaction.js";
import { dashboardCommandSafety } from "../../lib/dashboard-command-safety.js";
import { PLUGIN_VERSION } from "../../lib/plugin-version.js";
import { isolatedRuntimeEnv, writeInstalledRuntimeFixture } from "../helpers/cli-session.js";
import { quoteForShell } from "../helpers/process.js";

import { pluginRoot, runCli, withTempDir } from "../helpers/cli-test-context.js";

test("next command suggests measure for a first baseline decision packet", async () => {
  await withTempDir("next-command", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "next command", "--metric-name", "seconds"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=2')"`;
    const result = await runCli(["next", "--cwd", dir, "--command", command]);
    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.doctor.ok, true);
    assert.equal(payload.run.parsedPrimary, 2);
    assert.equal(payload.run.progress.mode, "synchronous");
    assert.equal(payload.run.progress.status, "completed");
    assert.equal(payload.run.progress.cancellable, false);
    assert.equal(payload.run.progress.cancelStatus, "not_requested");
    assert.equal(payload.run.progress.stages[0].stage, "benchmark");
    assert.equal(payload.run.progress.stages[0].status, "completed");
    assert.match(payload.run.progress.latestOutputTail, /METRIC seconds=2/);
    assert.deepEqual(payload.decision.allowedStatuses, ["keep", "discard", "measure"]);
    assert.equal(payload.decision.rawSuggestedStatus, "measure");
    assert.equal(payload.decision.suggestedStatus, "measure");
    assert.equal(payload.decision.safeSuggestedStatus, "measure");
    assert.match(payload.decision.statusGuidance, /without a prior improvement comparison/);
    assert.ok(Array.isArray(payload.decision.lanePortfolio));
    assert.equal(payload.decision.diversityGuidance, null);
    assert.match(payload.nextAction, /Log this run as measure/);
  });
});

test("dashboard renders an operator readout from ASI and failures", async () => {
  await withTempDir("dashboard-readout", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "dashboard readout",
      "--metric-name",
      "seconds",
      "--metric-unit",
      "s",
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "10",
      "--status",
      "keep",
      "--description",
      "Baseline",
      "--asi",
      JSON.stringify({
        hypothesis: "baseline",
        family: "baseline",
        lane: "incumbent-confirmation",
        next_action_hint: "try caching",
      }),
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "7",
      "--status",
      "keep",
      "--description",
      "Cache package metadata",
      "--asi",
      JSON.stringify({
        hypothesis: "metadata cache removes repeated filesystem scans",
        family: "metadata cache",
        lane: "near-neighbor",
        evidence: "seconds improved from 10 to 7",
        next_action_hint: "measure memory impact next",
      }),
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "12",
      "--status",
      "discard",
      "--description",
      "Inline all parsing",
      "--asi",
      JSON.stringify({
        family: "parser inlining",
        lane: "near-neighbor",
        rollback_reason: "slower and harder to read",
        next_action_hint: "avoid parser inlining",
      }),
    ]);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.ok(statePayload.memory.families.length >= 2);
    assert.equal(typeof statePayload.memory.plateau.detected, "boolean");
    assert.equal(typeof statePayload.memory.novelty.score, "number");
    assert.ok(statePayload.memory.lanePortfolio.some((lane) => lane.id === "measurement-quality"));
    assert.ok(statePayload.memory.diversityGuidance);
    const generatedCommands = statePayload.commands.map((item) => item.command).join("\n");
    assert.ok(statePayload.commands.some((item) => item.label === "State"));
    assert.ok(statePayload.commands.some((item) => item.label === "Quality gap"));
    assert.doesNotMatch(
      generatedCommands.replace(/\\/g, "/"),
      /autoresearch\.mjs\s+(?:serve|export|benchmark-lint)\b/i,
    );
    assert.doesNotMatch(generatedCommands, /--check-benchmark\b/i);
    for (const item of statePayload.commands) {
      assert.equal(dashboardCommandSafety(item.command).safe, true, item.command);
    }

    const exportResult = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const payload = JSON.parse(exportResult.stdout);
    const dashboard = await readFile(path.join(dir, "autoresearch-dashboard.html"), "utf8");

    assert.match(dashboard, /Codex brief/);
    assert.match(dashboard, /Best kept change/);
    assert.match(dashboard, /Recent failure/);
    assert.match(dashboard, /Next action/);
    assert.match(dashboard, /Parallel exploration board/);
    assert.match(dashboard, /lower is better/);
    assert.ok(payload.viewModel.nextBestAction.detail);
    assert.ok(payload.viewModel.nextBestAction.explanation.why);
    assert.ok(payload.viewModel.nextBestAction.explanation.avoids);
    assert.ok(payload.viewModel.nextBestAction.explanation.proof);
    assert.ok(
      payload.viewModel.nextBestAction.command || payload.viewModel.nextBestAction.safeAction,
    );
    assert.match(payload.viewModel.aiSummary.happened.join(" "), /runs/);
    assert.match(
      payload.viewModel.aiSummary.plan.join(" "),
      /avoid parser inlining|comparison anchor/i,
    );
    assert.equal(payload.viewModel.experimentMemory.latestNextAction, "avoid parser inlining");
    assert.equal(payload.viewModel.portfolio.families.length > 0, true);
    assert.equal(
      payload.viewModel.portfolio.lanes.some((lane) => lane.id === "measurement-quality"),
      true,
    );
    assert.equal(typeof payload.viewModel.portfolio.plateau.detected, "boolean");
    assert.equal(payload.progress.mode, "synchronous");
    assert.equal(payload.progress.status, "completed");
    assert.equal(payload.progress.stages[0].stage, "export");
  });
});

test("dashboard does not recommend next when manual metrics have no benchmark command", async () => {
  await withTempDir("dashboard-manual-no-command", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "manual metrics", "--metric-name", "seconds"]);
    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "5",
      "--status",
      "keep",
      "--description",
      "Manual baseline",
    ]);
    assert.equal(log.code, 0, log.stderr);

    const exportResult = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const payload = JSON.parse(exportResult.stdout);

    assert.equal(payload.viewModel.guidedSetup.stage, "needs-benchmark-command");
    assert.equal(payload.viewModel.setup.defaultBenchmarkCommandReady, false);
    assert.equal(payload.viewModel.nextBestAction.kind, "benchmark-command");
    assert.match(payload.viewModel.nextBestAction.title, /benchmark command/i);
    assert.doesNotMatch(payload.viewModel.nextBestAction.title, /next measured/i);
  });
});

test("dashboard surfaces stale last-run packets before normal next guidance", async () => {
  await withTempDir("dashboard-stale-last-run", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "stale dashboard", "--metric-name", "seconds"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);
    const directLog = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "2",
      "--status",
      "keep",
      "--description",
      "Manual run",
    ]);
    assert.equal(directLog.code, 0, directLog.stderr);

    const exportResult = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const payload = JSON.parse(exportResult.stdout);

    assert.equal(payload.viewModel.guidedSetup.stage, "stale-last-run");
    assert.equal(payload.viewModel.lastRun.freshness.fresh, false);
    assert.equal(payload.viewModel.nextBestAction.kind, "stale-packet");
    assert.equal(payload.viewModel.guidedSetup.commands, undefined);
    assert.doesNotMatch(
      String(payload.viewModel.nextBestAction.command || ""),
      /(?:^|\s)next(?:\s|$)/,
    );
    assert.equal(payload.viewModel.missionControl.logDecision.commandsByStatus, undefined);
    assert.equal(payload.viewModel.missionControl.logDecision.liveAction, undefined);
    assert.match(payload.viewModel.nextBestAction.detail, /Last-run packet is stale/);
    assert.match(payload.viewModel.readout.nextAction, /Last-run packet is stale/);
  });
});

test("doctor summarizes readiness and detects missing benchmark metrics", async () => {
  await withTempDir("doctor", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "doctor", "--metric-name", "seconds"]);

    const command = `${quoteForShell(process.execPath)} -e "console.log('no metric')"`;
    const result = await runCli([
      "doctor",
      "--cwd",
      dir,
      "--command",
      command,
      "--check-benchmark",
    ]);
    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.benchmark.checked, true);
    assert.equal(payload.benchmark.emitsPrimary, false);
    assert.equal(payload.benchmark.progress.mode, "synchronous");
    assert.equal(payload.benchmark.progress.status, "failed");
    assert.equal(payload.benchmark.progress.cancellable, false);
    assert.equal(payload.benchmark.progress.stages[0].stage, "benchmark");
    assert.doesNotMatch(payload.preflight.blockers.join("\n"), /No benchmark command/i);
    assert.match(payload.issues.join("\n"), /primary metric/);
    assert.match(payload.nextAction, /benchmark/i);
  });
});

test("doctor and next report missing future benchmark commands for manual sessions", async () => {
  await withTempDir("manual-metric-missing-benchmark-command", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "manual doctor", "--metric-name", "seconds"]);
    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "5",
      "--status",
      "keep",
      "--description",
      "Manual baseline",
    ]);
    assert.equal(log.code, 0, log.stderr);

    const doctor = await runCli(["doctor", "--cwd", dir, "--check-benchmark", "--explain"]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctorPayload = JSON.parse(doctor.stdout);
    assert.equal(doctorPayload.ok, false);
    assert.equal(doctorPayload.benchmark.checked, true);
    assert.equal(doctorPayload.benchmark.command, "");
    assert.match(doctorPayload.benchmark.metricError, /No benchmark command/i);
    assert.match(doctorPayload.issues.join("\n"), /No benchmark command/i);
    assert.equal(doctorPayload.preflight.status, "blocked");
    assert.match(doctorPayload.preflight.blockers.join("\n"), /future packets/i);
    assert.equal(doctorPayload.explanation.preflight.status, "blocked");

    const next = await runCli(["next", "--cwd", dir, "--compact"]);
    assert.equal(next.code, 0, next.stderr);
    const nextPayload = JSON.parse(next.stdout);
    assert.equal(nextPayload.ok, false);
    assert.equal(nextPayload.run, null);
    assert.equal(nextPayload.decision, null);
    assert.match(nextPayload.doctor.issues.join("\n"), /No benchmark command/i);
    assert.match(nextPayload.nextAction, /benchmark/i);
  });
});

test("doctor explain exposes runtime drift summary and next diagnostic command", async () => {
  await withTempDir("doctor-runtime-drift-summary", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "doctor drift", "--metric-name", "seconds"]);

    const result = await runCli(["doctor", "--cwd", dir, "--explain"]);
    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.runtimeDriftSummary.sourceVersion, PLUGIN_VERSION);
    assert.equal(payload.runtimeDriftSummary.packageRoot, pluginRoot);
    assert.match(payload.runtimeDriftSummary.smokeCheck, /autoresearch\.mjs|npm run build:node/);
    assert.match(payload.runtimeDriftSummary.nextActionHint, /runtime|smoke check/i);
    assert.deepEqual(payload.explanation.runtimeDriftSummary, {
      installedRuntime: payload.runtimeDriftSummary.installedRuntime,
      builtRuntime: payload.runtimeDriftSummary.builtRuntime,
      smokeCheck: payload.runtimeDriftSummary.smokeCheck,
      nextActionHint: payload.runtimeDriftSummary.nextActionHint,
    });
  });
});

test("doctor --check-installed blocks non-fresh installed runtime before packet guidance", async () => {
  await withTempDir("doctor-check-installed-runtime-authority", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "installed doctor", "--metric-name", "seconds"]);

    for (const status of ["stale", "missing", "unavailable"]) {
      await withTempDir(`runtime-cache-${status}`, async (homeDir) => {
        await writeInstalledRuntimeFixture(homeDir, status);

        const result = await runCli(["doctor", "--cwd", dir, "--check-installed", "--explain"], {
          env: isolatedRuntimeEnv(homeDir),
        });
        assert.equal(result.code, 0, result.stderr);

        const payload = JSON.parse(result.stdout);
        assert.equal(payload.ok, false, status);
        assert.equal(payload.runtimeAuthority.trustScope, "installed-plugin", status);
        assert.equal(payload.runtimeAuthority.blocking, true, status);
        assert.equal(payload.runtimeAuthority.installedRuntime.status, status);
        assert.equal(payload.canonicalNextAction.kind, "runtime-authority", status);
        assert.equal(payload.canonicalNextAction.safeAction, "doctor", status);
        assert.equal(payload.canonicalNextAction.toolName, "doctor", status);
        assert.match(payload.canonicalNextAction.command || "", /\bdoctor\b/, status);
        assert.match(payload.canonicalNextAction.command || "", /--explain\b/, status);
        assert.doesNotMatch(
          payload.canonicalNextAction.command || "",
          /(?:^|\s)next(?:\s|$)/,
          status,
        );
        assert.match(
          payload.issues.join("\n"),
          new RegExp(`${status} installed plugin runtime`, "i"),
        );
        assert.match(payload.nextAction, /installed.*runtime/i);
        assert.match(payload.nextAction, /inspect|refresh/i);
        assert.doesNotMatch(payload.nextAction, /Run the next experiment|next measured packet/i);
        assert.match(payload.explanation.nextSafeAction, /installed.*runtime/i);
      });
    }
  });
});

test("state and doctor use checksCommand from config for gate quality", async () => {
  await withTempDir("config-checks-gate-quality", async (dir) => {
    const checksCommand = `${quoteForShell(process.execPath)} -e "process.exit(0)" check`;
    const displayedChecksCommand = redactCommandDisplay(checksCommand);
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify(
        {
          name: "config checks",
          goal: "prove configured checks are respected",
          metricName: "seconds",
          metricUnit: "seconds",
          bestDirection: "lower",
          benchmarkCommand: `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1')"`,
          checksCommand,
        },
        null,
        2,
      ),
    );
    await writeFile(path.join(dir, "autoresearch.jsonl"), "");

    const state = await runCli(["state", "--cwd", dir, "--json"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.gateQuality.posture, "correctness");
    assert.equal(statePayload.commandAuthority?.checksCommand, displayedChecksCommand);

    const doctor = await runCli(["doctor", "--cwd", dir, "--explain", "--json"]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctorPayload = JSON.parse(doctor.stdout);
    assert.equal(doctorPayload.gateQuality.posture, "correctness");
    assert.equal(doctorPayload.commandAuthority?.checksCommand, displayedChecksCommand);
    assert.doesNotMatch(JSON.stringify(doctorPayload.explanation), /No independent checks gate/i);
  });
});

test("setup state and doctor expose gate quality and preflight readiness", async () => {
  await withTempDir("gate-quality-preflight", async (dir) => {
    const benchmarkCommand = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1')"`;
    const setupPlanResult = await runCli([
      "setup-plan",
      "--cwd",
      dir,
      "--name",
      "gate preflight",
      "--metric-name",
      "seconds",
      "--benchmark-command",
      benchmarkCommand,
    ]);
    assert.equal(setupPlanResult.code, 0, setupPlanResult.stderr);
    const setupPlanPayload = JSON.parse(setupPlanResult.stdout);
    assert.equal(setupPlanPayload.gateQuality.posture, "advisory-missing");
    assert.match(setupPlanPayload.preflight.status, /^(ready|blocked)$/);
    if (setupPlanPayload.preflight.status === "blocked") {
      assert.match(setupPlanPayload.preflight.blockers.join("\n"), /runtime|fingerprint/i);
    }
    assert.match(setupPlanPayload.preflight.nextCommand, /benchmark-lint|doctor/i);

    await runCli(["init", "--cwd", dir, "--name", "gate preflight", "--metric-name", "seconds"]);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.gateQuality.posture, "advisory-missing");
    assert.equal(statePayload.preflight.status, "blocked");
    assert.match(statePayload.preflight.blockers.join("\n"), /benchmark command/i);

    const compact = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(compact.code, 0, compact.stderr);
    const compactPayload = JSON.parse(compact.stdout);
    assert.equal(compactPayload.gateQuality.posture, "advisory-missing");
    assert.equal(compactPayload.preflight.status, "blocked");
    assert.match(compactPayload.preflight.blockers.join("\n"), /benchmark command/i);

    const doctor = await runCli(["doctor", "--cwd", dir, "--explain"]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctorPayload = JSON.parse(doctor.stdout);
    assert.equal(doctorPayload.ok, false);
    assert.equal(doctorPayload.gateQuality.posture, "advisory-missing");
    assert.equal(doctorPayload.preflight.status, "blocked");
    assert.match(doctorPayload.preflight.blockers.join("\n"), /benchmark command/i);
    assert.match(doctorPayload.issues.join("\n"), /benchmark command/i);
    assert.match(doctorPayload.nextAction, /benchmark/i);
    assert.doesNotMatch(doctorPayload.explanation.verdict, /no blocking/i);
    assert.equal(doctorPayload.explanation.preflight.status, "blocked");
  });
});

test("guide, dashboard, and recommend-next share canonical preflight blocker", async () => {
  await withTempDir("canonical-preflight-guide", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "canonical preflight",
      "--metric-name",
      "seconds",
    ]);

    const guide = await runCli(["guide", "--cwd", dir]);
    assert.equal(guide.code, 0, guide.stderr);
    const guidePayload = JSON.parse(guide.stdout);

    const exportResult = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const dashboardPayload = JSON.parse(exportResult.stdout);
    const dashboardAction = dashboardPayload.viewModel.nextBestAction;

    const recommend = await runCli(["recommend-next", "--cwd", dir]);
    assert.equal(recommend.code, 0, recommend.stderr);
    const recommendPayload = JSON.parse(recommend.stdout);

    assert.equal(guidePayload.stage, "preflight");
    assert.equal(dashboardAction.kind, "preflight");
    assert.equal(recommendPayload.action.kind, "preflight");
    assert.equal(guidePayload.nextStep.nextAction.title, "Resolve preflight");
    assert.equal(
      recommendPayload.nextStep.nextAction.title,
      guidePayload.nextStep.nextAction.title,
    );
    assert.match(guidePayload.nextAction, /benchmark command/i);
    assert.match(dashboardAction.detail, /benchmark command/i);
    assert.match(recommendPayload.nextAction, /benchmark command/i);
  });
});

test("recommend-next compact operator checklist uses bounded recovery for empty sessions", async () => {
  await withTempDir("compact-empty-recovery", async (dir) => {
    const recommend = await runCli([
      "recommend-next",
      "--cwd",
      dir,
      "--compact",
      "--operator-checklist",
    ]);
    assert.equal(recommend.code, 0, recommend.stderr);
    const payload = JSON.parse(recommend.stdout);
    const command = payload.operatorChecklist.command || "";

    assert.equal(payload.action.kind, "setup");
    assert.equal(payload.decisionEnvelope.canonicalNextAction.kind, "setup");
    assert.equal(payload.loopContract.blockers[0].kind, "setup");
    assert.equal(payload.loopContract.canRunNextPacket, false);
    assert.match(payload.nextAction, /setup/i);
    assert.match(payload.operatorChecklist.blocker, /setup/i);
    assert.match(command, /autoresearch\.mjs\b.*\b(setup-plan|state)\b/);
    assert.match(command, /--cwd\b/);
    assert.doesNotMatch(command, /\bdoctor\b.*--explain\b/);
    assert.doesNotMatch(payload.commands.primary || "", /\bdoctor\b.*--explain\b/);
  });
});

test("state and recommend-next suppress portfolio guidance while benchmark setup is blocked", async () => {
  await withTempDir("portfolio-guidance", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "portfolio", "--metric-name", "seconds"]);

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.portfolioRecommendation, null);
    assert.equal(statePayload.decisionEnvelope.canonicalNextAction.kind, "preflight");
    assert.equal(statePayload.decisionEnvelope.loopContract.blockers[0].kind, "preflight");
    assert.equal(statePayload.canRunNextPacket, false);

    const recommend = await runCli(["recommend-next", "--cwd", dir, "--compact"]);
    assert.equal(recommend.code, 0, recommend.stderr);
    const recommendPayload = JSON.parse(recommend.stdout);
    assert.equal(recommendPayload.portfolioRecommendation, null);
    assert.equal(recommendPayload.decisionEnvelope.canonicalNextAction.kind, "preflight");
    assert.equal(recommendPayload.loopContract.blockers[0].kind, "preflight");
  });
});

test("drift report treats installed routing as removed", async () => {
  const { buildDriftReport } = await import("../../lib/drift-doctor.js");
  const report = await buildDriftReport({
    pluginRoot,
    includeInstalled: true,
    inspectInstalled: async () => ({
      ok: true,
      available: false,
      pluginName: "codex-autoresearch",
      confidence: "not-applicable",
    }),
  });

  assert.equal(report.ok, true);
  assert.equal(report.local.version, PLUGIN_VERSION);
  assert.equal(report.local.surfaces.cliRuntime, PLUGIN_VERSION);
  assert.equal(report.installed.available, false);
  assert.deepEqual(report.warnings, []);
});
