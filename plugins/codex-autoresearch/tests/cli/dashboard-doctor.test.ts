import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { redactCommandDisplay } from "../../lib/evidence-redaction.js";
import { dashboardCommandSafety } from "../../lib/dashboard-command-safety.js";
import { PLUGIN_VERSION } from "../../lib/plugin-version.js";
import type { UnknownRecord } from "../../lib/types/json.js";
import { isolatedRuntimeEnv, writeInstalledRuntimeFixture } from "../helpers/cli-session.js";
import { quoteForAcceptedShell } from "../helpers/process.js";

import { pluginRoot, runCli, withTempDir, setupFixture } from "../helpers/cli-test-context.js";

function projectedPlan(payload: UnknownRecord): UnknownRecord {
  return (payload.decisionPlanProjection || payload.decisionPlan) as UnknownRecord;
}

function capabilityStatus(plan: UnknownRecord, capability: string): string {
  const capabilities = plan.capabilities as UnknownRecord;
  const value = capabilities[capability];
  return typeof value === "string" ? value : String((value as UnknownRecord).status || "");
}

function requiredEvidenceCodes(plan: UnknownRecord): string[] {
  const requiredEvidence = plan.requiredEvidence as UnknownRecord;
  return Array.isArray(requiredEvidence.diagnosticCodes)
    ? requiredEvidence.diagnosticCodes.map(String)
    : [];
}

function acceptedCheckIdentities(plan: UnknownRecord): string[] {
  const requiredEvidence = plan.requiredEvidence as UnknownRecord;
  return Array.isArray(requiredEvidence.acceptedCheckIdentities)
    ? requiredEvidence.acceptedCheckIdentities.map(String)
    : [];
}

test("next command suggests measure for a first baseline decision packet", async () => {
  await withTempDir("next-command", async (dir) => {
    const command = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=2')"`;
    const setup = await setupFixture(dir, {
      name: "next command",
      acceptedContract: true,
      benchmarkCommand: command,
    });
    assert.equal(setup.code, 0, setup.stderr);
    const result = await runCli(["next", "--cwd", dir]);
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
    assert.deepEqual(payload.decision.allowedStatuses, ["discard", "measure"]);
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
    const sourceDir = path.join(dir, "src");
    const metricPath = path.join(sourceDir, "metric.txt");
    const evaluatorPath = path.join(dir, "dashboard-evaluator.mjs");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(metricPath, "10\n");
    await writeFile(
      evaluatorPath,
      [
        'import { readFileSync } from "node:fs";',
        'const metric = readFileSync("src/metric.txt", "utf8").trim();',
        "console.log(`METRIC seconds=${metric}`);",
      ].join("\n"),
    );
    const benchmarkCommand = `${quoteForAcceptedShell(process.execPath)} ${quoteForAcceptedShell(evaluatorPath)}`;
    const setup = await setupFixture(dir, {
      name: "dashboard readout",
      metricUnit: "s",
      acceptedContract: true,
      benchmarkCommand,
    });
    assert.equal(setup.code, 0, setup.stderr);

    const baselinePacket = await runCli(["next", "--cwd", dir]);
    assert.equal(baselinePacket.code, 0, baselinePacket.stderr);
    const baseline = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "measure",
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
    assert.equal(baseline.code, 0, baseline.stderr);

    await writeFile(metricPath, "7\n");
    const measuredPacket = await runCli(["next", "--cwd", dir]);
    assert.equal(measuredPacket.code, 0, measuredPacket.stderr);
    const measured = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "measure",
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
    assert.equal(measured.code, 0, measured.stderr);

    await writeFile(metricPath, "12\n");
    const discardedPacket = await runCli(["next", "--cwd", dir]);
    assert.equal(discardedPacket.code, 0, discardedPacket.stderr);
    const discarded = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
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
    assert.equal(discarded.code, 0, discarded.stderr);

    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    const statePlan = projectedPlan(statePayload);
    assert.ok(statePayload.memory.families.length >= 2);
    assert.equal(typeof statePayload.memory.plateau.detected, "boolean");
    assert.equal(typeof statePayload.memory.novelty.score, "number");
    assert.ok(statePayload.memory.lanePortfolio.some((lane) => lane.id === "measurement-quality"));
    assert.ok(statePayload.memory.diversityGuidance);
    const commandItems = Object.values(statePayload.commands).filter(
      (item): item is UnknownRecord =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item),
    );
    const commandStrings = commandItems.map((item) => String(item.command || "")).filter(Boolean);
    const generatedCommands = commandStrings.join("\n");
    assert.ok(commandItems.some((item) => item.label === "State"));
    assert.ok(commandItems.some((item) => item.label === "Quality gap"));
    assert.doesNotMatch(
      generatedCommands.replace(/\\/g, "/"),
      /autoresearch\.mjs\s+(?:serve|export|benchmark-lint)\b/i,
    );
    assert.doesNotMatch(generatedCommands, /--check-benchmark\b/i);
    for (const commandText of commandStrings) {
      assert.equal(dashboardCommandSafety(commandText).safe, true, commandText);
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
    const dashboardPlan = projectedPlan(payload.viewModel);
    const dashboardAction = dashboardPlan.action as UnknownRecord;
    assert.equal(dashboardPlan.kind, "dashboard-decision-plan-projection");
    assert.equal(dashboardPlan.decisionId, statePlan.decisionId);
    assert.equal(dashboardPlan.phase, statePlan.phase);
    assert.equal(dashboardPlan.primaryBlockerCode, statePlan.primaryBlockerCode);
    assert.equal(
      (dashboardPlan.parentDisposition as UnknownRecord).kind,
      (statePlan.parentDisposition as UnknownRecord).kind,
    );
    assert.equal(dashboardPlan.contractDigest, statePlan.contractDigest);
    assert.equal(dashboardPlan.evaluatorIdentity, statePlan.evaluatorIdentity);
    assert.match(String(dashboardPlan.contractDigest), /^[a-f0-9]{64}$/);
    assert.match(String(dashboardPlan.evaluatorIdentity), /^primary@[a-f0-9]{64}$/);
    assert.ok(acceptedCheckIdentities(dashboardPlan).length > 0);
    assert.equal((dashboardAction as UnknownRecord).kind, "pause-packets");
    assert.equal(dashboardPlan.primaryBlockerCode, "no-learning-pause");
    assert.equal(capabilityStatus(dashboardPlan, "run-packet"), "blocked");
    assert.equal(capabilityStatus(dashboardPlan, "authorize-keep"), "allowed");
    assert.equal(capabilityStatus(dashboardPlan, "transition-segment"), "allowed");
    assert.equal(capabilityStatus(dashboardPlan, "finalize"), "blocked");
    assert.equal((dashboardPlan.loopDisposition as UnknownRecord).kind, "pause");
    assert.equal((dashboardPlan.parentDisposition as UnknownRecord).kind, "hand-back");
    assert.ok(requiredEvidenceCodes(dashboardPlan).includes("no-learning-pause"));
    assert.ok(requiredEvidenceCodes(dashboardPlan).includes("finalization-blocked"));
    assert.equal(dashboardPlan.outcome, "regressed");
    assert.equal((dashboardPlan.learning as UnknownRecord).kind, "none");
    assert.equal((dashboardPlan.learning as UnknownRecord).consecutiveNoLearningCandidates, 2);
    assert.equal(dashboardAction.command, "");
    assert.equal(dashboardAction.commandDigest, (statePlan.action as UnknownRecord).commandDigest);
    assert.equal(payload.viewModel.nextBestAction.command || "", "");
    assert.equal(payload.viewModel.nextBestAction.safeAction || "", "");
    assert.match(payload.viewModel.aiSummary.happened.join(" "), /runs/);
    assert.match(payload.viewModel.aiSummary.plan.join(" "), /slower and harder to read/i);
    assert.match(payload.viewModel.aiSummary.plan.join(" "), /no learning pause/i);
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

test("dashboard routes an incomplete manual session to accepted-contract setup", async () => {
  await withTempDir("dashboard-manual-no-command", async (dir) => {
    await setupFixture(dir, { name: "manual metrics" });
    const rejectedKeep = await runCli([
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
    assert.notEqual(rejectedKeep.code, 0);
    const rejection = JSON.parse(rejectedKeep.stderr);
    assert.equal(rejection.code, "mutation-precondition-blocked");
    assert.equal(rejection.preconditionDecision.primaryBlockerCode, "setup-required");
    assert.equal(rejection.preconditionDecision.capabilities["authorize-keep"], "blocked");

    const exportResult = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const payload = JSON.parse(exportResult.stdout);
    const plan = projectedPlan(payload.viewModel);

    assert.equal(plan.kind, "dashboard-decision-plan-projection");
    assert.equal((plan.action as UnknownRecord).kind, "setup");
    assert.equal(plan.primaryBlockerCode, "setup-required");
    assert.equal(capabilityStatus(plan, "mutate-session"), "allowed");
    assert.equal(capabilityStatus(plan, "run-packet"), "blocked");
    assert.equal(capabilityStatus(plan, "authorize-keep"), "blocked");
    assert.equal((plan.parentDisposition as UnknownRecord).kind, "hand-back");
    assert.ok(requiredEvidenceCodes(plan).includes("setup-required"));
    assert.equal(payload.viewModel.setup.defaultBenchmarkCommandReady, false);
    assert.equal(payload.viewModel.nextBestAction.kind, "setup");
    assert.match(payload.viewModel.nextBestAction.title, /setup/i);
    assert.doesNotMatch(payload.viewModel.nextBestAction.title, /next measured/i);
  });
});

test("dashboard surfaces stale last-run packets before normal next guidance", async () => {
  await withTempDir("dashboard-stale-last-run", async (dir) => {
    const command = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const setup = await setupFixture(dir, {
      name: "stale dashboard",
      acceptedContract: true,
      benchmarkCommand: command,
    });
    assert.equal(setup.code, 0, setup.stderr);
    const next = await runCli(["next", "--cwd", dir]);
    assert.equal(next.code, 0, next.stderr);
    const packetPath = path.join(dir, "autoresearch.last-run.json");
    const capturedPacket = await readFile(packetPath);
    const acceptedLog = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "measure",
      "--description",
      "Accepted later run",
    ]);
    assert.equal(acceptedLog.code, 0, acceptedLog.stderr);
    await writeFile(packetPath, capturedPacket);

    const exportResult = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const payload = JSON.parse(exportResult.stdout);
    const plan = projectedPlan(payload.viewModel);

    assert.equal(plan.kind, "dashboard-decision-plan-projection");
    assert.equal((plan.action as UnknownRecord).kind, "replace-packet");
    assert.equal(plan.primaryBlockerCode, "stale-packet");
    assert.equal(capabilityStatus(plan, "run-packet"), "recovery-only");
    assert.equal(capabilityStatus(plan, "authorize-keep"), "allowed");
    assert.ok(requiredEvidenceCodes(plan).includes("stale-packet"));
    assert.ok(acceptedCheckIdentities(plan).length > 0);
    assert.match(String(plan.contractDigest), /^[a-f0-9]{64}$/);
    assert.match(String(plan.evaluatorIdentity), /^primary@[a-f0-9]{64}$/);
    assert.equal(payload.viewModel.lastRun.freshness.fresh, false);
    assert.equal(payload.viewModel.nextBestAction.kind, "replace-packet");
    assert.equal(payload.viewModel.guidedSetup.commands, undefined);
    assert.equal((plan.action as UnknownRecord).command, "");
    assert.match(String((plan.action as UnknownRecord).commandDigest), /^[a-f0-9]{64}$/);
    assert.equal(payload.viewModel.missionControl.logDecision.commandsByStatus, undefined);
    assert.equal(payload.viewModel.missionControl.logDecision.liveAction, undefined);
    assert.match(payload.viewModel.nextBestAction.detail, /stale/i);
  });
});

test("doctor summarizes readiness and detects missing benchmark metrics", async () => {
  await withTempDir("doctor", async (dir) => {
    const command = `${quoteForAcceptedShell(process.execPath)} -e "console.log('no metric')"`;
    await setupFixture(dir, {
      name: "doctor",
      acceptedContract: true,
      benchmarkCommand: command,
    });
    const ordinaryState = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(ordinaryState.code, 0, ordinaryState.stderr);
    const ordinaryPlan = projectedPlan(JSON.parse(ordinaryState.stdout));
    const result = await runCli(["doctor", "--cwd", dir, "--check-benchmark", "--json-full"]);
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
    const plan = projectedPlan(payload);
    assert.deepEqual(plan, ordinaryPlan);
    assert.equal((plan.action as UnknownRecord).kind, "run-baseline");
  });
});

test("doctor check-benchmark rejects a command outside the accepted evaluator", async () => {
  await withTempDir("doctor-accepted-evaluator-only", async (dir) => {
    const accepted = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=1')"`;
    const overrideSentinel = path.join(dir, "override-ran.txt");
    const override = `${quoteForAcceptedShell(process.execPath)} -e "require('node:fs').writeFileSync(process.argv[1], 'ran'); console.log('METRIC seconds=999')" ${quoteForAcceptedShell(overrideSentinel)}`;
    await setupFixture(dir, {
      name: "doctor accepted evaluator",
      acceptedContract: true,
      benchmarkCommand: accepted,
    });

    const result = await runCli([
      "doctor",
      "--cwd",
      dir,
      "--command",
      override,
      "--check-benchmark",
      "--json-full",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.benchmark.checked, true);
    assert.equal(payload.benchmark.exitCode, null);
    assert.deepEqual(payload.benchmark.parsedMetrics, {});
    assert.match(
      `${payload.benchmark.metricError}\n${payload.issues.join("\n")}`,
      /accepted.*evaluator|experiment contract|start a new segment/i,
    );
    await assert.rejects(readFile(overrideSentinel), /ENOENT/);

    const acceptedResult = await runCli([
      "doctor",
      "--cwd",
      dir,
      "--check-benchmark",
      "--json-full",
    ]);
    assert.equal(acceptedResult.code, 0, acceptedResult.stderr);
    const acceptedPayload = JSON.parse(acceptedResult.stdout);
    assert.equal(acceptedPayload.benchmark.parsedMetrics.seconds, 1);
    assert.equal(acceptedPayload.benchmark.emitsPrimary, true);
  });
});

test("doctor and recommend-next preserve setup authority for incomplete manual sessions", async () => {
  await withTempDir("manual-metric-missing-benchmark-command", async (dir) => {
    await setupFixture(dir, { name: "manual doctor" });
    const rejectedKeep = await runCli([
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
    assert.notEqual(rejectedKeep.code, 0);
    const rejection = JSON.parse(rejectedKeep.stderr);
    assert.equal(rejection.code, "mutation-precondition-blocked");
    assert.equal(rejection.preconditionDecision.primaryBlockerCode, "setup-required");
    assert.equal(rejection.preconditionDecision.capabilities["authorize-keep"], "blocked");

    const doctor = await runCli([
      "doctor",
      "--cwd",
      dir,
      "--check-benchmark",
      "--explain",
      "--json-full",
    ]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctorPayload = JSON.parse(doctor.stdout);
    assert.equal(doctorPayload.ok, false);
    assert.equal(doctorPayload.benchmark.checked, true);
    assert.equal(doctorPayload.benchmark.command, "");
    assert.match(doctorPayload.benchmark.metricError, /No benchmark command/i);
    assert.match(doctorPayload.issues.join("\n"), /No benchmark command/i);
    assert.equal(doctorPayload.preflight.status, "blocked");
    assert.equal(doctorPayload.explanation.preflight.status, "blocked");
    const doctorPlan = projectedPlan(doctorPayload);
    assert.equal((doctorPlan.action as UnknownRecord).kind, "setup");
    assert.equal(doctorPlan.primaryBlockerCode, "setup-required");
    assert.equal(capabilityStatus(doctorPlan, "run-packet"), "blocked");
    assert.equal(capabilityStatus(doctorPlan, "authorize-keep"), "blocked");
    assert.ok(requiredEvidenceCodes(doctorPlan).includes("setup-required"));
    assert.equal(doctorPlan.generationId, doctorPayload.preconditionDecision.generationId);
    assert.equal(doctorPlan.decisionId, doctorPayload.preconditionDecision.decisionId);
    assert.equal(doctorPlan.generationId, doctorPayload.resultingDecision.generationId);
    assert.equal(doctorPlan.decisionId, doctorPayload.resultingDecision.decisionId);

    const recommend = await runCli(["recommend-next", "--cwd", dir, "--compact"]);
    assert.equal(recommend.code, 0, recommend.stderr);
    const recommendPayload = JSON.parse(recommend.stdout);
    const recommendPlan = projectedPlan(recommendPayload);
    assert.equal((recommendPlan.action as UnknownRecord).kind, "setup");
    assert.equal(recommendPlan.primaryBlockerCode, "setup-required");
    assert.equal(capabilityStatus(recommendPlan, "run-packet"), "blocked");
    assert.equal(capabilityStatus(recommendPlan, "authorize-keep"), "blocked");
    assert.equal((recommendPlan.parentDisposition as UnknownRecord).kind, "hand-back");
    assert.ok(requiredEvidenceCodes(recommendPlan).includes("setup-required"));
    assert.match(recommendPayload.nextAction, /accepted experiment contract/i);
    assert.equal(recommendPlan.generationId, doctorPlan.generationId);
    assert.equal(recommendPlan.decisionId, doctorPlan.decisionId);
  });
});

test("doctor explain exposes runtime drift summary and next diagnostic command", async () => {
  await withTempDir("doctor-runtime-drift-summary", async (dir) => {
    await setupFixture(dir, { name: "doctor drift" });

    const result = await runCli(["doctor", "--cwd", dir, "--explain", "--json-full"]);
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
    const setup = await setupFixture(dir, {
      name: "installed doctor",
      acceptedContract: true,
    });
    assert.equal(setup.code, 0, setup.stderr);
    const ordinaryState = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(ordinaryState.code, 0, ordinaryState.stderr);
    const ordinaryPlan = projectedPlan(JSON.parse(ordinaryState.stdout));

    for (const status of ["stale", "missing", "unavailable"]) {
      await withTempDir(`runtime-cache-${status}`, async (homeDir) => {
        await writeInstalledRuntimeFixture(homeDir, status);

        const result = await runCli(
          ["doctor", "--cwd", dir, "--check-installed", "--explain", "--json-full"],
          {
            env: isolatedRuntimeEnv(homeDir),
          },
        );
        assert.equal(result.code, 0, result.stderr);

        const payload = JSON.parse(result.stdout);
        assert.equal(payload.ok, false, status);
        assert.equal(payload.runtimeAuthority.trustScope, "installed-plugin", status);
        assert.equal(payload.runtimeAuthority.blocking, true, status);
        assert.equal(payload.runtimeAuthority.installedRuntime.status, status);
        const plan = projectedPlan(payload);
        assert.deepEqual(plan, ordinaryPlan, status);
        const action = plan.action as UnknownRecord;
        assert.equal(action.kind, "run-baseline", status);
        assert.deepEqual(requiredEvidenceCodes(plan), requiredEvidenceCodes(ordinaryPlan), status);
        assert.ok(acceptedCheckIdentities(plan).length > 0, status);
        assert.match(
          payload.issues.join("\n"),
          new RegExp(`${status} installed plugin runtime`, "i"),
        );
        assert.match(payload.runtimeAuthority.blocker, /installed.*runtime/i);
        assert.match(payload.runtimeAuthority.blocker, /inspect|refresh/i);
        assert.match(payload.runtimeDriftSummary.nextActionHint, /runtime/i);
        assert.equal(payload.nextAction, payload.decisionPlan.action.reason, status);
        assert.equal(
          payload.explanation.nextSafeAction,
          payload.decisionPlan.action.reason,
          status,
        );
      });
    }
  });
});

test("state and doctor use checksCommand from config for gate quality", async () => {
  await withTempDir("config-checks-gate-quality", async (dir) => {
    const checksCommand = `${quoteForAcceptedShell(process.execPath)} -e "process.exit(0)" check`;
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
          benchmarkCommand: `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=1')"`,
          checksCommand,
        },
        null,
        2,
      ),
    );
    await writeFile(path.join(dir, "autoresearch.jsonl"), "");

    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.gateQuality.posture, "correctness");
    assert.equal(statePayload.commandAuthority?.checksCommand, displayedChecksCommand);

    const doctor = await runCli(["doctor", "--cwd", dir, "--explain", "--json-full"]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctorPayload = JSON.parse(doctor.stdout);
    assert.equal(doctorPayload.gateQuality.posture, "correctness");
    assert.equal(doctorPayload.commandAuthority?.checksCommand, displayedChecksCommand);
    assert.doesNotMatch(JSON.stringify(doctorPayload.explanation), /No independent checks gate/i);
  });
});

test("setup state and doctor expose gate quality and preflight readiness", async () => {
  await withTempDir("gate-quality-preflight", async (dir) => {
    const benchmarkCommand = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=1')"`;
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

    await setupFixture(dir, { name: "gate preflight" });

    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    const statePlan = projectedPlan(statePayload);
    assert.equal(statePayload.gateQuality.posture, "advisory-missing");
    assert.equal(statePayload.preflight.status, "blocked");
    assert.match(statePayload.preflight.blockers.join("\n"), /benchmark command/i);
    assert.equal((statePlan.action as UnknownRecord).kind, "setup");
    assert.equal(statePlan.primaryBlockerCode, "setup-required");
    assert.equal(capabilityStatus(statePlan, "run-packet"), "blocked");
    assert.equal(capabilityStatus(statePlan, "authorize-keep"), "blocked");
    assert.equal((statePlan.parentDisposition as UnknownRecord).kind, "hand-back");
    assert.ok(requiredEvidenceCodes(statePlan).includes("setup-required"));

    const compact = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(compact.code, 0, compact.stderr);
    const compactPayload = JSON.parse(compact.stdout);
    const compactPlan = projectedPlan(compactPayload);
    assert.equal(compactPayload.gateQuality.posture, "advisory-missing");
    assert.equal(compactPayload.preflight.status, "blocked");
    assert.match(compactPayload.preflight.blockers.join("\n"), /benchmark command/i);
    assert.equal(compactPlan.kind, "decision-plan-projection");
    assert.equal(compactPlan.decisionId, statePlan.decisionId);
    assert.equal((compactPlan.action as UnknownRecord).kind, "setup");
    assert.equal(capabilityStatus(compactPlan, "run-packet"), "blocked");
    assert.ok(requiredEvidenceCodes(compactPlan).includes("setup-required"));

    const doctor = await runCli(["doctor", "--cwd", dir, "--explain", "--json-full"]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctorPayload = JSON.parse(doctor.stdout);
    const doctorPlan = projectedPlan(doctorPayload);
    assert.equal(doctorPayload.ok, false);
    assert.equal(doctorPayload.gateQuality.posture, "advisory-missing");
    assert.equal(doctorPayload.preflight.status, "blocked");
    assert.match(doctorPayload.preflight.blockers.join("\n"), /benchmark command/i);
    assert.match(doctorPayload.issues.join("\n"), /benchmark command/i);
    assert.equal((doctorPlan.action as UnknownRecord).kind, "setup");
    assert.equal(doctorPlan.primaryBlockerCode, "setup-required");
    assert.equal(capabilityStatus(doctorPlan, "run-packet"), "blocked");
    assert.equal(capabilityStatus(doctorPlan, "authorize-keep"), "blocked");
    assert.match(doctorPayload.nextAction, /accepted experiment contract/i);
    assert.doesNotMatch(doctorPayload.explanation.verdict, /no blocking/i);
    assert.equal(doctorPayload.explanation.preflight.status, "blocked");
  });
});

test("guide, dashboard, and recommend-next share the canonical setup decision", async () => {
  await withTempDir("canonical-preflight-guide", async (dir) => {
    await setupFixture(dir, { name: "canonical preflight" });

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    const statePlan = projectedPlan(statePayload);

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
    const dashboardPlan = projectedPlan(dashboardPayload.viewModel);
    const recommendPlan = projectedPlan(recommendPayload);

    assert.equal(guidePayload.stage, "setup");
    assert.equal(dashboardAction.kind, "setup");
    assert.equal(recommendPayload.action.kind, "setup");
    for (const plan of [statePlan, dashboardPlan, recommendPlan]) {
      assert.equal((plan.action as UnknownRecord).kind, "setup");
      assert.equal(plan.primaryBlockerCode, "setup-required");
      assert.equal(capabilityStatus(plan, "run-packet"), "blocked");
      assert.equal(capabilityStatus(plan, "authorize-keep"), "blocked");
      assert.equal((plan.parentDisposition as UnknownRecord).kind, "hand-back");
      assert.ok(requiredEvidenceCodes(plan).includes("setup-required"));
    }
    assert.deepEqual(
      [statePlan.decisionId, dashboardPlan.decisionId, recommendPlan.decisionId],
      Array(3).fill(statePlan.decisionId),
    );
    assert.match(guidePayload.nextAction, /accepted experiment contract/i);
    assert.match(dashboardAction.detail, /accepted experiment contract/i);
    assert.match(recommendPayload.nextAction, /accepted experiment contract/i);
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
    const plan = projectedPlan(payload);

    assert.equal(payload.action.kind, "setup");
    assert.equal(plan.kind, "decision-plan-projection");
    assert.equal((plan.action as UnknownRecord).kind, "setup");
    assert.equal(plan.primaryBlockerCode, "setup-required");
    assert.equal(capabilityStatus(plan, "mutate-session"), "allowed");
    assert.equal(capabilityStatus(plan, "run-packet"), "blocked");
    assert.equal(capabilityStatus(plan, "authorize-keep"), "blocked");
    assert.equal((plan.loopDisposition as UnknownRecord).kind, "blocked");
    assert.equal((plan.loopDisposition as UnknownRecord).canRunPacket, false);
    assert.equal((plan.parentDisposition as UnknownRecord).kind, "hand-back");
    assert.ok(requiredEvidenceCodes(plan).includes("setup-required"));
    assert.match(payload.nextAction, /accepted experiment contract/i);
    assert.equal(payload.operatorChecklist.blocker, "setup-required");
    assert.match(command, /autoresearch\.mjs\b.*\b(setup-plan|state)\b/);
    assert.match(command, /--cwd\b/);
    assert.doesNotMatch(command, /\bdoctor\b.*--explain\b/);
    assert.doesNotMatch(payload.commands.primary || "", /\bdoctor\b.*--explain\b/);
  });
});

test("state and recommend-next suppress portfolio guidance while benchmark setup is blocked", async () => {
  await withTempDir("portfolio-guidance", async (dir) => {
    await setupFixture(dir, { name: "portfolio" });

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(Object.hasOwn(statePayload, "portfolioRecommendation"), false);
    const statePlan = projectedPlan(statePayload);
    assert.equal((statePlan.action as UnknownRecord).kind, "setup");
    assert.equal(statePlan.primaryBlockerCode, "setup-required");
    assert.equal(capabilityStatus(statePlan, "run-packet"), "blocked");
    assert.equal(capabilityStatus(statePlan, "authorize-keep"), "blocked");
    assert.equal((statePlan.loopDisposition as UnknownRecord).canRunPacket, false);
    assert.ok(requiredEvidenceCodes(statePlan).includes("setup-required"));

    const recommend = await runCli(["recommend-next", "--cwd", dir, "--compact"]);
    assert.equal(recommend.code, 0, recommend.stderr);
    const recommendPayload = JSON.parse(recommend.stdout);
    assert.equal(Object.hasOwn(recommendPayload, "portfolioRecommendation"), false);
    const recommendPlan = projectedPlan(recommendPayload);
    assert.equal(recommendPlan.decisionId, statePlan.decisionId);
    assert.equal((recommendPlan.action as UnknownRecord).kind, "setup");
    assert.equal(recommendPlan.primaryBlockerCode, "setup-required");
    assert.equal(capabilityStatus(recommendPlan, "run-packet"), "blocked");
    assert.equal(capabilityStatus(recommendPlan, "authorize-keep"), "blocked");
    assert.ok(requiredEvidenceCodes(recommendPlan).includes("setup-required"));
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
