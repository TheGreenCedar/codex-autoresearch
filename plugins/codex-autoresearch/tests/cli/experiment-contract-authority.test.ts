import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { quoteForShell } from "../helpers/process.js";
import { runCli, setupFixture, withTempDir } from "../helpers/cli-test-context.js";
import { createExecutionSpec, createExperimentContract } from "../../lib/experiment-contract.js";

test("new-segment accepts one executable contract and next runs its evaluator and checks", async () => {
  await withTempDir("experiment-contract-authority", async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await mkdir(path.join(dir, "contract"), { recursive: true });
    await setupFixture(dir, {
      name: "contract authority",
      goal: "Raise the accepted score without changing the evaluator.",
      metricName: "score",
      direction: "higher",
    });
    await writeFile(
      path.join(dir, "contract", "evaluator.mjs"),
      [
        'import { appendFileSync } from "node:fs";',
        'appendFileSync("evaluator-runs.txt", "accepted\\n");',
        'console.log("METRIC score=2");',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(dir, "contract", "checks.mjs"),
      [
        'import { appendFileSync } from "node:fs";',
        'appendFileSync("check-runs.txt", "accepted\\n");',
        "",
      ].join("\n"),
      "utf8",
    );
    const evaluator = `${quoteForShell(process.execPath)} contract/evaluator.mjs`;
    const checks = `${quoteForShell(process.execPath)} contract/checks.mjs`;
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      `${JSON.stringify(
        {
          benchmarkCommand: evaluator,
          checksAuthoritative: true,
          checksCommand: checks,
          commitPaths: ["src"],
          maxIterations: 4,
          protectedBenchmarkPaths: ["contract/evaluator.mjs", "contract/checks.mjs"],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const segment = await runCli([
      "new-segment",
      "--cwd",
      dir,
      "--benchmark-command",
      evaluator,
      "--checks-command",
      checks,
      "--reason",
      "accept executable authority",
      "--yes",
    ]);
    assert.equal(segment.code, 0, segment.stderr);
    const segmentPayload = JSON.parse(segment.stdout);
    assert.equal(segmentPayload.experimentContract.status, "accepted");

    const ledgerAfterSegment = (await readFile(path.join(dir, "autoresearch.jsonl"), "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    const accepted = ledgerAfterSegment.filter(
      (entry) => entry.type === "experiment-contract-accepted",
    );
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].source, "legacy-derivation");
    assert.equal(
      ledgerAfterSegment.filter((entry) => entry.type === "config").length,
      2,
      "acceptance must not create another segment transition",
    );

    const next = await runCli(["next", "--cwd", dir]);
    assert.equal(next.code, 0, next.stderr);
    const nextPayload = JSON.parse(next.stdout);
    assert.equal(nextPayload.run.executionAuthority, "accepted-contract");
    assert.equal(nextPayload.run.experimentContractDigest, accepted[0].contract.contractDigest);
    assert.equal(await readFile(path.join(dir, "evaluator-runs.txt"), "utf8"), "accepted\n");
    assert.equal(await readFile(path.join(dir, "check-runs.txt"), "utf8"), "accepted\n");
  });
});

test("next rejects a compatibility command whose canonical digest differs from the accepted evaluator", async () => {
  await withTempDir("experiment-contract-mismatch", async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await setupFixture(dir, {
      name: "contract mismatch",
      goal: "Reject evaluator substitution",
      metricName: "score",
      direction: "higher",
    });
    const acceptedEvaluator = `${quoteForShell(process.execPath)} -e "require('node:fs').writeFileSync('accepted-ran.txt','yes'); console.log('METRIC score=1')"`;
    const acceptedChecks = `${quoteForShell(process.execPath)} -e "process.exit(0)"`;
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      `${JSON.stringify(
        {
          benchmarkCommand: acceptedEvaluator,
          checksAuthoritative: true,
          checksCommand: acceptedChecks,
          commitPaths: ["src"],
          maxIterations: 3,
        },
        null,
        2,
      )}\n`,
    );
    const segment = await runCli([
      "new-segment",
      "--cwd",
      dir,
      "--benchmark-command",
      acceptedEvaluator,
      "--checks-command",
      acceptedChecks,
      "--yes",
    ]);
    assert.equal(segment.code, 0, segment.stderr);

    const override = `${quoteForShell(process.execPath)} -e "require('node:fs').writeFileSync('override-ran.txt','yes'); console.log('METRIC score=99')"`;
    const next = await runCli(["next", "--cwd", dir, "--command", override]);
    assert.notEqual(next.code, 0);
    assert.match(next.stderr, /accepted.*digest|new-segment/i);
    await assert.rejects(readFile(path.join(dir, "accepted-ran.txt")), /ENOENT/);
    await assert.rejects(readFile(path.join(dir, "override-ran.txt")), /ENOENT/);
  });
});

test("next executes an accepted separator command as argv without shell expansion", async () => {
  await withTempDir("experiment-contract-argv", async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await setupFixture(dir, {
      name: "argv authority",
      goal: "Preserve evaluator argument boundaries",
      metricName: "score",
      direction: "higher",
    });
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      `${JSON.stringify(
        {
          checksCommand: `${quoteForShell(process.execPath)} -e "process.exit(0)"`,
          commitPaths: ["src"],
          maxIterations: 3,
        },
        null,
        2,
      )}\n`,
    );
    const literal = "$HOME; $(printf injected)";
    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--",
      process.execPath,
      "-e",
      "require('node:fs').writeFileSync('argument.txt', process.argv[1]); console.log('METRIC score=1')",
      literal,
    ]);

    assert.equal(next.code, 0, next.stderr);
    assert.equal(await readFile(path.join(dir, "argument.txt"), "utf8"), literal);
  });
});

test("next materializes accepted environment values without persisting secrets", async () => {
  await withTempDir("experiment-contract-environment", async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await setupFixture(dir, {
      name: "environment authority",
      goal: "Run with the accepted environment",
      metricName: "score",
      direction: "higher",
    });
    const evaluator = `${quoteForShell(process.execPath)} -e "require('node:fs').writeFileSync('observed-env.txt', process.env.CONTRACT_VALUE || ''); console.log('METRIC score=1')"`;
    const checks = `${quoteForShell(process.execPath)} -e "process.exit(0)"`;
    await writeFile(path.join(dir, "contract.env"), "CONTRACT_VALUE=exact-secret\n");
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      `${JSON.stringify(
        {
          benchmarkCommand: evaluator,
          checksCommand: checks,
          commitPaths: ["src"],
          maxIterations: 3,
        },
        null,
        2,
      )}\n`,
    );
    const segment = await runCli([
      "new-segment",
      "--cwd",
      dir,
      "--benchmark-command",
      evaluator,
      "--checks-command",
      checks,
      "--packet-env-file",
      "contract.env",
      "--yes",
    ]);
    assert.equal(segment.code, 0, segment.stderr);
    assert.doesNotMatch(
      await readFile(path.join(dir, "autoresearch.jsonl"), "utf8"),
      /exact-secret/,
    );

    const next = await runCli(["next", "--cwd", dir]);
    assert.equal(next.code, 0, next.stderr);
    assert.equal(JSON.parse(next.stdout).run.parsedPrimary, 1);
    assert.equal(await readFile(path.join(dir, "observed-env.txt"), "utf8"), "exact-secret");
  });
});

test("next executes every accepted check exactly once", async () => {
  await withTempDir("experiment-contract-check-list", async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await setupFixture(dir, {
      name: "check list authority",
      goal: "Run the whole accepted check list",
      metricName: "score",
      direction: "higher",
    });
    const evaluator = `${quoteForShell(process.execPath)} -e "console.log('METRIC score=1')"`;
    const firstCheck = `${quoteForShell(process.execPath)} -e "require('node:fs').appendFileSync('first-check.txt','run\\n')"`;
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      `${JSON.stringify(
        {
          benchmarkCommand: evaluator,
          checksAuthoritative: true,
          checksCommand: firstCheck,
          commitPaths: ["src"],
          maxIterations: 3,
        },
        null,
        2,
      )}\n`,
    );
    const segment = await runCli([
      "new-segment",
      "--cwd",
      dir,
      "--benchmark-command",
      evaluator,
      "--checks-command",
      firstCheck,
      "--yes",
    ]);
    assert.equal(segment.code, 0, segment.stderr);

    const ledgerPath = path.join(dir, "autoresearch.jsonl");
    const entries = (await readFile(ledgerPath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    const acceptedEvent = entries.findLast(
      (entry) => entry.type === "experiment-contract-accepted",
    );
    const firstExecution = acceptedEvent.contract.checks[0].execution;
    const secondExecution = createExecutionSpec({
      command: {
        kind: "shell",
        shell: process.platform === "win32" ? "powershell" : "bash",
        script: `${quoteForShell(process.execPath)} -e "require('node:fs').appendFileSync('second-check.txt','run\\n')"`,
      },
      relativeWorkingDirectory: firstExecution.relativeWorkingDirectory,
      environment: firstExecution.environment,
      timeoutSeconds: firstExecution.timeoutSeconds,
      parser: firstExecution.parser,
      protectedInputs: firstExecution.protectedInputs,
      runner: firstExecution.runner,
    });
    const contract = createExperimentContract({
      ...acceptedEvent.contract,
      checks: [
        acceptedEvent.contract.checks[0],
        { id: "second", authority: "authoritative", execution: secondExecution },
      ],
      keepPolicy: {
        ...acceptedEvent.contract.keepPolicy,
        authoritativeCheckIds: ["second"],
      },
      contractDigest: undefined,
    });
    acceptedEvent.contract = contract;
    acceptedEvent.eventId = `experiment-contract-accepted:${acceptedEvent.segment}:${contract.contractDigest}`;
    await writeFile(ledgerPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

    const next = await runCli(["next", "--cwd", dir]);
    assert.equal(next.code, 0, next.stderr);
    assert.equal(await readFile(path.join(dir, "first-check.txt"), "utf8"), "run\n");
    assert.equal(await readFile(path.join(dir, "second-check.txt"), "utf8"), "run\n");
  });
});

test("next does not reselect an evaluator after contract acceptance", async () => {
  await withTempDir("experiment-contract-no-reselection", async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await setupFixture(dir, {
      name: "no evaluator reselection",
      goal: "Keep accepted execution authoritative",
      metricName: "score",
      direction: "higher",
    });
    const evaluator = `${quoteForShell(process.execPath)} -e "console.log('METRIC score=1')"`;
    const checks = `${quoteForShell(process.execPath)} -e "process.exit(0)"`;
    const configPath = path.join(dir, "autoresearch.config.json");
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          benchmarkCommand: evaluator,
          checksCommand: checks,
          commitPaths: ["src"],
          maxIterations: 3,
        },
        null,
        2,
      )}\n`,
    );
    const segment = await runCli([
      "new-segment",
      "--cwd",
      dir,
      "--benchmark-command",
      evaluator,
      "--checks-command",
      checks,
      "--yes",
    ]);
    assert.equal(segment.code, 0, segment.stderr);
    await writeFile(
      configPath,
      `${JSON.stringify(
        { checksCommand: checks, commitPaths: ["src"], maxIterations: 3 },
        null,
        2,
      )}\n`,
    );

    const next = await runCli(["next", "--cwd", dir]);
    assert.equal(next.code, 0, next.stderr);
    const payload = JSON.parse(next.stdout);
    assert.ok(payload.run, JSON.stringify(payload, null, 2));
    assert.equal(payload.run.executionAuthority, "accepted-contract");
  });
});

test("the first legacy next mutation appends one acceptance event without a segment transition", async () => {
  await withTempDir("experiment-contract-migration", async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await setupFixture(dir, {
      name: "legacy migration",
      goal: "Accept legacy authority on first mutation",
      metricName: "score",
      direction: "higher",
    });
    const evaluator = `${quoteForShell(process.execPath)} -e "console.log('METRIC score=1')"`;
    const checks = `${quoteForShell(process.execPath)} -e "process.exit(0)"`;
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      `${JSON.stringify(
        {
          benchmarkCommand: evaluator,
          checksCommand: checks,
          commitPaths: ["src"],
          maxIterations: 3,
        },
        null,
        2,
      )}\n`,
    );

    const next = await runCli(["next", "--cwd", dir]);
    assert.equal(next.code, 0, next.stderr);
    const entries = (await readFile(path.join(dir, "autoresearch.jsonl"), "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    const acceptanceEvents = entries.filter(
      (entry) => entry.type === "experiment-contract-accepted",
    );
    assert.equal(acceptanceEvents.length, 1);
    assert.equal(acceptanceEvents[0].source, "legacy-derivation");
    assert.equal(acceptanceEvents[0].segment, 0);
    assert.match(acceptanceEvents[0].eventId, /^experiment-contract-accepted:0:[a-f0-9]{64}$/);
    assert.equal(entries.filter((entry) => entry.type === "config").length, 1);
  });
});

test("the first legacy next mutation rejects packet evaluator disagreement before acceptance", async () => {
  await withTempDir("experiment-contract-packet-conflict", async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await setupFixture(dir, {
      name: "packet conflict",
      goal: "Reject stale packet authority before accepting the contract",
      metricName: "score",
      direction: "higher",
    });
    const configuredEvaluator = `${quoteForShell(process.execPath)} -e "require('node:fs').writeFileSync('configured-ran.txt','yes'); console.log('METRIC score=1')"`;
    const packetEvaluator = `${quoteForShell(process.execPath)} -e "require('node:fs').writeFileSync('packet-ran.txt','yes'); console.log('METRIC score=99')"`;
    const checks = `${quoteForShell(process.execPath)} -e "process.exit(0)"`;
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      `${JSON.stringify(
        {
          benchmarkCommand: configuredEvaluator,
          checksCommand: checks,
          commitPaths: ["src"],
          maxIterations: 3,
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(dir, "autoresearch.last-run.json"),
      `${JSON.stringify(
        {
          workDir: dir,
          history: {
            segment: 0,
            workDir: dir,
            command: packetEvaluator,
            benchmarkContract: {
              command: packetEvaluator,
              checksCommand: checks,
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const next = await runCli(["next", "--cwd", dir]);
    assert.notEqual(next.code, 0);
    assert.match(next.stderr, /evaluator\.command:.*do not agree/i);
    const entries = (await readFile(path.join(dir, "autoresearch.jsonl"), "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(
      entries.filter((entry) => entry.type === "experiment-contract-accepted").length,
      0,
    );
    await assert.rejects(readFile(path.join(dir, "configured-ran.txt")), /ENOENT/);
    await assert.rejects(readFile(path.join(dir, "packet-ran.txt")), /ENOENT/);
  });
});

test("next refuses an expired accepted plugin wall-clock budget before evaluator execution", async () => {
  await withTempDir("experiment-contract-wall-clock", async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await setupFixture(dir, {
      name: "wall clock authority",
      goal: "Stop before expired evaluation",
      metricName: "score",
      direction: "higher",
    });
    const evaluator = `${quoteForShell(process.execPath)} -e "require('node:fs').writeFileSync('evaluator-ran.txt','yes'); console.log('METRIC score=1')"`;
    const checks = `${quoteForShell(process.execPath)} -e "process.exit(0)"`;
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      `${JSON.stringify(
        {
          benchmarkCommand: evaluator,
          checksCommand: checks,
          commitPaths: ["src"],
          maxIterations: 3,
          wallClockBudgetSeconds: 5,
        },
        null,
        2,
      )}\n`,
    );
    const segment = await runCli([
      "new-segment",
      "--cwd",
      dir,
      "--benchmark-command",
      evaluator,
      "--checks-command",
      checks,
      "--yes",
    ]);
    assert.equal(segment.code, 0, segment.stderr);

    const ledgerPath = path.join(dir, "autoresearch.jsonl");
    const entries = (await readFile(ledgerPath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    const acceptance = entries.findLast((entry) => entry.type === "experiment-contract-accepted");
    acceptance.timestamp = "2000-01-01T00:00:00.000Z";
    await writeFile(ledgerPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

    const next = await runCli(["next", "--cwd", dir]);
    assert.notEqual(next.code, 0);
    assert.match(next.stderr, /accepted plugin wall-clock ceiling reached/i);
    await assert.rejects(readFile(path.join(dir, "evaluator-ran.txt")), /ENOENT/);
  });
});
