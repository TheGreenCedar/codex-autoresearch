import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { quoteForAcceptedShell } from "../helpers/process.js";
import { git, runCli, setupFixture, withTempDir } from "../helpers/cli-test-context.js";
import { createExecutionSpec, createExperimentContract } from "../../lib/experiment-contract.js";

test("an interrupted segment transition never inherits old contract pauses", async () => {
  await withTempDir("segment-contract-interruption", async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    const benchmark = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC score=2')"`;
    const checks = `${quoteForAcceptedShell(process.execPath)} -e "process.exit(0)"`;
    const setup = await setupFixture(dir, {
      acceptedContract: true,
      benchmarkCommand: benchmark,
      checksCommand: checks,
      direction: "higher",
      goal: "Keep segment authority local to its accepted epoch.",
      metricName: "score",
      name: "segment interruption",
      packetBudget: 8,
      scope: "src",
    });
    assert.equal(setup.code, 0, setup.stderr);

    const ledgerPath = path.join(dir, "autoresearch.jsonl");
    const initialRecords = (await readFile(ledgerPath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    const accepted = initialRecords.find(
      (record) => record.type === "experiment-contract-accepted",
    );
    assert.ok(accepted);
    const oldCandidate = (run: number) => ({
      run,
      segment: 0,
      status: "discard",
      metric: 2,
      runPurpose: "candidate",
      evaluationAuthority: "accepted-contract",
      candidateOrigin: { kind: "working-tree" },
      experimentContractDigest: accepted.contract.contractDigest,
      preconditionEpoch: accepted.eventId,
      learning: { kind: "none", changedBelief: null, evidence: [] },
    });
    const interruptedConfig = {
      type: "config",
      name: "segment interruption",
      metricName: "score",
      bestDirection: "higher",
      segmentReason: "simulated interruption before contract acceptance",
      timestamp: "2026-08-24T12:00:00.000Z",
    };
    await writeFile(
      ledgerPath,
      `${[...initialRecords, oldCandidate(1), oldCandidate(2), interruptedConfig]
        .map((record) => JSON.stringify(record))
        .join("\n")}\n`,
    );
    const beforeRead = await readFile(ledgerPath, "utf8");

    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(state.code, 0, state.stderr);
    const plan = JSON.parse(state.stdout).decisionPlan;
    assert.equal(plan.contractDigest, "");
    assert.equal(plan.primaryBlockerCode, "legacy-contract-acceptance-required");
    assert.equal(plan.requiredEvidence.diagnosticCodes.includes("no-learning-pause"), false);
    assert.equal(
      await readFile(ledgerPath, "utf8"),
      beforeRead,
      "read-only state must not migrate",
    );

    const next = await runCli(["next", "--cwd", dir]);
    assert.equal(next.code, 0, next.stderr);
    const resultingRecords = (await readFile(ledgerPath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    const acceptanceEvents = resultingRecords.filter(
      (record) => record.type === "experiment-contract-accepted",
    );
    assert.equal(acceptanceEvents.length, 2);
    assert.equal(acceptanceEvents.at(-1).segment, 1);
    assert.equal(
      resultingRecords.filter((record) => record.type === "config").length,
      initialRecords.filter((record) => record.type === "config").length + 1,
      "acceptance recovery must not create another segment",
    );
  });
});

async function setupKeepPolicyFixture(
  dir: string,
  input: {
    baseline: number;
    candidate: number;
    config?: Record<string, unknown>;
    supplementalChecks?: boolean;
  },
) {
  await mkdir(path.join(dir, "src"), { recursive: true });
  await mkdir(path.join(dir, "contract"), { recursive: true });
  await writeFile(
    path.join(dir, "contract", "evaluator.mjs"),
    `console.log("METRIC score=${input.candidate}");\n`,
  );
  await writeFile(path.join(dir, "contract", "checks.mjs"), "process.exit(0);\n");
  const evaluator = `${quoteForAcceptedShell(process.execPath)} contract/evaluator.mjs`;
  const checks = `${quoteForAcceptedShell(process.execPath)} contract/checks.mjs`;
  const setup = await setupFixture(dir, {
    name: "mechanical keep policy",
    goal: "Only keep contract-qualified improvements.",
    metricName: "score",
    direction: "higher",
    completeContract: true,
    benchmarkCommand: evaluator,
    checksCommand: checks,
    packetBudget: 8,
    scope: "src",
  });
  assert.equal(setup.code, 0, setup.stderr);
  const configPath = path.join(dir, "autoresearch.config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        ...config,
        checksAuthoritative: !input.supplementalChecks,
        commitPaths: ["src"],
        editableScope: ["src"],
        maxIterations: 8,
        protectedBenchmarkPaths: ["contract/evaluator.mjs"],
        ...(!input.supplementalChecks ? { checkImplementationPaths: ["contract/checks.mjs"] } : {}),
        ...input.config,
      },
      null,
      2,
    )}\n`,
  );
  const accepted = await runCli([
    "new-segment",
    "--cwd",
    dir,
    "--reason",
    "Accept the mechanical keep-policy fixture contract",
    "--yes",
  ]);
  assert.equal(accepted.code, 0, accepted.stderr);
  const baseline = await runCli([
    "log",
    "--cwd",
    dir,
    "--metric",
    String(input.baseline),
    "--status",
    "measure",
    "--description",
    "Reference measurement",
  ]);
  assert.equal(baseline.code, 0, baseline.stderr);
}

async function assertMechanicalKeepRejected(dir: string, message: RegExp) {
  const next = await runCli(["next", "--cwd", dir]);
  assert.equal(next.code, 0, next.stderr);
  const payload = JSON.parse(next.stdout);
  assert.equal(payload.decision.allowedStatuses.includes("keep"), false);
  assert.match(payload.run.contractKeepEligibility.reasons.join("\n"), message);

  const packetPath = path.join(dir, "autoresearch.last-run.json");
  const packet = JSON.parse(await readFile(packetPath, "utf8"));
  packet.decision.allowedStatuses = ["keep", "discard", "measure"];
  packet.decision.suggestedStatus = "keep";
  await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`);
  const forgedKeep = await runCli([
    "log",
    "--cwd",
    dir,
    "--from-last",
    "--status",
    "keep",
    "--description",
    "Forged keep request",
  ]);
  assert.notEqual(forgedKeep.code, 0);
  assert.match(forgedKeep.stderr, message);
}

async function setupGitContractFixture(dir: string) {
  await mkdir(path.join(dir, "src"), { recursive: true });
  await mkdir(path.join(dir, "contract"), { recursive: true });
  await setupFixture(dir, {
    name: "git contract authority",
    goal: "Keep repository authority bound to the accepted checkout.",
    metricName: "score",
    direction: "higher",
  });
  await writeFile(path.join(dir, "src", "score.txt"), "1\n");
  await writeFile(path.join(dir, "README.md"), "initial\n");
  await writeFile(
    path.join(dir, "contract", "evaluator.mjs"),
    [
      'import { readFileSync } from "node:fs";',
      'const score = readFileSync("src/score.txt", "utf8").trim();',
      "console.log(`METRIC score=${score}`);",
      "",
    ].join("\n"),
  );
  await writeFile(path.join(dir, "contract", "checks.mjs"), "process.exit(0);\n");
  const evaluator = `${quoteForAcceptedShell(process.execPath)} contract/evaluator.mjs`;
  const checks = `${quoteForAcceptedShell(process.execPath)} contract/checks.mjs`;
  await writeFile(
    path.join(dir, "autoresearch.config.json"),
    `${JSON.stringify(
      {
        benchmarkCommand: evaluator,
        checkImplementationPaths: ["contract/checks.mjs"],
        checksAuthoritative: true,
        checksCommand: checks,
        commitPaths: ["src"],
        maxIterations: 10,
        metricSemantics: { kind: "maximize", minimumImprovement: 0 },
        noiseModel: { kind: "deterministic" },
        protectedBenchmarkPaths: ["contract/evaluator.mjs"],
      },
      null,
      2,
    )}\n`,
  );
  await git(dir, ["init"]);
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "initial"]);
  return { evaluator, checks };
}

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
    const evaluator = `${quoteForAcceptedShell(process.execPath)} contract/evaluator.mjs`;
    const checks = `${quoteForAcceptedShell(process.execPath)} contract/checks.mjs`;
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
    const acceptedEvaluator = `${quoteForAcceptedShell(process.execPath)} -e "require('node:fs').writeFileSync('accepted-ran.txt','yes'); console.log('METRIC score=1')"`;
    const acceptedChecks = `${quoteForAcceptedShell(process.execPath)} -e "process.exit(0)"`;
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

    const override = `${quoteForAcceptedShell(process.execPath)} -e "require('node:fs').writeFileSync('override-ran.txt','yes'); console.log('METRIC score=99')"`;
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
          checksCommand: `${quoteForAcceptedShell(process.execPath)} -e "process.exit(0)"`,
          commitPaths: ["src"],
          maxIterations: 3,
        },
        null,
        2,
      )}\n`,
    );
    const literal = "$HOME; $(printf injected)";
    const accepted = await runCli([
      "new-segment",
      "--cwd",
      dir,
      "--reason",
      "Accept argv evaluator authority",
      "--yes",
      "--",
      process.execPath,
      "-e",
      "require('node:fs').writeFileSync('argument.txt', process.argv[1]); console.log('METRIC score=1')",
      literal,
    ]);
    assert.equal(accepted.code, 0, accepted.stderr);

    const next = await runCli(["next", "--cwd", dir]);

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
    const evaluator = `${quoteForAcceptedShell(process.execPath)} -e "require('node:fs').writeFileSync('observed-env.txt', process.env.CONTRACT_VALUE || ''); console.log('METRIC score=1')"`;
    const checks = `${quoteForAcceptedShell(process.execPath)} -e "process.exit(0)"`;
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
    const evaluator = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC score=1')"`;
    const firstCheck = `${quoteForAcceptedShell(process.execPath)} -e "require('node:fs').appendFileSync('first-check.txt','run\\n')"`;
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
        script: `${quoteForAcceptedShell(process.execPath)} -e "require('node:fs').appendFileSync('second-check.txt','run\\n')"`,
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
        {
          id: "second",
          authority: "supplemental",
          reason: "The synthetic test check has no independently protected implementation input.",
          execution: secondExecution,
        },
      ],
      keepPolicy: {
        ...acceptedEvent.contract.keepPolicy,
        authoritativeCheckIds: acceptedEvent.contract.keepPolicy.authoritativeCheckIds,
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
    const evaluator = `${quoteForAcceptedShell(process.execPath)} -e "require('node:fs').writeFileSync('accepted-ran.txt','yes'); console.log('METRIC score=1')"`;
    const checks = `${quoteForAcceptedShell(process.execPath)} -e "process.exit(0)"`;
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
    assert.equal(JSON.parse(next.stdout).run.parsedPrimary, 1);
    assert.equal(await readFile(path.join(dir, "accepted-ran.txt"), "utf8"), "yes");
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
    const evaluator = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC score=1')"`;
    const checks = `${quoteForAcceptedShell(process.execPath)} -e "process.exit(0)"`;
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

test("the first complete legacy config mutation appends one acceptance event", async () => {
  await withTempDir("experiment-contract-config-migration", async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await setupFixture(dir, {
      name: "legacy config migration",
      goal: "Accept legacy authority before the first configuration mutation",
      metricName: "score",
      direction: "higher",
    });
    const evaluator = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC score=1')"`;
    const checks = `${quoteForAcceptedShell(process.execPath)} -e "process.exit(0)"`;
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      `${JSON.stringify(
        {
          benchmarkCommand: evaluator,
          checksCommand: checks,
          commitPaths: ["src"],
          maxIterations: 4,
        },
        null,
        2,
      )}\n`,
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const configured = await runCli(["config", "--cwd", dir, "--max-iterations", "4"]);
      assert.equal(configured.code, 0, configured.stderr);
    }

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
    const configuredEvaluator = `${quoteForAcceptedShell(process.execPath)} -e "require('node:fs').writeFileSync('configured-ran.txt','yes'); console.log('METRIC score=1')"`;
    const packetEvaluator = `${quoteForAcceptedShell(process.execPath)} -e "require('node:fs').writeFileSync('packet-ran.txt','yes'); console.log('METRIC score=99')"`;
    const checks = `${quoteForAcceptedShell(process.execPath)} -e "process.exit(0)"`;
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
    const evaluator = `${quoteForAcceptedShell(process.execPath)} -e "require('node:fs').writeFileSync('evaluator-ran.txt','yes'); console.log('METRIC score=1')"`;
    const checks = `${quoteForAcceptedShell(process.execPath)} -e "process.exit(0)"`;
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

test("unknown noise blocks keep until the accepted qualification repeats exist", async () => {
  await withTempDir("contract-keep-unknown-noise", async (dir) => {
    await setupKeepPolicyFixture(dir, {
      baseline: 10,
      candidate: 12,
      config: { noiseModel: { kind: "unknown", qualificationRepeats: 2 } },
    });
    await assertMechanicalKeepRejected(dir, /noise qualification/i);
  });
});

test("threshold metric semantics block keep below the accepted target", async () => {
  await withTempDir("contract-keep-threshold", async (dir) => {
    await setupKeepPolicyFixture(dir, {
      baseline: 10,
      candidate: 12,
      config: {
        metricSemantics: { kind: "threshold", comparator: ">=", target: 20 },
        noiseModel: { kind: "deterministic" },
      },
    });
    await assertMechanicalKeepRejected(dir, /threshold|metric comparison/i);
  });
});

test("minimum improvement blocks keep when directional gain is too small", async () => {
  await withTempDir("contract-keep-minimum-improvement", async (dir) => {
    await setupKeepPolicyFixture(dir, {
      baseline: 10,
      candidate: 10.5,
      config: {
        metricSemantics: { kind: "maximize", minimumImprovement: 1 },
        noiseModel: { kind: "deterministic" },
      },
    });
    await assertMechanicalKeepRejected(dir, /minimum improvement/i);
  });
});

test("supplemental-only checks cannot authorize keep", async () => {
  await withTempDir("contract-keep-supplemental", async (dir) => {
    await setupKeepPolicyFixture(dir, {
      baseline: 10,
      candidate: 12,
      supplementalChecks: true,
      config: { noiseModel: { kind: "deterministic" } },
    });
    await assertMechanicalKeepRejected(dir, /authoritative check/i);
  });
});

test("manual log cannot bypass accepted evaluation authority for keep", async () => {
  await withTempDir("contract-keep-manual-bypass", async (dir) => {
    await setupKeepPolicyFixture(dir, {
      baseline: 10,
      candidate: 12,
      config: {
        metricSemantics: { kind: "maximize", minimumImprovement: 1 },
        noiseModel: { kind: "deterministic" },
      },
    });
    const next = await runCli(["next", "--cwd", dir]);
    assert.equal(next.code, 0, next.stderr);

    const manualKeep = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "12",
      "--status",
      "keep",
      "--description",
      "Bypass accepted packet evidence",
    ]);
    assert.notEqual(manualKeep.code, 0);
    assert.match(manualKeep.stderr, /accepted.*evaluation|accepted.*packet/i);
  });
});

test("entry-limited candidate fingerprints cannot qualify noise or authorize keep", async () => {
  await withTempDir("contract-keep-truncated-candidate", async (dir) => {
    await setupKeepPolicyFixture(dir, {
      baseline: 10,
      candidate: 12,
      config: { noiseModel: { kind: "unknown", qualificationRepeats: 1 } },
    });
    for (let index = 0; index < 505; index += 1) {
      await writeFile(
        path.join(dir, "src", `candidate-${String(index).padStart(3, "0")}.txt`),
        "x\n",
      );
    }

    const next = await runCli(["next", "--cwd", dir]);
    assert.notEqual(next.code, 0);
    assert.match(
      next.stderr,
      /candidate fingerprint.*entry limit|incomplete candidate fingerprint/i,
    );
    await assert.rejects(readFile(path.join(dir, "autoresearch.last-run.json")), /ENOENT/);
  });
});

test("next uses the accepted evaluator runner metric limit", async () => {
  await withTempDir("contract-runner-metric-limit", async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await setupFixture(dir, {
      name: "runner metric limit",
      goal: "Use every accepted runner field.",
      metricName: "score",
      direction: "higher",
    });
    const evaluator = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC first=1\\nMETRIC second=2\\nMETRIC score=3')"`;
    const checks = `${quoteForAcceptedShell(process.execPath)} -e "process.exit(0)"`;
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      `${JSON.stringify(
        {
          benchmarkCommand: evaluator,
          checksCommand: checks,
          commitPaths: ["src"],
          maxIterations: 4,
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
    const evaluatorExecution = acceptance.contract.evaluator.execution;
    const limitedExecution = createExecutionSpec({
      command: evaluatorExecution.command,
      relativeWorkingDirectory: evaluatorExecution.relativeWorkingDirectory,
      environment: evaluatorExecution.environment,
      timeoutSeconds: evaluatorExecution.timeoutSeconds,
      parser: evaluatorExecution.parser,
      protectedInputs: evaluatorExecution.protectedInputs,
      runner: { ...evaluatorExecution.runner, metricLimit: 1 },
    });
    const contract = createExperimentContract({
      ...acceptance.contract,
      evaluator: { ...acceptance.contract.evaluator, execution: limitedExecution },
      contractDigest: undefined,
    });
    acceptance.contract = contract;
    acceptance.eventId = `experiment-contract-accepted:${acceptance.segment}:${contract.contractDigest}`;
    await writeFile(ledgerPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

    const next = await runCli(["next", "--cwd", dir]);
    assert.equal(next.code, 0, next.stderr);
    const payload = JSON.parse(next.stdout);
    assert.equal(payload.run.parsedPrimary, 3);
    assert.equal(payload.run.metricsTruncated, true);
    assert.deepEqual(payload.run.parsedMetrics, { first: 1, score: 3 });
  });
});

test("explicit timeout conflicts with the accepted configured timeout", async () => {
  await withTempDir("contract-timeout-source-conflict", async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await setupFixture(dir, {
      name: "timeout source conflict",
      goal: "Reject shadowed execution limits.",
      metricName: "score",
      direction: "higher",
    });
    const evaluator = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC score=1')"`;
    const checks = `${quoteForAcceptedShell(process.execPath)} -e "process.exit(0)"`;
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      `${JSON.stringify(
        {
          benchmarkCommand: evaluator,
          checksCommand: checks,
          commitPaths: ["src"],
          maxIterations: 4,
          timeoutSeconds: 60,
        },
        null,
        2,
      )}\n`,
    );
    const accepted = await runCli([
      "new-segment",
      "--cwd",
      dir,
      "--reason",
      "Accept the configured timeout authority",
      "--yes",
    ]);
    assert.equal(accepted.code, 0, accepted.stderr);

    const next = await runCli(["next", "--cwd", dir, "--timeout-seconds", "30"]);
    assert.notEqual(next.code, 0);
    assert.match(next.stderr, /evaluator\.timeoutSeconds|do not agree/i);
    const ledger = await readFile(path.join(dir, "autoresearch.jsonl"), "utf8");
    assert.match(ledger, /experiment-contract-accepted/);
  });
});

test("accepted clean-tree policy permits candidate edits only inside editable scope", async () => {
  await withTempDir("contract-editable-tree", async (dir) => {
    const { evaluator, checks } = await setupGitContractFixture(dir);
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
    await writeFile(path.join(dir, "src", "score.txt"), "2\n");

    const next = await runCli(["next", "--cwd", dir]);
    assert.equal(next.code, 0, next.stderr);
    assert.equal(JSON.parse(next.stdout).run.parsedPrimary, 2);
  });
});

test("accepted repository authority rejects an unauthorized HEAD change", async () => {
  await withTempDir("contract-head-drift", async (dir) => {
    const { evaluator, checks } = await setupGitContractFixture(dir);
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
    await git(dir, ["commit", "--allow-empty", "-m", "unauthorized head"]);

    const next = await runCli(["next", "--cwd", dir]);
    assert.notEqual(next.code, 0);
    assert.match(next.stderr, /expected HEAD|repository revision|new segment/i);
  });
});

test("accepted tree policy rejects dirty-state drift outside editable scope", async () => {
  await withTempDir("contract-tree-drift", async (dir) => {
    const { evaluator, checks } = await setupGitContractFixture(dir);
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
    await writeFile(path.join(dir, "README.md"), "unauthorized drift\n");

    const next = await runCli(["next", "--cwd", dir]);
    assert.notEqual(next.code, 0);
    assert.match(next.stderr, /dirty|tree policy|outside editable/i);
  });
});

test("accepted initial-dirty policy permits its baseline but rejects later outside-scope drift", async () => {
  await withTempDir("contract-initial-dirty-drift", async (dir) => {
    const { evaluator, checks } = await setupGitContractFixture(dir);
    await writeFile(path.join(dir, "README.md"), "initial dirty state\n");
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

    const first = await runCli(["next", "--cwd", dir]);
    assert.equal(first.code, 0, first.stderr);
    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "measure",
      "--description",
      "Initial dirty baseline",
    ]);
    assert.equal(logged.code, 0, logged.stderr);
    await writeFile(path.join(dir, "README.md"), "changed dirty state\n");

    const drift = await runCli(["next", "--cwd", dir]);
    assert.notEqual(drift.code, 0);
    assert.match(drift.stderr, /dirty|tree policy|outside editable/i);
  });
});

test("ledger-backed kept commits advance the accepted expected HEAD", async () => {
  await withTempDir("contract-kept-head", async (dir) => {
    const { evaluator, checks } = await setupGitContractFixture(dir);
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

    await writeFile(path.join(dir, "src", "score.txt"), "2\n");
    const candidate = await runCli(["next", "--cwd", dir]);
    assert.equal(candidate.code, 0, candidate.stderr);
    assert.equal(JSON.parse(candidate.stdout).decision.allowedStatuses.includes("keep"), true);
    const kept = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Keep accepted candidate",
    ]);
    assert.equal(kept.code, 0, kept.stderr);

    const afterKeep = await runCli(["next", "--cwd", dir]);
    assert.equal(afterKeep.code, 0, afterKeep.stderr);
    assert.equal(JSON.parse(afterKeep.stdout).run.executionAuthority, "accepted-contract");
  });
});
