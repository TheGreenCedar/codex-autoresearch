import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  prepareCurrentTreeFinalizationBlocker,
  writeDecisionCapsule,
} from "../helpers/git-fixtures.js";
import { quoteForShell } from "../helpers/process.js";

import { runCli, withTempDir, git } from "../helpers/cli-test-context.js";

test("compact state, recommend-next, and onboarding-packet surface resolved decisions", async () => {
  await withTempDir("decision-envelope", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "envelope", "--metric-name", "seconds"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1.5')"`;

    const next = await runCli(["next", "--cwd", dir, "--command", command, "--compact"]);
    assert.equal(next.code, 0, next.stderr);
    const nextPayload = JSON.parse(next.stdout);
    assert.ok(nextPayload.decision.allowedStatuses.includes("measure"));

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.resolvedDecision.canonicalNextAction.kind, "log-decision");
    assert.equal(statePayload.resolvedDecision.finalizationPressure.available, true);
    assert.equal(statePayload.resolvedDecision.finalizationPressure.ready, false);
    assert.match(
      statePayload.resolvedDecision.finalizationPressure.nextAction,
      /Git-backed autoresearch branch/,
    );
    assert.equal(typeof statePayload.resolvedDecision.nextAction, "string");
    assert.equal(Object.hasOwn(statePayload, "decisionEnvelope"), false);
    assert.equal(Object.hasOwn(statePayload, "resumeAudit"), false);

    const recommend = await runCli(["recommend-next", "--cwd", dir, "--compact"]);
    assert.equal(recommend.code, 0, recommend.stderr);
    const recommendPayload = JSON.parse(recommend.stdout);
    assert.equal(
      recommendPayload.nextAction,
      statePayload.resolvedDecision.canonicalNextAction.reason,
    );
    assert.equal(
      recommendPayload.resolvedDecision.canonicalNextAction.reason,
      statePayload.resolvedDecision.canonicalNextAction.reason,
    );

    const onboarding = await runCli(["onboarding-packet", "--cwd", dir, "--compact"]);
    assert.equal(onboarding.code, 0, onboarding.stderr);
    const onboardingPayload = JSON.parse(onboarding.stdout);
    assert.equal(onboardingPayload.resolvedDecision.canonicalNextAction.kind, "log-decision");
    assert.equal(Object.hasOwn(onboardingPayload, "decisionEnvelope"), false);
    assert.equal(Object.hasOwn(onboardingPayload, "resumeAudit"), false);
  });
});

test("canonical next action stays consistent across state, report, recommend-next, and dashboard", async () => {
  const benchmarkCommand = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
  const passingChecks = `${quoteForShell(process.execPath)} -e "process.exit(0)"`;
  const failingChecks = `${quoteForShell(process.execPath)} -e "process.exit(1)"`;
  const fixtures = [
    {
      name: "active-artifact",
      expectedKind: "partial-salvage",
      commandPattern: /partial-results/,
      blocked: true,
      absentBest: true,
      prepare: async (dir) => {
        await runCli([
          "init",
          "--cwd",
          dir,
          "--name",
          "active artifact",
          "--metric-name",
          "seconds",
        ]);
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
        const packet = await runCli([
          "next",
          "--cwd",
          dir,
          "--command",
          `${quoteForShell(process.execPath)} ${quoteForShell(script)}`,
        ]);
        assert.equal(packet.code, 0, packet.stderr);
      },
    },
    {
      name: "stale-packet",
      expectedKind: "stale-packet",
      commandPattern: /(?:^|\s)next(?:\s|$)/,
      blocked: true,
      absentBest: false,
      prepare: async (dir) => {
        await runCli(["init", "--cwd", dir, "--name", "stale packet", "--metric-name", "seconds"]);
        const packet = await runCli([
          "next",
          "--cwd",
          dir,
          "--command",
          benchmarkCommand,
          "--checks-command",
          passingChecks,
        ]);
        assert.equal(packet.code, 0, packet.stderr);
        const laterRun = await runCli([
          "log",
          "--cwd",
          dir,
          "--metric",
          "2",
          "--status",
          "keep",
          "--description",
          "Later direct run",
        ]);
        assert.equal(laterRun.code, 0, laterRun.stderr);
      },
    },
    {
      name: "missing-setup",
      expectedKind: "setup",
      commandPattern: /setup-plan/,
      blocked: true,
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
      expectedKind: "log-decision",
      commandPattern: /\blog\b/,
      blocked: true,
      absentBest: true,
      prepare: async (dir) => {
        await runCli(["init", "--cwd", dir, "--name", "failed checks", "--metric-name", "seconds"]);
        const packet = await runCli([
          "next",
          "--cwd",
          dir,
          "--command",
          benchmarkCommand,
          "--checks-command",
          failingChecks,
        ]);
        assert.equal(packet.code, 0, packet.stderr);
      },
    },
    {
      name: "ready",
      expectedKind: "next-packet",
      commandPattern: /(?:^|\s)next(?:\s|$)/,
      blocked: false,
      absentBest: true,
      prepare: async (dir) => {
        const setup = await runCli([
          "setup",
          "--cwd",
          dir,
          "--name",
          "ready session",
          "--metric-name",
          "seconds",
          "--benchmark-command",
          benchmarkCommand,
          "--checks-command",
          passingChecks,
        ]);
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
      const actions = [
        full.resolvedDecision.canonicalNextAction,
        compact.resolvedDecision.canonicalNextAction,
        recommend.resolvedDecision.canonicalNextAction,
        dashboard.viewModel.decisionEnvelope.canonicalNextAction,
      ];

      assert.deepEqual(
        actions.map((action) => action.kind),
        Array(actions.length).fill(fixture.expectedKind),
        fixture.name,
      );
      assert.deepEqual(
        actions.map((action) => action.reason),
        Array(actions.length).fill(actions[0].reason),
        fixture.name,
      );
      assert.deepEqual(
        [
          full.resolvedDecision.nextAction,
          compact.resolvedDecision.nextAction,
          recommend.resolvedDecision.nextAction,
          recommend.nextAction,
          dashboard.viewModel.decisionEnvelope.nextAction,
          report.report.json.nextAction,
        ],
        Array(6).fill(actions[0].reason),
        fixture.name,
      );
      assert.equal(report.report.json.nextAction, actions[0].reason, fixture.name);
      assert.equal(dashboard.viewModel.nextBestAction.kind, fixture.expectedKind, fixture.name);

      const commands = [
        actions[0].command,
        actions[1].command,
        recommend.commands.primary,
        report.report.json.nextCommand,
      ];
      assert.deepEqual(commands, Array(commands.length).fill(commands[0]), fixture.name);
      assert.match(commands[0], fixture.commandPattern, fixture.name);

      const loopContracts = [
        full.resolvedDecision.loopContract,
        compact.resolvedDecision.loopContract,
        recommend.resolvedDecision.loopContract,
        dashboard.viewModel.decisionEnvelope.loopContract,
      ];
      assert.deepEqual(
        loopContracts.map((contract) => contract.canRunNextPacket),
        Array(loopContracts.length).fill(!fixture.blocked),
        fixture.name,
      );
      assert.equal(
        compact.resolvedDecision.loopContract.canRunNextPacket,
        !fixture.blocked,
        fixture.name,
      );
      assert.equal(report.report.json.status === "blocked", fixture.blocked, fixture.name);

      const portfolioKinds = [
        full.portfolioRecommendation?.kind,
        recommend.portfolioRecommendation?.kind,
        dashboard.viewModel.portfolioRecommendation?.kind,
        report.report.json.portfolio.kind,
      ];
      assert.equal(portfolioKinds.includes("exploit-best"), false, fixture.name);
      if (fixture.blocked) {
        assert.deepEqual(portfolioKinds.slice(0, 3), [undefined, undefined, undefined]);
      }
      if (fixture.absentBest) {
        assert.equal(full.best, null, fixture.name);
        assert.equal(compact.best, null, fixture.name);
      }
    });
  }
});

test("recommend-next compact returns state-first handoff with shared finalization authority", async () => {
  await withTempDir("recommend-next-compact-state-first", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "compact recommend", "--metric-name", "seconds"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1.5')"`;

    const next = await runCli(["next", "--cwd", dir, "--command", command, "--compact"]);
    assert.equal(next.code, 0, next.stderr);

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.resolvedDecision.finalizationPressure.available, true);
    assert.equal(statePayload.resolvedDecision.finalizationPressure.ready, false);
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
    assert.equal(recommendPayload.resolvedDecision.finalizationPressure.available, true);
    assert.equal(statePayload.resolvedDecision.canonicalNextAction.kind, "log-decision");
    assert.equal(
      recommendPayload.commands.primary,
      statePayload.resolvedDecision.canonicalNextAction.command,
    );
    assert.doesNotMatch(recommendPayload.commands.primary, /(?:^|\s)next(?:\s|$).*--compact/);
    assert.equal(
      recommendPayload.resolvedDecision.canonicalNextAction.kind,
      statePayload.resolvedDecision.canonicalNextAction.kind,
    );
    assert.equal(recommendPayload.operatorChecklist.source, "latestPacketFreshness");
    assert.doesNotMatch(
      recommendPayload.operatorChecklist.command,
      /(?:^|\s)next(?:\s|$).*--compact/,
    );
    assert.match(recommendPayload.whySafe, /compact state/);
    assert.match(recommendPayload.whySafe, /shared resolved decision/);
  });
});

test("recommend-next compact refuses stale next command for plateau pivot", async () => {
  await withTempDir("plateau-pivot-command", async (dir) => {
    await runCli([
      "setup",
      "--cwd",
      dir,
      "--name",
      "plateau pivot",
      "--metric-name",
      "seconds",
      "--benchmark-command",
      `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=10')"`,
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
        family: "cache-size",
        hypothesis: "baseline cache size",
        evidence: "seconds=10",
      }),
    ]);
    for (const [metric, description] of [
      ["11", "cache size retry 1"],
      ["11.0001", "cache size retry 2"],
    ]) {
      await runCli([
        "log",
        "--cwd",
        dir,
        "--metric",
        metric,
        "--status",
        "discard",
        "--description",
        description,
        "--asi",
        JSON.stringify({
          family: "cache-size",
          rollback_reason: "slower than baseline",
        }),
      ]);
    }
    await runCli([
      "log",
      "--cwd",
      dir,
      "--status",
      "crash",
      "--description",
      "cache size retry 3",
      "--asi",
      JSON.stringify({
        family: "cache-size",
        rollback_reason: "crashed before producing a trusted metric",
      }),
    ]);

    const result = await runCli(["recommend-next", "--cwd", dir, "--compact"]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.action?.kind, "plateau-pivot");
    assert.equal(payload.resolvedDecision.canonicalNextAction.kind, "plateau-pivot");
    assert.doesNotMatch(payload.commands.primary, /(?:^|\s)next(?:\s|$)/);
    assert.match(payload.commands.primary, /(?:^|\s)(?:lane-runner|new-segment)(?:\s|$)/);
  });
});

test("pending log receipts block state, doctor, and new log attempts", async () => {
  await withTempDir("pending-log-receipt", async (dir) => {
    await git(dir, ["init"]);
    await runCli(["init", "--cwd", dir, "--name", "pending receipt", "--metric-name", "seconds"]);
    const receiptDir = path.join(dir, ".git", "autoresearch");
    const receiptPath = path.join(receiptDir, "pending-log-transaction.json");
    await mkdir(receiptDir, { recursive: true });
    await writeFile(
      receiptPath,
      JSON.stringify(
        {
          type: "autoresearch.log.pending",
          version: 1,
          status: "keep",
          intendedLedgerRun: 1,
          ledgerAppended: false,
        },
        null,
        2,
      ),
      "utf8",
    );

    const state = await runCli(["state", "--cwd", dir, "--compact", "--report"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.report.json.status, "blocked");
    assert.match(
      statePayload.compactState.resolvedDecision.loopContract.blockers.join("\n"),
      /pending receipt|not be recorded in autoresearch\.jsonl/i,
    );

    const doctor = await runCli(["doctor", "--cwd", dir, "--explain"]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctorPayload = JSON.parse(doctor.stdout);
    assert.equal(doctorPayload.ok, false);
    assert.ok(
      doctorPayload.issues.some((issue) =>
        /pending receipt|not be recorded in autoresearch\.jsonl/i.test(issue),
      ),
    );

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
    assert.match(log.stderr, /pending receipt|not be recorded in autoresearch\.jsonl/i);
  });
});

test("doctor explain preserves current-tree finalization blockers", async () => {
  await withTempDir("doctor-current-tree-finalization", async (dir) => {
    await prepareCurrentTreeFinalizationBlocker(dir, runCli);
    const benchmarkCommand = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1')"`;

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

    assert.equal(payload.ok, false);
    assert.equal(payload.resolvedDecision.canonicalNextAction.kind, "current-tree-finalization");
    assert.equal(payload.resolvedDecision.loopContract.canRunNextPacket, false);
    assert.equal(payload.resolvedDecision.finalizationPressure.available, true);
    assert.match(payload.nextAction, /finalize-current-tree|Final tree coverage/i);
    assert.doesNotMatch(
      payload.resolvedDecision.canonicalNextAction.command,
      /(?:^|\s)next(?:\s|$)/,
    );
  });
});

test("state, recommend-next, doctor, and dashboard share current-tree finalization authority", async () => {
  await withTempDir("shared-current-tree-finalization", async (dir) => {
    await prepareCurrentTreeFinalizationBlocker(dir, runCli);
    const benchmarkCommand = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1')"`;

    const state = await runCli(["state", "--cwd", dir, "--compact", "--report"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    const compactState = statePayload.compactState;
    assert.equal(
      compactState.resolvedDecision.canonicalNextAction.kind,
      "current-tree-finalization",
    );
    assert.equal(compactState.resolvedDecision.finalizationPressure.available, true);
    assert.equal(statePayload.report.json.status, "blocked");

    const recommend = await runCli([
      "recommend-next",
      "--cwd",
      dir,
      "--compact",
      "--operator-checklist",
    ]);
    assert.equal(recommend.code, 0, recommend.stderr);
    const recommendPayload = JSON.parse(recommend.stdout);
    assert.equal(
      recommendPayload.resolvedDecision.canonicalNextAction.kind,
      compactState.resolvedDecision.canonicalNextAction.kind,
    );
    assert.equal(recommendPayload.resolvedDecision.finalizationPressure.available, true);
    assert.match(recommendPayload.operatorChecklist.source, /currentTree/);
    assert.doesNotMatch(recommendPayload.commands.primary, /(?:^|\s)next(?:\s|$).*--compact/);

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
    assert.equal(
      doctorPayload.resolvedDecision.canonicalNextAction.kind,
      compactState.resolvedDecision.canonicalNextAction.kind,
    );
    assert.equal(doctorPayload.resolvedDecision.loopContract.canRunNextPacket, false);

    const exported = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exported.code, 0, exported.stderr);
    const exportPayload = JSON.parse(exported.stdout);
    assert.equal(
      exportPayload.viewModel.decisionEnvelope.canonicalNextAction.kind,
      compactState.resolvedDecision.canonicalNextAction.kind,
    );
    assert.equal(exportPayload.viewModel.nextBestAction.kind, "current-tree-finalization");
  });
});

test("next compact refuses current-tree finalization blockers before running packets", async () => {
  await withTempDir("next-current-tree-finalization", async (dir) => {
    await prepareCurrentTreeFinalizationBlocker(dir, runCli);

    const next = await runCli(["next", "--cwd", dir, "--compact"]);
    assert.equal(next.code, 0, next.stderr);
    const payload = JSON.parse(next.stdout);

    assert.equal(payload.ok, false);
    assert.equal(payload.refused, true);
    assert.equal(payload.code, "next_blocked_by_loop_contract");
    assert.equal(payload.blockingAction.kind, "current-tree-finalization");
    assert.equal(payload.loopContract.canRunNextPacket, false);
    assert.equal(payload.run, null);
    assert.equal(payload.decision, null);
    assert.match(payload.commandHint, /finalize-(preview|current-tree)/);
    assert.doesNotMatch(payload.commandHint, /autoresearch\.mjs"?\s+next\b/);
  });
});

test("codex goal complete audit blocks current-tree finalization blockers", async () => {
  await withTempDir("codex-goal-current-tree-complete-blocked", async (dir) => {
    await prepareCurrentTreeFinalizationBlocker(dir, runCli);

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

    assert.equal(audit.status, "blocked");
    assert.equal(audit.canMarkCodexGoalComplete, false);
    assert.match(
      audit.localEvidence.blockers.join("\n"),
      /Do not mark the Codex goal complete while Autoresearch has unresolved quality gaps, review-required evidence, fixed-control violations, or current-tree finalization blockers\./,
    );
    assert.match(audit.recommendedCodexAction, /Do not mark complete|Resolve/);
  });
});

test("stale packet compact state recommends replacement next command", async () => {
  await withTempDir("state-stale-last-run-replacement", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "stale state", "--metric-name", "seconds"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const checksCommand = `${quoteForShell(process.execPath)} -e "process.exit(0)"`;
    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "always",
      "--checks-command",
      checksCommand,
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

    const lastRunPath = path.join(dir, "autoresearch.last-run.json");
    const lastRunPacket = JSON.parse(await readFile(lastRunPath, "utf8"));
    assert.match(lastRunPacket.history.replayCommand, /METRIC seconds=3/);
    assert.match(lastRunPacket.history.replayChecksCommand, /process\.exit\(0\)/);
    lastRunPacket.history.command = "<redacted benchmark command>";
    lastRunPacket.run.command = "";
    lastRunPacket.run.checks.command = "";
    await writeFile(lastRunPath, JSON.stringify(lastRunPacket, null, 2), "utf8");

    const fullState = await runCli(["state", "--cwd", dir]);
    assert.equal(fullState.code, 0, fullState.stderr);
    const fullStatePayload = JSON.parse(fullState.stdout);

    assert.equal(fullStatePayload.resolvedDecision.canonicalNextAction.kind, "stale-packet");
    assert.match(
      fullStatePayload.resolvedDecision.canonicalNextAction.command,
      /(?:^|\s)next(?:\s|$)/,
    );
    assert.match(fullStatePayload.resolvedDecision.canonicalNextAction.command, /--command/);
    assert.match(fullStatePayload.resolvedDecision.canonicalNextAction.command, /--checks-command/);

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);

    assert.equal(statePayload.resolvedDecision.canonicalNextAction.kind, "stale-packet");
    assert.match(statePayload.commands.replaceLast, /(?:^|\s)next(?:\s|$)/);
    assert.match(statePayload.commands.replaceLast, /--command/);
    assert.match(statePayload.commands.replaceLast, /--checks-command/);
    assert.equal(
      statePayload.resolvedDecision.canonicalNextAction.command,
      statePayload.commands.replaceLast,
    );
    assert.equal(
      fullStatePayload.resolvedDecision.canonicalNextAction.command,
      statePayload.commands.replaceLast,
    );

    const recommend = await runCli(["recommend-next", "--cwd", dir, "--compact"]);
    assert.equal(recommend.code, 0, recommend.stderr);
    const recommendPayload = JSON.parse(recommend.stdout);

    assert.equal(recommendPayload.resolvedDecision.canonicalNextAction.kind, "stale-packet");
    assert.equal(recommendPayload.commands.primary, statePayload.commands.replaceLast);
    assert.match(recommendPayload.commands.primary, /(?:^|\s)next(?:\s|$)/);

    const replacement = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "always",
      "--checks-command",
      checksCommand,
    ]);
    assert.equal(replacement.code, 0, replacement.stderr);
    const replacementPayload = JSON.parse(replacement.stdout);
    assert.equal(replacementPayload.decision.metric, 3);
  });
});

test("state report returns a compact one-screen terminal report", async () => {
  await withTempDir("state-terminal-report", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "report loop", "--metric-name", "seconds"]);

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
    assert.equal(sourcePayload.compactState.metric, "seconds");
    assert.equal(sourcePayload.report.json.blocker.length > 0, true);
  });
});

test("state report uses canonical command for blocked decision capsules", async () => {
  await withTempDir("state-report-decision-capsule-command", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "report capsule", "--metric-name", "seconds"]);
    await writeDecisionCapsule(dir, "benchmark-contract");

    const report = await runCli(["state", "--cwd", dir, "--compact", "--report"]);
    assert.equal(report.code, 0, report.stderr);
    const payload = JSON.parse(report.stdout);

    assert.equal(
      payload.compactState.resolvedDecision.canonicalNextAction.kind,
      "decision-capsule",
    );
    assert.equal(
      payload.report.json.nextCommand,
      payload.compactState.resolvedDecision.canonicalNextAction.command,
    );
    assert.doesNotMatch(payload.report.json.nextCommand, /doctor --cwd/);
  });
});

test("state report does not promote empty promotion evidence", async () => {
  await withTempDir("state-report-empty-promotion", async (dir) => {
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1')"`;
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
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1')"`;
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
