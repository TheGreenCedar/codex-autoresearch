import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  prepareCurrentTreeFinalizationBlocker,
  writeDecisionCapsule,
} from "../helpers/git-fixtures.js";
import { quoteForAcceptedShell } from "../helpers/process.js";
import type { UnknownRecord } from "../../lib/types/json.js";

import { runCli, withTempDir, git, setupFixture } from "../helpers/cli-test-context.js";

function projectedPlan(payload: UnknownRecord): UnknownRecord {
  return (payload.decisionPlanProjection ||
    payload.decisionPlan ||
    payload.resultingDecision ||
    payload.preconditionDecision) as UnknownRecord;
}

function capabilityStatus(plan: UnknownRecord, capability: string): string {
  const capabilities = plan.capabilities as UnknownRecord;
  const value = capabilities[capability];
  return typeof value === "string" ? value : String((value as UnknownRecord).status || "");
}

function testIo(name: string, body: () => Promise<void>): void {
  test(name, { timeout: 240_000 }, body);
}

test("compact state, recommend-next, and onboarding-packet project one decision plan", async () => {
  await withTempDir("decision-envelope", async (dir) => {
    const command = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=1.5')"`;
    await setupFixture(dir, {
      name: "envelope",
      acceptedContract: true,
      benchmarkCommand: command,
    });

    const next = await runCli(["next", "--cwd", dir, "--compact"]);
    assert.equal(next.code, 0, next.stderr);
    const nextPayload = JSON.parse(next.stdout);
    assert.ok(nextPayload.decision.allowedStatuses.includes("measure"));

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    const statePlan = projectedPlan(statePayload);
    assert.equal((statePlan.action as UnknownRecord).kind, "log-decision");
    assert.equal(statePlan.primaryBlockerCode, "pending-packet");
    assert.equal(capabilityStatus(statePlan, "run-packet"), "blocked");
    assert.equal(capabilityStatus(statePlan, "mutate-session"), "allowed");
    assert.equal((statePlan.parentDisposition as UnknownRecord).kind, "hand-back");
    assert.equal(Object.hasOwn(statePayload, "decisionEnvelope"), false);
    assert.equal(Object.hasOwn(statePayload, "resumeAudit"), false);

    const recommend = await runCli(["recommend-next", "--cwd", dir, "--compact"]);
    assert.equal(recommend.code, 0, recommend.stderr);
    const recommendPayload = JSON.parse(recommend.stdout);
    const recommendPlan = projectedPlan(recommendPayload);
    assert.equal(recommendPlan.decisionId, statePlan.decisionId);
    assert.equal((recommendPlan.action as UnknownRecord).kind, "log-decision");

    const onboarding = await runCli(["onboarding-packet", "--cwd", dir, "--compact"]);
    assert.equal(onboarding.code, 0, onboarding.stderr);
    const onboardingPayload = JSON.parse(onboarding.stdout);
    const onboardingPlan = projectedPlan(onboardingPayload);
    assert.equal(onboardingPlan.decisionId, statePlan.decisionId);
    assert.equal((onboardingPlan.action as UnknownRecord).kind, "log-decision");
    assert.equal(Object.hasOwn(onboardingPayload, "decisionEnvelope"), false);
    assert.equal(Object.hasOwn(onboardingPayload, "resumeAudit"), false);
  });
});

test("canonical next action stays consistent across state, report, recommend-next, and dashboard", async () => {
  const benchmarkCommand = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
  const passingChecks = `${quoteForAcceptedShell(process.execPath)} -e "process.exit(0)"`;
  const failingChecks = `${quoteForAcceptedShell(process.execPath)} -e "process.exit(1)"`;
  const fixtures = [
    {
      name: "active-artifact",
      expectedAction: "log-decision",
      expectedBlocker: "pending-packet",
      commandPattern: /\blog\b/,
      runPacket: "blocked",
      absentBest: true,
      prepare: async (dir) => {
        const script = path.join(dir, "partial-packet.mjs");
        await writeFile(
          script,
          [
            "import { mkdirSync, writeFileSync } from 'node:fs';",
            "mkdirSync('out', { recursive: true });",
            "writeFileSync('out/rows.json', JSON.stringify({ schemaVersion: 1, metricName: 'seconds', formulaVersion: 'v1', rows: [{ seconds: 4.2 }] }));",
            "console.log('ARTIFACT rows=out/rows.json');",
            "process.exit(1);",
          ].join("\n"),
        );
        await setupFixture(dir, {
          name: "active artifact",
          acceptedContract: true,
          benchmarkCommand: `${quoteForAcceptedShell(process.execPath)} ${quoteForAcceptedShell(script)}`,
        });
        const packet = await runCli(["next", "--cwd", dir]);
        assert.equal(packet.code, 0, packet.stderr);
      },
    },
    {
      name: "stale-packet",
      expectedAction: "replace-packet",
      expectedBlocker: "stale-packet",
      commandPattern: /(?:^|\s)next(?:\s|$)/,
      runPacket: "recovery-only",
      absentBest: false,
      prepare: async (dir) => {
        await setupFixture(dir, {
          name: "stale packet",
          acceptedContract: true,
          benchmarkCommand,
          checksCommand: passingChecks,
        });
        const packet = await runCli(["next", "--cwd", dir]);
        assert.equal(packet.code, 0, packet.stderr);
        const packetPath = path.join(dir, "autoresearch.last-run.json");
        const capturedPacket = await readFile(packetPath);
        const laterRun = await runCli([
          "log",
          "--cwd",
          dir,
          "--from-last",
          "--status",
          "measure",
          "--description",
          "Accepted later run",
        ]);
        assert.equal(laterRun.code, 0, laterRun.stderr);
        await writeFile(packetPath, capturedPacket);
      },
    },
    {
      name: "missing-setup",
      expectedAction: "setup",
      expectedBlocker: "setup-required",
      commandPattern: /setup-plan/,
      runPacket: "blocked",
      absentBest: true,
      prepare: async (dir) => {
        await writeFile(
          path.join(dir, "autoresearch.jsonl"),
          `${JSON.stringify({ type: "config", metricName: "seconds" })}\n`,
          "utf8",
        );
      },
    },
    {
      name: "failed-checks",
      expectedAction: "log-decision",
      expectedBlocker: "pending-packet",
      commandPattern: /\blog\b/,
      runPacket: "blocked",
      absentBest: true,
      prepare: async (dir) => {
        await setupFixture(dir, {
          name: "failed checks",
          acceptedContract: true,
          benchmarkCommand,
          checksCommand: failingChecks,
        });
        const packet = await runCli(["next", "--cwd", dir]);
        assert.equal(packet.code, 0, packet.stderr);
      },
    },
    {
      name: "ready",
      expectedAction: "run-baseline",
      expectedBlocker: "finalization-blocked",
      commandPattern: /(?:^|\s)next(?:\s|$)/,
      runPacket: "allowed",
      absentBest: true,
      prepare: async (dir) => {
        const setup = await setupFixture(dir, {
          name: "ready session",
          acceptedContract: true,
          benchmarkCommand,
          checksCommand: passingChecks,
        });
        assert.equal(setup.code, 0, setup.stderr);
      },
    },
  ];

  for (const fixture of fixtures) {
    await withTempDir(`canonical-${fixture.name}`, async (dir) => {
      await fixture.prepare(dir);
      const [fullResult, compactResult, reportResult, recommendResult, dashboardResult] =
        await Promise.all([
          runCli(["state", "--cwd", dir, "--json-full"]),
          runCli(["state", "--cwd", dir, "--compact"]),
          runCli(["state", "--cwd", dir, "--report"]),
          runCli(["recommend-next", "--cwd", dir, "--compact"]),
          runCli(["export", "--cwd", dir, "--json-full"]),
        ]);
      for (const result of [
        fullResult,
        compactResult,
        reportResult,
        recommendResult,
        dashboardResult,
      ]) {
        assert.equal(result.code, 0, `${fixture.name}: ${result.stderr}`);
      }

      const full = JSON.parse(fullResult.stdout);
      const compact = JSON.parse(compactResult.stdout);
      const report = JSON.parse(reportResult.stdout);
      const recommend = JSON.parse(recommendResult.stdout);
      const dashboard = JSON.parse(dashboardResult.stdout);
      const plans = [
        projectedPlan(full),
        projectedPlan(compact),
        projectedPlan(recommend),
        projectedPlan(report.report.json),
        projectedPlan(dashboard.viewModel),
      ];

      assert.deepEqual(
        plans.map((plan) => plan.action.kind),
        Array(plans.length).fill(fixture.expectedAction),
        fixture.name,
      );
      assert.deepEqual(
        plans.map((plan) => plan.primaryBlockerCode),
        Array(plans.length).fill(fixture.expectedBlocker),
        fixture.name,
      );
      assert.deepEqual(
        plans.map((plan) => plan.decisionId),
        Array(plans.length).fill(plans[0].decisionId),
        fixture.name,
      );
      assert.deepEqual(
        plans.map((plan) => capabilityStatus(plan, "run-packet")),
        Array(plans.length).fill(fixture.runPacket),
        fixture.name,
      );
      assert.deepEqual(
        plans.map((plan) => plan.parentDisposition.kind),
        Array(plans.length).fill(plans[0].parentDisposition.kind),
        fixture.name,
      );

      const commands = [
        plans[0].action.command,
        plans[1].action.command,
        recommend.commands.primary,
        report.report.json.nextCommand,
      ];
      assert.deepEqual(commands, Array(commands.length).fill(commands[0]), fixture.name);
      assert.match(commands[0], fixture.commandPattern, fixture.name);
      if (fixture.absentBest) {
        assert.equal(full.best, null, fixture.name);
        assert.equal(compact.best, null, fixture.name);
      }
    });
  }
});

test("recommend-next compact returns the state plan and its capability-scoped handoff", async () => {
  await withTempDir("recommend-next-compact-state-first", async (dir) => {
    const command = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=1.5')"`;
    await setupFixture(dir, {
      name: "compact recommend",
      acceptedContract: true,
      benchmarkCommand: command,
    });

    const next = await runCli(["next", "--cwd", dir, "--compact"]);
    assert.equal(next.code, 0, next.stderr);

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    const statePlan = projectedPlan(statePayload);
    assert.equal(capabilityStatus(statePlan, "run-packet"), "blocked");
    assert.equal(capabilityStatus(statePlan, "mutate-session"), "allowed");
    assert.equal((statePlan.parentDisposition as UnknownRecord).kind, "hand-back");
    assert.match(statePayload.commands.state, /state --cwd/);

    const recommend = await runCli([
      "recommend-next",
      "--cwd",
      dir,
      "--compact",
      "--operator-checklist",
      "--codex-goal-objective",
      "Continue the autoresearch.",
    ]);
    assert.equal(recommend.code, 0, recommend.stderr);
    const recommendPayload = JSON.parse(recommend.stdout);
    const recommendPlan = projectedPlan(recommendPayload);
    assert.equal(recommendPlan.decisionId, statePlan.decisionId);
    assert.equal((statePlan.action as UnknownRecord).kind, "log-decision");
    assert.equal(recommendPayload.commands.primary, (statePlan.action as UnknownRecord).command);
    assert.doesNotMatch(recommendPayload.commands.primary, /(?:^|\s)next(?:\s|$).*--compact/);
    assert.equal(
      (recommendPlan.action as UnknownRecord).kind,
      (statePlan.action as UnknownRecord).kind,
    );
    assert.match(recommendPayload.operatorChecklist.source, /pending-packet/);
    assert.doesNotMatch(
      recommendPayload.operatorChecklist.command,
      /(?:^|\s)next(?:\s|$).*--compact/,
    );
    assert.match(recommendPayload.whySafe, /compact state/);
    assert.match(recommendPayload.whySafe, /shared resolved decision/);
  });
});

test("recommend-next preserves history without imposing a universal two-candidate pause", async () => {
  await withTempDir("plateau-pivot-command", async (dir) => {
    const benchmark = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=10')"`;
    const checks = `${quoteForAcceptedShell(process.execPath)} -e "process.exit(0)"`;
    await setupFixture(dir, {
      name: "no-learning pause",
      acceptedContract: true,
      benchmarkCommand: benchmark,
      checksCommand: checks,
      packetBudget: 6,
      scope: "src",
    });
    const baseline = await runCli(["next", "--cwd", dir]);
    assert.equal(baseline.code, 0, baseline.stderr);
    const baselineLog = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "measure",
      "--description",
      "Accepted baseline",
    ]);
    assert.equal(baselineLog.code, 0, baselineLog.stderr);

    for (let index = 1; index <= 2; index += 1) {
      await writeFile(path.join(dir, "src", "candidate.txt"), `${index}\n`, "utf8");
      for (let repeat = 1; repeat <= 2; repeat += 1) {
        const packet = await runCli(["next", "--cwd", dir]);
        assert.equal(packet.code, 0, packet.stderr);
        const logged = await runCli([
          "log",
          "--cwd",
          dir,
          "--from-last",
          "--status",
          "measure",
          "--description",
          `Accepted no-learning candidate ${index}, repeat ${repeat}`,
        ]);
        assert.equal(logged.code, 0, logged.stderr);
      }
    }

    const result = await runCli(["recommend-next", "--cwd", dir, "--compact"]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    const plan = projectedPlan(payload);
    assert.notEqual(plan.primaryBlockerCode, "no-learning-pause");
    assert.equal((plan.learning as UnknownRecord).consecutiveNoLearningCandidates, 2);
    assert.equal(capabilityStatus(plan, "run-packet"), "allowed");
    assert.equal(capabilityStatus(plan, "transition-segment"), "allowed");
    assert.doesNotMatch(String(payload.commands?.primary || ""), /(?:lane-runner|new-segment)/);
    const next = await runCli(["next", "--cwd", dir]);
    assert.equal(next.code, 0, next.stderr);
  });
});

test("pending log receipts block state, doctor, and new log attempts", async () => {
  await withTempDir("pending-log-receipt", async (dir) => {
    await git(dir, ["init"]);
    await setupFixture(dir, {
      name: "pending receipt",
      acceptedContract: true,
    });
    const receiptDir = path.join(dir, ".git", "autoresearch");
    const receiptPath = path.join(receiptDir, "pending-log-transaction.json");
    await mkdir(receiptDir, { recursive: true });
    await writeFile(
      receiptPath,
      JSON.stringify(
        {
          type: "autoresearch.log.transaction",
          schemaVersion: 2,
          transaction: { id: "pending-test-transaction", kind: "non-keep" },
          input: {
            requestDigest: "different-input",
            configDigest: "different-config",
          },
          status: "pending",
          completedStages: ["prepared"],
          evidence: {
            experiment: { run: 1 },
            processLifecycle: [],
            artifacts: [],
          },
          ledgerEvent: {
            transactionId: "pending-test-transaction",
            eventDigest: "pending",
          },
          cleanup: { trackedPaths: [], untrackedPaths: [], packetPaths: [] },
        },
        null,
        2,
      ),
      "utf8",
    );

    const state = await runCli(["state", "--cwd", dir, "--compact", "--report"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    const statePlan = projectedPlan(statePayload.compactState);
    assert.equal(statePlan.primaryBlockerCode, "pending-log-transaction");
    assert.equal(capabilityStatus(statePlan, "mutate-session"), "recovery-only");
    assert.equal(capabilityStatus(statePlan, "run-packet"), "blocked");
    assert.equal(capabilityStatus(statePlan, "finalize"), "blocked");
    assert.equal((statePlan.parentDisposition as UnknownRecord).kind, "block-final-answer");

    const doctor = await runCli(["doctor", "--cwd", dir, "--explain"]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctorPayload = JSON.parse(doctor.stdout);
    const doctorPlan = projectedPlan(doctorPayload);
    assert.equal(doctorPlan.decisionId, statePlan.decisionId);
    assert.equal(doctorPlan.primaryBlockerCode, "pending-log-transaction");

    const ledgerPath = path.join(dir, "autoresearch.jsonl");
    const ledgerBefore = await readFile(ledgerPath, "utf8");
    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "measure",
      "--description",
      "Blocked by receipt",
    ]);
    assert.notEqual(log.code, 0);
    assert.equal(await readFile(ledgerPath, "utf8"), ledgerBefore);
  });
});

testIo(
  "finalize receipt projects identities and passed checks from a real accepted keep",
  async () => {
    await withTempDir("accepted-keep-receipt", async (dir) => {
      await prepareCurrentTreeFinalizationBlocker(dir, runCli);
      const ledgerPath = path.join(dir, "autoresearch.jsonl");
      const before = await readFile(ledgerPath, "utf8");
      const entries = before
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const keep = entries.find((entry) => entry.status === "keep");
      assert.ok(keep?.contractEvaluationEvidence);
      const accepted = entries.find(
        (entry) =>
          entry.type === "experiment-contract-accepted" &&
          entry.contract?.contractDigest === keep.contractEvaluationEvidence.contractDigest,
      );
      assert.ok(accepted?.contract);

      const result = await runCli(["finalize-preview", "--cwd", dir, "--json-full"]);
      assert.equal(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      const observation = payload.evidenceReceipt.observations.find(
        (entry) => entry.run === keep.run,
      );
      assert.ok(observation, JSON.stringify(payload.evidenceReceipt));
      assert.equal(observation.contractDigest, accepted.contract.contractDigest);
      assert.equal(
        observation.evaluatorIdentity,
        accepted.contract.evaluator.execution.executionDigest,
      );
      assert.deepEqual(
        observation.checkIdentities,
        accepted.contract.checks.map((check) => check.execution.executionDigest),
      );
      assert.equal(observation.checkIdentities.length > 0, true);
      assert.equal(
        observation.checkIdentities.every(
          (identity) => typeof identity === "string" && identity.length > 0,
        ),
        true,
      );
      assert.equal(observation.checksPassed, true);
      assert.equal(observation.metric, keep.metric);
      assert.equal(payload.evidenceReceipt.previewReady, false);
      assert.equal(await readFile(ledgerPath, "utf8"), before);
    });
  },
);

testIo("doctor keeps current-tree finalization blockers scoped to finalization", async () => {
  await withTempDir("doctor-current-tree-finalization", async (dir) => {
    await prepareCurrentTreeFinalizationBlocker(dir, runCli);
    const benchmarkCommand = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=1')"`;

    const doctor = await runCli([
      "doctor",
      "--cwd",
      dir,
      "--command",
      benchmarkCommand,
      "--check-benchmark",
      "--explain",
    ]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const payload = JSON.parse(doctor.stdout);
    const plan = projectedPlan(payload);

    assert.equal(plan.primaryBlockerCode, "current-tree-finalization");
    assert.equal(capabilityStatus(plan, "finalize"), "recovery-only");
    assert.equal(capabilityStatus(plan, "run-packet"), "allowed");
    assert.equal(capabilityStatus(plan, "mutate-session"), "allowed");
    assert.equal((plan.loopDisposition as UnknownRecord).kind, "continue");
    assert.equal((plan.parentDisposition as UnknownRecord).kind, "hand-back");
  });
});

const SHARED_FINALIZATION_SCOPE_TEST =
  "state, recommend-next, doctor, and dashboard share finalization-scoped capability authority";
testIo(SHARED_FINALIZATION_SCOPE_TEST, async () => {
  await withTempDir("shared-current-tree-finalization", async (dir) => {
    await prepareCurrentTreeFinalizationBlocker(dir, runCli);
    const benchmarkCommand = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=1')"`;

    const state = await runCli(["state", "--cwd", dir, "--compact", "--report"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    const compactState = statePayload.compactState;
    const statePlan = projectedPlan(compactState);
    assert.equal(statePlan.primaryBlockerCode, "current-tree-finalization");
    assert.equal(capabilityStatus(statePlan, "finalize"), "recovery-only");
    assert.equal(capabilityStatus(statePlan, "run-packet"), "allowed");
    assert.equal((statePlan.parentDisposition as UnknownRecord).kind, "hand-back");

    const recommend = await runCli([
      "recommend-next",
      "--cwd",
      dir,
      "--compact",
      "--operator-checklist",
    ]);
    assert.equal(recommend.code, 0, recommend.stderr);
    const recommendPayload = JSON.parse(recommend.stdout);
    const recommendPlan = projectedPlan(recommendPayload);
    assert.equal(recommendPlan.decisionId, statePlan.decisionId);
    assert.equal(capabilityStatus(recommendPlan, "finalize"), "recovery-only");
    assert.equal(capabilityStatus(recommendPlan, "run-packet"), "allowed");

    const doctor = await runCli([
      "doctor",
      "--cwd",
      dir,
      "--command",
      benchmarkCommand,
      "--check-benchmark",
      "--explain",
    ]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctorPayload = JSON.parse(doctor.stdout);
    const doctorPlan = projectedPlan(doctorPayload);
    assert.equal(doctorPlan.decisionId, statePlan.decisionId);
    assert.equal(capabilityStatus(doctorPlan, "run-packet"), "allowed");

    const exported = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exported.code, 0, exported.stderr);
    const exportPayload = JSON.parse(exported.stdout);
    const dashboardPlan = projectedPlan(exportPayload.viewModel);
    assert.equal(dashboardPlan.decisionId, statePlan.decisionId);
    assert.equal(capabilityStatus(dashboardPlan, "finalize"), "recovery-only");
    assert.equal(capabilityStatus(dashboardPlan, "run-packet"), "allowed");
  });
});

testIo("next compact runs an accepted packet despite a finalization-only blocker", async () => {
  await withTempDir("next-current-tree-finalization", async (dir) => {
    await prepareCurrentTreeFinalizationBlocker(dir, runCli);

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const before = projectedPlan(JSON.parse(state.stdout));
    assert.equal(before.primaryBlockerCode, "current-tree-finalization");
    assert.equal(capabilityStatus(before, "finalize"), "recovery-only");
    assert.equal(capabilityStatus(before, "run-packet"), "allowed");

    const next = await runCli(["next", "--cwd", dir, "--compact"]);
    assert.equal(next.code, 0, next.stderr);
    const payload = JSON.parse(next.stdout);

    assert.equal(payload.ok, true);
    assert.equal(payload.run.ok, true);
    assert.equal(payload.preconditionDecision.capabilities["run-packet"], "allowed");
    assert.equal(payload.resultingDecision.primaryBlockerCode, "pending-packet");
  });
});

const CODEX_GOAL_FINALIZATION_TEST =
  "codex goal audit hands back direct work but blocks a finalization completion claim";
testIo(CODEX_GOAL_FINALIZATION_TEST, async () => {
  await withTempDir("codex-goal-current-tree-complete-blocked", async (dir) => {
    await prepareCurrentTreeFinalizationBlocker(dir, runCli);

    const handback = await runCli([
      "codex-goal-brief",
      "--cwd",
      dir,
      "--codex-goal-status",
      "active",
    ]);
    assert.equal(handback.code, 0, handback.stderr);
    const handbackPayload = JSON.parse(handback.stdout);
    const handbackPlan = projectedPlan(handbackPayload);
    assert.equal((handbackPlan.parentDisposition as UnknownRecord).kind, "hand-back");
    assert.equal(capabilityStatus(handbackPlan, "parent-final-answer"), "allowed");

    const result = await runCli([
      "codex-goal-brief",
      "--cwd",
      dir,
      "--codex-goal-status",
      "active",
      "--completion-confirmed",
      "--completion-evidence",
      "Kept metric and source changes are ready.",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    const audit = payload.completionAudit;
    const completionPlan = projectedPlan(payload);

    assert.equal((completionPlan.parentDisposition as UnknownRecord).kind, "block-final-answer");
    assert.equal(capabilityStatus(completionPlan, "parent-final-answer"), "blocked");
    assert.equal(audit.status, "blocked");
    assert.equal(audit.canMarkCodexGoalComplete, false);
  });
});

test("stale packet compact state recommends replacement next command", async () => {
  await withTempDir("state-stale-last-run-replacement", async (dir) => {
    const command = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const checksCommand = `${quoteForAcceptedShell(process.execPath)} -e "process.exit(0)"`;
    await setupFixture(dir, {
      name: "stale state",
      acceptedContract: true,
      benchmarkCommand: command,
      checksCommand,
    });
    const next = await runCli(["next", "--cwd", dir]);
    assert.equal(next.code, 0, next.stderr);
    const lastRunPath = String(JSON.parse(next.stdout).lastRunPath);
    assert.ok(lastRunPath);
    const capturedPacket = await readFile(lastRunPath, "utf8");
    const acceptedLog = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "measure",
      "--description",
      "Accepted evaluated run",
    ]);
    assert.equal(acceptedLog.code, 0, acceptedLog.stderr);

    const lastRunPacket = JSON.parse(capturedPacket);
    const replayWrapper = process.platform === "win32" ? /autoresearch\.ps1/ : /autoresearch\.sh/;
    const replayChecksWrapper =
      process.platform === "win32" ? /autoresearch\.checks\.ps1/ : /autoresearch\.checks\.sh/;
    assert.match(lastRunPacket.history.replayCommand, replayWrapper);
    assert.match(lastRunPacket.history.replayChecksCommand, replayChecksWrapper);
    lastRunPacket.history.command = "<redacted benchmark command>";
    lastRunPacket.run.command = "";
    lastRunPacket.run.checks.command = "";
    await writeFile(lastRunPath, JSON.stringify(lastRunPacket, null, 2), "utf8");

    const fullState = await runCli(["state", "--cwd", dir]);
    assert.equal(fullState.code, 0, fullState.stderr);
    const fullStatePayload = JSON.parse(fullState.stdout);
    const fullPlan = projectedPlan(fullStatePayload);

    assert.equal((fullPlan.action as UnknownRecord).kind, "replace-packet");
    assert.equal(fullPlan.primaryBlockerCode, "stale-packet");
    assert.match(String((fullPlan.action as UnknownRecord).command), /(?:^|\s)next(?:\s|$)/);
    assert.doesNotMatch(String((fullPlan.action as UnknownRecord).command), /--command/);
    assert.doesNotMatch(String((fullPlan.action as UnknownRecord).command), /--checks-command/);

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    const statePlan = projectedPlan(statePayload);

    assert.equal((statePlan.action as UnknownRecord).kind, "replace-packet");
    assert.equal(statePlan.primaryBlockerCode, "stale-packet");
    assert.equal(capabilityStatus(statePlan, "run-packet"), "recovery-only");
    assert.match(statePayload.commands.replaceLast, /(?:^|\s)next(?:\s|$)/);
    assert.doesNotMatch(statePayload.commands.replaceLast, /--command/);
    assert.doesNotMatch(statePayload.commands.replaceLast, /--checks-command/);
    assert.equal((statePlan.action as UnknownRecord).command, statePayload.commands.replaceLast);
    assert.equal((fullPlan.action as UnknownRecord).command, statePayload.commands.replaceLast);

    const recommend = await runCli(["recommend-next", "--cwd", dir, "--compact"]);
    assert.equal(recommend.code, 0, recommend.stderr);
    const recommendPayload = JSON.parse(recommend.stdout);
    const recommendPlan = projectedPlan(recommendPayload);

    assert.equal(recommendPlan.decisionId, statePlan.decisionId);
    assert.equal((recommendPlan.action as UnknownRecord).kind, "replace-packet");
    assert.equal(recommendPayload.commands.primary, statePayload.commands.replaceLast);
    assert.match(recommendPayload.commands.primary, /(?:^|\s)next(?:\s|$)/);

    const replacement = await runCli(["next", "--cwd", dir]);
    assert.equal(replacement.code, 0, replacement.stderr);
    const replacementPayload = JSON.parse(replacement.stdout);
    assert.equal(replacementPayload.decision.metric, 3);
  });
});

test("state report returns a compact one-screen terminal report", async () => {
  await withTempDir("state-terminal-report", async (dir) => {
    await setupFixture(dir, { name: "report loop", acceptedContract: true });

    const report = await runCli(["state", "--cwd", dir, "--report"]);
    assert.equal(report.code, 0, report.stderr);
    const payload = JSON.parse(report.stdout);

    assert.equal(payload.ok, true);
    assert.equal(typeof payload.report.text, "string");
    assert.equal(typeof payload.report.json.nextCommand, "string");
    assert.match(payload.report.text, /Next command/i);
    assert.match(payload.report.text, /Gate/i);
    assert.match(payload.report.text, /Runtime/i);
    assert.match(payload.report.text, /Dashboard/i);
    assert.doesNotMatch(
      payload.report.text,
      /\bserve\b|start_dashboard|--check-benchmark|benchmark-lint|git stash push/i,
    );
    assert.doesNotMatch(
      JSON.stringify(payload.report.json),
      /\bserve\b|start_dashboard|--check-benchmark|benchmark-lint|git stash push/i,
    );
    assert.notEqual(payload.report.json.dashboard.command, 'curl "/health"');
    assert.doesNotMatch(payload.report.text, /\[object Object\]/);
    assert.equal(payload.compactState, undefined);

    const reportWithSource = await runCli(["state", "--cwd", dir, "--compact", "--report"]);
    assert.equal(reportWithSource.code, 0, reportWithSource.stderr);
    const sourcePayload = JSON.parse(reportWithSource.stdout);
    const sourcePlan = projectedPlan(sourcePayload.compactState);
    assert.equal(sourcePayload.compactState.metric, "seconds");
    assert.equal(sourcePlan.primaryBlockerCode, "finalization-blocked");
    assert.equal(capabilityStatus(sourcePlan, "run-packet"), "allowed");
    assert.equal(capabilityStatus(sourcePlan, "finalize"), "blocked");
    assert.equal(sourcePayload.report.json.blocker, "");
    assert.equal(
      sourcePayload.report.json.nextCommand,
      (sourcePlan.action as UnknownRecord).command,
    );
  });
});

test("legacy decision capsules remain display facts and never become compiler authority", async () => {
  await withTempDir("state-report-decision-capsule-command", async (dir) => {
    await setupFixture(dir, { name: "report capsule", acceptedContract: true });
    await writeDecisionCapsule(dir, "benchmark-contract");

    const report = await runCli(["state", "--cwd", dir, "--compact", "--report"]);
    assert.equal(report.code, 0, report.stderr);
    const payload = JSON.parse(report.stdout);
    const plan = projectedPlan(payload.compactState);

    assert.equal((plan.action as UnknownRecord).kind, "run-baseline");
    assert.notEqual(plan.primaryBlockerCode, "decision-capsule");
    assert.equal(payload.report.json.nextCommand, (plan.action as UnknownRecord).command);
    assert.match(payload.report.json.nextCommand, /(?:^|\s)next(?:\s|$)/);
  });
});

test("state report does not promote empty promotion evidence", async () => {
  await withTempDir("state-report-empty-promotion", async (dir) => {
    const command = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=1')"`;
    const setup = await runCli([
      "setup",
      "--cwd",
      dir,
      "--name",
      "generic checks",
      "--metric-name",
      "seconds",
      "--benchmark-command",
      command,
      "--checks-command",
      "node verify.mjs",
    ]);
    assert.equal(setup.code, 0, setup.stderr);

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.gateQuality.posture, "unknown");

    const report = await runCli(["state", "--cwd", dir, "--report"]);
    assert.equal(report.code, 0, report.stderr);
    const reportPayload = JSON.parse(report.stdout);
    assert.equal(reportPayload.report.json.gate.posture, "unknown");
    assert.doesNotMatch(reportPayload.report.text, /Gate: promotion/);
    assert.notEqual(reportPayload.report.json.portfolio.kind, "holdout");
  });
});

test("persisted quality constraints gate state quality posture end-to-end", async () => {
  await withTempDir("quality-constraints-e2e", async (dir) => {
    const command = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=1')"`;
    const setup = await runCli([
      "setup",
      "--cwd",
      dir,
      "--name",
      "quality constrained",
      "--metric-name",
      "seconds",
      "--benchmark-command",
      command,
      "--quality-constraints",
      JSON.stringify([{ domain: "retrieval_quality", requiredBeforePromotion: true }]),
    ]);
    assert.equal(setup.code, 0, setup.stderr);

    const config = JSON.parse(await readFile(path.join(dir, "autoresearch.config.json"), "utf8"));
    assert.equal(config.qualityConstraints?.[0]?.domain, "retrieval_quality");

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.gateQuality.posture, "missing");
    assert.match(
      statePayload.gateQuality.blockers.join("\n"),
      /quality-sensitive performance loop/i,
    );
    assert.match(statePayload.gateQuality.warnings.join("\n"), /retrieval_quality/);
  });
});
