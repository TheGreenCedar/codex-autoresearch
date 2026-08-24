import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";

import { quoteForShell } from "../helpers/process.js";
import { runCli, setupFixture, withTempDir } from "../helpers/cli-test-context.js";

const SHARED_FIELDS = [
  "decisionId",
  "phase",
  "primaryBlockerCode",
  "parentDisposition",
  "contractDigest",
  "evaluatorIdentity",
] as const;

test("state, doctor, recommend-next, finalization, report, and dashboard project one plan", async () => {
  await withTempDir("canonical-decision-surfaces", async (dir) => {
    await mkdir(`${dir}/src`, { recursive: true });
    const benchmark = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const checks = `${quoteForShell(process.execPath)} -e "process.exit(0)"`;
    const setup = await runCli([
      "setup",
      "--cwd",
      dir,
      "--name",
      "canonical plan",
      "--metric-name",
      "seconds",
      "--benchmark-command",
      benchmark,
      "--checks-command",
      checks,
      "--scope",
      "src",
      "--packet-budget",
      "4",
      "--max-iterations",
      "4",
    ]);
    assert.equal(setup.code, 0, setup.stderr);

    const outputs = await Promise.all([
      runCli(["state", "--cwd", dir, "--compact"]),
      runCli(["doctor", "--cwd", dir]),
      runCli(["recommend-next", "--cwd", dir, "--compact"]),
      runCli(["finalize-preview", "--cwd", dir]),
      runCli(["state", "--cwd", dir, "--report"]),
      runCli(["export", "--cwd", dir, "--json-full"]),
    ]);
    for (const output of outputs) assert.equal(output.code, 0, output.stderr);
    const [state, doctor, recommend, finalization, report, dashboard] = outputs.map((output) =>
      JSON.parse(output.stdout),
    );
    const plans = [
      state.decisionPlanProjection,
      doctor.decisionPlanProjection,
      recommend.decisionPlanProjection,
      finalization.decisionPlanProjection,
      report.report.json.decisionPlanProjection,
      dashboard.viewModel.decisionPlanProjection,
    ];
    for (const [index, plan] of plans.entries()) {
      assert.equal(
        plan?.kind,
        index === plans.length - 1
          ? "dashboard-decision-plan-projection"
          : "decision-plan-projection",
        `surface ${index}`,
      );
    }
    for (const field of SHARED_FIELDS) {
      assert.deepEqual(
        plans.map((plan) => plan[field]),
        Array(plans.length).fill(plans[0][field]),
        field,
      );
    }
    assert.deepEqual(
      plans.map((plan) => plan.action.kind),
      Array(plans.length).fill(plans[0].action.kind),
    );
    assert.equal(dashboard.viewModel.decisionPlanProjection.action.command, "");
    assert.equal(
      dashboard.viewModel.decisionPlanProjection.action.commandDigest,
      state.decisionPlanProjection.action.commandDigest,
    );
  });
});

test("fresh packet surfaces select only an accepted log disposition", async () => {
  const cases = [
    {
      name: "baseline",
      benchmark: `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`,
      checks: `${quoteForShell(process.execPath)} -e "process.exit(0)"`,
      expectedStatus: "measure",
    },
    {
      name: "evaluator-crash",
      benchmark: `${quoteForShell(process.execPath)} -e "process.exit(3)"`,
      checks: `${quoteForShell(process.execPath)} -e "process.exit(0)"`,
      expectedStatus: "crash",
    },
    {
      name: "accepted-check-failure",
      benchmark: `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`,
      checks: `${quoteForShell(process.execPath)} -e "process.exit(2)"`,
      expectedStatus: "checks_failed",
    },
  ] as const;

  for (const fixture of cases) {
    await withTempDir(`canonical-packet-${fixture.name}`, async (dir) => {
      const setup = await setupFixture(dir, {
        acceptedContract: true,
        benchmarkCommand: fixture.benchmark,
        checksCommand: fixture.checks,
        metricName: "seconds",
        name: fixture.name,
        packetBudget: 4,
        scope: "src",
      });
      assert.equal(setup.code, 0, setup.stderr);
      const packet = await runCli(["next", "--cwd", dir]);
      assert.equal(packet.code, 0, packet.stderr);

      const outputs = await Promise.all([
        runCli(["state", "--cwd", dir, "--compact"]),
        runCli(["doctor", "--cwd", dir]),
        runCli(["recommend-next", "--cwd", dir, "--compact"]),
        runCli(["export", "--cwd", dir, "--json-full"]),
      ]);
      for (const output of outputs) assert.equal(output.code, 0, output.stderr);
      const [state, doctor, recommend, dashboard] = outputs.map((output) =>
        JSON.parse(output.stdout),
      );
      const plans = [
        state.decisionPlanProjection,
        doctor.decisionPlanProjection,
        recommend.decisionPlanProjection,
      ];
      for (const plan of plans) {
        assert.equal(plan.action.kind, "log-decision", fixture.name);
        assert.match(
          plan.action.command,
          new RegExp(`--status ${fixture.expectedStatus}\\b`),
          fixture.name,
        );
        assert.equal(plan.capabilities["authorize-keep"], "blocked", fixture.name);
      }
      assert.deepEqual(
        plans.map((plan) => plan.decisionId),
        Array(plans.length).fill(plans[0].decisionId),
      );
      assert.equal(dashboard.viewModel.decisionPlanProjection.decisionId, plans[0].decisionId);
      assert.equal(dashboard.viewModel.decisionPlanProjection.action.command, "");
      assert.equal(
        dashboard.viewModel.decisionPlanProjection.action.commandDigest,
        plans[0].action.commandDigest,
      );

      const logged = await runCli([
        "log",
        "--cwd",
        dir,
        "--from-last",
        "--status",
        fixture.expectedStatus,
        "--description",
        `${fixture.name} evidence`,
      ]);
      assert.equal(logged.code, 0, logged.stderr);
    });
  }
});
