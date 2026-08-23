import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  contractCandidateFingerprintForWorkDir,
  contractStopStatus,
  createExecutionSpec,
  createExperimentContract,
  deriveExperimentContract,
  noiseQualificationStatus,
  verifyExecutionSpecForWorkDir,
  type ExecutableCommand,
} from "../lib/experiment-contract.js";
import { runGit, withTempDir as withNamedTempDir } from "./helpers/process.js";
import { buildResearchIntegrity } from "../lib/truth-signals.js";
import { buildProtectedBenchmarkSnapshot } from "../lib/benchmark/contract-guards.js";
import { runExecutableCommand } from "../lib/runner.js";

const execution = (command: ExecutableCommand) =>
  createExecutionSpec({
    command,
    relativeWorkingDirectory: ".",
    environment: { inheritance: "minimal", declared: [], source: { kind: "none" } },
    timeoutSeconds: 60,
    parser: { id: "metric-lines", version: 1 },
    protectedInputs: [],
    runner: { id: "codex-autoresearch", version: 1, metricLimit: 512 },
  });

async function gitOk(workDir: string, args: string[]): Promise<void> {
  await runGit(workDir, args);
}

async function writeNumberedFiles(workDir: string, relativeDir: string, count: number) {
  const directory = path.join(workDir, relativeDir);
  await mkdir(directory, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    await writeFile(path.join(directory, `file-${String(index).padStart(3, "0")}.txt`), "x\n");
  }
}

test("execution digests preserve mode, shell, argv boundaries, quoting, and whitespace", () => {
  const bash = execution({ kind: "shell", shell: "bash", script: 'printf "a  b"\n' });
  const normalizedWhitespace = execution({
    kind: "shell",
    shell: "bash",
    script: 'printf "a b"\n',
  });
  const powershell = execution({
    kind: "shell",
    shell: "powershell",
    script: 'printf "a  b"\n',
  });
  const argvOneArgument = execution({ kind: "argv", executable: "printf", args: ["a  b"] });
  const argvTwoArguments = execution({ kind: "argv", executable: "printf", args: ["a", "b"] });

  assert.notEqual(bash.executionDigest, normalizedWhitespace.executionDigest);
  assert.notEqual(bash.executionDigest, powershell.executionDigest);
  assert.notEqual(bash.executionDigest, argvOneArgument.executionDigest);
  assert.notEqual(argvOneArgument.executionDigest, argvTwoArguments.executionDigest);
});

test("canonical argv execution preserves arguments without shell expansion", async () => {
  await withNamedTempDir("experiment-contract", "argv-execution", async (dir) => {
    const literal = "$HOME; $(printf injected)";
    const result = await runExecutableCommand(
      {
        kind: "argv",
        executable: process.execPath,
        args: [
          "-e",
          "require('node:fs').writeFileSync('argument.txt', process.argv[1]); console.log('METRIC score=1')",
          literal,
        ],
      },
      dir,
      30,
      { envMode: "minimal", retainMetricNames: ["score"] },
    );

    assert.equal(result.exitCode, 0, result.output);
    assert.equal(await readFile(path.join(dir, "argument.txt"), "utf8"), literal);
    assert.equal(result.parsedMetrics.score, 1);
  });
});

test("environment values stay secret while environment and protected-input drift invalidate execution", async () => {
  await withNamedTempDir("experiment-contract", "execution-drift", async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await mkdir(path.join(dir, "contract"), { recursive: true });
    await writeFile(path.join(dir, "contract", "evaluator.mjs"), "console.log('v1');\n");
    await writeFile(path.join(dir, "contract.env"), "API_TOKEN=top-secret-value\nMODE=test\n");
    const derivation = await deriveExperimentContract({
      workDir: dir,
      args: { packet_env_file: "contract.env" },
      config: {
        benchmarkCommand: "node contract/evaluator.mjs",
        checksAuthoritative: true,
        checksCommand: "node --check contract/evaluator.mjs",
        commitPaths: ["src"],
        maxIterations: 3,
        protectedBenchmarkPaths: ["contract/evaluator.mjs"],
      },
      entries: [
        {
          type: "config",
          name: "execution drift",
          goal: "Protect evaluator inputs",
          metricName: "score",
          bestDirection: "higher",
        },
      ],
    });
    assert.equal(derivation.status, "derived");
    if (derivation.status !== "derived") return;
    const evaluator = derivation.contract.evaluator.execution;
    assert.deepEqual(
      evaluator.environment.declared.map((item) => item.name),
      ["API_TOKEN", "MODE"],
    );
    assert.doesNotMatch(JSON.stringify(derivation.contract), /top-secret-value/);
    assert.equal(
      createExecutionSpec({
        command: evaluator.command,
        relativeWorkingDirectory: evaluator.relativeWorkingDirectory,
        environment: evaluator.environment,
        timeoutSeconds: evaluator.timeoutSeconds,
        parser: evaluator.parser,
        protectedInputs: evaluator.protectedInputs,
        runner: evaluator.runner,
      }).executionDigest,
      evaluator.executionDigest,
    );
    const initialVerification = await verifyExecutionSpecForWorkDir(dir, evaluator);
    assert.equal(initialVerification.ok, true, JSON.stringify(initialVerification.conflicts));

    await writeFile(path.join(dir, "contract.env"), "API_TOKEN=changed-secret\nMODE=test\n");
    const environmentDrift = await verifyExecutionSpecForWorkDir(dir, evaluator);
    assert.equal(environmentDrift.ok, false);
    assert.ok(environmentDrift.conflicts.some((conflict) => conflict.field === "environment"));

    await writeFile(path.join(dir, "contract.env"), "API_TOKEN=top-secret-value\nMODE=test\n");
    await writeFile(path.join(dir, "contract", "evaluator.mjs"), "console.log('v2');\n");
    const protectedInputDrift = await verifyExecutionSpecForWorkDir(dir, evaluator);
    assert.equal(protectedInputDrift.ok, false);
    assert.ok(
      protectedInputDrift.conflicts.some((conflict) => conflict.field === "protectedInputs"),
    );
  });
});

test("accepted environment compatibility inputs must match the accepted execution digest", async () => {
  await withNamedTempDir("experiment-contract", "environment-source-conflict", async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "accepted.env"), "MODE=accepted\n");
    await writeFile(path.join(dir, "replacement.env"), "MODE=replacement\n");
    const configEntry = {
      type: "config",
      name: "environment source conflict",
      goal: "Bind evaluator environment",
      metricName: "score",
      bestDirection: "higher",
    };
    const config = {
      benchmarkCommand: "node -e \"console.log('METRIC score=1')\"",
      checksCommand: 'node -e "process.exit(0)"',
      commitPaths: ["src"],
      maxIterations: 3,
    };
    const initial = await deriveExperimentContract({
      workDir: dir,
      args: { packet_env_file: "accepted.env" },
      config,
      entries: [configEntry],
    });
    assert.equal(initial.status, "derived");
    if (initial.status !== "derived") return;
    const accepted = {
      type: "experiment-contract-accepted",
      schemaVersion: 1,
      eventId: `experiment-contract-accepted:0:${initial.contract.contractDigest}`,
      source: "legacy-derivation",
      segment: 0,
      timestamp: new Date().toISOString(),
      contract: initial.contract,
    };

    const replacement = await deriveExperimentContract({
      workDir: dir,
      args: { packet_env_file: "replacement.env" },
      config,
      entries: [configEntry, accepted],
    });
    assert.equal(replacement.status, "invalid");
    if (replacement.status === "invalid") {
      assert.ok(replacement.conflicts.some((conflict) => conflict.field === "environment"));
    }
  });
});

test("fixtures, datasets, and runner configuration are protected execution inputs", async () => {
  await withNamedTempDir("experiment-contract", "protected-roles", async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await mkdir(path.join(dir, "fixtures"), { recursive: true });
    await mkdir(path.join(dir, "datasets"), { recursive: true });
    await mkdir(path.join(dir, "runner"), { recursive: true });
    await writeFile(path.join(dir, "fixtures", "case.json"), '{"input":1}\n');
    await writeFile(path.join(dir, "datasets", "eval.jsonl"), '{"expected":1}\n');
    await writeFile(path.join(dir, "runner", "settings.json"), '{"mode":"exact"}\n');
    const derived = await deriveExperimentContract({
      workDir: dir,
      entries: [
        {
          type: "config",
          name: "protected roles",
          goal: "Bind all evaluator inputs",
          metricName: "score",
          bestDirection: "higher",
        },
      ],
      config: {
        benchmarkCommand: "node -e \"console.log('METRIC score=1')\"",
        checksCommand: 'node -e "process.exit(0)"',
        commitPaths: ["src"],
        datasetPaths: ["datasets/eval.jsonl"],
        fixturePaths: ["fixtures/case.json"],
        maxIterations: 3,
        runnerConfigPaths: ["runner/settings.json"],
      },
    });
    assert.equal(derived.status, "derived");
    if (derived.status !== "derived") return;
    assert.deepEqual(
      derived.contract.evaluator.execution.protectedInputs.map((input) => input.role).sort(),
      ["dataset", "fixture", "runner-config"],
    );

    await writeFile(path.join(dir, "fixtures", "case.json"), '{"input":2}\n');
    const drift = await verifyExecutionSpecForWorkDir(dir, derived.contract.evaluator.execution);
    assert.equal(drift.ok, false);
    assert.ok(drift.conflicts.some((conflict) => conflict.field === "protectedInputs"));
  });
});

test("legacy derivation requires ledger, config, and packet agreement without mutating the ledger", async () => {
  await withNamedTempDir("experiment-contract", "legacy-agreement", async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await mkdir(path.join(dir, "contract"), { recursive: true });
    await writeFile(
      path.join(dir, "contract", "evaluator.mjs"),
      "console.log('METRIC score=1');\n",
    );
    await writeFile(path.join(dir, "contract", "checks.mjs"), "// checks\n");
    const evaluator = "node contract/evaluator.mjs";
    const checks = "node contract/checks.mjs";
    const entries = [
      {
        type: "config",
        name: "legacy agreement",
        goal: "Use one evaluator",
        metricName: "score",
        bestDirection: "higher",
        benchmarkContract: { command: evaluator, checksCommand: checks },
      },
    ];
    const ledgerPath = path.join(dir, "autoresearch.jsonl");
    await writeFile(ledgerPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    const config = {
      benchmarkCommand: evaluator,
      checksAuthoritative: true,
      checksCommand: checks,
      commitPaths: ["src"],
      maxIterations: 3,
      protectedBenchmarkPaths: ["contract/evaluator.mjs", "contract/checks.mjs"],
    };
    const packet = {
      history: {
        segment: 0,
        benchmarkContract: { command: evaluator, checksCommand: checks },
      },
    };
    const before = await readFile(ledgerPath, "utf8");
    const agreed = await deriveExperimentContract({
      workDir: dir,
      config,
      entries,
      packet,
    } as any);
    assert.equal(agreed.status, "derived");
    assert.equal(await readFile(ledgerPath, "utf8"), before);

    const conflicted = await deriveExperimentContract({
      workDir: dir,
      config,
      entries,
      packet: {
        history: {
          segment: 0,
          benchmarkContract: {
            command: "node contract/other-evaluator.mjs",
            checksCommand: checks,
          },
        },
      },
    } as any);
    assert.equal(conflicted.status, "invalid");
    assert.deepEqual(conflicted.missing, []);
    assert.ok(conflicted.conflicts.some((conflict) => conflict.field === "evaluator.command"));
    assert.equal(await readFile(ledgerPath, "utf8"), before);
  });
});

test("malformed legacy values and repository identity disagreements return typed conflicts", async () => {
  await withNamedTempDir("experiment-contract", "legacy-boundary", async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    const entries = [
      {
        type: "config",
        name: "legacy boundary",
        goal: "Parse untyped inputs once",
        metricName: "score",
        bestDirection: "higher",
      },
    ];
    const malformed = await deriveExperimentContract({
      workDir: dir,
      entries,
      config: {
        benchmarkCommand: { kind: "argv", executable: "node", args: "not-an-array" },
        checksCommand: 'node -e "process.exit(0)"',
        commitPaths: ["src"],
        maxIterations: 3,
      },
    });
    assert.equal(malformed.status, "invalid");
    if (malformed.status === "invalid") {
      assert.deepEqual(malformed.missing, []);
      assert.ok(malformed.conflicts.some((conflict) => conflict.field === "evaluator.command"));
    }

    const fractionalBudget = await deriveExperimentContract({
      workDir: dir,
      entries,
      config: {
        benchmarkCommand: "node -e \"console.log('METRIC score=1')\"",
        checksCommand: 'node -e "process.exit(0)"',
        commitPaths: ["src"],
        maxIterations: 3.5,
      },
    });
    assert.equal(fractionalBudget.status, "invalid");
    if (fractionalBudget.status === "invalid") {
      assert.deepEqual(fractionalBudget.missing, []);
      assert.ok(
        fractionalBudget.conflicts.some((conflict) => conflict.field === "stopPolicy.packets"),
      );
    }

    const missingEnvironmentFile = await deriveExperimentContract({
      workDir: dir,
      entries,
      config: {
        benchmarkCommand: "node -e \"console.log('METRIC score=1')\"",
        checksCommand: 'node -e "process.exit(0)"',
        commitPaths: ["src"],
        maxIterations: 3,
        packetEnvFile: "missing.env",
      },
    });
    assert.equal(missingEnvironmentFile.status, "invalid");
    if (missingEnvironmentFile.status === "invalid") {
      assert.deepEqual(missingEnvironmentFile.missing, []);
      assert.ok(
        missingEnvironmentFile.conflicts.some((conflict) => conflict.field === "environment"),
      );
    }

    const invalidEnvironmentMode = await deriveExperimentContract({
      workDir: dir,
      entries,
      config: {
        benchmarkCommand: "node -e \"console.log('METRIC score=1')\"",
        checksCommand: 'node -e "process.exit(0)"',
        commitPaths: ["src"],
        maxIterations: 3,
        packetEnvMode: "everything",
      },
    });
    assert.equal(invalidEnvironmentMode.status, "invalid");
    if (invalidEnvironmentMode.status === "invalid") {
      assert.deepEqual(invalidEnvironmentMode.missing, []);
      assert.ok(
        invalidEnvironmentMode.conflicts.some((conflict) => conflict.field === "environment"),
      );
    }

    const invalidNoise = await deriveExperimentContract({
      workDir: dir,
      entries,
      config: {
        benchmarkCommand: "node -e \"console.log('METRIC score=1')\"",
        checksCommand: 'node -e "process.exit(0)"',
        commitPaths: ["src"],
        maxIterations: 3,
        noiseModel: { kind: "bounded", repeats: 0, tolerance: -1 },
      },
    });
    assert.equal(invalidNoise.status, "invalid");
    if (invalidNoise.status === "invalid") {
      assert.deepEqual(invalidNoise.missing, []);
      assert.ok(invalidNoise.conflicts.some((conflict) => conflict.field === "noise"));
    }

    const missingProtectedInput = await deriveExperimentContract({
      workDir: dir,
      entries,
      config: {
        benchmarkCommand: "node -e \"console.log('METRIC score=1')\"",
        checksCommand: 'node -e "process.exit(0)"',
        commitPaths: ["src"],
        maxIterations: 3,
        protectedBenchmarkPaths: ["missing-evaluator.mjs"],
      },
    });
    assert.equal(missingProtectedInput.status, "invalid");
    if (missingProtectedInput.status === "invalid") {
      assert.deepEqual(missingProtectedInput.missing, []);
      assert.ok(
        missingProtectedInput.conflicts.some((conflict) => conflict.field === "protectedInputs"),
      );
    }

    const wrongRepository = await deriveExperimentContract({
      workDir: dir,
      entries,
      packet: { history: { segment: 0, workDir: path.join(dir, "other") } },
      config: {
        benchmarkCommand: "node -e \"console.log('METRIC score=1')\"",
        checksCommand: 'node -e "process.exit(0)"',
        commitPaths: ["src"],
        maxIterations: 3,
      },
    });
    assert.equal(wrongRepository.status, "invalid");
    if (wrongRepository.status === "invalid") {
      assert.deepEqual(wrongRepository.missing, []);
      assert.ok(wrongRepository.conflicts.some((conflict) => conflict.field === "repository"));
    }
  });
});

test("accepted contract parsing rejects contract-digest drift and malformed check lists", async () => {
  await withNamedTempDir("experiment-contract", "accepted-boundary", async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    const configEntry = {
      type: "config",
      name: "accepted boundary",
      goal: "Reject mutated accepted authority",
      metricName: "score",
      bestDirection: "higher",
    };
    const config = {
      benchmarkCommand: "node -e \"console.log('METRIC score=1')\"",
      checksCommand: 'node -e "process.exit(0)"',
      commitPaths: ["src"],
      maxIterations: 3,
    };
    const initial = await deriveExperimentContract({
      workDir: dir,
      config,
      entries: [configEntry],
    });
    assert.equal(initial.status, "derived");
    if (initial.status !== "derived") return;
    const accepted = {
      type: "experiment-contract-accepted",
      schemaVersion: 1,
      eventId: `experiment-contract-accepted:0:${initial.contract.contractDigest}`,
      source: "legacy-derivation",
      segment: 0,
      timestamp: new Date().toISOString(),
      contract: initial.contract,
    };

    const tampered = structuredClone(accepted);
    tampered.contract.stopPolicy.packets.limit = 99;
    const digestDrift = await deriveExperimentContract({
      workDir: dir,
      config,
      entries: [configEntry, tampered],
    });
    assert.equal(digestDrift.status, "invalid");
    if (digestDrift.status === "invalid") {
      assert.ok(digestDrift.conflicts.some((conflict) => conflict.field === "contractDigest"));
    }

    const malformed = structuredClone(accepted) as any;
    malformed.contract = createExperimentContract({
      ...malformed.contract,
      checks: [] as any,
      contractDigest: undefined,
    });
    malformed.eventId = `experiment-contract-accepted:0:${malformed.contract.contractDigest}`;
    const missingChecks = await deriveExperimentContract({
      workDir: dir,
      config,
      entries: [configEntry, malformed],
    });
    assert.equal(missingChecks.status, "invalid");
    if (missingChecks.status === "invalid") {
      assert.ok(missingChecks.conflicts.some((conflict) => conflict.field === "checks"));
    }
  });
});

test("accepted contract parsing recomputes check authority instead of trusting persisted labels", async () => {
  await withNamedTempDir("experiment-contract", "forged-check-authority", async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    const configEntry = {
      type: "config",
      name: "forged check authority",
      goal: "Reject forged keep authority",
      metricName: "score",
      bestDirection: "higher",
    };
    const config = {
      benchmarkCommand: "node -e \"console.log('METRIC score=1')\"",
      checksCommand: 'node -e "process.exit(0)"',
      commitPaths: ["src"],
      maxIterations: 3,
    };
    const initial = await deriveExperimentContract({
      workDir: dir,
      config,
      entries: [configEntry],
    });
    assert.equal(initial.status, "derived");
    if (initial.status !== "derived") return;
    assert.equal(initial.contract.checks[0].authority, "supplemental");

    const forgedCheck = {
      id: initial.contract.checks[0].id,
      authority: "authoritative" as const,
      execution: initial.contract.checks[0].execution,
    };
    const forgedContract = createExperimentContract({
      ...initial.contract,
      checks: [forgedCheck],
      keepPolicy: {
        ...initial.contract.keepPolicy,
        authoritativeCheckIds: [forgedCheck.id],
      },
      contractDigest: undefined,
    });
    const forgedEvent = {
      type: "experiment-contract-accepted",
      schemaVersion: 1,
      eventId: `experiment-contract-accepted:0:${forgedContract.contractDigest}`,
      source: "legacy-derivation",
      segment: 0,
      timestamp: new Date().toISOString(),
      contract: forgedContract,
    };

    const parsed = await deriveExperimentContract({
      workDir: dir,
      config,
      entries: [configEntry, forgedEvent],
    });
    assert.equal(parsed.status, "invalid");
    if (parsed.status === "invalid") {
      assert.ok(parsed.conflicts.some((conflict) => conflict.field === "checks"));
    }
  });
});

test("accepted authoritative checks reject editable implementation inputs", async () => {
  await withNamedTempDir("experiment-contract", "editable-authority-input", async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await mkdir(path.join(dir, "contract"), { recursive: true });
    await writeFile(path.join(dir, "src", "fixture.txt"), "editable\n");
    await writeFile(path.join(dir, "contract", "checks.mjs"), "process.exit(0);\n");
    const configEntry = {
      type: "config",
      name: "editable authority input",
      goal: "Keep editable inputs supplemental",
      metricName: "score",
      bestDirection: "higher",
    };
    const config = {
      benchmarkCommand: "node -e \"console.log('METRIC score=1')\"",
      checkImplementationPaths: ["contract/checks.mjs"],
      checksAuthoritative: true,
      checksCommand: "node contract/checks.mjs",
      commitPaths: ["src"],
      maxIterations: 3,
    };
    const initial = await deriveExperimentContract({
      workDir: dir,
      config,
      entries: [configEntry],
    });
    assert.equal(initial.status, "derived");
    if (initial.status !== "derived") return;
    assert.equal(initial.contract.checks[0].authority, "authoritative");

    const acceptedExecution = initial.contract.checks[0].execution;
    const editableInput = await buildProtectedBenchmarkSnapshot({
      workDir: dir,
      paths: ["src/fixture.txt"],
    });
    const executionWithEditableInput = createExecutionSpec({
      ...acceptedExecution,
      protectedInputs: [
        ...acceptedExecution.protectedInputs,
        {
          path: "src/fixture.txt",
          role: "fixture",
          contentDigest: editableInput.surfaceHash,
        },
      ],
    });
    const check = { ...initial.contract.checks[0], execution: executionWithEditableInput };
    const contract = createExperimentContract({
      ...initial.contract,
      checks: [check],
      contractDigest: undefined,
    });
    const event = {
      type: "experiment-contract-accepted",
      schemaVersion: 1,
      eventId: `experiment-contract-accepted:0:${contract.contractDigest}`,
      source: "legacy-derivation",
      segment: 0,
      timestamp: new Date().toISOString(),
      contract,
    };
    const parsed = await deriveExperimentContract({
      workDir: dir,
      config,
      entries: [configEntry, event],
    });
    assert.equal(parsed.status, "invalid");
    if (parsed.status === "invalid") {
      assert.ok(parsed.conflicts.some((conflict) => conflict.field === "checks"));
    }
  });
});

test("accepted contract parsing rejects wrong runtime types even with recomputed digests", async () => {
  await withNamedTempDir("experiment-contract", "strict-accepted-types", async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    const configEntry = {
      type: "config",
      name: "strict accepted types",
      goal: "Reject coercive accepted data",
      metricName: "score",
      bestDirection: "higher",
    };
    const config = {
      benchmarkCommand: "node -e \"console.log('METRIC score=1')\"",
      checksCommand: 'node -e "process.exit(0)"',
      commitPaths: ["src"],
      maxIterations: 3,
    };
    const initial = await deriveExperimentContract({
      workDir: dir,
      config,
      entries: [configEntry],
    });
    assert.equal(initial.status, "derived");
    if (initial.status !== "derived") return;

    const replaceEvaluatorExecution = (updates: Record<string, unknown>) => {
      const accepted = initial.contract.evaluator.execution;
      const executionSpec = createExecutionSpec({
        command: accepted.command,
        relativeWorkingDirectory: accepted.relativeWorkingDirectory,
        environment: accepted.environment,
        timeoutSeconds: accepted.timeoutSeconds,
        parser: accepted.parser,
        protectedInputs: accepted.protectedInputs,
        runner: accepted.runner,
        ...updates,
      } as any);
      return createExperimentContract({
        ...initial.contract,
        evaluator: { ...initial.contract.evaluator, execution: executionSpec },
        contractDigest: undefined,
      });
    };
    const cases: Array<{
      field: string;
      label: string;
      contract: ReturnType<typeof createExperimentContract>;
    }> = [
      {
        label: "null minimum improvement",
        field: "metric",
        contract: createExperimentContract({
          ...initial.contract,
          metric: { ...initial.contract.metric, minimumImprovement: null } as any,
          contractDigest: undefined,
        }),
      },
      {
        label: "string timeout",
        field: "evaluator",
        contract: replaceEvaluatorExecution({ timeoutSeconds: "60" }),
      },
      {
        label: "string stop limit",
        field: "stopPolicy",
        contract: createExperimentContract({
          ...initial.contract,
          stopPolicy: {
            ...initial.contract.stopPolicy,
            evaluatorRuns: {
              ...initial.contract.stopPolicy.evaluatorRuns,
              limit: "3",
            } as any,
          },
          contractDigest: undefined,
        }),
      },
      {
        label: "unsupported parser",
        field: "evaluator",
        contract: replaceEvaluatorExecution({ parser: { id: "other-parser", version: 2 } }),
      },
      {
        label: "unsupported runner",
        field: "evaluator",
        contract: replaceEvaluatorExecution({
          runner: { id: "codex-autoresearch", version: 2, metricLimit: 512 },
        }),
      },
      {
        label: "unsupported check runner metric limit",
        field: "checks",
        contract: (() => {
          const acceptedCheck = initial.contract.checks[0];
          const checkExecution = createExecutionSpec({
            ...acceptedCheck.execution,
            runner: { ...acceptedCheck.execution.runner, metricLimit: 1 },
          });
          return createExperimentContract({
            ...initial.contract,
            checks: [{ ...acceptedCheck, execution: checkExecution }],
            contractDigest: undefined,
          });
        })(),
      },
      {
        label: "non-string argv",
        field: "evaluator",
        contract: replaceEvaluatorExecution({
          command: { kind: "argv", executable: process.execPath, args: [42] },
        }),
      },
    ];

    for (const malformed of cases) {
      const event = {
        type: "experiment-contract-accepted",
        schemaVersion: 1,
        eventId: `experiment-contract-accepted:0:${malformed.contract.contractDigest}`,
        source: "legacy-derivation",
        segment: 0,
        timestamp: new Date().toISOString(),
        contract: malformed.contract,
      };
      const parsed = await deriveExperimentContract({
        workDir: dir,
        config,
        entries: [configEntry, event],
      });
      assert.equal(parsed.status, "invalid", malformed.label);
      if (parsed.status === "invalid") {
        assert.ok(
          parsed.conflicts.some((conflict) => conflict.field === malformed.field),
          malformed.label,
        );
      }
    }
  });
});

test("legacy environment, execution, and stop-policy sources must agree before acceptance", async () => {
  await withNamedTempDir("experiment-contract", "all-source-agreement", async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "arguments.env"), "MODE=arguments\n");
    await writeFile(path.join(dir, "config.env"), "MODE=config\n");
    const entries = [
      {
        type: "config",
        name: "all source agreement",
        goal: "Reject shadowed compatibility inputs",
        metricName: "score",
        bestDirection: "higher",
      },
    ];
    const baseConfig = {
      benchmarkCommand: "node -e \"console.log('METRIC score=1')\"",
      checksCommand: 'node -e "process.exit(0)"',
      commitPaths: ["src"],
      maxIterations: 5,
    };
    const cases = [
      {
        label: "environment file",
        field: "environment",
        args: { packet_env_file: "arguments.env" },
        config: { ...baseConfig, packetEnvFile: "config.env" },
      },
      {
        label: "environment mode",
        field: "environment",
        args: { packet_env_mode: "inherit" },
        config: { ...baseConfig, packetEnvMode: "minimal" },
      },
      {
        label: "evaluator timeout",
        field: "evaluator.timeoutSeconds",
        args: { timeout_seconds: "30" },
        config: { ...baseConfig, timeoutSeconds: 60 },
      },
      {
        label: "checks timeout",
        field: "checks.timeoutSeconds",
        args: { checks_timeout_seconds: "30" },
        config: { ...baseConfig, checksTimeoutSeconds: 60 },
      },
      {
        label: "evaluator ceiling",
        field: "stopPolicy.evaluatorRuns",
        args: { max_evaluator_runs: "4" },
        config: { ...baseConfig, maxEvaluatorRuns: 5 },
      },
      {
        label: "wall-clock ceiling",
        field: "stopPolicy.pluginWallClockSeconds",
        args: { wall_clock_budget_seconds: "60" },
        config: { ...baseConfig, wallClockBudgetSeconds: 120 },
      },
      {
        label: "no-learning ceiling",
        field: "stopPolicy.noLearningPackets",
        args: { no_learning_limit: "3" },
        config: { ...baseConfig, noLearningLimit: 4 },
      },
      {
        label: "repeated-failure ceiling",
        field: "stopPolicy.repeatedFailures",
        args: { repeated_failure_limit: "3" },
        config: { ...baseConfig, repeatedFailureLimit: 4 },
      },
      {
        label: "model-token ceiling",
        field: "stopPolicy.modelTokens",
        args: { model_token_budget: "100" },
        config: { ...baseConfig, modelTokenBudget: 200 },
      },
      {
        label: "model-call ceiling",
        field: "stopPolicy.modelCalls",
        args: { model_call_budget: "10" },
        config: { ...baseConfig, modelCallBudget: 20 },
      },
    ];

    for (const conflictCase of cases) {
      const derivation = await deriveExperimentContract({
        workDir: dir,
        args: conflictCase.args,
        config: conflictCase.config,
        entries,
      });
      assert.equal(derivation.status, "invalid", conflictCase.label);
      if (derivation.status === "invalid") {
        assert.ok(
          derivation.conflicts.some((conflict) => conflict.field === conflictCase.field),
          conflictCase.label,
        );
      }
    }

    const malformedExplicit = await deriveExperimentContract({
      workDir: dir,
      args: { timeout_seconds: "not-a-timeout" },
      config: { ...baseConfig, timeoutSeconds: 60 },
      entries,
    });
    assert.equal(malformedExplicit.status, "invalid");
    if (malformedExplicit.status === "invalid") {
      assert.ok(
        malformedExplicit.conflicts.some(
          (conflict) => conflict.field === "evaluator.timeoutSeconds",
        ),
      );
    }
  });
});

test("accepted repository and worktree identities cannot be replayed in another checkout", async () => {
  await withNamedTempDir("experiment-contract", "repository-one", async (firstDir) => {
    await withNamedTempDir("experiment-contract", "repository-two", async (secondDir) => {
      await mkdir(path.join(firstDir, "src"), { recursive: true });
      await mkdir(path.join(secondDir, "src"), { recursive: true });
      const configEntry = {
        type: "config",
        name: "repository identity",
        goal: "Bind authority to one checkout",
        metricName: "score",
        bestDirection: "higher",
      };
      const config = {
        benchmarkCommand: "node -e \"console.log('METRIC score=1')\"",
        checksCommand: 'node -e "process.exit(0)"',
        commitPaths: ["src"],
        maxIterations: 3,
      };
      const initial = await deriveExperimentContract({
        workDir: firstDir,
        config,
        entries: [configEntry],
      });
      assert.equal(initial.status, "derived");
      if (initial.status !== "derived") return;
      const accepted = {
        type: "experiment-contract-accepted",
        schemaVersion: 1,
        eventId: `experiment-contract-accepted:0:${initial.contract.contractDigest}`,
        source: "legacy-derivation",
        segment: 0,
        timestamp: new Date().toISOString(),
        contract: initial.contract,
      };

      const replayed = await deriveExperimentContract({
        workDir: secondDir,
        config,
        entries: [configEntry, accepted],
      });
      assert.equal(replayed.status, "invalid");
      if (replayed.status === "invalid") {
        assert.ok(replayed.conflicts.some((conflict) => conflict.field === "repository"));
      }
    });
  });
});

test("complete candidate snapshots remain authoritative and content-sensitive", async () => {
  await withNamedTempDir("experiment-contract", "complete-candidate-fingerprint", async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "candidate.txt"), "first\n");
    const configEntry = {
      type: "config",
      name: "complete candidate fingerprint",
      goal: "Fingerprint a complete candidate",
      metricName: "score",
      bestDirection: "higher",
    };
    const config = {
      benchmarkCommand: "node -e \"console.log('METRIC score=1')\"",
      checksCommand: 'node -e "process.exit(0)"',
      commitPaths: ["src"],
      maxIterations: 3,
    };
    const derivation = await deriveExperimentContract({
      workDir: dir,
      config,
      entries: [configEntry],
    });
    assert.equal(derivation.status, "derived");
    if (derivation.status !== "derived") return;

    const first = await contractCandidateFingerprintForWorkDir(dir, derivation.contract);
    assert.match(first, /^[a-f0-9]{64}$/);
    await writeFile(path.join(dir, "src", "candidate.txt"), "second\n");
    const second = await contractCandidateFingerprintForWorkDir(dir, derivation.contract);
    assert.match(second, /^[a-f0-9]{64}$/);
    assert.notEqual(first, second);
  });
});

test("candidate snapshots with an entry-limit quarantine are unusable authority", async () => {
  await withNamedTempDir("experiment-contract", "truncated-candidate-fingerprint", async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    const configEntry = {
      type: "config",
      name: "truncated candidate fingerprint",
      goal: "Reject incomplete candidate authority",
      metricName: "score",
      bestDirection: "higher",
    };
    const derivation = await deriveExperimentContract({
      workDir: dir,
      config: {
        benchmarkCommand: "node -e \"console.log('METRIC score=1')\"",
        checksCommand: 'node -e "process.exit(0)"',
        commitPaths: ["src"],
        maxIterations: 3,
      },
      entries: [configEntry],
    });
    assert.equal(derivation.status, "derived");
    if (derivation.status !== "derived") return;
    await writeNumberedFiles(dir, "src", 505);

    await assert.rejects(
      contractCandidateFingerprintForWorkDir(dir, derivation.contract),
      /candidate fingerprint.*entry limit|entry-limit.*candidate fingerprint|incomplete candidate fingerprint/i,
    );
  });
});

test("initial-dirty acceptance rejects entry-limited tree fingerprints as a typed conflict", async () => {
  await withNamedTempDir(
    "experiment-contract",
    "truncated-initial-dirty-acceptance",
    async (dir) => {
      await mkdir(path.join(dir, "src"), { recursive: true });
      await writeFile(path.join(dir, "src", "seed.txt"), "seed\n");
      await gitOk(dir, ["init"]);
      await gitOk(dir, ["config", "user.email", "codex@example.test"]);
      await gitOk(dir, ["config", "user.name", "Codex Test"]);
      await gitOk(dir, ["add", "."]);
      await gitOk(dir, ["commit", "-m", "initial"]);
      await writeNumberedFiles(dir, "outside", 505);
      const derivation = await deriveExperimentContract({
        workDir: dir,
        config: {
          benchmarkCommand: "node -e \"console.log('METRIC score=1')\"",
          checksCommand: 'node -e "process.exit(0)"',
          commitPaths: ["src"],
          maxIterations: 3,
        },
        entries: [
          {
            type: "config",
            name: "truncated initial dirty acceptance",
            goal: "Reject incomplete tree authority",
            metricName: "score",
            bestDirection: "higher",
          },
        ],
      });

      assert.equal(derivation.status, "invalid");
      if (derivation.status === "invalid") {
        assert.ok(
          derivation.conflicts.some(
            (conflict) =>
              conflict.field === "repository.treePolicy" &&
              /entry limit|incomplete|quarantin/i.test(conflict.message),
          ),
        );
      }
    },
  );
});

test("accepted initial-dirty verification reports entry-limited drift as a typed blocker", async () => {
  await withNamedTempDir(
    "experiment-contract",
    "truncated-initial-dirty-verification",
    async (dir) => {
      await mkdir(path.join(dir, "src"), { recursive: true });
      await writeFile(path.join(dir, "src", "seed.txt"), "seed\n");
      await gitOk(dir, ["init"]);
      await gitOk(dir, ["config", "user.email", "codex@example.test"]);
      await gitOk(dir, ["config", "user.name", "Codex Test"]);
      await gitOk(dir, ["add", "."]);
      await gitOk(dir, ["commit", "-m", "initial"]);
      await mkdir(path.join(dir, "outside"), { recursive: true });
      await writeFile(path.join(dir, "outside", "baseline.txt"), "dirty baseline\n");
      const configEntry = {
        type: "config",
        name: "truncated initial dirty verification",
        goal: "Reject incomplete verification authority",
        metricName: "score",
        bestDirection: "higher",
      };
      const config = {
        benchmarkCommand: "node -e \"console.log('METRIC score=1')\"",
        checksCommand: 'node -e "process.exit(0)"',
        commitPaths: ["src"],
        maxIterations: 3,
      };
      const initial = await deriveExperimentContract({
        workDir: dir,
        config,
        entries: [configEntry],
      });
      assert.equal(initial.status, "derived");
      if (initial.status !== "derived") return;
      const accepted = {
        type: "experiment-contract-accepted",
        schemaVersion: 1,
        eventId: `experiment-contract-accepted:0:${initial.contract.contractDigest}`,
        source: "legacy-derivation",
        segment: 0,
        timestamp: new Date().toISOString(),
        contract: initial.contract,
      };
      await writeNumberedFiles(dir, "outside/overflow", 505);

      const verification = await deriveExperimentContract({
        workDir: dir,
        config,
        entries: [configEntry, accepted],
      });
      assert.equal(verification.status, "invalid");
      if (verification.status === "invalid") {
        assert.ok(
          verification.conflicts.some(
            (conflict) =>
              conflict.field === "repository.treePolicy" &&
              /entry limit|incomplete|quarantin/i.test(conflict.message),
          ),
        );
      }
    },
  );
});

test("editable checks remain supplemental and editable/protected overlap is invalid", async () => {
  await withNamedTempDir("experiment-contract", "check-authority", async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await mkdir(path.join(dir, "contract"), { recursive: true });
    await writeFile(path.join(dir, "src", "checks.mjs"), "// editable check\n");
    await writeFile(path.join(dir, "contract", "evaluator.mjs"), "// evaluator\n");
    const entries = [
      {
        type: "config",
        name: "check authority",
        goal: "Protect keep authority",
        metricName: "score",
        bestDirection: "higher",
      },
    ];
    const derived = await deriveExperimentContract({
      workDir: dir,
      entries,
      config: {
        benchmarkCommand: "node contract/evaluator.mjs",
        checkImplementationPaths: ["src/checks.mjs"],
        checksAuthoritative: true,
        checksCommand: "node src/checks.mjs",
        commitPaths: ["src"],
        maxIterations: 3,
        protectedBenchmarkPaths: ["contract/evaluator.mjs"],
      },
    });
    assert.equal(derived.status, "derived");
    if (derived.status !== "derived") return;
    assert.equal(derived.contract.checks[0].authority, "supplemental");
    assert.deepEqual(derived.contract.keepPolicy.authoritativeCheckIds, []);

    const undeclaredImplementation = await deriveExperimentContract({
      workDir: dir,
      entries,
      config: {
        benchmarkCommand: "node contract/evaluator.mjs",
        checksAuthoritative: true,
        checksCommand: 'node -e "process.exit(0)"',
        commitPaths: ["src"],
        maxIterations: 3,
        protectedBenchmarkPaths: ["contract/evaluator.mjs"],
      },
    });
    assert.equal(undeclaredImplementation.status, "derived");
    if (undeclaredImplementation.status !== "derived") return;
    assert.equal(undeclaredImplementation.contract.checks[0].authority, "supplemental");
    assert.deepEqual(undeclaredImplementation.contract.keepPolicy.authoritativeCheckIds, []);

    const overlap = await deriveExperimentContract({
      workDir: dir,
      entries,
      config: {
        benchmarkCommand: "node contract/evaluator.mjs",
        checksCommand: "node src/checks.mjs",
        commitPaths: ["src"],
        maxIterations: 3,
        protectedBenchmarkPaths: ["src/checks.mjs"],
      },
    });
    assert.equal(overlap.status, "invalid");
    assert.ok(overlap.conflicts.some((conflict) => conflict.field === "scope"));
  });
});

test("unknown noise allows baselines but blocks keeps until qualification repeats complete", () => {
  const noise = { kind: "unknown", qualificationRepeats: 3 } as const;

  const baseline = noiseQualificationStatus(noise, {
    completedRepeats: 0,
    purpose: "baseline",
  });
  assert.equal(baseline.evaluationAllowed, true);
  assert.equal(baseline.keepEligible, false);

  const unqualified = noiseQualificationStatus(noise, {
    completedRepeats: 2,
    purpose: "candidate",
  });
  assert.equal(unqualified.evaluationAllowed, true);
  assert.equal(unqualified.keepEligible, false);
  assert.equal(unqualified.remainingRepeats, 1);

  const qualified = noiseQualificationStatus(noise, {
    completedRepeats: 3,
    purpose: "candidate",
  });
  assert.equal(qualified.keepEligible, true);
  assert.equal(qualified.remainingRepeats, 0);
});

test("budget dimensions enforce plugin ceilings without inventing model usage", async () => {
  await withNamedTempDir("experiment-contract", "budget-truth", async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    const derivation = await deriveExperimentContract({
      workDir: dir,
      entries: [
        {
          type: "config",
          name: "budget truth",
          goal: "Stop honestly",
          metricName: "score",
          bestDirection: "higher",
        },
      ],
      config: {
        benchmarkCommand: "node -e \"console.log('METRIC score=1')\"",
        checksCommand: 'node -e "process.exit(0)"',
        commitPaths: ["src"],
        maxIterations: 5,
        maxEvaluatorRuns: 6,
        hostTelemetryTrusted: true,
        modelCallBudget: 20,
        modelTokenBudget: 1000,
        wallClockBudgetSeconds: 900,
      },
    });
    assert.equal(derivation.status, "derived");
    if (derivation.status !== "derived") return;
    const policy = derivation.contract.stopPolicy;
    assert.deepEqual(policy.packets, { status: "enforced", limit: 5, telemetry: "plugin" });
    assert.deepEqual(policy.evaluatorRuns, {
      status: "enforced",
      limit: 6,
      telemetry: "plugin",
    });
    assert.deepEqual(policy.pluginWallClockSeconds, {
      status: "enforced",
      limit: 900,
      telemetry: "plugin",
    });
    assert.equal(policy.modelTokens.status, "advisory");
    assert.equal(policy.modelCalls.status, "advisory");
    assert.equal(Object.hasOwn(policy.modelTokens, "remaining"), false);
    assert.equal(Object.hasOwn(policy.modelCalls, "remaining"), false);
  });
});

test("the accepted stop policy mechanically enforces every plugin-owned ceiling", async () => {
  await withNamedTempDir("experiment-contract", "stop-policy", async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    const derivation = await deriveExperimentContract({
      workDir: dir,
      entries: [
        {
          type: "config",
          name: "stop policy",
          goal: "Stop at accepted ceilings",
          metricName: "score",
          bestDirection: "higher",
        },
      ],
      config: {
        benchmarkCommand: "node -e \"console.log('METRIC score=1')\"",
        checksCommand: 'node -e "process.exit(0)"',
        commitPaths: ["src"],
        maxIterations: 10,
        maxEvaluatorRuns: 10,
        noLearningLimit: 2,
        repeatedFailureLimit: 2,
        wallClockBudgetSeconds: 60,
      },
    });
    assert.equal(derivation.status, "derived");
    if (derivation.status !== "derived") return;
    const acceptedAt = "2026-08-23T12:00:00.000Z";
    const now = "2026-08-23T12:00:30.000Z";

    assert.equal(
      contractStopStatus(derivation.contract, {
        acceptedAt,
        currentRuns: [{ status: "measure" }],
        now,
      }).status,
      "allowed",
    );

    const packetLimited = createExperimentContract({
      ...derivation.contract,
      stopPolicy: {
        ...derivation.contract.stopPolicy,
        packets: { status: "enforced", limit: 1, telemetry: "plugin" },
      },
      contractDigest: undefined,
    });
    assert.deepEqual(
      contractStopStatus(packetLimited, {
        acceptedAt,
        currentRuns: [{ status: "measure" }],
        now,
      }),
      {
        status: "exhausted",
        dimension: "packets",
        limit: 1,
        used: 1,
        message: "Accepted packet ceiling reached (1/1). Start a new segment.",
      },
    );

    const evaluatorLimited = createExperimentContract({
      ...derivation.contract,
      stopPolicy: {
        ...derivation.contract.stopPolicy,
        evaluatorRuns: { status: "enforced", limit: 2, telemetry: "plugin" },
      },
      contractDigest: undefined,
    });
    assert.equal(
      contractStopStatus(evaluatorLimited, {
        acceptedAt,
        currentRuns: [{ status: "measure", evaluatorRuns: 2 }],
        now,
      }).dimension,
      "evaluatorRuns",
    );

    assert.equal(
      contractStopStatus(derivation.contract, {
        acceptedAt,
        currentRuns: [{ status: "discard" }, { status: "discard" }],
        now,
      }).dimension,
      "noLearningPackets",
    );
    assert.equal(
      contractStopStatus(derivation.contract, {
        acceptedAt,
        currentRuns: [{ status: "crash" }, { status: "checks_failed" }],
        now,
      }).dimension,
      "repeatedFailures",
    );
    assert.equal(
      contractStopStatus(derivation.contract, {
        acceptedAt,
        currentRuns: [],
        now: "2026-08-23T12:01:00.000Z",
      }).dimension,
      "pluginWallClockSeconds",
    );
  });
});

test("metric names and numeric values do not invent perfect-score semantics", () => {
  const integrity = buildResearchIntegrity({
    metricName: "quality_total",
    parsedMetrics: { quality_total: 6 },
  });

  assert.deepEqual(integrity.suspiciousPerfectMetrics, []);
  assert.doesNotMatch(integrity.warnings.join("\n"), /perfect/i);
});

test("explicit threshold metrics preserve comparator and target semantics", async () => {
  await withNamedTempDir("experiment-contract", "threshold-metric", async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    const entries = [
      {
        type: "config",
        name: "threshold metric",
        goal: "Meet the accepted quality threshold",
        metricName: "quality_total",
        metricUnit: "points",
        bestDirection: "higher",
      },
    ];
    const baseConfig = {
      benchmarkCommand: "node -e \"console.log('METRIC quality_total=6')\"",
      checksCommand: 'node -e "process.exit(0)"',
      commitPaths: ["src"],
      maxIterations: 3,
    };
    const threshold = await deriveExperimentContract({
      workDir: dir,
      entries,
      config: {
        ...baseConfig,
        metricSemantics: { kind: "threshold", comparator: ">=", target: 6 },
      },
    });
    assert.equal(threshold.status, "derived");
    if (threshold.status === "derived") {
      assert.deepEqual(threshold.contract.metric, {
        kind: "threshold",
        metricName: "quality_total",
        unit: "points",
        comparator: ">=",
        target: 6,
      });
    }

    const malformed = await deriveExperimentContract({
      workDir: dir,
      entries,
      config: {
        ...baseConfig,
        metricSemantics: { kind: "threshold", comparator: ">=" },
      },
    });
    assert.equal(malformed.status, "invalid");
    if (malformed.status === "invalid") {
      assert.ok(malformed.conflicts.some((conflict) => conflict.field === "metric"));
    }
  });
});

test("separator argv, command files, and platform wrappers become canonical execution specs", async () => {
  await withNamedTempDir("experiment-contract", "legacy-command-sources", async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    const entries = [
      {
        type: "config",
        name: "command sources",
        goal: "Preserve command identity",
        metricName: "score",
        bestDirection: "higher",
      },
    ];
    const baseConfig = {
      checksCommand: 'node -e "process.exit(0)"',
      commitPaths: ["src"],
      maxIterations: 3,
    };
    const argv = await deriveExperimentContract({
      workDir: dir,
      entries,
      config: baseConfig,
      args: { _: ["next", process.execPath, "-e", "console.log('METRIC score=1')"] },
    });
    assert.equal(argv.status, "derived");
    if (argv.status !== "derived") return;
    assert.deepEqual(argv.contract.evaluator.execution.command, {
      kind: "argv",
      executable: process.execPath,
      args: ["-e", "console.log('METRIC score=1')"],
    });

    const commandFileContents = "  node -e \"console.log('METRIC score=2')\"  \n";
    await writeFile(path.join(dir, "packet.command"), commandFileContents);
    const commandFile = await deriveExperimentContract({
      workDir: dir,
      entries,
      config: baseConfig,
      args: { command_file: "packet.command" },
    });
    assert.equal(commandFile.status, "derived");
    if (commandFile.status !== "derived") return;
    assert.deepEqual(commandFile.contract.evaluator.execution.command, {
      kind: "shell",
      shell: process.platform === "win32" ? "powershell" : "bash",
      script: commandFileContents,
    });
    assert.ok(
      commandFile.contract.evaluator.execution.protectedInputs.some(
        (input) => input.role === "command-file" && input.path === "packet.command",
      ),
    );

    if (process.platform !== "win32") {
      await writeFile(path.join(dir, "autoresearch.sh"), "echo 'METRIC score=3'\n");
      await writeFile(path.join(dir, "autoresearch.checks.sh"), "exit 0\n");
      const wrappers = await deriveExperimentContract({
        workDir: dir,
        entries,
        config: { commitPaths: ["src"], maxIterations: 3 },
      });
      assert.equal(wrappers.status, "derived");
      if (wrappers.status !== "derived") return;
      assert.deepEqual(wrappers.contract.evaluator.execution.command, {
        kind: "argv",
        executable: "bash",
        args: ["./autoresearch.sh"],
      });
      assert.deepEqual(wrappers.contract.checks[0].execution.command, {
        kind: "argv",
        executable: "bash",
        args: ["./autoresearch.checks.sh"],
      });
    }
  });
});

test("legacy wrapper commands participate in agreement even when config commands exist", async () => {
  if (process.platform === "win32") return;
  await withNamedTempDir("experiment-contract", "wrapper-agreement", async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "autoresearch.sh"), "echo 'METRIC score=1'\n");
    await writeFile(path.join(dir, "autoresearch.checks.sh"), "exit 0\n");
    const result = await deriveExperimentContract({
      workDir: dir,
      entries: [
        {
          type: "config",
          name: "wrapper agreement",
          goal: "Reject an ambiguous evaluator",
          metricName: "score",
          bestDirection: "higher",
        },
      ],
      config: {
        benchmarkCommand: "node -e \"console.log('METRIC score=2')\"",
        checksCommand: 'node -e "process.exit(0)"',
        commitPaths: ["src"],
        maxIterations: 3,
      },
    });

    assert.equal(result.status, "invalid");
    if (result.status === "invalid") {
      assert.ok(result.conflicts.some((conflict) => conflict.field === "evaluator.command"));
      assert.ok(result.conflicts.some((conflict) => conflict.sources.includes("wrapper")));
      assert.ok(result.conflicts.some((conflict) => conflict.field === "checks.command"));
    }
  });
});

test("explicit and separator evaluator sources must agree at acceptance", async () => {
  await withNamedTempDir("experiment-contract", "separator-agreement", async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    const result = await deriveExperimentContract({
      workDir: dir,
      entries: [
        {
          type: "config",
          name: "separator agreement",
          goal: "Reject hidden evaluator precedence",
          metricName: "score",
          bestDirection: "higher",
        },
      ],
      args: {
        command: "node -e \"console.log('METRIC score=1')\"",
        _: ["next", process.execPath, "-e", "console.log('METRIC score=2')"],
      },
      config: {
        checksCommand: 'node -e "process.exit(0)"',
        commitPaths: ["src"],
        maxIterations: 3,
      },
    });

    assert.equal(result.status, "invalid");
    if (result.status === "invalid") {
      assert.ok(result.conflicts.some((conflict) => conflict.field === "evaluator.command"));
      assert.ok(result.conflicts.some((conflict) => conflict.sources.includes("separator")));
    }
  });
});
