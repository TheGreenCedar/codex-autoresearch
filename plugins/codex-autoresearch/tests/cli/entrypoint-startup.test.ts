import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import test from "node:test";
import { escapeRegExp } from "../helpers/runtime-release-fixtures.js";

import { pluginRoot, runCli, runSpawnedCli, withTempDir } from "../helpers/cli-test-context.js";

test("spawned CLI contract covers source launcher startup and env workdir resolution", async () => {
  await withTempDir("spawned-contract", async (dir) => {
    const help = await runSpawnedCli(["--help"]);
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /Usage:/);

    const env = { ...process.env, CODEX_AUTORESEARCH_WORKDIR: dir };
    const init = await runSpawnedCli(["init", "--name", "spawned", "--metric-name", "seconds"], {
      cwd: pluginRoot,
      env,
    });
    assert.equal(init.code, 0, init.stderr);

    const state = await runSpawnedCli(["state"], { cwd: pluginRoot, env });
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.equal(payload.config.name, "spawned");
    assert.equal(payload.config.metricName, "seconds");
  });
});

test("spawned CLI returns scoped help and human-safe usage errors", async () => {
  const rootHelp = await runSpawnedCli(["-h"]);
  assert.equal(rootHelp.code, 0, rootHelp.stderr);
  assert.match(rootHelp.stdout, /Happy path:/);

  const commandHelp = await runSpawnedCli(["state", "--help"]);
  assert.equal(commandHelp.code, 0, commandHelp.stderr);
  assert.match(commandHelp.stdout, /Command: state/);
  assert.match(commandHelp.stdout, /autoresearch\.mjs state --cwd <project>/);
  assert.doesNotMatch(commandHelp.stdout, /autoresearch\.mjs setup --cwd/);

  const prefixedHelp = await runSpawnedCli(["--debug", "--all", "help", "state"]);
  assert.equal(prefixedHelp.code, 0, prefixedHelp.stderr);
  assert.match(prefixedHelp.stdout, /Command: state/);

  for (const args of [
    ["state", "--metric-name", "latency"],
    ["state", "--compact=perhaps"],
    ["state", "--debug", "nonsense"],
  ]) {
    const result = await runSpawnedCli(args);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /Command: state/);
    assert.match(result.stderr, /Usage:/);
    assert.doesNotMatch(result.stderr, /\n\s+at\s/);
    assert.doesNotMatch(result.stderr, new RegExp(escapeRegExp(pluginRoot), "i"));
  }

  const invalidDebug = await runSpawnedCli(["--debug=perhaps"]);
  assert.equal(invalidDebug.code, 1, invalidDebug.stderr);
  assert.match(invalidDebug.stderr, /debug expects a boolean value/i);
  assert.doesNotMatch(invalidDebug.stderr, /\n\s+at\s/);

  for (const value of [
    path.join(pluginRoot, "private-project"),
    "secret-token-shaped-value",
    "line-one\nline-two\u001b[31m",
  ]) {
    const invalidBoolean = await runSpawnedCli(["state", `--compact=${value}`]);
    assert.equal(invalidBoolean.code, 1, invalidBoolean.stderr);
    assert.match(invalidBoolean.stderr, /compact expects a boolean value/i);
    assert.equal(invalidBoolean.stderr.includes(value), false);
    assert.equal(invalidBoolean.stderr.includes("\u001b"), false);
    assert.doesNotMatch(invalidBoolean.stderr, /\n\s+at\s/);
  }

  const debug = await runSpawnedCli(["state", "--metric-name", "latency", "--debug"]);
  assert.equal(debug.code, 1, debug.stderr);
  assert.match(debug.stderr, /\n\s+at\s/);

  const debugThenMalformed = await runSpawnedCli([
    "state",
    "--metric-name",
    "latency",
    "--debug=true",
    "--debug=perhaps",
  ]);
  assert.equal(debugThenMalformed.code, 1, debugThenMalformed.stderr);
  assert.match(debugThenMalformed.stderr, /\n\s+at\s/);
});

test("compact state exposes authoritative goal frame and operator handoff", async () => {
  await withTempDir("compact-goal-frame", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "goal frame",
      "--metric-name",
      "agent_value_gap",
      "--goal",
      "Use cheap local evidence before live A/B.",
    ]);

    const result = await runCli([
      "state",
      "--cwd",
      dir,
      "--compact",
      "--codex-goal-objective",
      "Please continue with the autoresearch. Start by stating the goal.",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);

    assert.equal(payload.goalFrame.authoritativeGoal, "Use cheap local evidence before live A/B.");
    assert.equal(payload.goalFrame.codexObjectiveRole, "operator_instruction");
    assert.equal(payload.goalFrame.mismatch, true);
    assert.match(payload.goalFrame.warning, /Codex prompt is not the research goal/);
    assert.match(payload.goalFrame.operatorLine, /Research goal:/);
    assert.match(payload.operatorHandoff.goal, /Use cheap local evidence/);
    assert.equal(payload.operatorHandoff.next, payload.nextAction);
  });
});

test("state recommend-next and dashboard share workflow friction readout", async () => {
  await withTempDir("shared-workflow-friction-readout", async (dir) => {
    const repeatedCommand = "node scripts/check.mjs --fast";
    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "shared friction",
          goal: "Keep the operator readout consistent.",
          metricName: "seconds",
          bestDirection: "lower",
        }),
        ...Array.from({ length: 10 }, (_, index) =>
          JSON.stringify({
            run: index + 1,
            metric: 10 - index,
            status: "measure",
            command: repeatedCommand,
            benchmarkContract: { command: repeatedCommand },
            description: `Repeat verification ${index + 1}`,
          }),
        ),
      ].join("\n") + "\n",
    );

    const fullState = JSON.parse((await runCli(["state", "--cwd", dir])).stdout);
    const compactState = JSON.parse((await runCli(["state", "--cwd", dir, "--compact"])).stdout);
    const recommendNext = JSON.parse(
      (await runCli(["recommend-next", "--cwd", dir, "--compact"])).stdout,
    );
    const exported = JSON.parse((await runCli(["export", "--cwd", dir, "--json-full"])).stdout);

    const hasVerificationChurn = (signals) =>
      Array.isArray(signals) && signals.some((signal) => signal?.kind === "verification_churn");
    assert.equal(hasVerificationChurn(fullState.workflowFriction), true);
    assert.equal(hasVerificationChurn(compactState.workflowFriction), true);
    assert.equal(Object.hasOwn(compactState, "decisionEnvelope"), false);
    assert.match((recommendNext.frictionSignals || []).join("\n"), /ran 10 times/);
    assert.equal(
      hasVerificationChurn(exported.viewModel?.decisionEnvelope?.workflowFriction),
      true,
    );
  });
});

test(
  "compact read commands stay within a warm local startup budget",
  {
    skip:
      process.env.CODEX_AUTORESEARCH_RUN_PERF_TESTS !== "1" &&
      "Set CODEX_AUTORESEARCH_RUN_PERF_TESTS=1 for wall-clock startup budgets.",
  },
  async () => {
    await withTempDir("compact-read-budget", async (dir) => {
      await runCli([
        "init",
        "--cwd",
        dir,
        "--name",
        "compact read budget",
        "--metric-name",
        "seconds",
        "--goal",
        "Keep compact read commands fast.",
      ]);

      const commands = [
        ["state", "--cwd", dir, "--compact"],
        ["recommend-next", "--cwd", dir, "--compact"],
        ["guide", "--cwd", dir, "--compact"],
      ];
      const budgetMs = 1500;
      for (const command of commands) {
        let bestElapsedMs = Number.POSITIVE_INFINITY;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const started = performance.now();
          const result = await runSpawnedCli(command);
          const elapsedMs = performance.now() - started;
          assert.equal(result.code, 0, result.stderr);
          bestElapsedMs = Math.min(bestElapsedMs, elapsedMs);
        }
        assert.ok(
          bestElapsedMs < budgetMs,
          `${command[0]} --compact best-of-3 took ${Math.round(bestElapsedMs)} ms, budget ${budgetMs} ms`,
        );
      }
    });
  },
);
