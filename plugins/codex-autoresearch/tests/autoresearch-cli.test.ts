import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "./helpers/sharded-test.js";
import { redactCommandDisplay } from "../lib/evidence-redaction.js";
import { dashboardCommandSafety } from "../lib/dashboard-command-safety.js";
import { resolvePackageRoot } from "../lib/runtime-paths.js";
import { PLUGIN_VERSION } from "../lib/plugin-version.js";
import { writeServeRegistry } from "../lib/dashboard-server-registry.js";
import {
  PARTIAL_RESULT_ARTIFACT_MAX_BYTES,
  PARTIAL_RESULT_ARTIFACT_MAX_ROWS,
} from "../lib/partial-results.js";
import { commandForDecisionCapsule } from "../lib/commands/session-forensics.js";
import { analyzeLedgerHealth, repairLedgerRecords } from "../lib/ledger-health.js";
import { renderExportedDashboard } from "./helpers/dashboard-export.js";
import {
  prepareCurrentTreeFinalizationBlocker,
  writeDecisionCapsule,
} from "./helpers/git-fixtures.js";
import { parseLedger, writeLedger } from "./helpers/ledger.js";
import { runNode, runShellCommand } from "./helpers/process-fixtures.js";
import {
  cliPayload,
  isolatedRuntimeEnv,
  pathExists,
  withAutoresearchTempDir,
  writeInstalledRuntimeFixture,
} from "./helpers/cli-session.js";
import {
  createCliRunner,
  createSpawnedCliRunner,
  quoteForShell,
  runGit,
} from "./helpers/process.js";
import {
  createRuntimeReleaseAsset,
  escapeRegExp,
  writeFakeSourcePlugin,
} from "./helpers/runtime-release-fixtures.js";
import {
  addressPort,
  closeServer,
  listenOnRandomPort,
  withReleaseServer,
} from "./helpers/server.js";

const pluginRoot = resolvePackageRoot(import.meta.url);
const cli = path.join(pluginRoot, "scripts", "autoresearch.mjs");
const runCli = createCliRunner(cli, pluginRoot);
const runSpawnedCli = createSpawnedCliRunner(cli, pluginRoot);
const withTempDir = withAutoresearchTempDir;

const git = async (cwd, args) => {
  return await runGit(cwd, args);
};

test("ledger health detects duplicate, missing, non-monotonic, and malformed run fields", () => {
  const duplicateAndMissing = analyzeLedgerHealth([
    { run: 1, status: "keep" },
    { run: 2, status: "discard" },
    { run: 2, status: "measure" },
    { run: 4, status: "keep" },
  ]);

  assert.equal(duplicateAndMissing.ok, false);
  assert.deepEqual(duplicateAndMissing.duplicateRuns, [2]);
  assert.deepEqual(duplicateAndMissing.missingRuns, [3]);
  assert.deepEqual(duplicateAndMissing.nonMonotonicRuns, [{ previous: 2, current: 2, index: 2 }]);
  assert.match(duplicateAndMissing.warnings.join("\n"), /Duplicate run numbers: 2/);

  const nonMonotonic = analyzeLedgerHealth([
    { run: 1, status: "keep" },
    { run: 3, status: "discard" },
    { run: 2, status: "measure" },
  ]);
  assert.deepEqual(nonMonotonic.nonMonotonicRuns, [{ previous: 3, current: 2, index: 2 }]);

  const malformed = analyzeLedgerHealth([
    { run: "2", status: "keep" },
    { run: 0, status: "discard" },
    { run: 1.5, status: "measure" },
    { type: "config" },
  ]);
  assert.deepEqual(malformed.malformedRecords, [0, 1, 2]);
});

test("ledger health bounds large missing-run gaps without enumerating every missing run", () => {
  const health = analyzeLedgerHealth([
    { run: 1, status: "keep" },
    { run: 1_000_000_000, status: "discard" },
  ]);

  assert.equal(health.ok, false);
  assert.equal(health.missingRunCount, 999_999_998);
  assert.equal(health.missingRuns.length, health.bounded.sampleLimit);
  assert.equal(health.missingRunsOmitted, 999_999_978);
  assert.equal(health.missingRunRanges[0].start, 2);
  assert.equal(health.missingRunRanges[0].end, 999_999_999);
  assert.equal(health.missingRunRanges[0].count, 999_999_998);
  assert.equal(health.bounded.truncated, true);
  assert.ok(health.warnings.join("\n").length < 500);
});

test("ledger repair normalizes duplicate numeric runs and preserves evidence", () => {
  const records = [
    { type: "config", metricName: "seconds" },
    { run: 1, status: "keep", evidence: { artifact: "a.json" } },
    { run: 1, status: "discard", evidence: { artifact: "b.json" } },
    { run: "bad", status: "measure", evidence: { artifact: "malformed.json" } },
    { run: 2, status: "keep", evidence: { artifact: "c.json" } },
  ];

  const repair = repairLedgerRecords(records);

  assert.equal(repair.changed, true);
  assert.equal(repair.records.length, records.length);
  assert.deepEqual(
    repair.records.map((record) => record.run),
    [undefined, 1, 2, "bad", 3],
  );
  assert.deepEqual(repair.records[2].evidence, { artifact: "b.json" });
  assert.deepEqual(repair.records[3].evidence, { artifact: "malformed.json" });
  assert.equal(records[2].run, 1, "repair should not mutate caller-owned records");
});

test("ledger-doctor --json returns bounded structured health for malformed JSONL", async () => {
  await withTempDir("ledger-doctor-malformed-jsonl", async (dir) => {
    const ledgerPath = path.join(dir, "autoresearch.jsonl");
    const before = [
      JSON.stringify({ type: "config", metricName: "seconds", bestDirection: "lower" }),
      "{ bad json",
      JSON.stringify({ run: 1, metric: 5, status: "keep" }),
      "",
    ].join("\n");
    await writeFile(ledgerPath, before);

    const result = await runCli(["ledger-doctor", "--cwd", dir, "--json"]);

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.ledgerHealth.parseErrorCount, 1);
    assert.equal(payload.ledgerHealth.parseErrors[0].line, 2);
    assert.equal(payload.ledgerHealth.bounded.truncated, false);
    assert.match(payload.ledgerHealth.warnings.join("\n"), /Malformed JSONL lines: 2/);
    assert.equal(await readFile(ledgerPath, "utf8"), before);
  });
});

test("doctor routes corrupt ledgers to ledger-doctor guidance", async () => {
  await withTempDir("doctor-malformed-jsonl", async (dir) => {
    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      [
        JSON.stringify({ type: "config", metricName: "seconds", bestDirection: "lower" }),
        "{ bad json",
        "",
      ].join("\n"),
    );

    const result = await runCli(["doctor", "--cwd", dir, "--json"]);

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.state.code, "ledger_jsonl_invalid");
    assert.equal(payload.benchmarkContract.activeSource, "none");
    assert.match(payload.nextAction, /ledger-doctor/i);
  });
});

test("ledger-doctor --repair --yes refuses malformed JSONL and writes no backup", async () => {
  await withTempDir("ledger-doctor-malformed-repair-refused", async (dir) => {
    const ledgerPath = path.join(dir, "autoresearch.jsonl");
    const before = [
      JSON.stringify({ type: "config", metricName: "seconds", bestDirection: "lower" }),
      "{ bad json",
      JSON.stringify({ run: 1, metric: 5, status: "keep" }),
      "",
    ].join("\n");
    await writeFile(ledgerPath, before);

    const result = await runCli(["ledger-doctor", "--cwd", dir, "--repair", "--yes", "--json"]);

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.refused, true);
    assert.equal(payload.code, "ledger_parse_errors");
    assert.equal(payload.repair.changed, false);
    assert.equal(payload.backupPath, "");
    assert.equal(await readFile(ledgerPath, "utf8"), before);
    const backups = (await readdir(dir)).filter((entry) =>
      entry.startsWith("autoresearch.jsonl.repair-backup-"),
    );
    assert.deepEqual(backups, []);
  });
});

test("ledger-doctor --json reports duplicate runs without modifying the ledger", async () => {
  await withTempDir("ledger-doctor-read-only", async (dir) => {
    await writeLedger(dir, [
      { type: "config", metricName: "seconds", bestDirection: "lower" },
      { run: 1, metric: 5, status: "keep", evidence: { artifact: "a.json" } },
      { run: 1, metric: 6, status: "discard", evidence: { artifact: "b.json" } },
    ]);
    const ledgerPath = path.join(dir, "autoresearch.jsonl");
    const before = await readFile(ledgerPath, "utf8");

    const result = await runCli(["ledger-doctor", "--cwd", dir, "--json"]);

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.deepEqual(payload.ledgerHealth.duplicateRuns, [1]);
    assert.equal(await readFile(ledgerPath, "utf8"), before);
  });
});

test("ledger-doctor --repair refuses without --yes and leaves files untouched", async () => {
  await withTempDir("ledger-doctor-repair-refuses", async (dir) => {
    await writeLedger(dir, [
      { type: "config", metricName: "seconds", bestDirection: "lower" },
      { run: 1, metric: 5, status: "keep" },
      { run: 1, metric: 6, status: "discard" },
    ]);
    const ledgerPath = path.join(dir, "autoresearch.jsonl");
    const before = await readFile(ledgerPath, "utf8");

    const result = await runCli(["ledger-doctor", "--cwd", dir, "--repair"]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /ledger-doctor --repair requires --yes/);
    assert.equal(await readFile(ledgerPath, "utf8"), before);
    const backups = (await readdir(dir)).filter((entry) =>
      entry.startsWith("autoresearch.jsonl.repair-backup-"),
    );
    assert.deepEqual(backups, []);
  });
});

test("ledger-doctor --repair --yes backs up and normalizes duplicates without deleting evidence", async () => {
  await withTempDir("ledger-doctor-repair-confirmed", async (dir) => {
    await writeLedger(dir, [
      { type: "config", metricName: "seconds", bestDirection: "lower" },
      { run: 1, metric: 5, status: "keep", evidence: { artifact: "a.json" } },
      { run: 1, metric: 6, status: "discard", evidence: { artifact: "b.json" } },
      { run: 2, metric: 4, status: "keep", evidence: { artifact: "c.json" } },
    ]);
    const ledgerPath = path.join(dir, "autoresearch.jsonl");
    const before = await readFile(ledgerPath, "utf8");

    const result = await runCli(["ledger-doctor", "--cwd", dir, "--repair", "--yes", "--json"]);

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.repair.changed, true);
    assert.match(path.basename(payload.backupPath), /^autoresearch\.jsonl\.repair-backup-/);
    assert.equal(await readFile(payload.backupPath, "utf8"), before);
    assert.deepEqual(payload.ledgerHealth.duplicateRuns, [1]);
    assert.equal(payload.repairedLedgerHealth.ok, true);

    const after = parseLedger(await readFile(ledgerPath, "utf8"));
    assert.equal(after.length, 4);
    assert.deepEqual(
      after.map((record) => record.run),
      [undefined, 1, 2, 3],
    );
    assert.deepEqual(after[2].evidence, { artifact: "b.json" });
    assert.deepEqual(after[3].evidence, { artifact: "c.json" });
  });
});

test("state --json includes ledgerHealth and does not repair duplicates", async () => {
  await withTempDir("state-ledger-health", async (dir) => {
    await writeLedger(dir, [
      { type: "config", metricName: "seconds", bestDirection: "lower" },
      { run: 1, metric: 5, status: "keep" },
      { run: 1, metric: 6, status: "discard" },
    ]);
    const ledgerPath = path.join(dir, "autoresearch.jsonl");
    const before = await readFile(ledgerPath, "utf8");

    const result = await runCli(["state", "--cwd", dir, "--json"]);

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ledgerHealth.ok, false);
    assert.deepEqual(payload.ledgerHealth.duplicateRuns, [1]);
    assert.match(payload.ledgerHealth.warnings.join("\n"), /Duplicate run numbers: 1/);
    assert.equal(payload.decisionEnvelope.loopContract.canRunNextPacket, false);
    assert.equal(payload.decisionEnvelope.canonicalNextAction.kind, "ledger-integrity");
    assert.match(payload.decisionEnvelope.canonicalNextAction.command, /ledger-doctor\b.*--json/);
    assert.match(
      payload.decisionEnvelope.loopContract.blockers[0].reason,
      /Duplicate run numbers: 1/,
    );

    const report = await runCli(["state", "--cwd", dir, "--report", "--json"]);
    assert.equal(report.code, 0, report.stderr);
    const reportPayload = JSON.parse(report.stdout);
    assert.equal(reportPayload.report.json.status, "blocked");
    assert.match(reportPayload.report.json.blocker, /Duplicate run numbers: 1/);
    assert.match(reportPayload.report.json.nextCommand, /ledger-doctor\b.*--json/);
    assert.equal(await readFile(ledgerPath, "utf8"), before);
  });
});

test("state --json exposes bounded ledgerHealth for large gaps without repairing", async () => {
  await withTempDir("state-ledger-health-bounded", async (dir) => {
    await writeLedger(dir, [
      { type: "config", metricName: "seconds", bestDirection: "lower" },
      { run: 1, metric: 5, status: "keep" },
      { run: 1_000_000_000, metric: 6, status: "discard" },
    ]);
    const ledgerPath = path.join(dir, "autoresearch.jsonl");
    const before = await readFile(ledgerPath, "utf8");

    const result = await runCli(["state", "--cwd", dir, "--json"]);

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ledgerHealth.ok, false);
    assert.equal(payload.ledgerHealth.missingRunCount, 999_999_998);
    assert.equal(payload.ledgerHealth.missingRuns.length, payload.ledgerHealth.bounded.sampleLimit);
    assert.equal(payload.ledgerHealth.bounded.truncated, true);
    assert.ok(payload.ledgerHealth.warnings.join("\n").length < 500);
    assert.equal(await readFile(ledgerPath, "utf8"), before);
  });
});

test("state exposes missing product claim coverage for shippable retrieval work", async () => {
  await withTempDir("product-claim-coverage-state", async (dir) => {
    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "semantic retrieval",
          goal: "Deliver a shippable lazy semantic retrieval performance improvement.",
          metricName: "seconds",
          bestDirection: "lower",
        }),
        JSON.stringify({
          run: 1,
          metric: 20,
          status: "keep",
          evidenceStatus: "accepted",
          description: "Sidecar safety fails closed and foreground embedding work can be bounded.",
        }),
      ].join("\n") + "\n",
    );

    const result = await runCli(["state", "--cwd", dir]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    const coverage = payload.productClaimCoverage;
    assert.equal(coverage.productGradeReady, false);
    assert.deepEqual(
      coverage.missingRequiredProof.map((proof) => proof.id),
      ["retrieval_accuracy", "lazy_behavior", "ranking_quality", "docs_tests"],
    );
  });
});

test("finalize-preview json exposes missing product-grade claim coverage", async () => {
  await withTempDir("product-claim-coverage-finalize-preview", async (dir) => {
    await git(dir, ["init", "-b", "main"]);
    await git(dir, ["config", "user.email", "codex@example.invalid"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "retrieval.ts"), "export const value = 'base';\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "base"]);

    await git(dir, ["switch", "-c", "codex/retrieval-product-claim"]);
    await writeFile(
      path.join(dir, "src", "retrieval.ts"),
      "export const value = 'bounded foreground embedding';\n",
    );
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "bound foreground embedding work"]);
    const kept = (await git(dir, ["rev-parse", "HEAD"])).trim();

    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "semantic retrieval",
          goal: "Deliver a shippable lazy semantic retrieval performance improvement.",
          metricName: "seconds",
          bestDirection: "lower",
        }),
        JSON.stringify({
          run: 1,
          status: "keep",
          metric: 1,
          description: "Bound foreground embedding work.",
          evidence: "foreground embedding work can be bounded",
          commit: kept,
        }),
        "",
      ].join("\n"),
    );
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "log autoresearch session"]);

    const result = await runCli(["finalize-preview", "--cwd", dir, "--json"]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.productGradeReady, false);
    assert.match(payload.blockers.join("\n"), /retrieval accuracy/i);
    assert.match(payload.blockers.join("\n"), /lazy/i);
    assert.match(result.stdout, /Product-grade evidence is missing/);
    assert.match(result.stdout, /Lazy\/selective behavior/);
    assert.match(result.stdout, /Experimental review branch only/);
  });
});

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
    assert.equal(hasVerificationChurn(compactState.decisionEnvelope?.workflowFriction), true);
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
      const budgetMs = process.env.CODEX_AUTORESEARCH_TEST_SHARD_RANGE ? 2200 : 1500;
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

test("run reports missing primary metric as a failed experiment", async () => {
  await withTempDir("missing-metric", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "missing metric", "--metric-name", "seconds"]);

    const command = `${quoteForShell(process.execPath)} -e "console.log('no metric here')"`;
    const result = await runCli(["run", "--cwd", dir, "--command", command]);
    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.parsedPrimary, null);
    assert.match(payload.metricError, /seconds/);
    assert.equal(payload.logHint.status, "crash");
    assert.deepEqual(payload.logHint.allowedStatuses, ["crash"]);
  });
});

test("test shard runner validates jobs and fails closed on discovery gaps", async () => {
  await withTempDir("test-shard-runner", async (dir) => {
    const shardRunner = path.join(pluginRoot, "dist", "scripts", "run-test-shards.mjs");
    const unshardedFile = path.join(dir, "unsharded.test.mjs");
    await writeFile(
      unshardedFile,
      [
        "import test from 'node:test';",
        "if (process.env.CODEX_AUTORESEARCH_TEST_DISCOVER === '1') {",
        "  console.log('DISCOVERY_WITHOUT_COUNT');",
        "} else {",
        "  console.log('UNSHARDED_EXECUTION_MARKER');",
        "}",
        "test('plain file runs once', () => {});",
      ].join("\n"),
    );

    const invalidJobs = await runNode([shardRunner, unshardedFile, "1"], {
      env: {
        ...process.env,
        CODEX_AUTORESEARCH_TEST_SHARD_JOBS: "not-a-number",
      },
    });
    assert.notEqual(invalidJobs.code, 0);
    assert.match(`${invalidJobs.stdout}\n${invalidJobs.stderr}`, /positive integer/);

    const unsharded = await runNode([shardRunner, unshardedFile, "1"], {
      env: {
        ...process.env,
        CODEX_AUTORESEARCH_TEST_SHARD_VERBOSE: "1",
      },
    });
    assert.equal(unsharded.code, 0, unsharded.stderr);
    const unshardedOutput = `${unsharded.stdout}\n${unsharded.stderr}`;
    assert.equal(
      (unshardedOutput.match(/UNSHARDED_EXECUTION_MARKER/g) || []).length,
      1,
      unshardedOutput,
    );
    assert.equal(unshardedOutput.includes("DISCOVERY_WITHOUT_COUNT"), false, unshardedOutput);

    const missingDiscovery = await runNode([shardRunner, unshardedFile, "2"]);
    assert.notEqual(missingDiscovery.code, 0);
    assert.match(
      `${missingDiscovery.stdout}\n${missingDiscovery.stderr}`,
      /AUTORESEARCH_TEST_COUNT/,
    );

    const unevenShardedFile = path.join(dir, "uneven-sharded.test.mjs");
    await writeFile(
      unevenShardedFile,
      [
        "import test from 'node:test';",
        "if (process.env.CODEX_AUTORESEARCH_TEST_DISCOVER === '1') {",
        "  console.log('AUTORESEARCH_TEST_COUNT 25');",
        "}",
        "test('plain file runs as a shard target', () => {});",
      ].join("\n"),
    );

    const uneven = await runNode([shardRunner, "--jobs", "1", unevenShardedFile, "12"]);
    assert.equal(uneven.code, 0, uneven.stderr);
    const unevenOutput = `${uneven.stdout}\n${uneven.stderr}`;
    assert.match(unevenOutput, /uneven-sharded\.test\.mjs 1\/9 \(1-3\)/);
    assert.match(unevenOutput, /uneven-sharded\.test\.mjs 9\/9 \(25-25\)/);
    assert.equal(unevenOutput.includes("/12"), false, unevenOutput);
  });
});

test("partial-results records diagnostic measure evidence from a failed packet artifact", async () => {
  await withTempDir("partial-results-record", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "partial salvage", "--metric-name", "seconds"]);
    const script = path.join(dir, "partial-packet.mjs");
    await writeFile(
      script,
      [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "mkdirSync('out', { recursive: true });",
        "writeFileSync('out/rows.json', JSON.stringify({ schemaVersion: 1, metricName: 'seconds', formulaVersion: 'v1', rows: [{ seconds: 4.2, rawBody: 'must not persist' }] }));",
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
    const packetPayload = JSON.parse(packet.stdout);

    const list = await runCli(["partial-results", "--cwd", dir, "--from-last"]);
    assert.equal(list.code, 0, list.stderr);
    const listPayload = JSON.parse(list.stdout);
    assert.equal(listPayload.candidates.length, 1);
    assert.equal(listPayload.candidates[0].status, "scored");
    assert.equal(listPayload.candidates[0].metricValue, 4.2);
    assert.equal(JSON.stringify(listPayload).includes("must not persist"), false);

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.canonicalNextAction.kind, "partial-salvage");
    assert.equal(statePayload.nextAction, statePayload.canonicalNextAction.reason);

    const recommend = await runCli(["recommend-next", "--cwd", dir, "--compact"]);
    assert.equal(recommend.code, 0, recommend.stderr);
    const recommendPayload = JSON.parse(recommend.stdout);
    assert.equal(recommendPayload.action.kind, "partial-salvage");
    assert.equal(recommendPayload.nextAction, statePayload.canonicalNextAction.reason);
    assert.equal(
      recommendPayload.decisionEnvelope.canonicalNextAction.kind,
      statePayload.canonicalNextAction.kind,
    );

    const record = await runCli([
      "partial-results",
      "--cwd",
      dir,
      "--record",
      listPayload.candidates[0].id,
    ]);
    assert.equal(record.code, 0, record.stderr);
    const recordPayload = JSON.parse(record.stdout);
    assert.equal(recordPayload.experiment.status, "measure");
    assert.equal(recordPayload.experiment.metricEligible, false);
    assert.equal(recordPayload.experiment.partialResult.validationStatus, "scored");
    assert.equal(recordPayload.evidenceClaim.promotionRelevance, "diagnostic");

    const ledger = await readFile(path.join(dir, "autoresearch.jsonl"), "utf8");
    assert.match(ledger, /"status":"measure"/);
    assert.match(ledger, /"partialResult"/);
    await assert.rejects(access(packetPayload.lastRunPath));
    const evidenceIndex = await readFile(
      path.join(dir, "autoresearch.research", "partial-results", "evidence-index.json"),
      "utf8",
    );
    assert.match(evidenceIndex, /benchmark-artifact/);
  });
});

test("partial-results bounds oversized malformed missing and truncated artifacts", async () => {
  await withTempDir("partial-results-bounds", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "partial bounds", "--metric-name", "seconds"]);
    const rows = Array.from({ length: PARTIAL_RESULT_ARTIFACT_MAX_ROWS + 5 }, (_, index) => ({
      seconds: index + 1,
    }));
    await writeFile(
      path.join(dir, "rows-many.json"),
      JSON.stringify({ schemaVersion: 1, formulaVersion: "v1", rows }),
      "utf8",
    );
    await writeFile(path.join(dir, "rows-bad.json"), "{ nope", "utf8");
    await writeFile(
      path.join(dir, "rows-huge.json"),
      " ".repeat(PARTIAL_RESULT_ARTIFACT_MAX_BYTES + 1),
      "utf8",
    );

    const many = await runCli([
      "partial-results",
      "--cwd",
      dir,
      "--artifact",
      "rows-many.json",
      "--command-hash",
      "hash",
    ]);
    assert.equal(many.code, 0, many.stderr);
    const manyPayload = JSON.parse(many.stdout);
    assert.equal(manyPayload.candidates.length, PARTIAL_RESULT_ARTIFACT_MAX_ROWS);
    assert.equal(
      manyPayload.skippedArtifacts.some((item) => item.reason === "artifact_rows_truncated"),
      true,
    );

    const huge = await runCli(["partial-results", "--cwd", dir, "--artifact", "rows-huge.json"]);
    assert.equal(huge.code, 0, huge.stderr);
    assert.equal(JSON.parse(huge.stdout).skippedArtifacts[0].reason, "artifact_too_large");

    const malformed = await runCli([
      "partial-results",
      "--cwd",
      dir,
      "--artifact",
      "rows-bad.json",
    ]);
    assert.equal(malformed.code, 0, malformed.stderr);
    assert.equal(JSON.parse(malformed.stdout).skippedArtifacts[0].reason, "artifact_invalid_json");

    const missing = await runCli([
      "partial-results",
      "--cwd",
      dir,
      "--artifact",
      "missing-rows.json",
    ]);
    assert.equal(missing.code, 0, missing.stderr);
    assert.equal(JSON.parse(missing.stdout).skippedArtifacts[0].reason, "artifact_missing");
  });
});

test("partial-results rejects outside and linked artifact paths", async (t) => {
  await withTempDir("partial-results-outside", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "partial outside", "--metric-name", "seconds"]);
    const outsideDir = path.join(path.dirname(dir), `${path.basename(dir)}-outside`);
    await mkdir(outsideDir, { recursive: true });
    try {
      const outsideRows = path.join(outsideDir, "rows.json");
      await writeFile(
        outsideRows,
        JSON.stringify({ schemaVersion: 1, formulaVersion: "v1", rows: [{ seconds: 1 }] }),
        "utf8",
      );

      const absoluteOutside = await runCli([
        "partial-results",
        "--cwd",
        dir,
        "--artifact",
        outsideRows,
      ]);
      assert.equal(absoluteOutside.code, 0, absoluteOutside.stderr);
      assert.equal(
        JSON.parse(absoluteOutside.stdout).skippedArtifacts[0].reason,
        "artifact_path_outside_workdir",
      );

      const linkPath = path.join(dir, "linked-rows.json");
      try {
        await symlink(outsideRows, linkPath, "file");
      } catch (error) {
        t.skip(`file symlink unavailable on this platform: ${error}`);
        return;
      }
      const linked = await runCli([
        "partial-results",
        "--cwd",
        dir,
        "--artifact",
        "linked-rows.json",
      ]);
      assert.equal(linked.code, 0, linked.stderr);
      assert.equal(
        JSON.parse(linked.stdout).skippedArtifacts[0].reason,
        "artifact_path_outside_workdir",
      );
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

test("state surfaces active runner progress while next is still executing", async () => {
  await withTempDir("active-progress", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "active progress", "--metric-name", "seconds"]);
    const script = path.join(dir, "slow-packet.mjs");
    const releaseFile = path.join(dir, "release-packet");
    await writeFile(
      script,
      [
        "import { existsSync } from 'node:fs';",
        "const releaseFile = process.argv[2];",
        "const started = Date.now();",
        "const timer = setInterval(() => {",
        "  if (existsSync(releaseFile) || Date.now() - started > 60000) {",
        "    clearInterval(timer);",
        "    console.log('METRIC seconds=1');",
        "  }",
        "}, 100);",
      ].join("\n"),
    );

    const child = spawn(process.execPath, [
      cli,
      "next",
      "--cwd",
      dir,
      "--command",
      `${quoteForShell(process.execPath)} ${quoteForShell(script)} ${quoteForShell(releaseFile)}`,
    ]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    let progress = null;
    const started = Date.now();
    while (Date.now() - started < 30000) {
      const state = await runCli(["state", "--cwd", dir, "--compact"]);
      assert.equal(state.code, 0, state.stderr);
      const payload = JSON.parse(state.stdout);
      progress = payload.experimentEconomics?.progress || null;
      if (progress?.exitState === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await writeFile(releaseFile, "go\n", "utf8");
    assert.equal(progress?.exitState, "running");
    assert.match(progress?.packetId || "", /active/);

    const exitCode = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(exitCode, 0, stderr);
    const packetPayload = JSON.parse(stdout);
    assert.equal(packetPayload.packetEvidence.progressSnapshot.exitState, "completed");
  });
});

test("research-setup creates a quality_gap scratchpad and benchmark", async () => {
  await withTempDir("research-setup", async (dir) => {
    const result = await runCli([
      "research-setup",
      "--cwd",
      dir,
      "--slug",
      "Project Study",
      "--goal",
      "Study the project before improving it",
      "--max-iterations",
      "7",
    ]);
    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.slug, "project-study");
    assert.equal(payload.init.config.metricName, "quality_gap");
    assert.equal(payload.init.config.bestDirection, "lower");
    assert.equal(payload.qualityGap.open, 6);

    const researchRoot = path.join(dir, "autoresearch.research", "project-study");
    assert.match(await readFile(path.join(researchRoot, "brief.md"), "utf8"), /Study the project/);
    assert.match(await readFile(path.join(researchRoot, "sources.md"), "utf8"), /Claim Supported/);
    assert.match(
      await readFile(path.join(researchRoot, "synthesis.md"), "utf8"),
      /Quality-Gap Translation/,
    );
    assert.match(await readFile(path.join(researchRoot, "quality-gaps.md"), "utf8"), /- \[ \]/);

    const scriptName = process.platform === "win32" ? "autoresearch.ps1" : "autoresearch.sh";
    const benchmark = await readFile(path.join(dir, scriptName), "utf8");
    assert.match(benchmark, /quality-gap/);
    assert.match(benchmark, /project-study/);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    assert.equal(JSON.parse(state.stdout).config.metricName, "quality_gap");

    const exportResult = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const exportPayload = JSON.parse(exportResult.stdout);
    assert.match(exportPayload.modeGuidance.difference, /read-only fallback snapshot/);
    const dashboard = await readFile(path.join(dir, "autoresearch-dashboard.html"), "utf8");
    assert.match(dashboard, /"deliveryMode":"static-export"/);
    assert.match(dashboard, /Read-only snapshot/);
    assert.doesNotMatch(dashboard, /Serve dashboard/);
    assert.doesNotMatch(dashboard, /--research-slug \\"project-study\\"/);
    assert.match(dashboard, /activeResearchSlug/);
  });
});

test("research-start dry-run prints the full qualitative loop start plan", async () => {
  await withTempDir("research-start-dry-run", async (dir) => {
    const result = await runCli([
      "research-start",
      "--cwd",
      dir,
      "--slug",
      "language-support",
      "--goal",
      "Improve language support in CodeStory",
      "--checks-command",
      `${quoteForShell(process.execPath)} -e "process.exit(0)"`,
      "--dry-run",
      "--json",
    ]);

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.slug, "language-support");
    assert.equal(payload.metricName, "quality_gap");
    assert.match(payload.commands.setup, /\bresearch-setup\b/);
    assert.match(payload.commands.benchmarkLint, /\bbenchmark-lint\b/);
    assert.match(payload.commands.doctor, /\bdoctor\b.*--check-benchmark/);
    assert.match(payload.commands.baseline, /\bnext\b.*--compact/);
    assert.match(payload.commands.logBaseline, /\blog\b.*--status measure/);
    assert.match(payload.commands.resume, /\brecommend-next\b.*--compact/);
    assert.equal(await pathExists(path.join(dir, "autoresearch.config.json")), false);
  });
});

test("research-start creates a quality-gap session and can skip baseline logging", async () => {
  await withTempDir("research-start-baseline", async (dir) => {
    const result = await runCli([
      "research-start",
      "--cwd",
      dir,
      "--slug",
      "language-support",
      "--goal",
      "Improve language support in CodeStory",
      "--no-baseline-log",
      "--json",
    ]);

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.metricName, "quality_gap");
    assert.equal(payload.baselineLogged, false);
    const config = JSON.parse(await readFile(path.join(dir, "autoresearch.config.json"), "utf8"));
    assert.equal(config.metricName, "quality_gap");
    assert.match(config.benchmarkCommand, /autoresearch\.(ps1|sh)/);
    assert.equal(
      await pathExists(
        path.join(dir, "autoresearch.research", "language-support", "quality-gaps.md"),
      ),
      true,
    );
  });
});

test("research-start skip-init skips default baseline logging cleanly", async () => {
  await withTempDir("research-start-skip-init", async (dir) => {
    const result = await runCli([
      "research-start",
      "--cwd",
      dir,
      "--slug",
      "language-support",
      "--goal",
      "Improve language support in CodeStory",
      "--skip-init",
      "--json",
    ]);

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.baselineLogged, false);
    assert.match(payload.baselineSkippedReason, /skip-init/i);
    assert.equal(payload.setup.init, null);
    assert.equal(payload.benchmarkLint.ok, true);
    assert.equal(payload.benchmarkLint.metricName, "quality_gap");
    assert.equal(payload.doctor.benchmark.emitsPrimary, true);
    assert.equal(await pathExists(path.join(dir, "autoresearch.last-run.json")), false);
    assert.equal(await pathExists(path.join(dir, "autoresearch.jsonl")), false);
    assert.equal(await pathExists(path.join(dir, "autoresearch.config.json")), true);
    assert.equal(
      await pathExists(
        path.join(dir, "autoresearch.research", "language-support", "quality-gaps.md"),
      ),
      true,
    );
  });
});

test("research-start default baseline logging keeps benchmark command authority aligned", async () => {
  await withTempDir("research-start-default-baseline", async (dir) => {
    const result = await runCli([
      "research-start",
      "--cwd",
      dir,
      "--slug",
      "language-support",
      "--goal",
      "Improve language support in CodeStory",
      "--json",
    ]);

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.baselineLogged, true);

    const config = JSON.parse(await readFile(path.join(dir, "autoresearch.config.json"), "utf8"));
    const baselineCommand = payload.baselinePacket?.run?.command;
    const baselineIdentityCommand =
      payload.baselinePacket?.packetEvidence?.commandIdentity?.command;
    assert.equal(config.benchmarkCommand, baselineCommand);
    assert.equal(config.benchmarkCommand, baselineIdentityCommand);
    assert.match(config.benchmarkCommand, /autoresearch\.(ps1|sh)/);

    const ledger = (await readFile(path.join(dir, "autoresearch.jsonl"), "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    const measureEntry = ledger.find((entry) => entry.status === "measure");
    assert.ok(measureEntry);
    assert.equal(measureEntry.benchmarkContract?.command, config.benchmarkCommand);
  });
});

test("quality-gap counts checked and unchecked research gaps", async () => {
  await withTempDir("quality-gap", async (dir) => {
    await runCli([
      "research-setup",
      "--cwd",
      dir,
      "--slug",
      "study",
      "--goal",
      "Study quality gaps",
    ]);
    await writeFile(
      path.join(dir, "autoresearch.research", "study", "quality-gaps.md"),
      [
        "# Quality Gaps",
        "",
        "- [ ] Open gap",
        "- [x] Closed gap",
        "- [X] Rejected with evidence",
        "- [ ] Another open gap",
        "- plain note",
        "",
      ].join("\n"),
    );

    const result = await runCli(["quality-gap", "--cwd", dir, "--research-slug", "study"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /METRIC quality_gap=2/);
    assert.match(result.stdout, /METRIC quality_total=4/);
    assert.match(result.stdout, /METRIC quality_closed=2/);

    const listed = await runCli([
      "quality-gap",
      "--cwd",
      dir,
      "--research-slug",
      "study",
      "--list",
    ]);
    assert.equal(listed.code, 0, listed.stderr);
    const listedPayload = JSON.parse(listed.stdout);
    assert.deepEqual(listedPayload.openItems, ["Open gap", "Another open gap"]);
    assert.deepEqual(listedPayload.closedItems, ["Closed gap", "Rejected with evidence"]);
  });
});

test("session-forensics supports dry-run and safe apply capsule writes", async () => {
  await withTempDir("session-forensics-cli", async (dir) => {
    const sessionPath = path.join(dir, "rollout.jsonl");
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          timestamp: "2026-05-25T00:00:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Segments UX is not the best." }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({ cmd: "git status --short" }),
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T00:00:01.500Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: "API_KEY=abcdefghijklmnop node scripts/private-check.mjs",
            }),
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T00:00:01.600Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: "API_KEY=abc$def%ghi node scripts/private-check.mjs",
            }),
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T00:00:01.700Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: 'CLIENT_SECRET="abc def ghijkl" node scripts/private-check.mjs',
            }),
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T00:00:01.800Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: "TOKEN=abc:def:ghijkl node scripts/private-check.mjs",
            }),
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T00:00:01.850Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: "node scripts/private-check.mjs --api-key flagsecretvalue123",
            }),
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T00:00:01.900Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: 'node scripts/private-check.mjs --client-secret "flag secret value 456"',
            }),
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T00:00:01.950Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: "node scripts/private-check.mjs --api-key=flag:secret:value789",
            }),
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T00:00:02.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call1",
            output:
              "Chunk ID: abc\nProcess exited with code 0\nOriginal token count: 25000\nTotal output lines: 600\nOutput:\ntoken=abcdefghijklmnop",
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T00:00:03.000Z",
          type: "compacted",
          payload: {},
        }),
        JSON.stringify({
          timestamp: "2026-05-25T00:00:04.000Z",
          type: "compacted",
          payload: {},
        }),
        JSON.stringify({
          timestamp: "2026-05-25T00:00:05.000Z",
          type: "compacted",
          payload: {},
        }),
      ].join("\n"),
    );

    const dryRun = await runCli([
      "session-forensics",
      "--cwd",
      dir,
      "--session-jsonl",
      sessionPath,
      "--research-slug",
      "session-019e",
      "--dry-run",
    ]);
    assert.equal(dryRun.code, 0, dryRun.stderr);
    const dryPayload = JSON.parse(dryRun.stdout);
    assert.equal(dryPayload.ok, true);
    assert.equal(dryPayload.dryRun, true);
    assert.equal(dryPayload.wrote, false);
    assert.equal(dryPayload.sourcePath, "rollout.jsonl");
    assert.equal(dryPayload.compact, true);
    assert.equal(typeof dryPayload.commandClassCount, "number");
    assert.equal(Object.hasOwn(dryPayload, "commandClasses"), false);
    for (const rawSecret of [
      "abcdefghijklmnop",
      "abc$def%ghi",
      "abc def ghijkl",
      "abc:def:ghijkl",
      "flagsecretvalue123",
      "flag secret value 456",
      "flag:secret:value789",
    ]) {
      assert.equal(JSON.stringify(dryPayload).includes(rawSecret), false);
      assert.equal(JSON.stringify(dryPayload.topCommandHeads).includes(rawSecret), false);
    }
    assert.equal((dryPayload.canonicalNextAction.command || "").includes(sessionPath), false);
    assert.equal(dryPayload.canonicalNextAction.kind, "decision-capsule");
    assert.match(dryPayload.canonicalNextAction.command || "", /session-forensics/);
    assert.match(dryPayload.canonicalNextAction.command || "", /--apply/);
    assert.match(dryPayload.canonicalNextAction.command || "", /--session-jsonl rollout\.jsonl/);
    assert.match(dryPayload.canonicalNextAction.command || "", /--research-slug session-019e/);
    assert.doesNotMatch(dryPayload.canonicalNextAction.command || "", /recommend-next/);
    assert.doesNotMatch(
      dryPayload.canonicalNextAction.command || "",
      /node scripts[\\/]autoresearch\.mjs/i,
    );
    assert.equal(dryPayload.plannedFiles.length, 5);
    assert.equal(dryPayload.decisionCapsule.kind, "session-decision-capsule");
    assert.match(dryPayload.decisionCapsule.nextExperiment, /context capsule|bounded|cheapest/i);
    await assert.rejects(() =>
      access(path.join(dir, "autoresearch.research", "session-019e", "session-digest.md")),
    );

    const applied = await runCli([
      "session-forensics",
      "--cwd",
      dir,
      "--session-jsonl",
      sessionPath,
      "--research-slug",
      "session-019e",
      "--apply",
    ]);
    assert.equal(applied.code, 0, applied.stderr);
    const applyPayload = JSON.parse(applied.stdout);
    assert.equal(applyPayload.wrote, true);
    assert.equal(applyPayload.evidenceClaims > 0, true);

    const researchRoot = path.join(dir, "autoresearch.research", "session-019e");
    const digest = await readFile(path.join(researchRoot, "session-digest.md"), "utf8");
    const capsule = JSON.parse(
      await readFile(path.join(researchRoot, "decision-capsule.json"), "utf8"),
    );
    const gaps = await readFile(path.join(researchRoot, "quality-gaps.md"), "utf8");
    const evidence = JSON.parse(
      await readFile(path.join(researchRoot, "evidence-index.json"), "utf8"),
    );
    assert.doesNotMatch(
      capsule.enforcement.commandHint || "",
      /node scripts[\\/]autoresearch\.mjs/i,
    );
    assert.match(capsule.enforcement.commandHint || "", /autoresearch\.mjs/);
    assert.match(digest, /Session Forensics Import/);
    assert.match(digest, /Decision Capsule/);
    assert.equal(capsule.kind, "session-decision-capsule");
    assert.equal(JSON.stringify(capsule).includes("abcdefghijklmnop"), false);
    assert.match(gaps, /\[evidence:ev-/);
    assert.equal(evidence.schemaVersion, 1);
    assert.equal(JSON.stringify(evidence).includes("abcdefghijklmnop"), false);

    const full = await runCli([
      "session-forensics",
      "--cwd",
      dir,
      "--session-jsonl",
      sessionPath,
      "--research-slug",
      "session-019e",
      "--dry-run",
      "--json-full",
    ]);
    assert.equal(full.code, 0, full.stderr);
    const fullPayload = JSON.parse(full.stdout);
    assert.equal(fullPayload.compact, false);
    assert.equal(fullPayload.commandClasses["git status --short"], 1);
    assert.equal(
      fullPayload.commandClasses["API_KEY=<redacted> node scripts/private-check.mjs"],
      2,
    );
    assert.equal(
      fullPayload.commandClasses["CLIENT_SECRET=<redacted> node scripts/private-check.mjs"],
      1,
    );
    assert.equal(fullPayload.commandClasses["TOKEN=<redacted> node scripts/private-check.mjs"], 1);
    assert.equal(
      fullPayload.commandClasses["node scripts/private-check.mjs --api-key <redacted>"],
      1,
    );
    assert.equal(
      fullPayload.commandClasses["node scripts/private-check.mjs --client-secret <redacted>"],
      1,
    );
    assert.equal(
      fullPayload.commandClasses["node scripts/private-check.mjs --api-key=<redacted>"],
      1,
    );
    assert.equal(JSON.stringify(fullPayload.commandClasses).includes("abcdefghijklmnop"), false);
    assert.equal(JSON.stringify(fullPayload).includes("abcdefghijklmnop"), false);
    for (const rawSecret of [
      "abc$def%ghi",
      "abc def ghijkl",
      "abc:def:ghijkl",
      "flagsecretvalue123",
      "flag secret value 456",
      "flag:secret:value789",
    ]) {
      assert.equal(JSON.stringify(fullPayload).includes(rawSecret), false);
    }
    assert.equal(Array.isArray(fullPayload.productSignals), true);

    const reapplied = await runCli([
      "session-forensics",
      "--cwd",
      dir,
      "--session-jsonl",
      sessionPath,
      "--research-slug",
      "session-019e",
      "--apply",
    ]);
    assert.equal(reapplied.code, 0, reapplied.stderr);
    const evidenceAfter = JSON.parse(
      await readFile(path.join(researchRoot, "evidence-index.json"), "utf8"),
    );
    const claimIds = new Set(
      (evidenceAfter.claims || []).map((claim: { id?: string }) => claim.id).filter(Boolean),
    );
    const gapsAfter = await readFile(path.join(researchRoot, "quality-gaps.md"), "utf8");
    const referencedIds = [...gapsAfter.matchAll(/\[evidence:(ev-[^\]]+)\]/g)].map(
      (match) => match[1],
    );
    assert.equal(referencedIds.length > 0, true);
    for (const evidenceId of referencedIds) {
      assert.equal(claimIds.has(evidenceId), true, evidenceId);
    }
    assert.equal((evidenceAfter.claims || []).length >= (evidence.claims || []).length, true);
  });
});

test("session-forensics routes context distillation to apply despite stale safe hints", () => {
  const script = path.join(pluginRoot, "state", "scripts", "autoresearch.mjs");
  const subcommandFor = (command: string) => {
    const launcherIndex = command.indexOf("autoresearch.mjs");
    assert.notEqual(launcherIndex, -1);
    const tokens = command
      .slice(launcherIndex + "autoresearch.mjs".length)
      .trim()
      .split(/\s+/);
    return tokens[0];
  };
  const commands = {
    state: `node ${script} state --cwd C:\\repo --compact`,
    recommendNext: `node ${script} recommend-next --cwd C:\\repo --compact`,
    benchmarkLint: `node ${script} benchmark-lint --cwd C:\\repo`,
    applyForensics: `node ${script} session-forensics --cwd C:\\repo --session-jsonl rollout.jsonl --research-slug session-019e --apply`,
  };

  for (const commandHint of [
    "node scripts/autoresearch.mjs recommend-next --cwd <project> --compact",
    "node scripts/autoresearch.mjs state --cwd <project> --compact",
  ]) {
    const command = commandForDecisionCapsule(
      {
        enforcement: {
          commandHint,
          triggeredBy: ["sessionDecisionCapsule", "contextDistillation"],
        },
      },
      commands,
    );

    assert.match(command, /session-forensics/);
    assert.equal(subcommandFor(command), "session-forensics");
    assert.match(command, /--apply/);
    assert.match(command, /--session-jsonl rollout\.jsonl/);
    assert.match(command, /--research-slug session-019e/);
  }
});

test("session-forensics preserves advisory capsule command hints", async () => {
  await withTempDir("session-forensics-advisory-hint", async (dir) => {
    const sessionPath = path.join(dir, "advisory-rollout.jsonl");
    const rows = [
      JSON.stringify({
        timestamp: "2026-06-12T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "019eadvisory" },
      }),
      JSON.stringify({
        timestamp: "2026-06-12T10:01:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "Reviewed the imported session signals and found no blocker.",
            },
          ],
        },
      }),
    ];
    await writeFile(sessionPath, rows.join("\n"));

    const dryRun = await runCli([
      "session-forensics",
      "--cwd",
      dir,
      "--session-jsonl",
      sessionPath,
      "--research-slug",
      "advisory",
      "--dry-run",
    ]);
    assert.equal(dryRun.code, 0, dryRun.stderr);
    const dryPayload = JSON.parse(dryRun.stdout);
    assert.equal(dryPayload.decisionCapsule.enforcement.mode, "advisory");
    assert.equal(dryPayload.canonicalNextAction.kind, "next-packet");
    assert.equal(dryPayload.canonicalNextAction.command || "", "");
    assert.match(dryPayload.decisionCapsule.enforcement.commandHint || "", /autoresearch\.mjs/);
    assert.match(dryPayload.decisionCapsule.enforcement.commandHint || "", /recommend-next/);
    assert.match(dryPayload.decisionCapsule.enforcement.commandHint || "", /--compact/);
    assert.doesNotMatch(
      dryPayload.decisionCapsule.enforcement.commandHint || "",
      /node scripts[\\/]autoresearch\.mjs/i,
    );

    const applied = await runCli([
      "session-forensics",
      "--cwd",
      dir,
      "--session-jsonl",
      sessionPath,
      "--research-slug",
      "advisory",
      "--apply",
    ]);
    assert.equal(applied.code, 0, applied.stderr);
    const applyPayload = JSON.parse(applied.stdout);
    assert.equal(applyPayload.decisionCapsule.enforcement.mode, "advisory");
    assert.equal(applyPayload.canonicalNextAction.kind, "next-packet");
    assert.equal(applyPayload.canonicalNextAction.command || "", "");
    assert.match(applyPayload.decisionCapsule.enforcement.commandHint || "", /autoresearch\.mjs/);
    assert.match(applyPayload.decisionCapsule.enforcement.commandHint || "", /recommend-next/);
    assert.match(applyPayload.decisionCapsule.enforcement.commandHint || "", /--compact/);
    assert.doesNotMatch(
      applyPayload.decisionCapsule.enforcement.commandHint || "",
      /node scripts[\\/]autoresearch\.mjs/i,
    );

    const capsule = JSON.parse(
      await readFile(
        path.join(dir, "autoresearch.research", "advisory", "decision-capsule.json"),
        "utf8",
      ),
    );
    assert.equal(capsule.enforcement.mode, "advisory");
    assert.match(capsule.enforcement.commandHint || "", /autoresearch\.mjs/);
    assert.match(capsule.enforcement.commandHint || "", /recommend-next/);
    assert.match(capsule.enforcement.commandHint || "", /--compact/);
    assert.doesNotMatch(
      capsule.enforcement.commandHint || "",
      /node scripts[\\/]autoresearch\.mjs/i,
    );
  });
});

test("session-forensics dry run surfaces goal-frame correction capsule", async () => {
  await withTempDir("session-forensics-goal-frame", async (dir) => {
    const sessionPath = path.join(dir, "goal-frame-rollout.jsonl");
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          timestamp: "2026-06-01T13:00:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "That's not the goal of the autoresearch, that's my prompt. Keep the real research goal from the project state.",
              },
            ],
          },
        }),
      ].join("\n"),
    );

    const result = await runCli([
      "session-forensics",
      "--cwd",
      dir,
      "--session-jsonl",
      sessionPath,
      "--research-slug",
      "goal-frame-correction",
      "--dry-run",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);

    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.wrote, false);
    assert.equal(payload.canonicalNextAction.kind, "decision-capsule");
    assert.equal(payload.decisionCapsule.enforcement.mode, "bounded-next");
    assert.equal(payload.decisionCapsule.enforcement.canRunNextPacket, false);
    assert.equal(payload.decisionCapsule.enforcement.allowBoundedNext, true);
    assert.equal(
      payload.productSignals.some((signal) => signal.kind === "goal_frame_mismatch"),
      true,
    );
    assert.match(payload.decisionCapsule.bottleneck, /goal-frame drift/i);
    assert.match(payload.nextAction, /durable Autoresearch goal/i);
  });
});

test("session-forensics requires an explicit gate for outside-workdir JSONL", async () => {
  await withTempDir("session-forensics-boundary", async (dir) => {
    const projectDir = path.join(dir, "project");
    await mkdir(projectDir, { recursive: true });
    const sessionPath = path.join(dir, "outside-rollout.jsonl");
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          timestamp: "2026-05-25T00:00:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Segments UX is not the best." }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T00:00:01.000Z",
          type: "compacted",
          payload: {},
        }),
        JSON.stringify({
          timestamp: "2026-05-25T00:00:02.000Z",
          type: "compacted",
          payload: {},
        }),
        JSON.stringify({
          timestamp: "2026-05-25T00:00:03.000Z",
          type: "compacted",
          payload: {},
        }),
      ].join("\n"),
    );

    const blocked = await runCli([
      "session-forensics",
      "--cwd",
      projectDir,
      "--session-jsonl",
      sessionPath,
      "--research-slug",
      "outside-session",
      "--dry-run",
    ]);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /--allow-outside-workdir/);

    const allowed = await runCli([
      "session-forensics",
      "--cwd",
      projectDir,
      "--session-jsonl",
      sessionPath,
      "--research-slug",
      "outside-session",
      "--dry-run",
      "--allow-outside-workdir",
    ]);
    assert.equal(allowed.code, 0, allowed.stderr);
    const payload = JSON.parse(allowed.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.sourcePath, "<outside-workdir>/outside-rollout.jsonl");
    assert.equal(payload.canonicalNextAction.kind, "decision-capsule");
    assert.match(payload.canonicalNextAction.command || "", /session-forensics/);
    assert.match(payload.canonicalNextAction.command || "", /--apply/);
    assert.match(payload.canonicalNextAction.command || "", /--allow-outside-workdir/);
    assert.doesNotMatch(payload.canonicalNextAction.command || "", /<outside-workdir>/);
    assert.equal((payload.canonicalNextAction.command || "").includes(sessionPath), true);
    assert.doesNotMatch(
      payload.canonicalNextAction.command || "",
      /node scripts[\\/]autoresearch\.mjs/i,
    );
    assert.match(payload.canonicalNextAction.reason || "", /context capsule/i);
    assert.deepEqual(payload.snippets, []);
  });
});

test("session-forensics keeps secondary overfit blockers visible in compact output", async () => {
  await withTempDir("session-forensics-real-shape", async (dir) => {
    const sessionPath = path.join(dir, "real-shape-rollout.jsonl");
    const rows = [
      JSON.stringify({
        timestamp: "2026-06-11T20:24:14.000Z",
        type: "session_meta",
        payload: { id: "019eb85a" },
      }),
      ...Array.from({ length: 6 }, (_item, index) =>
        JSON.stringify({
          timestamp: `2026-06-12T20:00:0${index}.000Z`,
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "benchmark-lint timed out and parses zero primary METRIC lines; the benchmark contract is broken.",
              },
            ],
          },
        }),
      ),
      JSON.stringify({
        timestamp: "2026-06-12T22:40:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "The targeted row wins are substantially overfit benchmark-specific retrieval steering through task-family detectors, protected probes, and static citations.",
            },
          ],
        },
      }),
    ];
    await writeFile(sessionPath, rows.join("\n"));

    const result = await runCli([
      "session-forensics",
      "--cwd",
      dir,
      "--session-jsonl",
      sessionPath,
      "--research-slug",
      "real-shape",
      "--dry-run",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    const productKinds = new Map(payload.productSignals.map((signal) => [signal.kind, signal]));

    assert.equal(payload.compact, true);
    assert.equal(payload.canonicalNextAction.kind, "decision-capsule");
    assert.match(payload.canonicalNextAction.command || "", /benchmark-lint/);
    assert.doesNotMatch(
      payload.canonicalNextAction.command || "",
      /node scripts[\\/]autoresearch\.mjs/i,
    );
    assert.doesNotMatch(
      payload.decisionCapsule.enforcement.commandHint || "",
      /node scripts[\\/]autoresearch\.mjs/i,
    );
    assert.match(payload.decisionCapsule.enforcement.commandHint || "", /autoresearch\.mjs/);
    assert.equal(productKinds.has("benchmark_contract_broken"), true);
    assert.equal(productKinds.has("benchmark_overfit_steering"), true);
    assert.match(payload.decisionCapsule.evidence.join("\n"), /overfit row wins/i);
    assert.equal(Object.hasOwn(payload, "commandClasses"), false);
  });
});

test("state and recommend-next surface active decision capsules as loop brakes", async () => {
  await withTempDir("active-decision-capsule-state", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "capsule state", "--metric-name", "seconds"]);
    await writeDecisionCapsule(dir, "benchmark-contract");

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.sessionDecisionCapsule.kind, "session-decision-capsule");
    assert.equal(
      statePayload.decisionEnvelope.sessionDecisionCapsule.kind,
      "session-decision-capsule",
    );
    assert.equal(statePayload.canonicalNextAction.kind, "decision-capsule");
    assert.notEqual(statePayload.decisionEnvelope.canonicalNextAction.toolName, "decision_capsule");
    assert.equal(statePayload.decisionEnvelope.canonicalNextAction.toolName, "recommend_next");
    assert.equal(statePayload.loopContract.canRunNextPacket, false);
    const stateActionCommand = statePayload.canonicalNextAction.command || "";
    assert.match(stateActionCommand, /autoresearch\.mjs (?:recommend-next|state|benchmark-lint)\b/);
    assert.doesNotMatch(stateActionCommand, /node scripts[\\/]autoresearch\.mjs/i);

    const recommend = await runCli(["recommend-next", "--cwd", dir, "--compact"]);
    assert.equal(recommend.code, 0, recommend.stderr);
    const recommendPayload = JSON.parse(recommend.stdout);
    assert.equal(recommendPayload.sessionDecisionCapsule.kind, "session-decision-capsule");
    assert.equal(recommendPayload.decisionEnvelope.canonicalNextAction.kind, "decision-capsule");
    assert.notEqual(
      recommendPayload.decisionEnvelope.canonicalNextAction.toolName,
      "decision_capsule",
    );
    assert.equal(recommendPayload.decisionEnvelope.canonicalNextAction.toolName, "recommend_next");
    const recommendActionCommand =
      recommendPayload.decisionEnvelope.canonicalNextAction.command || "";
    assert.match(
      recommendActionCommand,
      /autoresearch\.mjs (?:recommend-next|state|benchmark-lint)\b/,
    );
    assert.doesNotMatch(recommendActionCommand, /node scripts[\\/]autoresearch\.mjs/i);
    assert.match(recommendPayload.nextAction, /benchmark-lint|primary METRIC/i);

    const doctor = await runCli(["doctor", "--cwd", dir, "--explain"]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctorPayload = JSON.parse(doctor.stdout);
    assert.equal(doctorPayload.ok, false);
    assert.equal(doctorPayload.loopContract.canRunNextPacket, false);
    assert.equal(doctorPayload.canonicalNextAction.kind, "decision-capsule");
    assert.equal(doctorPayload.state.decisionEnvelope.canonicalNextAction.kind, "decision-capsule");
    assert.equal(doctorPayload.state.sessionDecisionCapsule.kind, "session-decision-capsule");
    assert.match(doctorPayload.issues.join("\n"), /benchmark-lint|primary METRIC/i);
    assert.match(doctorPayload.nextAction, /benchmark-lint|primary METRIC/i);
    assert.doesNotMatch(doctorPayload.explanation.verdict, /no blocking/i);

    const { toolSchemas } = await import("../lib/tool-schemas.js");
    const doctorSchema = toolSchemas.find((tool) => tool.name === "doctor_session");
    assert.ok(doctorSchema);
    for (const field of Object.keys(doctorPayload)) {
      assert.ok(
        doctorSchema.outputSchema.properties[field],
        `doctor_session schema should cover doctor --explain field ${field}`,
      );
    }
    assert.equal(doctorSchema.outputSchema.properties.loopContract.type, "object");
    assert.equal(doctorSchema.outputSchema.properties.canonicalNextAction.type, "object");
    assert.equal(doctorSchema.outputSchema.properties.runtimeProvenance.type, "object");
    assert.equal(doctorSchema.outputSchema.properties.decisionEnvelope.type, "object");
    assert.equal(doctorSchema.outputSchema.properties.sessionDecisionCapsule.type, "object");
    assert.match(doctorSchema.outputSchema.properties.state.description, /decisionEnvelope/);
  });
});

test("recommend-next compact bounds noisy session evidence", async () => {
  await withTempDir("recommend-next-noisy-session", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "noisy compact", "--metric-name", "seconds"]);
    const rawBody = [
      "RAW_TOOL_OUTPUT_BODY_SENTINEL",
      "Chunk ID: noisy",
      "Original token count: 65601",
      "Output:",
      "x".repeat(9000),
    ].join("\n");
    await writeDecisionCapsule(dir, "noisy-session", {
      evidence: [
        "User rejected the product bar after accuracy was not tested.",
        "Assistant admitted the loop-complete signal was treated as enough.",
        "Tool output exceeded the compact handoff budget.",
        rawBody,
      ],
      commandBudgetWarnings: [rawBody],
    });

    const recommend = await runCli(["recommend-next", "--cwd", dir, "--compact"]);
    assert.equal(recommend.code, 0, recommend.stderr);
    assert.equal(recommend.stdout.length < 7000, true, String(recommend.stdout.length));
    assert.doesNotMatch(recommend.stdout, /RAW_TOOL_OUTPUT_BODY_SENTINEL/);
    const payload = JSON.parse(recommend.stdout);
    assert.equal(payload.evidenceNotes.length <= 3, true);
    assert.equal(
      payload.evidenceNotes[0],
      "User rejected the product bar after accuracy was not tested.",
    );
  });
});

test("next refuses hard decision capsules before running a packet", async () => {
  await withTempDir("next-hard-decision-capsule", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "hard capsule", "--metric-name", "seconds"]);
    await writeDecisionCapsule(dir, "benchmark-contract");

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1')"`;
    const result = await runCli(["next", "--cwd", dir, "--command", command, "--compact"]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.refused, true);
    assert.equal(payload.code, "next_blocked_by_loop_contract");
    assert.equal(payload.blockingAction.kind, "decision-capsule");
    assert.equal(payload.sessionDecisionCapsule.enforcement.mode, "hard-block");
    assert.match(payload.clearingCondition, /benchmark-lint/i);
  });
});

test("next refuses fixed-control rerun commands without override", async () => {
  await withTempDir("fixed-control-next", async (dir) => {
    const secret = "sk-fixed-control-next-secret-123";
    const sentinel = path.join(dir, "next-sentinel.txt");
    await runCli(["init", "--cwd", dir, "--name", "fixed control", "--metric-name", "score"]);
    const command = `${quoteForShell(process.execPath)} -e "require('node:fs').writeFileSync(process.argv[1], 'ran'); console.log('METRIC score=1')" ${quoteForShell(sentinel)} --mode no-codestory --token=${secret}`;
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({
        name: "fixed control",
        goal: "preserve baseline",
        metricName: "score",
        metricUnit: "points",
        bestDirection: "higher",
        benchmarkCommand: command,
        fixedControl: {
          artifact: "target/control/no-codestory.json",
          reason: "The no-CodeStory control is fixed for this round.",
          forbiddenCommandPatterns: [`--mode no-codestory --token=${secret}`],
          reuseCommandHint: `OPENAI_API_KEY=${secret} node bench.mjs --reuse-control target/control/no-codestory.json`,
        },
      }),
    );

    const blocked = await runCli(["next", "--cwd", dir, "--compact"]);
    assert.equal(blocked.code, 0, blocked.stderr);
    const blockedPayload = JSON.parse(blocked.stdout);
    assert.equal(blockedPayload.ok, false);
    assert.equal(blockedPayload.refused, true);
    assert.equal(blockedPayload.code, "fixed_control_rerun_blocked");
    assert.match(blockedPayload.nextAction, /target\/control\/no-codestory\.json/);
    assert.doesNotMatch(blocked.stdout, new RegExp(secret));
    assert.equal(await pathExists(sentinel), false);

    const allowed = await runCli([
      "next",
      "--cwd",
      dir,
      "--compact",
      "--allow-fixed-control-rerun",
    ]);
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.equal(await pathExists(sentinel), true);
  });
});

test("run refuses fixed-control rerun commands without override", async () => {
  await withTempDir("fixed-control-run", async (dir) => {
    const sentinel = path.join(dir, "run-sentinel.txt");
    await runCli(["init", "--cwd", dir, "--name", "fixed control", "--metric-name", "score"]);
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({
        name: "fixed control",
        goal: "preserve baseline",
        metricName: "score",
        metricUnit: "points",
        bestDirection: "higher",
        fixedControl: {
          artifact: "target/control/no-codestory.json",
          reason: "The no-CodeStory control is fixed for this round.",
          forbiddenCommandPatterns: ["--mode no-codestory"],
          reuseCommandHint: "node bench.mjs --reuse-control target/control/no-codestory.json",
        },
      }),
    );

    const command = `${quoteForShell(process.execPath)} -e "require('node:fs').writeFileSync(process.argv[1], 'ran'); console.log('METRIC score=1')" ${quoteForShell(sentinel)} --mode no-codestory`;
    const blocked = await runCli(["run", "--cwd", dir, "--command", command]);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr + blocked.stdout, /fixed_control_rerun_blocked/);
    assert.equal(await pathExists(sentinel), false);

    const allowed = await runCli([
      "run",
      "--cwd",
      dir,
      "--command",
      command,
      "--allow-fixed-control-rerun",
    ]);
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.equal(await pathExists(sentinel), true);
  });
});

test("doctor check-benchmark refuses fixed-control rerun commands without executing", async () => {
  await withTempDir("fixed-control-doctor", async (dir) => {
    const secret = "sk-fixed-control-doctor-secret-123";
    const sentinel = path.join(dir, "doctor-sentinel.txt");
    const command = `${quoteForShell(process.execPath)} -e "require('node:fs').writeFileSync(process.argv[1], 'ran'); console.log('METRIC score=1')" ${quoteForShell(sentinel)} --mode no-codestory --token=${secret}`;
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({
        name: "fixed control",
        goal: "preserve baseline",
        metricName: "score",
        metricUnit: "points",
        bestDirection: "higher",
        benchmarkCommand: command,
        fixedControl: {
          artifact: "target/control/no-codestory.json",
          reason: "The no-CodeStory control is fixed for this round.",
          forbiddenCommandPatterns: [`--mode no-codestory --token=${secret}`],
          reuseCommandHint: `OPENAI_API_KEY=${secret} node bench.mjs --reuse-control target/control/no-codestory.json`,
        },
      }),
    );

    const blocked = await runCli(["doctor", "--cwd", dir, "--check-benchmark", "--json"]);
    assert.equal(blocked.code, 0, blocked.stderr);
    assert.equal(await pathExists(sentinel), false);
    assert.doesNotMatch(blocked.stdout, new RegExp(secret));
    const payload = JSON.parse(blocked.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.benchmark.checked, true);
    assert.equal(payload.benchmark.exitCode, null);
    assert.equal(payload.benchmark.fixedControlViolation.code, "fixed_control_rerun_blocked");
    assert.match(payload.issues.join("\n"), /fixed_control_rerun_blocked/);

    const allowed = await runCli([
      "doctor",
      "--cwd",
      dir,
      "--check-benchmark",
      "--json",
      "--allow-fixed-control-rerun",
    ]);
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.equal(await pathExists(sentinel), true);
  });
});

test("benchmark-lint refuses fixed-control explicit commands without override", async () => {
  await withTempDir("fixed-control-benchmark-lint", async (dir) => {
    const secret = "sk-fixed-control-lint-secret-123";
    const sentinel = path.join(dir, "lint-sentinel.txt");
    const command = `${quoteForShell(process.execPath)} -e "require('node:fs').writeFileSync(process.argv[1], 'ran'); console.log('METRIC score=1')" ${quoteForShell(sentinel)} --mode no-codestory --token=${secret}`;
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({
        name: "fixed control",
        goal: "preserve baseline",
        metricName: "score",
        metricUnit: "points",
        bestDirection: "higher",
        fixedControl: {
          artifact: "target/control/no-codestory.json",
          reason: "The no-CodeStory control is fixed for this round.",
          forbiddenCommandPatterns: [`--mode no-codestory --token=${secret}`],
          reuseCommandHint: `OPENAI_API_KEY=${secret} node bench.mjs --reuse-control target/control/no-codestory.json`,
        },
      }),
    );

    const blocked = await runCli(["benchmark-lint", "--cwd", dir, "--command", command]);
    assert.equal(blocked.code, 0, blocked.stderr);
    assert.equal(await pathExists(sentinel), false);
    assert.doesNotMatch(blocked.stdout, new RegExp(secret));
    const payload = JSON.parse(blocked.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "fixed_control_rerun_blocked");
    assert.equal(payload.fixedControlViolation.code, "fixed_control_rerun_blocked");
    assert.match(payload.issues.join("\n"), /fixed_control_rerun_blocked/);

    const allowed = await runCli([
      "benchmark-lint",
      "--cwd",
      dir,
      "--command",
      command,
      "--allow-fixed-control-rerun",
    ]);
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.equal(await pathExists(sentinel), true);
  });
});

test("benchmark-inspect refuses fixed-control explicit commands without override", async () => {
  await withTempDir("fixed-control-benchmark-inspect", async (dir) => {
    const secret = "sk-fixed-control-inspect-secret-123";
    const sentinel = path.join(dir, "inspect-sentinel.txt");
    const command = `${quoteForShell(process.execPath)} -e "require('node:fs').writeFileSync(process.argv[1], 'ran'); console.log('METRIC score=1')" ${quoteForShell(sentinel)} --mode no-codestory --token=${secret}`;
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({
        name: "fixed control",
        goal: "preserve baseline",
        metricName: "score",
        metricUnit: "points",
        bestDirection: "higher",
        fixedControl: {
          artifact: "target/control/no-codestory.json",
          reason: "The no-CodeStory control is fixed for this round.",
          forbiddenCommandPatterns: [`--mode no-codestory --token=${secret}`],
          reuseCommandHint: `OPENAI_API_KEY=${secret} node bench.mjs --reuse-control target/control/no-codestory.json`,
        },
      }),
    );

    const blocked = await runCli(["benchmark-inspect", "--cwd", dir, "--command", command]);
    assert.equal(blocked.code, 0, blocked.stderr);
    assert.equal(await pathExists(sentinel), false);
    assert.doesNotMatch(blocked.stdout, new RegExp(secret));
    const payload = JSON.parse(blocked.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "fixed_control_rerun_blocked");
    assert.equal(payload.fixedControlViolation.code, "fixed_control_rerun_blocked");
    assert.match(payload.warnings.join("\n"), /fixed_control_rerun_blocked/);

    const allowed = await runCli([
      "benchmark-inspect",
      "--cwd",
      dir,
      "--command",
      command,
      "--allow-fixed-control-rerun",
    ]);
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.equal(await pathExists(sentinel), true);
  });
});

test("state exposes fixed-control config", async () => {
  await withTempDir("fixed-control-state", async (dir) => {
    const secret = "sk-fixed-control-state-secret-123";
    const longReason = "The no-CodeStory control is fixed for this round. " + "r".repeat(500);
    const forbiddenCommandPatterns = Array.from(
      { length: 16 },
      (_, index) => `--mode no-codestory-${index} --token=${secret}`,
    );
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC score=1')" --mode no-codestory --token=${secret}`;
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({
        name: "fixed control",
        goal: "preserve baseline",
        metricName: "score",
        metricUnit: "points",
        bestDirection: "higher",
        benchmarkCommand: command,
        fixedControl: {
          artifact: "target/control/no-codestory.json",
          reason: longReason,
          validUntilChanged: Array.from({ length: 13 }, (_, index) => `benchmarks/${index}.mjs`),
          forbiddenCommandPatterns,
          reuseCommandHint: `OPENAI_API_KEY=${secret} node bench.mjs --reuse-control target/control/no-codestory.json ${"x".repeat(500)}`,
        },
      }),
    );

    const full = await runCli(["state", "--cwd", dir, "--json"]);
    assert.equal(full.code, 0, full.stderr);
    assert.doesNotMatch(full.stdout, new RegExp(secret));

    const compact = await runCli(["state", "--cwd", dir, "--compact", "--json"]);
    assert.equal(compact.code, 0, compact.stderr);
    assert.doesNotMatch(compact.stdout, new RegExp(secret));

    const payload = JSON.parse(compact.stdout);
    assert.equal(payload.fixedControl.artifact, "target/control/no-codestory.json");
    assert.equal(payload.fixedControl.reason.length <= 240, true);
    assert.equal(payload.fixedControl.validUntilChanged.length, 10);
    assert.equal(payload.fixedControl.forbiddenCommandPatterns.length, 10);
    assert.equal(payload.fixedControl.reuseCommandHint.length <= 240, true);
    assert.doesNotMatch(payload.fixedControl.reuseCommandHint, new RegExp(secret));
    assert.equal(payload.fixedControl.truncated, true);
    assert.equal(payload.fixedControl.truncation.validUntilChanged, 3);
    assert.equal(payload.fixedControl.truncation.forbiddenCommandPatterns, 6);
    assert.equal(payload.fixedControl.truncation.reasonChars > 0, true);
  });
});

test("next allows explicitly bounded packet work for bounded-next capsules", async () => {
  await withTempDir("next-bounded-decision-capsule", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "bounded capsule", "--metric-name", "seconds"]);
    await writeDecisionCapsule(dir, "search-latency", {
      enforcement: {
        mode: "bounded-next",
        canRunNextPacket: false,
        allowBoundedNext: true,
        blocksFinalization: false,
        clearingCondition: "Run a bounded packet that measures search latency.",
        commandHint:
          "node scripts/autoresearch.mjs next --cwd <project> --timeout-seconds <n> --command-file <path>",
        triggeredBy: ["sessionDecisionCapsule"],
      },
      bottleneck: "Initial retrieval/search latency dominates packet wall time.",
      evidence: ["Search latency dominated the long session."],
      nextExperiment: "Run a bounded search-latency packet.",
      wrongNextActions: ["Do not run a broad packet."],
    });

    const defaultTimeoutOnly = await runCli([
      "next",
      "--cwd",
      dir,
      "--timeout-seconds",
      "5",
      "--compact",
    ]);
    assert.equal(defaultTimeoutOnly.code, 0, defaultTimeoutOnly.stderr);
    const blockedPayload = JSON.parse(defaultTimeoutOnly.stdout);
    assert.equal(blockedPayload.ok, false);
    assert.equal(blockedPayload.refused, undefined);
    assert.match(blockedPayload.doctor.issues.join("\n"), /No benchmark command/i);
    assert.match(blockedPayload.nextAction, /benchmark/i);

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1')"`;
    const result = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--timeout-seconds",
      "5",
      "--compact",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.refused, undefined);
    assert.equal(payload.decision.metric, 1);
  });
});

test("run returns explicit keep/discard decision options instead of a fake status", async () => {
  await withTempDir("decision-hint", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "decision hint", "--metric-name", "seconds"]);

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1.25')"`;
    const result = await runCli(["run", "--cwd", dir, "--command", command]);
    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.logHint.status, null);
    assert.equal(payload.logHint.needsDecision, true);
    assert.deepEqual(payload.logHint.allowedStatuses, ["keep", "discard", "measure"]);
  });
});

test("state and dashboard math keep zero-valued metrics visible", async () => {
  await withTempDir("zero-metric", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "zero metric", "--metric-name", "failures"]);
    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "0",
      "--status",
      "keep",
      "--description",
      "Reach zero failures",
    ]);
    assert.equal(log.code, 0, log.stderr);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.equal(payload.baseline, 0);
    assert.equal(payload.best, 0);

    const exportResult = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const dashboard = await readFile(path.join(dir, "autoresearch-dashboard.html"), "utf8");
    assert.match(dashboard, /Reach zero failures/);
  });
});

test("showcase export scrubs local paths from embedded ledger entries", async () => {
  await withTempDir("showcase-public-entry-scrub", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "public scrub", "--metric-name", "seconds"]);
    const localPath = "D:\\Sensitive\\client\\file.txt";
    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      `Evidence at ${localPath}`,
    ]);
    assert.equal(logged.code, 0, logged.stderr);

    const exported = await runCli(["export", "--cwd", dir, "--showcase"]);
    assert.equal(exported.code, 0, exported.stderr);
    const dashboard = await readFile(path.join(dir, "autoresearch-dashboard.html"), "utf8");
    assert.doesNotMatch(dashboard, /D:\\\\Sensitive\\\\client/);
    assert.match(dashboard, /local-path/);
    const metaMatch = dashboard.match(/window\.__AUTORESEARCH_META__ = ([\s\S]*?);\n<\/script>/);
    assert.ok(metaMatch);
    const meta = JSON.parse(metaMatch[1]);
    assert.equal(meta.publicExport, true);
    assert.equal(meta.showcaseMode, true);
    assert.equal(meta.deliveryMode, "showcase");
    assert.equal(meta.settings.publicExport, true);
    assert.equal(meta.settings.showcaseMode, true);
    assert.equal(meta.settings.deliveryMode, "showcase");
    assert.equal(meta.viewModel.trustState.mode, "showcase");
    assert.equal(meta.viewModel.processHygiene.mode, "showcase");
    assert.doesNotMatch(JSON.stringify(meta.viewModel.trustState.reasons), /Static export/i);
    assert.doesNotMatch(JSON.stringify(meta.viewModel.processHygiene.warnings), /Static export/i);
  });
});

test("offline exports bound embedded ledger entries for long sessions", async () => {
  await withTempDir("offline-export-ledger-bounds", async (dir) => {
    const entries = [
      { type: "config", name: "large export", metricName: "seconds", bestDirection: "lower" },
      ...Array.from({ length: 5100 }, (_, index) => ({
        run: index + 1,
        metric: index + 1,
        status: "measure",
        description: `measurement ${index + 1}`,
        command: "node scripts/autoresearch.mjs log --cwd . --from-last --status keep",
      })),
    ];
    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );

    for (const exportCase of [
      {
        args: [],
        output: "autoresearch-dashboard.html",
        deliveryMode: "static-export",
      },
      {
        args: ["--output", "showcase-dashboard.html", "--showcase"],
        output: "showcase-dashboard.html",
        deliveryMode: "showcase",
      },
    ]) {
      const exported = await runCli(["export", "--cwd", dir, ...exportCase.args]);
      assert.equal(exported.code, 0, exported.stderr);
      const dashboard = await readFile(path.join(dir, exportCase.output), "utf8");
      const dataMatch = dashboard.match(
        /window\.__AUTORESEARCH_DATA__ = ([\s\S]*?);\nwindow\.__AUTORESEARCH_META__/,
      );
      const metaMatch = dashboard.match(/window\.__AUTORESEARCH_META__ = ([\s\S]*?);\n<\/script>/);
      assert.ok(dataMatch);
      assert.ok(metaMatch);
      const data = JSON.parse(dataMatch[1]);
      const meta = JSON.parse(metaMatch[1]);

      assert.equal(meta.deliveryMode, exportCase.deliveryMode);
      assert.equal(data.length, 5000);
      assert.equal(data[0].type, "config");
      assert.equal(data.at(-1).run, 5100);
      assert.doesNotMatch(JSON.stringify([data, meta]), /--from-last/);
      assert.equal(meta.ledgerBounds.truncated, true);
      assert.equal(meta.ledgerBounds.omittedEntries, 101);
      assert.equal(meta.viewModel.readout.measurementRunCount, 5100);
      assert.equal(meta.viewModel.readout.measurementRuns.length, 50);
      assert.equal(meta.viewModel.readout.measurementRuns[0].run, 5051);
      assert.equal(meta.viewModel.readout.measurementRuns.at(-1).run, 5100);
      assert.equal(meta.viewModel.readout.measurementRunsTruncated, true);
      assert.equal(meta.viewModel.readout.measurementRunsOmitted, 5050);
      assert.ok(
        JSON.stringify(meta.viewModel).length < 500_000,
        "offline export view model should stay transport-bounded",
      );
      assert.ok(dashboard.length < 2_500_000, "offline export HTML should stay transport-bounded");
    }
  });
});

test("log accepts metrics from a JSON file for PowerShell-safe logging", async () => {
  await withTempDir("metrics-file", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "metrics file", "--metric-name", "seconds"]);
    await writeFile(
      path.join(dir, "metrics.json"),
      JSON.stringify(
        {
          promotionGrade: true,
          queryCount: 12,
          evidenceLabel: 'holdout "quoted" path',
          windowsPath: "C:\\tmp\\artifact.json",
        },
        null,
        2,
      ),
      "utf8",
    );

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "File-backed metrics",
      "--metrics-file",
      "metrics.json",
    ]);
    assert.equal(log.code, 0, log.stderr);
    const payload = JSON.parse(log.stdout);

    assert.equal(payload.experiment.metrics.promotionGrade, true);
    assert.equal(payload.experiment.metrics.queryCount, 12);
    assert.equal(payload.experiment.metrics.evidenceLabel, 'holdout "quoted" path');
    assert.equal(payload.experiment.metrics.windowsPath, "C:\\tmp\\artifact.json");
    assert.equal(payload.experiment.evidenceStatus, "accepted");
    assert.equal(payload.experiment.promotion.label, "promotion_eligible");
  });
});

test("log succeeds with recovery warning when session note update fails", async () => {
  await withTempDir("log-note-warning", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "note warning", "--metric-name", "seconds"]);
    const notePath = path.join(dir, "autoresearch.md");
    await rm(notePath, { recursive: true, force: true });
    await mkdir(notePath);

    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "measure",
      "--description",
      "Durable log despite note failure",
    ]);
    assert.equal(logged.code, 0, logged.stderr);
    const payload = JSON.parse(logged.stdout);
    assert.equal(payload.ok, true);
    assert.match(payload.recovery, /durably logged to autoresearch\.jsonl/i);
    assert.match(payload.warnings.join("\n"), /autoresearch\.md could not be updated/i);

    const ledger = await readFile(path.join(dir, "autoresearch.jsonl"), "utf8");
    assert.match(ledger, /Durable log despite note failure/);
  });
});

test("state supports negative metrics when lower is better", async () => {
  await withTempDir("negative-metric", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "negative metric",
      "--metric-name",
      "delta",
      "--direction",
      "lower",
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Baseline positive delta",
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "-2",
      "--status",
      "keep",
      "--description",
      "Beat baseline below zero",
    ]);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.equal(payload.baseline, 1);
    assert.equal(payload.best, -2);

    const exportResult = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const dashboard = await readFile(path.join(dir, "autoresearch-dashboard.html"), "utf8");
    const dom = await renderExportedDashboard(dashboard);
    const chart = dom.window.document.getElementById("trend-chart").innerHTML;
    assert.match(chart, /#1 1 keep/);
    assert.match(chart, /#2 -2 keep/);
    assert.doesNotMatch(chart, /Infinity|NaN/);
    assert.equal(dom.window.document.getElementById("improvement-value").textContent, "+300.0%");
    dom.window.close();
  });
});

test("state reports corrupt JSONL with repair-first ledger guidance", async () => {
  await withTempDir("state-corrupt-jsonl", async (dir) => {
    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      [
        JSON.stringify({ type: "config", name: "corrupt state", metricName: "seconds" }),
        "{ not valid json",
      ].join("\n") + "\n",
      "utf8",
    );

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "ledger_jsonl_invalid");
    assert.match(payload.ledgerPath, /autoresearch\.jsonl$/);
    assert.equal(payload.ledgerHealth.parseErrorCount, 1);
    assert.equal(payload.ledgerHealth.parseErrors[0].line, 2);
    assert.match(payload.decisionEnvelope.canonicalNextAction.command, /ledger-doctor\b.*--json/);

    const report = await runCli(["state", "--cwd", dir, "--report", "--json"]);
    assert.equal(report.code, 0, report.stderr);
    const reportPayload = JSON.parse(report.stdout);
    assert.equal(reportPayload.ok, false);
    assert.equal(reportPayload.report.json.status, "blocked");
    assert.match(reportPayload.report.json.blocker, /Malformed JSONL lines: 2/);
    assert.match(reportPayload.report.json.nextCommand, /ledger-doctor\b.*--json/);
  });
});

test("new config segment preserves previous durable goal when omitted", async () => {
  await withTempDir("segment-preserves-goal", async (dir) => {
    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "simplify plugin code",
          goal: "Reduce simplification candidates without weakening checks.",
          metricName: "simplification_candidates",
          bestDirection: "lower",
        }),
        JSON.stringify({
          run: 1,
          metric: 24,
          status: "keep",
          description: "Baseline simplification scan",
        }),
        JSON.stringify({
          type: "config",
          name: "simplify plugin code",
          metricName: "simplification_candidates",
          bestDirection: "lower",
          segmentReason: "Reset after benchmark-surface drift.",
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.equal(payload.config.goal, "Reduce simplification candidates without weakening checks.");
    assert.deepEqual(payload.historicalBest, {
      run: 1,
      metric: 24,
      status: "keep",
      segment: 0,
      description: "Baseline simplification scan",
      promotionGrade: null,
    });
    assert.equal(payload.decisionEnvelope.goalAdvice.present, true);
  });
});

test("discarded metrics do not become best or suppress on-improvement checks", async () => {
  await withTempDir("discarded-best", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "discarded best",
      "--metric-name",
      "seconds",
      "--direction",
      "lower",
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
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "5",
      "--status",
      "discard",
      "--description",
      "Faster but rejected",
    ]);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    assert.equal(JSON.parse(state.stdout).best, 10);

    const checksFile =
      process.platform === "win32" ? "autoresearch.checks.ps1" : "autoresearch.checks.sh";
    const checksBody = process.platform === "win32" ? "exit 1\n" : "#!/bin/sh\nexit 1\n";
    await writeFile(path.join(dir, checksFile), checksBody, "utf8");

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=7')"`;
    const result = await runCli([
      "run",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "on-improvement",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.improvesPrimary, true);
    assert.equal(payload.checks?.passed, false);
    assert.equal(payload.ok, false);
    assert.deepEqual(payload.logHint.allowedStatuses, ["checks_failed"]);
  });
});

test("next supports command-file, env-file, and ARTIFACT output contracts", async () => {
  await withTempDir("command-env-artifact", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "artifact packet",
      "--metric-name",
      "score",
      "--direction",
      "higher",
    ]);
    await mkdir(path.join(dir, "out"), { recursive: true });
    await writeFile(path.join(dir, "out", "manifest.json"), '{"ok":true}\n', "utf8");
    await writeFile(
      path.join(dir, "out", "task-manifest.json"),
      JSON.stringify({ tasks: [{ id: "task-1", status: "done" }] }, null, 2),
      "utf8",
    );
    await writeFile(
      path.join(dir, "packet-runner.mjs"),
      "console.log(`METRIC score=${process.env.SCORE}`);\nconsole.log('ARTIFACT manifest=out/manifest.json');\nconsole.log('ARTIFACT task_manifest=out/task-manifest.json');\n",
      "utf8",
    );
    await writeFile(path.join(dir, "packet.command"), "node packet-runner.mjs\n", "utf8");
    await writeFile(path.join(dir, ".packet.env"), "SCORE=7\n", "utf8");

    const packet = await runCli([
      "next",
      "--cwd",
      dir,
      "--command-file",
      "packet.command",
      "--packet-env-file",
      ".packet.env",
    ]);
    assert.equal(packet.code, 0, packet.stderr);
    const payload = JSON.parse(packet.stdout);
    assert.equal(payload.run.parsedPrimary, 7);
    assert.equal(payload.run.artifacts.manifest, "out/manifest.json");
    assert.equal(payload.run.artifacts.task_manifest, "out/task-manifest.json");
    assert.equal(payload.packetEvidence.artifacts[0].exists, true);
    assert.equal(payload.packetEvidence.taskArtifacts.acceptedTasks.length, 1);
    assert.equal(payload.packetEvidence.taskArtifacts.quarantinedTasks.length, 0);
    assert.deepEqual(payload.run.envKeys, ["SCORE"]);

    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Keep artifact packet",
    ]);
    assert.equal(logged.code, 0, logged.stderr);
    const logPayload = JSON.parse(logged.stdout);
    assert.equal(logPayload.experiment.artifacts.manifest, "out/manifest.json");
    assert.equal(logPayload.experiment.taskArtifacts.acceptedTasks[0].id, "task-1");

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(
      statePayload.evidenceRegistry.currentRuns[0].taskArtifacts.acceptedTasks[0].id,
      "task-1",
    );
  });
});

test("malformed task manifests are quarantined without invalidating primary metrics", async () => {
  await withTempDir("task-manifest-malformed", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "task manifest",
      "--metric-name",
      "score",
      "--direction",
      "higher",
    ]);
    await writeFile(path.join(dir, "task-manifest.json"), "{not json}\n", "utf8");

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC score=1'); console.log('ARTIFACT task_manifest=task-manifest.json')"`;
    const packet = await runCli(["next", "--cwd", dir, "--command", command]);
    assert.equal(packet.code, 0, packet.stderr);
    const payload = JSON.parse(packet.stdout);
    assert.equal(payload.run.parsedPrimary, 1);
    assert.equal(payload.packetEvidence.metrics.score, 1);
    assert.equal(payload.packetEvidence.taskArtifacts.acceptedTasks.length, 0);
    assert.equal(payload.packetEvidence.taskArtifacts.quarantinedTasks.length, 1);
  });
});

test("symlinked task manifests outside the workdir are quarantined", async (t) => {
  await withTempDir("task-manifest-symlink-outside", async (dir) => {
    const outsideDir = path.join(path.dirname(dir), `${path.basename(dir)}-outside`);
    await mkdir(outsideDir, { recursive: true });
    try {
      const outsideManifest = path.join(outsideDir, "task-manifest.json");
      await writeFile(
        outsideManifest,
        JSON.stringify({ tasks: [{ id: "outside-secret-task", status: "done" }] }),
        "utf8",
      );
      const linkPath = path.join(dir, "task-manifest.json");
      try {
        await symlink(outsideManifest, linkPath, "file");
      } catch (error) {
        t.skip(`file symlink unavailable on this platform: ${error}`);
        return;
      }

      await runCli([
        "init",
        "--cwd",
        dir,
        "--name",
        "task manifest symlink",
        "--metric-name",
        "score",
        "--direction",
        "higher",
      ]);

      const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC score=1'); console.log('ARTIFACT task_manifest=task-manifest.json')"`;
      const packet = await runCli(["next", "--cwd", dir, "--command", command]);
      assert.equal(packet.code, 0, packet.stderr);
      const payload = JSON.parse(packet.stdout);
      const taskArtifacts = payload.packetEvidence.taskArtifacts;
      assert.equal(taskArtifacts.acceptedTasks.length, 0);
      assert.equal(taskArtifacts.quarantinedTasks.length, 1);
      assert.match(taskArtifacts.warnings.join("\n"), /outside_workdir_realpath|escapes/i);
      assert.doesNotMatch(JSON.stringify(taskArtifacts), /outside-secret-task/);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

test("external catalog recipes require trust and record provenance", async () => {
  await withTempDir("catalog-trust", async (dir) => {
    const catalogPath = path.join(dir, "recipes.json");
    const catalog = {
      recipes: [
        {
          id: "external-speed",
          title: "External speed",
          metricName: "seconds",
          metricUnit: "s",
          direction: "lower",
          benchmarkCommand: `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1')"`,
          benchmarkPrintsMetric: true,
          checksCommand: "",
          scope: ["src"],
        },
      ],
    };
    await writeFile(catalogPath, JSON.stringify(catalog, null, 2), "utf8");

    const blocked = await runCli([
      "setup-plan",
      "--cwd",
      dir,
      "--recipe",
      "external-speed",
      "--catalog",
      catalogPath,
    ]);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /trust-catalog|External catalog recipe/);

    const trusted = await runCli([
      "setup",
      "--cwd",
      dir,
      "--recipe",
      "external-speed",
      "--catalog",
      catalogPath,
      "--trust-catalog",
      "--skip-init",
    ]);
    assert.equal(trusted.code, 0, trusted.stderr);
    const config = JSON.parse(await readFile(path.join(dir, "autoresearch.config.json"), "utf8"));
    assert.equal(config.recipeId, "external-speed");
    assert.equal(config.recipeCatalogProvenance.recipeId, "external-speed");
    assert.equal(config.recipeCatalogProvenance.source, "recipes.json");
    assert.match(config.recipeCatalogProvenance.recipeHash, /^[a-f0-9]{64}$/);

    const promptPlan = await runCli([
      "prompt-plan",
      "--cwd",
      dir,
      "--prompt",
      "Optimize the external speed recipe.",
      "--recipe",
      "external-speed",
      "--catalog",
      catalogPath,
      "--trust-catalog",
    ]);
    assert.equal(promptPlan.code, 0, promptPlan.stderr);
    const promptPayload = JSON.parse(promptPlan.stdout);
    assert.equal(promptPayload.setup.recommendedRecipe.id, "external-speed");
    assert.match(promptPayload.setup.nextCommand, /--catalog/);
    assert.match(promptPayload.setup.nextCommand, /--trust-catalog/);

    catalog.recipes[0].benchmarkCommand = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=2')"`;
    await writeFile(catalogPath, JSON.stringify(catalog, null, 2), "utf8");
    const doctor = await runCli(["doctor", "--cwd", dir]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctorPayload = JSON.parse(doctor.stdout);
    assert.equal(doctorPayload.ok, false);
    assert.match(doctorPayload.issues.join("\n"), /Trusted catalog recipe changed/);

    const next = await runCli(["next", "--cwd", dir]);
    assert.equal(next.code, 0, next.stderr);
    const nextPayload = JSON.parse(next.stdout);
    assert.equal(nextPayload.ok, false);
    assert.match(nextPayload.doctor.issues.join("\n"), /Trusted catalog recipe changed/);
  });
});

test("external ARTIFACT paths are quarantined instead of stored as usable paths", async () => {
  await withTempDir("external-artifact", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "external artifact packet",
      "--metric-name",
      "score",
      "--direction",
      "higher",
    ]);
    const outside = path.join(path.dirname(dir), "outside-manifest.json");
    await writeFile(
      path.join(dir, "packet-runner.mjs"),
      [
        "console.log('METRIC score=7');",
        `console.log('ARTIFACT manifest=${outside.replace(/\\/g, "\\\\")}');`,
      ].join("\n"),
      "utf8",
    );

    const packet = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      `${quoteForShell(process.execPath)} packet-runner.mjs`,
    ]);
    assert.equal(packet.code, 0, packet.stderr);
    const payload = JSON.parse(packet.stdout);
    assert.equal(payload.run.artifacts.manifest, "<outside-workdir>");
    assert.equal(payload.packetEvidence.artifacts[0].exists, false);
    assert.equal(payload.packetEvidence.artifacts[0].quarantined, true);
    assert.match(payload.packetEvidence.artifactWarnings.join("\n"), /quarantined/);

    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Keep external artifact evidence",
    ]);
    assert.equal(logged.code, 0, logged.stderr);
    assert.equal(JSON.parse(logged.stdout).experiment.artifacts.manifest, "<outside-workdir>");
    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.evidenceRegistry.currentArtifacts.length, 0);
    assert.equal(statePayload.evidenceRegistry.counts.rejected, 1);
  });
});

test("ARTIFACT paths through linked directories outside the workdir are quarantined", async (t) => {
  await withTempDir("linked-external-artifact", async (dir) => {
    const outsideDir = path.join(path.dirname(dir), `${path.basename(dir)}-outside`);
    await mkdir(outsideDir, { recursive: true });
    try {
      await writeFile(path.join(outsideDir, "manifest.json"), '{"secret":true}\n', "utf8");
      const linkPath = path.join(dir, "linked-out");
      try {
        await symlink(outsideDir, linkPath, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        t.skip(
          `directory symlink creation unavailable: ${error instanceof Error ? error.message : error}`,
        );
        return;
      }

      await runCli([
        "init",
        "--cwd",
        dir,
        "--name",
        "linked external artifact",
        "--metric-name",
        "score",
        "--direction",
        "higher",
      ]);
      await writeFile(
        path.join(dir, "packet-runner.mjs"),
        [
          "console.log('METRIC score=7');",
          "console.log('ARTIFACT manifest=linked-out/manifest.json');",
        ].join("\n"),
        "utf8",
      );

      const packet = await runCli([
        "next",
        "--cwd",
        dir,
        "--command",
        `${quoteForShell(process.execPath)} packet-runner.mjs`,
      ]);
      assert.equal(packet.code, 0, packet.stderr);
      const payload = JSON.parse(packet.stdout);
      assert.equal(payload.run.artifacts.manifest, "<outside-workdir>");
      assert.equal(payload.packetEvidence.artifacts[0].exists, false);
      assert.equal(payload.packetEvidence.artifacts[0].quarantined, true);
      assert.match(payload.packetEvidence.artifactWarnings.join("\n"), /quarantined/);
      assert.doesNotMatch(JSON.stringify(payload.packetEvidence), /secret/);

      const logged = await runCli([
        "log",
        "--cwd",
        dir,
        "--from-last",
        "--status",
        "keep",
        "--description",
        "Keep linked external artifact evidence",
      ]);
      assert.equal(logged.code, 0, logged.stderr);
      assert.equal(JSON.parse(logged.stdout).experiment.artifacts.manifest, "<outside-workdir>");
      const state = await runCli(["state", "--cwd", dir]);
      assert.equal(state.code, 0, state.stderr);
      const statePayload = JSON.parse(state.stdout);
      assert.equal(statePayload.evidenceRegistry.currentArtifacts.length, 0);
      assert.equal(statePayload.evidenceRegistry.counts.rejected, 1);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

test("accepted logged artifacts become current evidence in state registry", async () => {
  await withTempDir("accepted-artifact-registry", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "accepted artifact registry",
      "--metric-name",
      "score",
      "--direction",
      "higher",
    ]);
    await mkdir(path.join(dir, "out"), { recursive: true });
    await writeFile(path.join(dir, "out", "manifest.json"), '{"ok":true}\n', "utf8");
    await writeFile(
      path.join(dir, "packet-runner.mjs"),
      "console.log('METRIC score=7');\nconsole.log('ARTIFACT manifest=out/manifest.json');\n",
      "utf8",
    );

    const packet = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      `${quoteForShell(process.execPath)} packet-runner.mjs`,
    ]);
    assert.equal(packet.code, 0, packet.stderr);

    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Keep accepted artifact evidence",
    ]);
    assert.equal(logged.code, 0, logged.stderr);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.evidenceRegistry.currentArtifacts.length, 1);
    assert.equal(statePayload.evidenceRegistry.currentArtifacts[0].name, "manifest");
    assert.equal(statePayload.evidenceRegistry.currentArtifacts[0].evidenceStatus, "accepted");
    assert.equal(statePayload.evidenceRegistry.counts.accepted, 2);
  });
});

test("last-run packet storage redacts raw benchmark evidence and still logs from last", async () => {
  await withTempDir("last-run-redaction", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "redacted packet", "--metric-name", "seconds"]);
    await writeFile(
      path.join(dir, "runner.mjs"),
      [
        "console.log('METRIC seconds=1');",
        "console.log('api_key=abcdefghijklmnop');",
        "console.log('Bearer zyxwvutsrqponmlkjihgfedcba');",
      ].join("\n"),
      "utf8",
    );

    const packet = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      `${quoteForShell(process.execPath)} runner.mjs`,
    ]);
    assert.equal(packet.code, 0, packet.stderr);
    assert.doesNotMatch(packet.stdout, /abcdefghijklmnop/);
    assert.doesNotMatch(packet.stdout, /zyxwvutsrqponmlkjihgfedcba/);
    assert.match(packet.stdout, /api_key=<redacted>/);
    assert.match(packet.stdout, /Bearer <redacted>/);
    const payload = JSON.parse(packet.stdout);
    assert.equal(payload.packetEvidence.stdoutTail.includes("abcdefghijklmnop"), false);
    assert.equal(payload.run.tailOutput.includes("abcdefghijklmnop"), false);
    assert.doesNotMatch(JSON.stringify(payload.run.progressSnapshot), /zyxwvutsrqponmlkjihgfedcba/);

    const lastRunText = await readFile(path.join(dir, "autoresearch.last-run.json"), "utf8");
    assert.doesNotMatch(lastRunText, /abcdefghijklmnop/);
    assert.doesNotMatch(lastRunText, /zyxwvutsrqponmlkjihgfedcba/);
    assert.match(lastRunText, /api_key=<redacted>/);
    assert.match(lastRunText, /Bearer <redacted>/);

    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Keep redacted packet",
    ]);
    assert.equal(logged.code, 0, logged.stderr);
    const loggedPayload = JSON.parse(logged.stdout);
    assert.equal(loggedPayload.experiment.metric, 1);
    assert.equal(loggedPayload.lastRunCleared, true);
  });
});

test("last-run packet storage redacts run benchmark contract command and option-file metadata", async () => {
  await withTempDir("last-run-contract-redaction", async (dir) => {
    const outsideDir = path.join(path.dirname(dir), `${path.basename(dir)}-outside`);
    try {
      await mkdir(outsideDir, { recursive: true });
      const commandSecret = "command-secret-abcdefghijklmnop";
      const checksSecret = "checks-secret-zyxwvutsrqpon";
      const commandFile = path.join(outsideDir, "private-packet.command");
      const envFile = path.join(outsideDir, ".env.private");
      await writeFile(
        commandFile,
        `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=2')" -- --api-key ${commandSecret}\n`,
        "utf8",
      );
      await writeFile(envFile, "PACKET_TOKEN=env-secret-qwertyuiop\n", "utf8");
      await runCli([
        "init",
        "--cwd",
        dir,
        "--name",
        "redacted contract",
        "--metric-name",
        "seconds",
      ]);

      const packet = await runCli([
        "next",
        "--cwd",
        dir,
        "--command-file",
        commandFile,
        "--packet-env-file",
        envFile,
        "--checks-command",
        `${quoteForShell(process.execPath)} -e "process.exit(0)" -- --token ${checksSecret}`,
      ]);
      assert.equal(packet.code, 0, packet.stderr);

      const lastRunText = await readFile(path.join(dir, "autoresearch.last-run.json"), "utf8");
      assert.doesNotMatch(lastRunText, new RegExp(commandSecret));
      assert.doesNotMatch(lastRunText, new RegExp(checksSecret));
      assert.doesNotMatch(lastRunText, /private-packet\.command/);
      assert.doesNotMatch(lastRunText, /\.env\.private/);
      assert.doesNotMatch(
        lastRunText,
        new RegExp(outsideDir.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")),
      );

      const stored = JSON.parse(lastRunText);
      const contract = stored.run.benchmarkContract;
      assert.match(contract.command, /--api-key <redacted>/);
      assert.match(contract.checksCommand, /--token <redacted>/);
      assert.equal(contract.commandFile, "<outside-workdir>");
      assert.equal(contract.envFile, "<env-file>");
      assert.equal(
        contract.files.some((file: Record<string, unknown>) =>
          String(file.path || "").includes("private-packet.command"),
        ),
        false,
      );
      assert.equal(
        contract.files.some((file: Record<string, unknown>) =>
          String(file.path || "").includes(".env.private"),
        ),
        false,
      );
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

test("last-run packet storage does not corrupt common option-file basenames", async () => {
  await withTempDir("last-run-common-basename-redaction", async (dir) => {
    const outsideDir = path.join(path.dirname(dir), `${path.basename(dir)}-outside`);
    try {
      await mkdir(outsideDir, { recursive: true });
      const commandFile = path.join(outsideDir, "run");
      const envFile = path.join(outsideDir, "env");
      await writeFile(
        commandFile,
        [
          `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3'); console.log('ordinary run env node packet text')"`,
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(envFile, "PACKET_TOKEN=common-name-env-value\n", "utf8");
      await runCli([
        "init",
        "--cwd",
        dir,
        "--name",
        "common basename contract",
        "--metric-name",
        "seconds",
      ]);

      const packet = await runCli([
        "next",
        "--cwd",
        dir,
        "--command-file",
        commandFile,
        "--packet-env-file",
        envFile,
      ]);
      assert.equal(packet.code, 0, packet.stderr);

      const lastRunText = await readFile(path.join(dir, "autoresearch.last-run.json"), "utf8");
      assert.match(lastRunText, /ordinary run env node packet text/);
      assert.doesNotMatch(
        lastRunText,
        new RegExp(outsideDir.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")),
      );

      const stored = JSON.parse(lastRunText);
      assert.equal(stored.run.benchmarkContract.commandFile, "<outside-workdir>");
      assert.equal(stored.run.benchmarkContract.envFile, "<env-file>");
      assert.equal(stored.run.tailOutput.includes("ordinary run env node packet text"), true);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

test("run command response redacts raw benchmark evidence", async () => {
  await withTempDir("run-response-redaction", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "redacted run", "--metric-name", "seconds"]);
    await writeFile(
      path.join(dir, "runner.mjs"),
      [
        "console.log('METRIC seconds=1');",
        "console.log('api_key=abcdefghijklmnop');",
        "console.log('Bearer zyxwvutsrqponmlkjihgfedcba');",
        "console.log('win_path=C:\\\\Users\\\\alice\\\\secret.txt');",
        "console.log('win_slash=C:/Users/alice/secret.txt');",
        "console.log('posix_path=/home/alice/secret.txt');",
        "console.log('unc_path=\\\\\\\\server\\\\share\\\\secret.txt');",
        "console.log('secret_from_env=' + process.env.SAMPLE_SECRET);",
      ].join("\n"),
      "utf8",
    );
    await writeFile(path.join(dir, ".env.secret"), "SAMPLE_SECRET=from-env-secret-value\n", "utf8");

    const result = await runCli([
      "run",
      "--cwd",
      dir,
      "--command",
      `${quoteForShell(process.execPath)} runner.mjs`,
      "--packet-env-file",
      ".env.secret",
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /abcdefghijklmnop/);
    assert.doesNotMatch(result.stdout, /zyxwvutsrqponmlkjihgfedcba/);
    assert.doesNotMatch(result.stdout, /from-env-secret-value/);
    assert.doesNotMatch(result.stdout, /C:\\\\Users\\\\alice/);
    assert.doesNotMatch(result.stdout, /C:\/Users\/alice/);
    assert.doesNotMatch(result.stdout, /\/home\/alice/);
    assert.doesNotMatch(result.stdout, /server\\\\share/);
    assert.match(result.stdout, /api_key=<redacted>/);
    assert.match(result.stdout, /Bearer <redacted>/);
    assert.match(result.stdout, /secret_from_env=<redacted>/);
    assert.match(result.stdout, /<network-path>/);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.envFile, "<env-file>");
    assert.equal(payload.tailOutput.includes("abcdefghijklmnop"), false);
    assert.doesNotMatch(JSON.stringify(payload.progressSnapshot), /zyxwvutsrqponmlkjihgfedcba/);
  });
});

test("command and env files are included in benchmark contract drift", async () => {
  await withTempDir("command-env-contract-drift", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "contract files",
      "--metric-name",
      "score",
      "--direction",
      "higher",
    ]);
    await writeFile(
      path.join(dir, "packet-runner.mjs"),
      "console.log(`METRIC score=${process.env.SCORE}`);\n",
      "utf8",
    );
    await writeFile(path.join(dir, "packet.command"), "node packet-runner.mjs\n", "utf8");
    await writeFile(path.join(dir, ".packet.env"), "SCORE=7\n", "utf8");

    const packet = await runCli([
      "next",
      "--cwd",
      dir,
      "--command-file",
      "packet.command",
      "--packet-env-file",
      ".packet.env",
    ]);
    assert.equal(packet.code, 0, packet.stderr);
    assert.equal(JSON.parse(packet.stdout).run.parsedPrimary, 7);

    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Keep first packet",
    ]);
    assert.equal(logged.code, 0, logged.stderr);

    await writeFile(path.join(dir, ".packet.env"), "SCORE=8\n", "utf8");
    const blocked = await runCli([
      "next",
      "--cwd",
      dir,
      "--command-file",
      "packet.command",
      "--packet-env-file",
      ".packet.env",
    ]);
    assert.equal(blocked.code, 0, blocked.stderr);
    const payload = JSON.parse(blocked.stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.doctor.issues.join("\n"), /contract changed/i);
  });
});

test("packet env mode is part of benchmark contract and doctor recheck", async () => {
  await withTempDir("packet-env-mode-contract", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "env mode contract",
      "--metric-name",
      "score",
      "--direction",
      "higher",
    ]);
    const scriptPath = path.join(dir, "env-mode-runner.mjs");
    await writeFile(
      scriptPath,
      [
        "const inherited = process.env.AUTORESEARCH_ENV_MODE_REVIEW === 'parent';",
        "console.log(`METRIC score=${inherited ? 2 : 1}`);",
        "",
      ].join("\n"),
      "utf8",
    );
    const command = `${quoteForShell(process.execPath)} ${quoteForShell(scriptPath)}`;
    const previous = process.env.AUTORESEARCH_ENV_MODE_REVIEW;
    process.env.AUTORESEARCH_ENV_MODE_REVIEW = "parent";
    try {
      const packet = await runCli([
        "next",
        "--cwd",
        dir,
        "--command",
        command,
        "--packet-env-mode",
        "minimal",
        "--checks-policy",
        "manual",
      ]);
      assert.equal(packet.code, 0, packet.stderr);
      assert.equal(JSON.parse(packet.stdout).run.parsedPrimary, 1);

      const logged = await runCli([
        "log",
        "--cwd",
        dir,
        "--from-last",
        "--status",
        "keep",
        "--description",
        "Keep minimal env packet",
      ]);
      assert.equal(logged.code, 0, logged.stderr);
      const loggedPayload = JSON.parse(logged.stdout);
      assert.equal(loggedPayload.experiment.benchmarkContract.packetEnvMode, "minimal");

      const doctor = await runCli([
        "doctor",
        "--cwd",
        dir,
        "--command",
        command,
        "--check-benchmark",
      ]);
      assert.equal(doctor.code, 0, doctor.stderr);
      const doctorPayload = JSON.parse(doctor.stdout);
      assert.equal(doctorPayload.benchmark.packetEnvMode, "minimal");
      assert.equal(doctorPayload.benchmark.parsedMetrics.score, 1);
    } finally {
      if (previous == null) delete process.env.AUTORESEARCH_ENV_MODE_REVIEW;
      else process.env.AUTORESEARCH_ENV_MODE_REVIEW = previous;
    }
  });
});

test("state separates development best from promotion-grade best", async () => {
  await withTempDir("promotion-tracks", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "promotion",
      "--metric-name",
      "score",
      "--direction",
      "higher",
    ]);
    for (const [metric, promotionGrade] of [
      [0.6, 0],
      [0.8, 1],
      [0.9, 0],
    ]) {
      const logged = await runCli([
        "log",
        "--cwd",
        dir,
        "--metric",
        String(metric),
        "--status",
        "keep",
        "--description",
        `score ${metric}`,
        "--metrics",
        JSON.stringify({ promotionGrade }),
      ]);
      assert.equal(logged.code, 0, logged.stderr);
    }
    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.equal(payload.best, 0.9);
    assert.equal(payload.development.best, 0.9);
    assert.equal(payload.promotion.best, 0.8);
    assert.equal(payload.promotion.kept, 1);
  });
});

test("research-fanout records generic parallel lanes without creating a bespoke metric", async () => {
  await withTempDir("research-fanout", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "fanout", "--metric-name", "quality_gap"]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "4",
      "--status",
      "measure",
      "--description",
      "Baseline measurement",
      "--asi",
      JSON.stringify({
        hypothesis: "Measure current research gaps",
        lane: "benchmark-contract",
        next_action_hint: "Scout benchmark validity before editing.",
      }),
    ]);

    const fanout = await runCli(["research-fanout", "--cwd", dir, "--lanes", "4", "--yes"]);
    assert.equal(fanout.code, 0, fanout.stderr);
    const plan = JSON.parse(fanout.stdout);
    assert.equal(plan.ok, true);
    assert.equal(plan.dryRun, false);
    assert.ok(plan.parallelLanes.length >= 4);
    assert.ok(plan.parallelLanes.length <= 6);
    assert.match(plan.fanoutPlan.metric.contract, /configured benchmark METRIC output/);
    assert.equal(plan.parallelLanes[0].evidenceStatus, "provisional");
    assert.equal(typeof plan.parallelLanes[0].brief.objective, "string");
    assert.ok(Array.isArray(plan.parallelLanes[0].brief.boundaries));
    assert.equal(typeof plan.parallelLanes[0].brief.expectedDecisionOutput, "string");

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.ok(payload.parallelLanes.length > 0);
    assert.equal(typeof payload.parallelLanes[0].brief.objective, "string");
    assert.equal(payload.fanoutPlan.status, "planned");
    assert.equal(payload.metric, "quality_gap");

    const exportResult = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const exportPayload = JSON.parse(exportResult.stdout);
    assert.ok(exportPayload.viewModel.parallelLanes.length > 0);
    assert.equal(exportPayload.viewModel.fanoutPlan.status, "planned");
    assert.equal(exportPayload.viewModel.evidenceLedger.counts.provisional, 1);
  });
});

test("lane-runner allows read-only lanes without worktree isolation", async () => {
  await withTempDir("lane-runner-read-only", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "lane runner", "--metric-name", "quality_gap"]);
    await runCli(["research-fanout", "--cwd", dir, "--lanes", "4", "--yes"]);

    const result = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "read-only-scout",
      "--summary",
      "Scout found one benchmark-contract hypothesis.",
      "--recommendation",
      "Run one benchmark-contract packet next.",
      "--yes",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, false);
    assert.equal(payload.lane.mode, "read_only_scout");
    assert.equal(payload.result.status, "completed");
    assert.equal(payload.result.evidenceAccepted, true);
    assert.equal(payload.result.isolation.worktree, "");
    assert.deepEqual(payload.result.isolation.writeScope, []);
    assert.equal(typeof payload.lane.brief.objective, "string");

    const ledger = await readFile(path.join(dir, "autoresearch.jsonl"), "utf8");
    assert.match(ledger, /"type":"lane_result"/);
    const laneEntry = ledger
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((entry) => entry.type === "lane_result");
    assert.equal(typeof laneEntry.lane.brief.objective, "string");

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    const lane = statePayload.parallelLanes.find((item) => item.id === "read-only-scout");
    assert.equal(lane.status, "completed");
    assert.equal(lane.evidenceStatus, "accepted");
    assert.equal(typeof lane.brief.objective, "string");
  });
});

test("lane-runner records big-idea lanes as approval-gated advice only", async () => {
  await withTempDir("lane-runner-big-idea", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "big idea", "--metric-name", "quality_gap"]);

    const blockedCommand = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--mode",
      "big_idea",
      "--command",
      "node -e \"console.log('METRIC quality_gap=0')\"",
    ]);
    assert.notEqual(blockedCommand.code, 0);
    assert.match(blockedCommand.stderr, /cannot run commands/i);

    const result = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "architecture-scout",
      "--mode",
      "big_idea",
      "--summary",
      "Explore a distant architecture split for benchmark isolation.",
      "--recommendation",
      "Ask the operator before creating an implementation lane.",
      "--evidence",
      "Current loop has repeated local tweaks; benchmark trust is the bottleneck.",
      "--risks",
      "Architecture work can invalidate current metric history.",
      "--yes",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.lane.mode, "big_idea");
    assert.equal(payload.result.command, "");
    assert.equal(payload.result.approvalRequired, true);
    assert.equal(payload.result.approvalGate.required, true);
    assert.deepEqual(payload.result.approvalGate.requiredBefore, [
      "implementation_lane",
      "measured_packet",
    ]);
    assert.match(payload.result.summary, /distant architecture/i);
    assert.match(payload.result.recommendation, /operator/i);
    assert.match(payload.result.evidence.join("\n"), /benchmark trust/i);
    assert.match(payload.result.risks.join("\n"), /invalidate/i);
    assert.equal(payload.coordinatorRecommendation.status, "awaiting_human_approval");
    assert.match(payload.coordinatorRecommendation.measuredPacket, /Blocked/i);
  });
});

test("empty lane-runner records are planned breadcrumbs, not watchdog progress", async () => {
  await withTempDir("lane-runner-empty-planned", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "lane watchdog",
      "--metric-name",
      "quality_gap",
      "--max-iterations",
      "100",
    ]);
    const oldTimestamp = Date.now() - 10 * 60 * 60 * 1000;
    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "lane watchdog",
          metricName: "quality_gap",
          bestDirection: "lower",
        }),
        JSON.stringify({
          run: 1,
          metric: 4,
          status: "measure",
          description: "Old baseline.",
          timestamp: oldTimestamp,
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    await runCli(["research-fanout", "--cwd", dir, "--lanes", "4", "--yes"]);

    const emptyResult = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "read-only-scout",
      "--yes",
    ]);
    assert.equal(emptyResult.code, 0, emptyResult.stderr);
    const emptyPayload = JSON.parse(emptyResult.stdout);
    assert.equal(emptyPayload.result.status, "planned");
    assert.equal(emptyPayload.result.evidenceAccepted, false);

    const staleState = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(staleState.code, 0, staleState.stderr);
    const stalePayload = JSON.parse(staleState.stdout);
    const plannedLane = stalePayload.parallelLanes.find((item) => item.id === "read-only-scout");
    assert.equal(plannedLane.status, "planned");
    assert.equal(plannedLane.evidenceStatus, "provisional");
    assert.equal(stalePayload.watchdogSummary.stale, true);

    const commandResult = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "read-only-scout",
      "--command",
      `${quoteForShell(process.execPath)} -e ""`,
      "--allow-non-git-command",
      "--yes",
    ]);
    assert.equal(commandResult.code, 0, commandResult.stderr);
    const commandPayload = JSON.parse(commandResult.stdout);
    assert.equal(commandPayload.result.status, "completed");
    assert.equal(commandPayload.result.evidenceAccepted, true);

    const freshState = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(freshState.code, 0, freshState.stderr);
    const freshPayload = JSON.parse(freshState.stdout);
    const completedLane = freshPayload.parallelLanes.find((item) => item.id === "read-only-scout");
    assert.equal(completedLane.status, "completed");
    assert.equal(completedLane.evidenceStatus, "accepted");
    assert.equal(freshPayload.watchdogSummary.stale, false);
  });
});

test("lane-runner blocks implementation lanes without explicit isolation", async () => {
  await withTempDir("lane-runner-isolation", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "lane runner", "--metric-name", "quality_gap"]);
    await runCli(["research-fanout", "--cwd", dir, "--lanes", "4", "--yes"]);

    const result = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "implementation-candidate",
      "--mode",
      "implementation",
      "--summary",
      "Try an implementation candidate.",
      "--yes",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Implementation lanes require explicit isolation/);
  });
});

test("lane-runner rejects missing and foreign implementation worktrees", async () => {
  await withTempDir("lane-runner-worktree-edges", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "lane runner", "--metric-name", "quality_gap"]);
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "README.md"), "base\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial"]);

    const missing = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "implementation-candidate",
      "--mode",
      "implementation",
      "--worktree",
      "missing-worktree-path",
      "--command",
      "git status --short",
      "--summary",
      "Missing worktree.",
      "--yes",
    ]);
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /existing Git worktree/i);

    const foreignRepo = path.join(dir, "foreign-repo");
    await mkdir(foreignRepo, { recursive: true });
    await git(foreignRepo, ["init"]);
    await git(foreignRepo, ["config", "user.email", "codex@example.test"]);
    await git(foreignRepo, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(foreignRepo, "README.md"), "foreign\n", "utf8");
    await git(foreignRepo, ["add", "-A"]);
    await git(foreignRepo, ["commit", "-m", "foreign"]);

    const foreign = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "implementation-candidate",
      "--mode",
      "implementation",
      "--worktree",
      foreignRepo,
      "--command",
      "git status --short",
      "--summary",
      "Foreign worktree.",
      "--yes",
    ]);
    assert.notEqual(foreign.code, 0);
    assert.match(foreign.stderr, /same Git repository/i);
  });
});

test("lane-runner allows a sibling implementation worktree", async () => {
  await withTempDir("lane-runner-worktree-pass", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "lane runner", "--metric-name", "quality_gap"]);
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "README.md"), "base\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial"]);

    const worktreePath = path.join(dir, "lane-worktree");
    await git(dir, ["worktree", "add", worktreePath, "-b", "lane-impl"]);

    const result = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "implementation-candidate",
      "--mode",
      "implementation",
      "--worktree",
      worktreePath,
      "--command",
      "git status --short",
      "--summary",
      "Sibling worktree command.",
      "--yes",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.result.commandResult.code, 0);
  });
});

test("lane-runner rejects the main checkout as an implementation worktree", async () => {
  await withTempDir("lane-runner-main-worktree", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "lane runner", "--metric-name", "quality_gap"]);
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial"]);

    const result = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "implementation-candidate",
      "--mode",
      "implementation",
      "--worktree",
      ".",
      "--summary",
      "Unsafe main checkout.",
      "--yes",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /separate Git worktree/);
  });
});

test("lane-runner blocks implementation commands that escape write scope", async () => {
  await withTempDir("lane-runner-write-scope", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "lane runner", "--metric-name", "quality_gap"]);
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "owned.txt"), "before\n", "utf8");
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial"]);

    const result = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "implementation-candidate",
      "--mode",
      "implementation",
      "--write-scope",
      "src",
      "--command",
      "node -e \"require('fs').writeFileSync('outside.txt','escape')\"",
      "--summary",
      "Unsafe write.",
      "--yes",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /outside --write-scope/);
  });
});

test("lane-runner blocks write-scope commands that hide changes in commits", async () => {
  await withTempDir("lane-runner-write-scope-commit", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "lane runner", "--metric-name", "quality_gap"]);
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "owned.txt"), "before\n", "utf8");
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial"]);

    const result = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "implementation-candidate",
      "--mode",
      "implementation",
      "--write-scope",
      "src",
      "--command",
      "node -e \"require('fs').writeFileSync('outside.txt','escape')\" && git add outside.txt && git commit -m escape",
      "--summary",
      "Hidden unsafe write.",
      "--yes",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /cannot run git cleanup|cannot move HEAD/);
  });
});

test("lane-runner blocks write-scope mutators before execution", async () => {
  const blockedCommands = [
    ["git stash push -m blocked", /cannot run git cleanup|look mutating/i],
    ["git cherry-pick HEAD", /cannot run git cleanup|look mutating/i],
    ["git revert --no-edit HEAD", /cannot run git cleanup|look mutating/i],
    ["npm ci", /cannot run git cleanup|dependency|look mutating/i],
  ];
  for (const [command, pattern] of blockedCommands) {
    await withTempDir("lane-runner-write-scope-mutator", async (dir) => {
      await runCli(["init", "--cwd", dir, "--name", "lane runner", "--metric-name", "quality_gap"]);
      await mkdir(path.join(dir, "src"), { recursive: true });
      await writeFile(path.join(dir, "src", "owned.txt"), "before\n", "utf8");
      await git(dir, ["init"]);
      await git(dir, ["config", "user.email", "codex@example.test"]);
      await git(dir, ["config", "user.name", "Codex Test"]);
      await git(dir, ["add", "-A"]);
      await git(dir, ["commit", "-m", "initial"]);
      const marker = path.join(dir, "lane-ran.marker");
      const guardedCommand = `${command} && node -e "require('fs').writeFileSync('lane-ran.marker','ran')"`;

      const result = await runCli([
        "lane-runner",
        "--cwd",
        dir,
        "--lane-id",
        "implementation-candidate",
        "--mode",
        "implementation",
        "--write-scope",
        "src",
        "--command",
        guardedCommand,
        "--summary",
        "Unsafe mutator.",
        "--yes",
      ]);
      assert.notEqual(result.code, 0, command);
      assert.match(result.stderr, pattern, command);
      await assert.rejects(() => access(marker));
    });
  }
});

test("lane-runner blocks write-scope cleanup commands in the main checkout", async () => {
  await withTempDir("lane-runner-write-scope-cleanup", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "lane runner", "--metric-name", "quality_gap"]);
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "owned.txt"), "before\n", "utf8");
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial"]);

    const result = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "implementation-candidate",
      "--mode",
      "implementation",
      "--write-scope",
      "src",
      "--command",
      "git -C . reset --hard",
      "--summary",
      "Unsafe cleanup.",
      "--yes",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /cannot run git cleanup/);
  });
});

test("lane-runner refuses write-scope when unrelated dirty files already exist", async () => {
  await withTempDir("lane-runner-write-scope-pre-dirty", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "lane runner", "--metric-name", "quality_gap"]);
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "owned.txt"), "before\n", "utf8");
    await writeFile(path.join(dir, "outside.txt"), "before\n", "utf8");
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial"]);
    await writeFile(path.join(dir, "outside.txt"), "user edit\n", "utf8");

    const result = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "implementation-candidate",
      "--mode",
      "implementation",
      "--write-scope",
      "src",
      "--command",
      "node -e \"require('fs').writeFileSync('src/owned.txt','after')\"",
      "--summary",
      "Owned write.",
      "--yes",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /dirty files outside scope/);
  });
});

test("lane-runner ignores completed lane results from older segments", async () => {
  await withTempDir("lane-runner-segment-results", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "first segment", "--metric-name", "quality_gap"]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "7",
      "--status",
      "measure",
      "--description",
      "First segment measurement.",
    ]);
    await runCli(["research-fanout", "--cwd", dir, "--lanes", "4", "--yes"]);
    const first = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "benchmark-contract",
      "--summary",
      "Old segment result.",
      "--recommendation",
      "Do not reuse this after a segment change.",
      "--yes",
    ]);
    assert.equal(first.code, 0, first.stderr);

    await runCli(["new-segment", "--cwd", dir, "--reason", "New lane decision round.", "--yes"]);
    const second = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "benchmark-contract",
      "--dry-run",
    ]);
    assert.equal(second.code, 0, second.stderr);
    const payload = JSON.parse(second.stdout);
    assert.equal(payload.coordinatorRecommendation.status, "needs_lane_result");
    assert.notEqual(
      payload.coordinatorRecommendation.nextAction,
      "Do not reuse this after a segment change.",
    );
  });
});

test("lane-runner synthesizes completed lane results into one next action", async () => {
  await withTempDir("lane-runner-synthesis", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "lane runner", "--metric-name", "quality_gap"]);
    await runCli(["research-fanout", "--cwd", dir, "--lanes", "4", "--yes"]);

    const result = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "benchmark-contract",
      "--summary",
      "Benchmark contract is the riskiest assumption.",
      "--recommendation",
      "Run one measured packet that validates benchmark contract parsing.",
      "--yes",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.coordinatorRecommendation.status, "ready");
    assert.equal(
      payload.coordinatorRecommendation.nextAction,
      "Run one measured packet that validates benchmark contract parsing.",
    );
    assert.equal(typeof payload.coordinatorRecommendation.nextAction, "string");
    assert.ok(payload.coordinatorRecommendation.lessonsToAvoid.length >= 1);

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.ok(statePayload.laneLifecycle.lessonsToAvoid.length >= 1);
  });
});

test("state and doctor surface scaffold health and evidence labels", async () => {
  await withTempDir("truth-layer-state", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "truth layer",
      "--metric-name",
      "score",
      "--direction",
      "higher",
    ]);
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({ commitPaths: ["src/missing.ts"] }, null, 2),
      "utf8",
    );
    await writeFile(
      path.join(dir, "autoresearch.ps1"),
      "& powershell -NoProfile -ExecutionPolicy Bypass -File ./autoresearch.ps1\n",
      "utf8",
    );
    await writeFile(path.join(dir, "autoresearch.sh"), "bash ./autoresearch.sh\n", "utf8");

    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "perfect dev slice pending repeat",
      "--metrics",
      JSON.stringify({ repeatRequired: 1 }),
    ]);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.equal(payload.scaffoldHealth.ok, false);
    assert.ok(
      payload.scaffoldHealth.checks.some((check) => check.code === "self_recursive_wrapper"),
    );
    assert.ok(payload.scaffoldHealth.checks.some((check) => check.code === "missing_commit_path"));
    assert.ok(payload.researchIntegrity.evidenceLabels.includes("dev_best"));
    assert.ok(payload.researchIntegrity.evidenceLabels.includes("pending_repeat"));
    assert.match(payload.researchIntegrity.warnings.join("\n"), /perfect/i);

    const doctor = await runCli(["doctor", "--cwd", dir]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctorPayload = JSON.parse(doctor.stdout);
    assert.equal(doctorPayload.scaffoldHealth.ok, false);
    assert.match(doctorPayload.warnings.join("\n"), /self-recursive|commitPaths/i);

    const compact = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(compact.code, 0, compact.stderr);
    const compactPayload = JSON.parse(compact.stdout);
    assert.equal(compactPayload.scaffoldHealth.ok, false);
    assert.equal(compactPayload.canonicalNextAction.kind, "safety-blocker");
    assert.ok(compactPayload.decisionEnvelope.scaffoldHealth.blockers.length > 0);
  });
});

test("scaffold health catches direct PowerShell wrapper self-recursion", async () => {
  await withTempDir("powershell-direct-self-recursion", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "powershell recursion",
      "--metric-name",
      "score",
    ]);
    await writeFile(path.join(dir, "autoresearch.ps1"), "& .\\autoresearch.ps1\n", "utf8");

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.equal(payload.scaffoldHealth.ok, false);
    assert.ok(
      payload.scaffoldHealth.checks.some((check) => check.code === "self_recursive_wrapper"),
    );
  });
});

test("benchmark-lint separates metric parsing from research integrity", async () => {
  await withTempDir("benchmark-lint-integrity", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "lint integrity",
      "--metric-name",
      "score",
      "--direction",
      "higher",
    ]);

    const result = await runCli([
      "benchmark-lint",
      "--cwd",
      dir,
      "--metric-name",
      "score",
      "--sample",
      "METRIC score=1\nMETRIC hit_at_10=1\n",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.metricParsing.ok, true);
    assert.equal(payload.researchIntegrity.ok, false);
    assert.match(payload.researchIntegrity.warnings.join("\n"), /perfect|holdout|repeat/i);
  });
});

test("benchmark-lint uses config benchmark command without wrapper fallback", async () => {
  await withTempDir("benchmark-lint-config-command", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "lint config command",
      "--metric-name",
      "score",
      "--direction",
      "higher",
    ]);
    const benchmarkCommand = `${quoteForShell(process.execPath)} -e "console.log('METRIC score=7')"`;
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({ benchmarkCommand }, null, 2),
      "utf8",
    );

    const result = await runCli(["benchmark-lint", "--cwd", dir, "--json"]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.parsedMetrics.score, 7);
    assert.equal(payload.checkedCommand, benchmarkCommand);
  });
});

test("benchmark-lint sample respects configured holdout guard", async () => {
  await withTempDir("benchmark-lint-configured-holdout", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "configured holdout",
      "--metric-name",
      "agent_value_gap",
      "--direction",
      "lower",
    ]);
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({ holdoutCommand: "node holdout-benchmark.mjs" }, null, 2),
      "utf8",
    );

    const result = await runCli([
      "benchmark-lint",
      "--cwd",
      dir,
      "--sample",
      "METRIC agent_value_gap=0",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.researchIntegrity.hasIntegrityGuard, true);
    assert.doesNotMatch(
      payload.researchIntegrity.warnings.join("\n"),
      /no holdout, repeat, contamination, or promotion guard is configured/i,
    );
  });
});

test("doctor does not treat routine rollback wording as evidence invalidation", async () => {
  await withTempDir("doctor-routine-rollback", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "routine rollback",
      "--metric-name",
      "score",
      "--direction",
      "higher",
    ]);
    if (process.platform === "win32") {
      await writeFile(path.join(dir, "autoresearch.ps1"), "Write-Output 'METRIC score=1'\n");
    } else {
      await writeFile(path.join(dir, "autoresearch.sh"), "echo 'METRIC score=1'\n");
    }
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "kept candidate",
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "0.9",
      "--status",
      "discard",
      "--description",
      "ordinary rejected packet",
      "--asi",
      JSON.stringify({ rollback_reason: "reverted scoped experiment changes" }),
    ]);

    const doctor = await runCli(["doctor", "--cwd", dir]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const payload = JSON.parse(doctor.stdout);
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.researchIntegrity.blockers, []);
    assert.ok(!payload.researchIntegrity.evidenceLabels.includes("invalidated"));
  });
});

test("prompt-plan prefers documented repo benchmark hints over generic cargo recipes", async () => {
  await withTempDir("prompt-plan-doc-hints", async (dir) => {
    await mkdir(path.join(dir, "scripts"), { recursive: true });
    await mkdir(path.join(dir, "docs"), { recursive: true });
    await writeFile(
      path.join(dir, "Cargo.toml"),
      [
        "[package]",
        'name = "prompt-plan-doc-hints"',
        'version = "0.1.0"',
        'edition = "2021"',
        "",
        "[dev-dependencies]",
        'criterion = "0.5"',
        "",
        "[[bench]]",
        'name = "generic_bench"',
        "harness = false",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(dir, "scripts", "embedding-harness.mjs"),
      "console.log('repo-specific embedding harness');\n",
      "utf8",
    );
    await writeFile(
      path.join(dir, "docs", "autoresearch-benchmark.md"),
      [
        "# Autoresearch benchmark",
        "",
        "Use `node scripts/embedding-harness.mjs --holdout fresh` for the measured loop.",
        "The harness prints `METRIC embedding_score=<number>` from the fresh embedding holdout.",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runCli([
      "prompt-plan",
      "--cwd",
      dir,
      "--prompt",
      "Optimize the embedding pipeline runtime using the project benchmark.",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.match(payload.intent.setupDefaults.benchmarkCommand, /embedding-harness\.mjs/);
    assert.doesNotMatch(payload.intent.setupDefaults.benchmarkCommand, /cargo\s+(test|bench)/);
    assert.equal(
      payload.intent.inferredFrom.discoveredBenchmark.path,
      "docs/autoresearch-benchmark.md",
    );
  });
});

test("prompt-plan flags retrieval speed work as needing a quality constraint", async () => {
  await withTempDir("prompt-plan-retrieval-quality", async (dir) => {
    const result = await runCli([
      "prompt-plan",
      "--cwd",
      dir,
      "--prompt",
      "Speed up large-codebase semantic retrieval with lazy search",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    const serialized = JSON.stringify(payload);

    assert.match(serialized, /quality constraint/i);
    assert.match(serialized, /accuracy|recall|ranking/i);
    assert.doesNotMatch(serialized, /cargo test.*primary benchmark/i);
  });
});

test("run notes append inside the managed ledger block", async () => {
  await withTempDir("managed-ledger", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "ledger", "--metric-name", "seconds"]);
    await writeFile(
      path.join(dir, "autoresearch.md"),
      "# Session\n\n## Guardrails\nKeep this section stable.\n",
      "utf8",
    );
    for (const metric of ["3", "2"]) {
      const logged = await runCli([
        "log",
        "--cwd",
        dir,
        "--metric",
        metric,
        "--status",
        "keep",
        "--description",
        `Run ${metric}`,
      ]);
      assert.equal(logged.code, 0, logged.stderr);
    }
    const note = await readFile(path.join(dir, "autoresearch.md"), "utf8");
    assert.match(note, /## Run Ledger/);
    assert.equal((note.match(/AUTORESEARCH_RUN_LEDGER:START/g) || []).length, 1);
    assert.match(note, /Run 1 keep: Run 3[\s\S]+Run 2 keep: Run 2/);
    assert.match(note, /## Guardrails\nKeep this section stable\.\n\n## Run Ledger/);
  });
});

test("benchmark contract changes block the next packet until a new segment", async () => {
  await withTempDir("contract-drift", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "contract",
      "--metric-name",
      "score",
      "--direction",
      "higher",
    ]);
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({ maxIterations: 5 }, null, 2),
      "utf8",
    );
    await writeFile(
      path.join(dir, "packet.cmd"),
      "node -e \"console.log('METRIC score=1')\"\n",
      "utf8",
    );

    const packet = await runCli(["next", "--cwd", dir, "--command-file", "packet.cmd"]);
    assert.equal(packet.code, 0, packet.stderr);
    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Baseline contract",
    ]);
    assert.equal(logged.code, 0, logged.stderr);

    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({ maxIterations: 8 }, null, 2),
      "utf8",
    );
    const blocked = await runCli(["next", "--cwd", dir, "--command-file", "packet.cmd"]);
    assert.equal(blocked.code, 0, blocked.stderr);
    const payload = JSON.parse(blocked.stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.doctor.issues.join("\n"), /Benchmark\/check\/config contract changed/);
    assert.match(payload.nextAction, /new segment|old evidence|contract/i);
  });
});

test("new segment rebaselines benchmark contract drift for changed benchmark surface", async () => {
  await withTempDir("segment-contract-rebaseline", async (dir) => {
    const benchmarkCommand = `${quoteForShell(process.execPath)} benchmark.mjs`;
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "contract rebaseline",
      "--metric-name",
      "score",
      "--direction",
      "higher",
    ]);
    await writeFile(path.join(dir, "bench-a.txt"), "protected A\n", "utf8");
    await writeFile(
      path.join(dir, "benchmark.mjs"),
      "import { readFileSync } from 'node:fs';\nconsole.log(`METRIC score=${readFileSync('score.txt', 'utf8').trim()}`);\n",
      "utf8",
    );
    await writeFile(path.join(dir, "score.txt"), "1\n", "utf8");
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({ protectedBenchmarkPaths: ["bench-a.txt"] }, null, 2),
      "utf8",
    );

    const packet = await runCli(["next", "--cwd", dir, "--command", benchmarkCommand]);
    assert.equal(packet.code, 0, packet.stderr);
    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Baseline contract",
    ]);
    assert.equal(logged.code, 0, logged.stderr);

    await writeFile(path.join(dir, "bench-b.txt"), "protected B\n", "utf8");
    await writeFile(path.join(dir, "score.txt"), "2\n", "utf8");
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({ protectedBenchmarkPaths: ["bench-b.txt"] }, null, 2),
      "utf8",
    );
    const segment = await runCli([
      "new-segment",
      "--cwd",
      dir,
      "--benchmark-command",
      benchmarkCommand,
      "--reason",
      "new benchmark surface",
      "--yes",
    ]);
    assert.equal(segment.code, 0, segment.stderr);

    const doctor = await runCli(["doctor", "--cwd", dir, "--check-benchmark", "--json"]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const payload = JSON.parse(doctor.stdout);
    assert.equal(payload.benchmarkContract.ok, true);
    assert.equal(
      payload.warningDetails.some((warning: any) => warning?.code === "benchmark_contract_changed"),
      false,
    );
    assert.doesNotMatch(payload.issues.join("\n"), /benchmark.*drift/i);
  });
});

test("new segment warns when metric semantics change across segments", async () => {
  await withTempDir("segment-metric-semantics", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "metric semantics",
      "--metric-name",
      "seconds",
      "--metric-unit",
      "s",
      "--direction",
      "lower",
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "3",
      "--status",
      "keep",
      "--description",
      "Seconds baseline",
    ]);

    const segment = await runCli([
      "new-segment",
      "--cwd",
      dir,
      "--metric-name",
      "embedded_docs",
      "--metric-unit",
      "docs",
      "--direction",
      "higher",
      "--reason",
      "new semantic metric",
      "--yes",
    ]);
    assert.equal(segment.code, 0, segment.stderr);
    const segmentPayload = cliPayload(JSON.parse(segment.stdout));
    assert.equal(segmentPayload.metricSemanticsWarning?.code, "metric_semantics_changed");

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = cliPayload(JSON.parse(state.stdout));
    assert.equal(statePayload.metricSemanticsWarning?.code, "metric_semantics_changed");

    const report = await runCli(["state", "--cwd", dir, "--report", "--compact"]);
    assert.equal(report.code, 0, report.stderr);
    const reportPayload = cliPayload(JSON.parse(report.stdout));
    const reportCompact = (reportPayload.compactState as Record<string, unknown>) || reportPayload;
    assert.equal(reportCompact.metricSemanticsWarning?.code, "metric_semantics_changed");
  });
});

test("new segment honors explicit lower direction after a higher segment", async () => {
  await withTempDir("segment-direction-lower", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "direction flip",
      "--metric-name",
      "score",
      "--direction",
      "higher",
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
      "Higher baseline",
    ]);

    const segment = await runCli([
      "new-segment",
      "--cwd",
      dir,
      "--metric-name",
      "latency",
      "--direction",
      "lower",
      "--reason",
      "switch to latency",
      "--yes",
    ]);
    assert.equal(segment.code, 0, segment.stderr);
    const payload = cliPayload(JSON.parse(segment.stdout));
    assert.equal(payload.entry.bestDirection, "lower");
    assert.equal(payload.metricSemanticsWarning?.code, "metric_semantics_changed");
  });
});

test("new segment does not treat its own ledger append as dirty source drift", async () => {
  await withTempDir("segment-self-dirty", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await runCli(["init", "--cwd", dir, "--name", "segment", "--metric-name", "seconds"]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "3",
      "--status",
      "measure",
      "--description",
      "Initial segment measurement",
    ]);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial session"]);

    const segment = await runCli([
      "new-segment",
      "--cwd",
      dir,
      "--reason",
      "fresh metric phase",
      "--yes",
    ]);
    assert.equal(segment.code, 0, segment.stderr);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.equal(payload.segment, 1);
    assert.equal(payload.decisionEnvelope.dirtySourceDrift.dirty, false);
    assert.equal(payload.sourceCleanliness.status, "session-artifacts-dirty");
    assert.equal(payload.sourceCleanliness.sourceDirty, false);
    assert.equal(payload.sourceCleanliness.sessionArtifactDirty, true);
    assert.equal(payload.sourceCleanliness.cleanupCommand, "");
    assert.ok(
      payload.warningDetails.every((warning) => warning.code !== "git_dirty"),
      "session-only dirtiness should not be reported as source drift",
    );
    const report = await runCli(["state", "--cwd", dir, "--report"]);
    assert.equal(report.code, 0, report.stderr);
    const reportPayload = JSON.parse(report.stdout);
    assert.equal(reportPayload.report.json.cleanliness.status, "session-artifacts-dirty");
    assert.equal(reportPayload.report.json.cleanliness.cleanupCommand, "");
    assert.match(reportPayload.report.text, /Only Autoresearch session artifacts are dirty/);
    assert.doesNotMatch(reportPayload.report.text, /git stash push --include-untracked/);
    const doctor = await runCli(["doctor", "--cwd", dir]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctorPayload = JSON.parse(doctor.stdout);
    assert.doesNotMatch(doctorPayload.warnings.join("\n"), /Git worktree is dirty/);
    assert.ok(
      doctorPayload.warningDetails.every((warning) => warning.code !== "git_dirty"),
      "doctor should use the same session-only dirtiness filter as state",
    );

    await writeFile(path.join(dir, "tracked.txt"), "changed\n", "utf8");
    const dirty = await runCli(["state", "--cwd", dir]);
    assert.equal(dirty.code, 0, dirty.stderr);
    const dirtyPayload = JSON.parse(dirty.stdout);
    assert.equal(dirtyPayload.decisionEnvelope.dirtySourceDrift.dirty, true);
    assert.ok(dirtyPayload.warningDetails.some((warning) => warning.code === "git_dirty"));

    const dirtyCompact = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(dirtyCompact.code, 0, dirtyCompact.stderr);
    const dirtyCompactPayload = JSON.parse(dirtyCompact.stdout);
    assert.equal(dirtyCompactPayload.decisionEnvelope.dirtySourceDrift.dirty, true);
    assert.equal(dirtyCompactPayload.sourceCleanliness.status, "source-dirty");
    assert.equal(dirtyCompactPayload.sourceCleanliness.cleanupCommand, "");
    assert.ok(
      dirtyCompactPayload.blockers.some((blocker) =>
        String(blocker).includes("Git worktree is dirty"),
      ),
    );
  });
});

test("state and recommend-next share watchdog canonical next-action parity", async () => {
  await withTempDir("watchdog-cli-parity", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "watchdog parity", "--metric-name", "seconds"]);
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
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "10",
      "--status",
      "discard",
      "--description",
      "No movement",
    ]);

    const ledgerPath = path.join(dir, "autoresearch.jsonl");
    const oldMs = Date.now() - 10 * 60 * 60 * 1000;
    const lines = (await readFile(ledgerPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    for (const entry of lines) {
      if (entry.run != null) entry.timestamp = oldMs;
    }
    await writeFile(
      ledgerPath,
      `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );

    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({ maxIterations: 100 }, null, 2),
      "utf8",
    );

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.watchdogSummary?.stale, true);
    assert.equal(statePayload.decisionEnvelope?.watchdog?.stale, true);
    assert.equal(statePayload.limitReached, false);

    const recommend = await runCli(["recommend-next", "--cwd", dir, "--compact"]);
    assert.equal(recommend.code, 0, recommend.stderr);
    const recommendPayload = JSON.parse(recommend.stdout);
    assert.equal(recommendPayload.decisionEnvelope?.watchdog?.stale, true);
    assert.equal(
      recommendPayload.decisionEnvelope?.canonicalNextAction?.kind,
      statePayload.canonicalNextAction?.kind,
    );
    assert.equal(
      recommendPayload.decisionEnvelope?.watchdog?.recommendation,
      statePayload.decisionEnvelope?.watchdog?.recommendation,
    );
    assert.match(
      String(statePayload.decisionEnvelope?.watchdog?.recommendation || ""),
      /Intervene|finalize|rescope/i,
    );
  });
});

test("fanout plans are scoped to the active segment", async () => {
  await withTempDir("fanout-segment-scope", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "fanout scope", "--metric-name", "quality_gap"]);
    const fanout = await runCli(["research-fanout", "--cwd", dir, "--lanes", "4", "--yes"]);
    assert.equal(fanout.code, 0, fanout.stderr);
    const plan = JSON.parse(fanout.stdout).fanoutPlan;
    assert.ok(plan.id);

    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "4",
      "--status",
      "measure",
      "--description",
      "Segment zero measurement",
    ]);
    await runCli([
      "new-segment",
      "--cwd",
      dir,
      "--reason",
      "fresh segment for fanout scope",
      "--yes",
    ]);

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.equal(payload.segment, 1);
    assert.equal(payload.fanoutProvenance?.matchedSegment, false);
    assert.equal(payload.fanoutProvenance?.source, "memory_or_defaults");
    assert.notEqual(payload.fanoutPlan?.id, plan.id);
    assert.equal(payload.fanoutPlan, null);
  });
});

test("read-only lane-runner rejects commands outside git without explicit opt-in", async () => {
  await withTempDir("lane-runner-non-git", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "non git lane", "--metric-name", "quality_gap"]);
    await runCli(["research-fanout", "--cwd", dir, "--lanes", "2", "--yes"]);

    const blocked = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "read-only-scout",
      "--command",
      `${quoteForShell(process.execPath)} -e "console.log('scout')"`,
      "--yes",
    ]);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /Git worktree|porcelain verification/i);

    const allowed = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "read-only-scout",
      "--command",
      `${quoteForShell(process.execPath)} -e "console.log('scout')"`,
      "--allow-non-git-command",
      "--yes",
    ]);
    assert.equal(allowed.code, 0, allowed.stderr);
  });
});

test("completed lane results count as watchdog progress signals", async () => {
  await withTempDir("watchdog-lane-result", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "lane watchdog",
      "--metric-name",
      "seconds",
      "--max-iterations",
      "100",
    ]);
    await runCli(["research-fanout", "--cwd", dir, "--lanes", "2", "--yes"]);
    const oldMs = Date.now() - 10 * 60 * 60 * 1000;
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "10",
      "--status",
      "keep",
      "--description",
      "Old baseline",
    ]);
    const ledgerPath = path.join(dir, "autoresearch.jsonl");
    const lines = (await readFile(ledgerPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    for (const entry of lines) {
      if (entry.run != null) entry.timestamp = oldMs;
    }
    await writeFile(
      ledgerPath,
      `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );

    const before = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(JSON.parse(before.stdout).watchdogSummary?.stale, true);

    await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "read-only-scout",
      "--summary",
      "Scout completed.",
      "--recommendation",
      "Run one measured packet next.",
      "--yes",
    ]);

    const after = await runCli(["state", "--cwd", dir, "--compact"]);
    const afterPayload = JSON.parse(after.stdout);
    assert.equal(afterPayload.watchdogSummary?.stale, false);
    assert.ok(
      afterPayload.parallelLanes.some(
        (lane) => lane.id === "read-only-scout" && lane.status === "completed",
      ),
    );
  });
});

test("dashboard includes segment controls and visual-aid layout", async () => {
  await withTempDir("dashboard-cockpit", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "first segment", "--metric-name", "seconds"]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "4",
      "--status",
      "keep",
      "--description",
      "Baseline",
    ]);
    await runCli(["init", "--cwd", dir, "--name", "second segment", "--metric-name", "seconds"]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "3",
      "--status",
      "keep",
      "--description",
      "Second baseline",
    ]);

    const exportResult = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const dashboard = await readFile(path.join(dir, "autoresearch-dashboard.html"), "utf8");
    const dom = await renderExportedDashboard(dashboard);
    const doc = dom.window.document;
    const rendered = doc.body.innerHTML;

    assert.ok(doc.getElementById("segment-navigator"));
    const segmentSelect = doc.getElementById("segment-select") as HTMLSelectElement | null;
    assert.ok(segmentSelect);
    assert.equal(segmentSelect.options.length, 2);
    assert.match(segmentSelect.options[0].textContent || "", /S1 - first segment/);
    assert.match(segmentSelect.options[1].textContent || "", /S2 - second segment/);
    assert.ok(doc.getElementById("live-toggle"));
    assert.doesNotMatch(dashboard, /id="command-grid"/);
    assert.match(doc.body.textContent, /Run log/);
    assert.ok(doc.getElementById("ledger-scroll"));
    assert.match(doc.body.textContent, /Codex brief/);
    assert.ok(doc.getElementById("ai-summary-title"));
    assert.equal(doc.getElementById("mission-control-grid"), null);
    assert.equal(doc.getElementById("run-log-decision"), null);
    assert.equal(doc.getElementById("trust-strip"), null);
    assert.match(dashboard, /__AUTORESEARCH_META__/);
    assert.doesNotMatch(dashboard, /clipboard\?\.writeText/);
    assert.doesNotMatch(dashboard, /autoresearch\.mjs/);
    assert.match(doc.body.textContent, /Finalize/);
    assert.ok(rendered.indexOf('id="trend-panel"') < rendered.indexOf('id="decision-rail"'));
    assert.ok(rendered.indexOf('id="decision-rail"') < rendered.indexOf('id="codex-brief"'));
    assert.ok(rendered.indexOf('id="codex-brief"') < rendered.indexOf('id="strategy-memory"'));
    assert.ok(rendered.indexOf('id="decision-rail"') < rendered.indexOf('id="ledger"'));
    assert.ok(rendered.indexOf('id="trend-panel"') < rendered.indexOf('id="ledger"'));
    assert.ok(rendered.indexOf('id="ledger"') < rendered.indexOf('id="research-truth-meter"'));
    dom.window.close();
  });
});

test("config persists operator settings and extends iteration limits", async () => {
  await withTempDir("operator-config", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "operator config", "--metric-name", "seconds"]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "5",
      "--status",
      "keep",
      "--description",
      "Baseline",
    ]);

    const result = await runCli([
      "config",
      "--cwd",
      dir,
      "--autonomy-mode",
      "owner-autonomous",
      "--checks-policy",
      "on-improvement",
      "--keep-policy",
      "primary-or-risk-reduction",
      "--dashboard-refresh-seconds",
      "2",
      "--extend",
      "4",
      "--commit-paths",
      "src,tests",
    ]);
    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.config.autonomyMode, "owner-autonomous");
    assert.equal(payload.config.checksPolicy, "on-improvement");
    assert.equal(payload.config.keepPolicy, "primary-or-risk-reduction");
    assert.equal(payload.config.dashboardRefreshSeconds, 2);
    assert.equal(payload.config.maxIterations, 5);
    assert.deepEqual(payload.config.commitPaths, ["src", "tests"]);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.settings.autonomyMode, "owner-autonomous");
    assert.equal(statePayload.limit.remainingIterations, 4);
    assert.match(statePayload.commands[0].command, /autoresearch\.mjs/);
    assert.match(statePayload.commands[0].command, /--cwd/);
    const commandRail = statePayload.commands
      .map((command) => `${command.label}: ${command.command}`)
      .join("\n");
    const commandTexts = statePayload.commands.map((command) => command.command).join("\n");
    assert.match(commandRail, /\bfinalize-preview\b/);
    assert.match(commandRail, /\bnew-segment\b.*--dry-run/);
    assert.doesNotMatch(commandTexts, /\bfinalize-current-tree\b/);
    assert.doesNotMatch(commandTexts, /\sconfig\s.*--extend/);
    assert.doesNotMatch(commandTexts, /\slog\s.*--from-last/);
    assert.doesNotMatch(commandTexts, /\snext\s.*--compact/);
  });
});

test("next writes a reusable last-run packet and log can consume it", async () => {
  await withTempDir("last-run", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "last run", "--metric-name", "seconds"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3'); console.log('METRIC cache_hits=8')"`;

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
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.decision.metric, 3);
    assert.equal(packet.decision.metrics.cache_hits, 8);
    assert.equal(packet.decision.rawSuggestedStatus, "measure");
    assert.equal(packet.decision.safeSuggestedStatus, "measure");
    assert.equal(packet.decision.promotion.label, "exploratory");
    assert.match(packet.decision.statusGuidance, /baseline or diagnostic packet/);
    assert.equal(packet.decision.diversityGuidance, null);
    assert.equal(packet.decision.asiTemplate.lane, "");
    assert.match(packet.packetEvidence.packetId, /^packet-/);
    assert.equal(
      packet.packetEvidence.commandIdentity.command,
      redactCommandDisplay(command, { workDir: dir }),
    );
    assert.equal(packet.packetEvidence.exitStatus, 0);
    assert.equal(packet.packetEvidence.metrics.seconds, 3);
    assert.match(packet.packetEvidence.stdoutTail, /METRIC seconds=3/);
    assert.match(packet.packetEvidence.freshnessFingerprint, /^[a-f0-9]{64}$/);

    const lastRun = JSON.parse(await readFile(packet.lastRunPath, "utf8"));
    assert.equal(lastRun.decision.metric, 3);
    assert.equal(lastRun.decision.promotion.label, "exploratory");
    assert.equal(lastRun.packetEvidence.metrics.cache_hits, 8);
    assert.equal(lastRun.history.nextRun, 1);
    assert.equal(lastRun.history.config.metricName, "seconds");

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "discard",
      "--description",
      "Discard cached packet",
    ]);
    assert.equal(log.code, 0, log.stderr);
    const payload = JSON.parse(log.stdout);
    assert.equal(payload.experiment.metric, 3);
    assert.equal(payload.experiment.metrics.cache_hits, 8);
    assert.equal(payload.experiment.metricEligible, true);
    assert.equal(payload.experiment.promotion.label, "invalidated");
    assert.match(payload.experiment.packetFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(payload.lastRunCleared, true);
    await assert.rejects(access(packet.lastRunPath));

    const duplicate = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "discard",
      "--description",
      "Duplicate cached packet",
    ]);
    assert.notEqual(duplicate.code, 0);
    assert.match(duplicate.stderr, /No last-run packet/);
  });
});

test("next refuses to overwrite an unlogged fresh last-run packet", async () => {
  await withTempDir("fresh-last-run-next-refusal", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "fresh last run", "--metric-name", "seconds"]);
    const firstCommand = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const first = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      firstCommand,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(first.code, 0, first.stderr);
    const firstPayload = JSON.parse(first.stdout);
    const packetPath = firstPayload.lastRunPath;
    const before = JSON.parse(await readFile(packetPath, "utf8"));
    assert.equal(before.decision.metric, 3);

    const sideEffectFile = path.join(dir, "second-packet-ran.txt");
    const sideEffectScript = path.join(dir, "second-packet.mjs");
    await writeFile(
      sideEffectScript,
      [
        `import { writeFileSync } from "node:fs";`,
        `writeFileSync(${JSON.stringify(sideEffectFile)}, "ran");`,
        `console.log("METRIC seconds=99");`,
        "",
      ].join("\n"),
      "utf8",
    );
    const secondCommand = `${quoteForShell(process.execPath)} ${quoteForShell(sideEffectScript)}`;
    const second = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      secondCommand,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(second.code, 0, second.stderr);
    const refused = JSON.parse(second.stdout);
    assert.equal(refused.ok, false);
    assert.equal(refused.refused, true);
    assert.equal(refused.code, "next_blocked_by_loop_contract");
    assert.equal(refused.blockingAction.kind, "log-decision");
    assert.equal(refused.loopContract.canRunNextPacket, false);
    assert.equal(refused.run, null);
    assert.equal(refused.decision, null);
    assert.match(refused.commandHint, /\blog\b/);

    const after = JSON.parse(await readFile(packetPath, "utf8"));
    assert.equal(after.decision.metric, 3);
    assert.equal(after.packetEvidence.metrics.seconds, 3);
    await assert.rejects(access(sideEffectFile));
  });
});

test("next parses metrics from the full benchmark output before display truncation", async () => {
  await withTempDir("full-output-metric", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "full output", "--metric-name", "seconds"]);
    const script = path.join(dir, "noisy-benchmark.mjs");
    await writeFile(
      script,
      [
        "console.log('METRIC seconds=7');",
        "for (let i = 0; i < 3000; i += 1) console.log(`noise ${i} ${'x'.repeat(80)}`);",
        "",
      ].join("\n"),
      "utf8",
    );

    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      `${quoteForShell(process.execPath)} ${quoteForShell(script)}`,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.decision.metric, 7);
    assert.equal(packet.run.parsedPrimary, 7);
    assert.equal(packet.run.outputTruncated, true);
  });
});

test("successful last-run packets require explicit status and suggest discard for regressions", async () => {
  await withTempDir("last-run-suggest-discard", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "suggest discard",
      "--metric-name",
      "seconds",
      "--direction",
      "lower",
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "3",
      "--status",
      "keep",
      "--description",
      "Baseline",
    ]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=4')"`;

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
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.decision.suggestedStatus, "discard");
    assert.deepEqual(packet.decision.allowedStatuses, ["keep", "discard", "measure"]);

    const missingStatus = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--description",
      "No status",
    ]);
    assert.notEqual(missingStatus.code, 0);
    assert.match(missingStatus.stderr, /status is required/);

    const discard = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "discard",
      "--description",
      "Discard slower run",
    ]);
    assert.equal(discard.code, 0, discard.stderr);
    assert.equal(JSON.parse(discard.stdout).experiment.status, "discard");
  });
});

test("stale last-run packets are rejected when history advances", async () => {
  await withTempDir("stale-last-run", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "stale packet", "--metric-name", "seconds"]);
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

    const stale = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Old packet",
    ]);
    assert.notEqual(stale.code, 0);
    assert.match(stale.stderr, /Last-run packet is stale/);
    assert.match(stale.stderr, /next --cwd/);
    assert.match(stale.stderr, /--status measure/);
  });
});

test("stale last-run packets are rejected when scoped git evidence changes", async () => {
  await withTempDir("stale-last-run-git-evidence", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "git stale packet", "--metric-name", "seconds"]);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);

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

    await writeFile(path.join(dir, "tracked.txt"), "changed after next\n", "utf8");
    const stale = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "discard",
      "--description",
      "Old packet after file edit",
    ]);
    assert.notEqual(stale.code, 0);
    assert.match(stale.stderr, /Git dirty state changed|scoped file fingerprints changed/);
  });
});

test("stale last-run packets are rejected when dirty file contents change without status shape changes", async () => {
  await withTempDir("stale-last-run-dirty-content", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "dirty content packet",
      "--metric-name",
      "seconds",
    ]);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await writeFile(path.join(dir, "tracked.txt"), "dirty before packet\n", "utf8");

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

    await writeFile(path.join(dir, "tracked.txt"), "dirty after packet\n", "utf8");
    const stale = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Old packet after dirty content edit",
      "--allow-add-all",
    ]);
    assert.notEqual(stale.code, 0);
    assert.match(stale.stderr, /dirty file contents changed/);
  });
});

test("stale last-run packets are rejected when untracked directory contents change", async () => {
  await withTempDir("stale-last-run-untracked-dir", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "untracked dir packet",
      "--metric-name",
      "seconds",
    ]);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await mkdir(path.join(dir, "scratch"), { recursive: true });
    await writeFile(path.join(dir, "scratch", "thing.txt"), "before packet\n", "utf8");

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

    await writeFile(path.join(dir, "scratch", "thing.txt"), "after packet\n", "utf8");
    const stale = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Old packet after untracked dir edit",
      "--allow-add-all",
    ]);
    assert.notEqual(stale.code, 0);
    assert.match(stale.stderr, /dirty file contents changed|Git dirty state changed/);
  });
});

test("next refuses runs when dirty fingerprints would be truncated", async () => {
  await withTempDir("stale-last-run-truncated-dirty", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "truncated dirty packet",
      "--metric-name",
      "seconds",
    ]);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);

    const scratch = path.join(dir, "scratch");
    await mkdir(scratch, { recursive: true });
    for (let index = 0; index < 505; index += 1) {
      await writeFile(path.join(scratch, `file-${String(index).padStart(3, "0")}.txt`), "x\n");
    }

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
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.ok, false);
    assert.equal(packet.refused, true);
    assert.equal(packet.code, "next_blocked_by_truncated_fingerprints");
    assert.match(
      JSON.stringify(packet.git.dirtyFileFingerprints),
      /dirty_file_entry_limit|directory_entry_limit/,
    );
    assert.match(packet.nextAction, /Clean or narrow the dirty tree/);
    await assert.rejects(access(path.join(dir, "autoresearch.last-run.json")));
    await assert.rejects(access(path.join(dir, ".git", "autoresearch", "last-run.json")));
  });
});

test("next allows clean repos with broad scoped commit paths", async () => {
  await withTempDir("large-clean-scoped-commit-path", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    const srcDir = path.join(dir, "src");
    await mkdir(srcDir, { recursive: true });
    for (let index = 0; index < 501; index += 1) {
      await writeFile(path.join(srcDir, `file-${String(index).padStart(3, "0")}.txt`), "x\n");
    }
    await git(dir, ["add", "src"]);
    await git(dir, ["commit", "-m", "initial src"]);

    await runCli(["init", "--cwd", dir, "--name", "large clean scope", "--metric-name", "seconds"]);
    const configured = await runCli(["config", "--cwd", dir, "--commit-paths", "src"]);
    assert.equal(configured.code, 0, configured.stderr);
    await git(dir, ["add", "autoresearch.config.json", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session config"]);
    const status = await git(dir, ["status", "--short"]);
    assert.equal(status, "");

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
    const packet = JSON.parse(next.stdout);
    assert.notEqual(packet.code, "next_blocked_by_truncated_fingerprints");
    assert.equal(packet.decision.metric, 3);
    const lastRun = JSON.parse(await readFile(packet.lastRunPath, "utf8"));
    assert.match(JSON.stringify(lastRun.history.git.fileFingerprints), /scoped_file_entry_limit/);
    assert.equal(
      JSON.stringify(lastRun.history.git.dirtyFileFingerprints).includes("truncated"),
      false,
    );

    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "measure",
      "--description",
      "Large clean scoped path measurement",
    ]);
    assert.equal(logged.code, 0, logged.stderr);
  });
});

test("last-run packets are rejected when config changes before logging", async () => {
  await withTempDir("config-stale-last-run", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "first config", "--metric-name", "seconds"]);
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

    const secondConfig = await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "second config",
      "--metric-name",
      "points",
      "--direction",
      "higher",
    ]);
    assert.equal(secondConfig.code, 0, secondConfig.stderr);

    const stale = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Old metric packet",
    ]);
    assert.notEqual(stale.code, 0);
    assert.match(stale.stderr, /session config changed/);
  });
});

test("owner-autonomous runs return continuation instead of handing control back", async () => {
  await withTempDir("continuation", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "continuation", "--metric-name", "seconds"]);
    await runCli([
      "config",
      "--cwd",
      dir,
      "--autonomy-mode",
      "owner-autonomous",
      "--checks-policy",
      "manual",
    ]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;

    const next = await runCli(["next", "--cwd", dir, "--command", command]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.continuation.stage, "needs-log-decision");
    assert.equal(packet.continuation.requiresLogDecision, true);
    assert.equal(packet.continuation.shouldAskUser, false);
    assert.equal(packet.continuation.forbidFinalAnswer, true);

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Keep baseline",
    ]);
    assert.equal(log.code, 0, log.stderr);
    const payload = JSON.parse(log.stdout);
    assert.equal(payload.continuation.stage, "logged");
    assert.equal(payload.continuation.shouldContinue, true);
    assert.equal(payload.continuation.shouldAskUser, false);
    assert.equal(payload.continuation.forbidFinalAnswer, true);
    assert.match(payload.continuation.nextAction, /without asking the user/);
    assert.match(payload.continuation.commands.next, / next /);
  });
});

test("guarded sessions with active budgets keep continuation non-final", async () => {
  await withTempDir("guarded-active-budget", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "budget", "--metric-name", "seconds"]);
    await runCli(["config", "--cwd", dir, "--checks-policy", "manual", "--max-iterations", "3"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;

    const next = await runCli(["next", "--cwd", dir, "--command", command, "--compact"]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.continuation.stage, "needs-log-decision");
    assert.equal(packet.continuation.activeBudget, true);
    assert.equal(packet.continuation.shouldContinue, true);
    assert.equal(packet.continuation.forbidFinalAnswer, true);
    assert.match(packet.report.tried, /seconds=3/);
    assert.equal(packet.doctor, undefined);
    assert.match(packet.fullPacket, /lastRunPath/);

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Keep baseline",
    ]);
    assert.equal(log.code, 0, log.stderr);
    const payload = JSON.parse(log.stdout);
    assert.equal(payload.continuation.stage, "logged");
    assert.equal(payload.continuation.activeBudget, true);
    assert.equal(payload.continuation.shouldContinue, true);
    assert.equal(payload.continuation.forbidFinalAnswer, true);
    assert.match(payload.continuation.finalAnswerPolicy, /Do not stop/);

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.activeBudget, true);
    assert.equal(statePayload.forbidFinalAnswer, true);
    assert.match(statePayload.commands.next, /--compact/);
    assert.match(statePayload.report.next, /Keep going/);
  });
});

test("continuation stops cleanly at the configured iteration limit", async () => {
  await withTempDir("continuation-limit", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "continuation limit",
      "--metric-name",
      "seconds",
    ]);
    await runCli([
      "config",
      "--cwd",
      dir,
      "--autonomy-mode",
      "owner-autonomous",
      "--checks-policy",
      "manual",
      "--max-iterations",
      "1",
    ]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;

    const next = await runCli(["next", "--cwd", dir, "--command", command]);
    assert.equal(next.code, 0, next.stderr);
    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Limit baseline",
    ]);
    assert.equal(log.code, 0, log.stderr);
    const payload = JSON.parse(log.stdout);
    assert.equal(payload.limit.limitReached, true);
    assert.equal(payload.continuation.shouldContinue, false);
    assert.match(payload.continuation.stopReason, /maxIterations reached/);
    assert.match(payload.continuation.commands.extendLimit, /--extend 10/);
  });
});

test("log from last packet rejects keep after failed checks", async () => {
  await withTempDir("last-run-check-failure", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "last run checks", "--metric-name", "seconds"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const checks = `${quoteForShell(process.execPath)} -e "process.exit(1)"`;

    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-command",
      checks,
    ]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.deepEqual(packet.decision.allowedStatuses, ["checks_failed"]);

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Should not keep failed checks",
    ]);
    assert.notEqual(log.code, 0);
    assert.match(log.stderr, /Cannot log status 'keep'/);

    const jsonl = await readFile(path.join(dir, "autoresearch.jsonl"), "utf8");
    assert.doesNotMatch(jsonl, /Should not keep failed checks/);
  });
});

test("metricless failure logs do not become baseline or best", async () => {
  await withTempDir("metricless-failures", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "metricless failures",
      "--metric-name",
      "seconds",
    ]);

    const crash = await runCli([
      "log",
      "--cwd",
      dir,
      "--status",
      "crash",
      "--description",
      "Benchmark crashed before metric",
    ]);
    assert.equal(crash.code, 0, crash.stderr);
    const crashPayload = JSON.parse(crash.stdout);
    assert.equal(crashPayload.experiment.metric, null);
    assert.equal(crashPayload.experiment.metricEligible, false);
    assert.equal(crashPayload.experiment.promotion.label, "blocked");

    const checksFailed = await runCli([
      "log",
      "--cwd",
      dir,
      "--status",
      "checks_failed",
      "--description",
      "Checks failed before metric",
    ]);
    assert.equal(checksFailed.code, 0, checksFailed.stderr);
    const checksFailedPayload = JSON.parse(checksFailed.stdout);
    assert.equal(checksFailedPayload.experiment.metric, null);
    assert.equal(checksFailedPayload.experiment.metricEligible, false);
    assert.equal(checksFailedPayload.experiment.promotion.label, "blocked");

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.equal(payload.baseline, null);
    assert.equal(payload.best, null);
    assert.equal(payload.crashed, 1);
    assert.equal(payload.checksFailed, 1);
  });
});

test("measure logs metric evidence without keep/finalizer eligibility or git mutation", async () => {
  await withTempDir("measure-log-git-safe", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "test@example.com"]);
    await git(dir, ["config", "user.name", "Test User"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);
    const headBefore = await git(dir, ["rev-parse", "HEAD"]);

    await runCli(["init", "--cwd", dir, "--name", "measure", "--metric-name", "seconds"]);
    await writeFile(path.join(dir, "tracked.txt"), "after\n");

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1.23",
      "--status",
      "measure",
      "--description",
      "Record observation only",
      "--asi",
      JSON.stringify({ promotionGrade: true, evidence: "diagnostic measurement only" }),
    ]);
    assert.equal(log.code, 0, log.stderr);
    const payload = JSON.parse(log.stdout);
    assert.equal(payload.experiment.status, "measure");
    assert.equal(payload.experiment.metricEligible, false);
    assert.equal(payload.experiment.promotion.label, "measurement");
    assert.equal(payload.experiment.commit, "");
    assert.equal(payload.git, "Git: no commit created.");
    assert.equal(await git(dir, ["rev-parse", "HEAD"]), headBefore);
    assert.match(await git(dir, ["status", "--short"]), /M tracked\.txt/);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.kept, 0);
    assert.equal(statePayload.measured, 1);
    assert.equal(statePayload.baseline, 1.23);
    assert.equal(statePayload.best, null);
    assert.equal(statePayload.promotion.count, 0);
    assert.equal(statePayload.promotion.baseline, null);
    assert.equal(statePayload.development.latest.status, "measure");
    assert.equal(statePayload.development.latest.metric, 1.23);

    const explicitCommit = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1.24",
      "--status",
      "measure",
      "--description",
      "Invalid commit provenance",
      "--commit",
      "HEAD",
    ]);
    assert.notEqual(explicitCommit.code, 0);
    assert.match(explicitCommit.stderr, /--commit is not allowed for measure logs/);
  });
});

test("from-last errors name next and manual measure recovery commands", async () => {
  await withTempDir("from-last-recovery", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "recovery", "--metric-name", "seconds"]);

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "measure",
      "--description",
      "No packet",
    ]);
    assert.notEqual(log.code, 0);
    assert.match(log.stderr, /No last-run packet found/);
    assert.match(log.stderr, /next --cwd/);
    assert.match(log.stderr, /--status measure/);
  });
});

test("compact state, recommend-next, and onboarding-packet surface decision envelopes", async () => {
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
    assert.equal(statePayload.decisionEnvelope.activeSegment.segment, 0);
    assert.equal(statePayload.resumeAudit.latestPacketFreshness.fresh, true);
    assert.equal(statePayload.decisionEnvelope.finalizationReadiness.available, true);
    assert.equal(statePayload.decisionEnvelope.finalizationReadiness.ready, false);
    assert.match(
      statePayload.decisionEnvelope.finalizationReadiness.nextAction,
      /Git-backed autoresearch branch/,
    );
    assert.equal(typeof statePayload.decisionEnvelope.nextAction, "string");

    const recommend = await runCli(["recommend-next", "--cwd", dir, "--compact"]);
    assert.equal(recommend.code, 0, recommend.stderr);
    const recommendPayload = JSON.parse(recommend.stdout);
    assert.equal(recommendPayload.decisionEnvelope.latestPacketFreshness.fresh, true);
    assert.equal(recommendPayload.nextAction, statePayload.canonicalNextAction.reason);
    assert.equal(
      recommendPayload.decisionEnvelope.canonicalNextAction.reason,
      statePayload.canonicalNextAction.reason,
    );

    const onboarding = await runCli(["onboarding-packet", "--cwd", dir, "--compact"]);
    assert.equal(onboarding.code, 0, onboarding.stderr);
    const onboardingPayload = JSON.parse(onboarding.stdout);
    assert.equal(onboardingPayload.decisionEnvelope.latestPacketFreshness.fresh, true);
    assert.equal(onboardingPayload.resumeAudit.activeSegment.runs, 0);
  });
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
    assert.equal(statePayload.decisionEnvelope.finalizationReadiness.available, true);
    assert.equal(statePayload.decisionEnvelope.finalizationReadiness.ready, false);
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
    assert.equal(
      recommendPayload.compactState.goalFrame.codexObjectiveRole,
      "operator_instruction",
    );
    assert.equal(
      recommendPayload.compactState.decisionEnvelope.finalizationReadiness.available,
      true,
    );
    assert.equal(recommendPayload.decisionEnvelope.finalizationReadiness.available, true);
    assert.equal(statePayload.canonicalNextAction.kind, "log-decision");
    assert.doesNotMatch(statePayload.operatorHandoff.command, /\bnext\b.*--compact/);
    assert.equal(
      recommendPayload.commands.primary,
      statePayload.canonicalNextAction.command || statePayload.commands.state,
    );
    assert.doesNotMatch(recommendPayload.commands.primary, /\bnext\b.*--compact/);
    assert.equal(
      recommendPayload.decisionEnvelope.canonicalNextAction.kind,
      statePayload.canonicalNextAction.kind,
    );
    assert.equal(recommendPayload.operatorChecklist.source, "latestPacketFreshness");
    assert.doesNotMatch(recommendPayload.operatorChecklist.command, /\bnext\b.*--compact/);
    assert.match(recommendPayload.whySafe, /compact state/);
    assert.match(recommendPayload.whySafe, /shared decision envelope/);
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
    assert.doesNotMatch(payload.commands.primary, /\bnext\b/);
    assert.match(payload.commands.primary, /lane-runner|new-segment/);
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
      statePayload.compactState.preflight.blockers.join("\n"),
      /pending receipt|not be recorded in autoresearch\.jsonl/i,
    );
    assert.match(
      statePayload.compactState.blockers.join("\n"),
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
    assert.equal(payload.canonicalNextAction.kind, "current-tree-finalization");
    assert.equal(payload.loopContract.canRunNextPacket, false);
    assert.equal(payload.decisionEnvelope.finalizationReadiness.available, true);
    assert.equal(payload.decisionEnvelope.canonicalNextAction.kind, "current-tree-finalization");
    assert.match(payload.nextAction, /finalize-current-tree|Final tree coverage/i);
    assert.doesNotMatch(payload.canonicalNextAction.command, /\bnext\b/);
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
    assert.equal(compactState.canonicalNextAction.kind, "current-tree-finalization");
    assert.equal(compactState.decisionEnvelope.finalizationReadiness.available, true);
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
      recommendPayload.decisionEnvelope.canonicalNextAction.kind,
      compactState.canonicalNextAction.kind,
    );
    assert.equal(
      recommendPayload.compactState.decisionEnvelope.finalizationReadiness.available,
      true,
    );
    assert.match(recommendPayload.operatorChecklist.source, /currentTree/);
    assert.doesNotMatch(recommendPayload.commands.primary, /\bnext\b.*--compact/);

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
    assert.equal(doctorPayload.canonicalNextAction.kind, compactState.canonicalNextAction.kind);
    assert.equal(doctorPayload.loopContract.canRunNextPacket, false);

    const exported = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exported.code, 0, exported.stderr);
    const exportPayload = JSON.parse(exported.stdout);
    assert.equal(
      exportPayload.viewModel.decisionEnvelope.canonicalNextAction.kind,
      compactState.canonicalNextAction.kind,
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

    assert.equal(fullStatePayload.decisionEnvelope.canonicalNextAction.kind, "stale-packet");
    assert.match(fullStatePayload.decisionEnvelope.canonicalNextAction.command, /\bnext\b/);
    assert.match(fullStatePayload.decisionEnvelope.canonicalNextAction.command, /--command/);
    assert.match(fullStatePayload.decisionEnvelope.canonicalNextAction.command, /--checks-command/);

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);

    assert.equal(statePayload.canonicalNextAction.kind, "stale-packet");
    assert.match(statePayload.commands.replaceLast, /\bnext\b/);
    assert.match(statePayload.commands.replaceLast, /--command/);
    assert.match(statePayload.commands.replaceLast, /--checks-command/);
    assert.equal(statePayload.canonicalNextAction.command, statePayload.commands.replaceLast);
    assert.equal(
      fullStatePayload.decisionEnvelope.canonicalNextAction.command,
      statePayload.commands.replaceLast,
    );

    const recommend = await runCli(["recommend-next", "--cwd", dir, "--compact"]);
    assert.equal(recommend.code, 0, recommend.stderr);
    const recommendPayload = JSON.parse(recommend.stdout);

    assert.equal(recommendPayload.decisionEnvelope.canonicalNextAction.kind, "stale-packet");
    assert.equal(recommendPayload.commands.primary, statePayload.commands.replaceLast);
    assert.match(recommendPayload.commands.primary, /\bnext\b/);

    const replacement = await runShellCommand(statePayload.commands.replaceLast, {
      cwd: pluginRoot,
    });
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

    assert.equal(payload.compactState.canonicalNextAction.kind, "decision-capsule");
    assert.equal(payload.report.json.nextCommand, payload.compactState.canonicalNextAction.command);
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

test("state report marks registry-only dashboard health dead until HTTP responds", async () => {
  await withTempDir("state-report-dashboard-health", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "dashboard health", "--metric-name", "seconds"]);
    await writeServeRegistry(dir, {
      pid: process.pid,
      port: 60241,
      cwd: dir,
      startedAt: "2026-06-01T00:00:00.000Z",
      version: PLUGIN_VERSION,
      healthUrl: "http://127.0.0.1:60241/health",
    });

    const report = await runCli(["state", "--cwd", dir, "--report"]);
    assert.equal(report.code, 0, report.stderr);
    const payload = JSON.parse(report.stdout);
    assert.equal(payload.report.json.dashboard.status, "dead");
    assert.match(payload.report.text, /Dashboard: dead/);
    assert.match(
      payload.report.json.dashboard.command ?? "",
      /scripts[\\/]autoresearch\.mjs serve/,
    );
    assert.doesNotMatch(payload.report.json.dashboard.command ?? "", /^curl /);

    const compact = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(compact.code, 0, compact.stderr);
    const compactPayload = JSON.parse(compact.stdout);
    assert.equal(compactPayload.dashboardHealth.liveness, "dead");
    assert.equal(compactPayload.dashboardHealth.stale, true);
    assert.equal(compactPayload.dashboardHealth.registryPath.includes("serve-registry.json"), true);
  });
});

test("state report does not call a fake same-process registry a live dashboard", async () => {
  await withTempDir("state-report-dashboard-fake-same-process", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "fake dashboard health",
      "--metric-name",
      "seconds",
    ]);
    await writeServeRegistry(dir, {
      pid: process.pid,
      port: 60242,
      cwd: dir,
      startedAt: "2026-06-02T00:00:00.000Z",
      version: PLUGIN_VERSION,
      healthUrl: "http://127.0.0.1:60242/health",
    });

    const report = await runCli(["state", "--cwd", dir, "--report"]);
    assert.equal(report.code, 0, report.stderr);
    const payload = JSON.parse(report.stdout);
    assert.notEqual(payload.report.json.dashboard.status, "alive");
    assert.doesNotMatch(payload.report.text, /Dashboard: alive/);
    assert.match(
      payload.report.json.dashboard.command ?? "",
      /scripts[\\/]autoresearch\.mjs serve/,
    );
    assert.doesNotMatch(payload.report.json.dashboard.command ?? "", /^curl /);
  });
});

test("static export does not call a same-process registry a live dashboard without HTTP health", async () => {
  await withTempDir("export-dashboard-fake-same-process", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "static fake dashboard health",
      "--metric-name",
      "seconds",
    ]);
    await writeServeRegistry(dir, {
      pid: process.pid,
      port: 60243,
      cwd: dir,
      startedAt: "2026-06-02T00:00:00.000Z",
      version: PLUGIN_VERSION,
      healthUrl: "http://127.0.0.1:60243/health",
    });

    const exported = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exported.code, 0, exported.stderr);
    const payload = JSON.parse(exported.stdout);
    const registry = payload.viewModel.processHygiene.dashboardServerRegistry;
    assert.notEqual(registry.liveness, "alive");
    assert.equal(registry.stale, true);
    assert.match(registry.message, /HTTP health/i);
  });
});

test("state health rejects an alive HTTP response for a different cwd", async () => {
  await withTempDir("state-dashboard-health-wrong-cwd", async (dir) => {
    const otherDir = path.join(dir, "other");
    await mkdir(otherDir, { recursive: true });
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "wrong cwd dashboard health",
      "--metric-name",
      "seconds",
    ]);
    const server = createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: true,
            dashboard: {
              pid: process.pid,
              port: addressPort(server),
              cwd: path.resolve(otherDir),
              version: PLUGIN_VERSION,
              liveness: "alive",
            },
          }),
        );
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await listenOnRandomPort(server);
    const port = addressPort(server);

    try {
      await writeServeRegistry(dir, {
        pid: process.pid,
        port,
        cwd: dir,
        startedAt: "2026-06-02T00:00:00.000Z",
        version: PLUGIN_VERSION,
        healthUrl: `http://127.0.0.1:${port}/health`,
      });

      const report = await runCli(["state", "--cwd", dir, "--report"]);
      assert.equal(report.code, 0, report.stderr);
      const payload = JSON.parse(report.stdout);
      assert.notEqual(payload.report.json.dashboard.status, "alive");
      assert.doesNotMatch(payload.report.text, /Dashboard: alive/);

      const compact = await runCli(["state", "--cwd", dir, "--compact"]);
      assert.equal(compact.code, 0, compact.stderr);
      const compactPayload = JSON.parse(compact.stdout);
      assert.notEqual(compactPayload.dashboardHealth.liveness, "alive");
      assert.equal(compactPayload.dashboardHealth.stale, true);
    } finally {
      await closeServer(server);
    }
  });
});

test("state health accepts an alive same-cwd current-version HTTP response", async () => {
  await withTempDir("state-dashboard-health-alive", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "alive dashboard health",
      "--metric-name",
      "seconds",
    ]);
    const server = createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: true,
            dashboard: {
              pid: process.pid,
              port: addressPort(server),
              cwd: path.resolve(dir),
              version: PLUGIN_VERSION,
              liveness: "alive",
            },
          }),
        );
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await listenOnRandomPort(server);
    const port = addressPort(server);

    try {
      await writeServeRegistry(dir, {
        pid: process.pid,
        port,
        cwd: dir,
        startedAt: "2026-06-02T00:00:00.000Z",
        version: PLUGIN_VERSION,
        healthUrl: `http://127.0.0.1:${port}/health`,
      });

      const compact = await runCli(["state", "--cwd", dir, "--compact"]);
      assert.equal(compact.code, 0, compact.stderr);
      const compactPayload = JSON.parse(compact.stdout);
      assert.equal(compactPayload.dashboardHealth.liveness, "alive");
      assert.equal(compactPayload.dashboardHealth.stale, false);

      const report = await runCli(["state", "--cwd", dir, "--report"]);
      assert.equal(report.code, 0, report.stderr);
      const payload = JSON.parse(report.stdout);
      assert.equal(payload.report.json.dashboard.status, "alive");
      assert.match(payload.report.text, /Dashboard: alive/);
    } finally {
      await closeServer(server);
    }
  });
});

test("legacy failed sentinel metrics do not suppress next-run baseline measure guidance", async () => {
  await withTempDir("legacy-sentinel-baseline", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "legacy sentinel", "--metric-name", "seconds"]);

    const legacyFailure = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "-999",
      "--status",
      "crash",
      "--description",
      "Legacy sentinel failure",
    ]);
    assert.equal(legacyFailure.code, 0, legacyFailure.stderr);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    assert.equal(JSON.parse(state.stdout).baseline, null);

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=5')"`;
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
    const payload = JSON.parse(next.stdout);
    assert.equal(payload.decision.rawSuggestedStatus, "measure");
    assert.equal(payload.decision.safeSuggestedStatus, "measure");
  });
});

test("metricless failed last-run packets log cleanly and preserve packet on invalid status", async () => {
  await withTempDir("metricless-last-run", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "metricless last run",
      "--metric-name",
      "seconds",
    ]);
    const command = `${quoteForShell(process.execPath)} -e "process.exit(1)"`;

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
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.decision.metric, null);
    assert.deepEqual(packet.decision.allowedStatuses, ["crash"]);

    const invalid = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Wrong failed status",
    ]);
    assert.notEqual(invalid.code, 0);
    assert.match(invalid.stderr, /Cannot log status 'keep'/);
    await access(path.join(dir, "autoresearch.last-run.json"));

    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "crash",
      "--description",
      "Log failed packet",
    ]);
    assert.equal(logged.code, 0, logged.stderr);
    const payload = JSON.parse(logged.stdout);
    assert.equal(payload.experiment.metric, null);
    assert.equal(payload.experiment.metricEligible, false);
    assert.equal(payload.experiment.promotion.label, "blocked");
    assert.match(payload.experiment.packetFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(payload.lastRunCleared, true);
    await assert.rejects(access(path.join(dir, "autoresearch.last-run.json")));
  });
});

test("keep, discard, and measure still require finite metrics", async () => {
  await withTempDir("metric-required", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "metric required", "--metric-name", "seconds"]);

    for (const status of ["keep", "discard", "measure"]) {
      const result = await runCli([
        "log",
        "--cwd",
        dir,
        "--status",
        status,
        "--description",
        `${status} without metric`,
      ]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /metric is required/);
    }
  });
});

test("state normalizes invalid metrics before experiment memory ranking", async () => {
  await withTempDir("state-invalid-metric-memory", async (dir) => {
    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "invalid metric memory",
          metricName: "seconds",
          bestDirection: "lower",
        }),
        JSON.stringify({
          run: 1,
          metric: false,
          status: "keep",
          description: "Invalid metric",
          asi: { family: "same" },
        }),
        JSON.stringify({
          run: 2,
          metric: "not-a-number",
          status: "discard",
          description: "Invalid string",
          asi: { family: "same" },
        }),
        JSON.stringify({
          run: 3,
          metric: 5,
          status: "keep",
          description: "Real metric",
          asi: { family: "same" },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    const family = payload.memory.families.find((item) => item.label === "same");

    assert.equal(payload.baseline, 5);
    assert.equal(payload.best, 5);
    assert.deepEqual(
      payload.memory.kept.map((item) => item.metric),
      [null, 5],
    );
    assert.equal(family.bestRun.run, 3);
    assert.equal(family.bestRun.metric, 5);
    assert.equal(family.bestKeptRun.run, 3);
    assert.equal(family.bestKeptRun.metric, 5);
  });
});

test("last-run packet does not dirty git worktrees before discard logging", async () => {
  await withTempDir("git-last-run", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "git last run", "--metric-name", "seconds"]);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);

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
    const packet = JSON.parse(next.stdout);
    assert.doesNotMatch(packet.lastRunPath, /autoresearch\.last-run\.json$/);

    const statusBeforeLog = await git(dir, ["status", "--short"]);
    assert.equal(statusBeforeLog, "");

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "discard",
      "--description",
      "Discard clean packet",
    ]);
    assert.equal(log.code, 0, log.stderr);
    const payload = JSON.parse(log.stdout);
    assert.equal(payload.experiment.metric, 3);
  });
});

test("no-change keep records no fake kept commit", async () => {
  await withTempDir("no-change-keep", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "no change keep", "--metric-name", "seconds"]);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1')"`;
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

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Keep evidence without file changes",
      "--commit-paths",
      "tracked.txt",
    ]);
    assert.equal(log.code, 0, log.stderr);
    const payload = JSON.parse(log.stdout);
    assert.equal(payload.experiment.commit, "");
    assert.match(payload.git, /nothing to commit/);
  });
});

test("config extend is based on the active segment run count", async () => {
  await withTempDir("segment-extend", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "first segment", "--metric-name", "seconds"]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "5",
      "--status",
      "keep",
      "--description",
      "Baseline",
    ]);
    await runCli(["init", "--cwd", dir, "--name", "second segment", "--metric-name", "seconds"]);

    const result = await runCli(["config", "--cwd", dir, "--extend", "4"]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.config.maxIterations, 4);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.limit.maxIterations, 4);
    assert.equal(statePayload.limit.remainingIterations, 4);
  });
});

test("dashboard script renders zero and negative metric points", async () => {
  await withTempDir("dashboard-runtime", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "runtime dashboard",
      "--metric-name",
      "delta",
      "--direction",
      "lower",
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "0",
      "--status",
      "keep",
      "--description",
      "Zero baseline",
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "-2",
      "--status",
      "keep",
      "--description",
      "Negative improvement",
    ]);

    const exportResult = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const dashboard = await readFile(path.join(dir, "autoresearch-dashboard.html"), "utf8");
    const dom = await renderExportedDashboard(dashboard);
    const chart = dom.window.document.getElementById("trend-chart").innerHTML;
    assert.match(chart, /#1 0 keep/);
    assert.match(chart, /#2 -2 keep/);
    dom.window.close();
  });
});

test("keep commits can be scoped to experiment paths", async () => {
  await withTempDir("scoped-commit", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "scoped commit", "--metric-name", "seconds"]);
    await writeFile(path.join(dir, "tracked.txt"), "after\n", "utf8");
    await writeFile(path.join(dir, "scratch.txt"), "do not commit\n", "utf8");

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Scope the keep commit",
      "--commit-paths",
      "tracked.txt",
    ]);
    assert.equal(result.code, 0, result.stderr);

    const committed = await git(dir, ["show", "--name-only", "--format=", "HEAD"]);
    assert.match(committed, /tracked\.txt/);
    assert.doesNotMatch(committed, /scratch\.txt/);

    const status = await git(dir, ["status", "--short"]);
    assert.match(status, /\?\? scratch\.txt/);
  });
});

test("keep logs require scoped commit paths or explicit add-all in git repos", async () => {
  await withTempDir("keep-add-all-gate", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "add all gate", "--metric-name", "seconds"]);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await writeFile(path.join(dir, "tracked.txt"), "after\n", "utf8");

    const blocked = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Blocked keep",
    ]);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /commitPaths is empty/);
    assert.match(await git(dir, ["status", "--short"]), /M tracked\.txt/);

    const allowed = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Allow broad keep",
      "--allow-add-all",
    ]);
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.match(JSON.parse(allowed.stdout).git, /explicit add-all/);
  });
});

test("keep logs preflight missing commit paths before git add mutates the index", async () => {
  await withTempDir("missing-commit-path-preflight", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "missing path", "--metric-name", "seconds"]);
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({ commitPaths: ["docs/testing/research-data-catalog.md"] }, null, 2),
      "utf8",
    );
    await git(dir, ["add", "autoresearch.jsonl", "autoresearch.config.json"]);
    await git(dir, ["commit", "-m", "session"]);
    await writeFile(path.join(dir, "tracked.txt"), "after\n", "utf8");

    const blocked = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Blocked missing path",
    ]);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /Configured commitPaths do not exist before git add/);
    assert.doesNotMatch(blocked.stderr, /pathspec/);
    assert.equal(await git(dir, ["diff", "--cached", "--name-only"]), "");
    assert.match(await git(dir, ["status", "--short"]), /M tracked\.txt/);
  });
});

test("keep logs reject Git pathspec magic in commit paths", async () => {
  await withTempDir("commit-path-pathspec-magic", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "a.txt"), "before\n", "utf8");
    await writeFile(path.join(dir, "b.txt"), "before\n", "utf8");
    await git(dir, ["add", "a.txt", "b.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "pathspec commit", "--metric-name", "seconds"]);
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({ commitPaths: [":(top)"] }, null, 2),
      "utf8",
    );
    await git(dir, ["add", "autoresearch.jsonl", "autoresearch.config.json"]);
    await git(dir, ["commit", "-m", "session"]);
    await writeFile(path.join(dir, "a.txt"), "after\n", "utf8");
    await writeFile(path.join(dir, "b.txt"), "after\n", "utf8");

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Blocked pathspec keep",
    ]);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /pathspec magic/);
    assert.equal(await git(dir, ["diff", "--cached", "--name-only"]), "");
    assert.match(await git(dir, ["status", "--short"]), /M a\.txt/);
    assert.match(await git(dir, ["status", "--short"]), /M b\.txt/);
  });
});

test("discard cleanup rejects Git pathspec magic in revert paths", async () => {
  await withTempDir("revert-path-pathspec-magic", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "a.txt"), "before\n", "utf8");
    await writeFile(path.join(dir, "b.txt"), "before\n", "utf8");
    await git(dir, ["add", "a.txt", "b.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "pathspec revert", "--metric-name", "seconds"]);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await writeFile(path.join(dir, "a.txt"), "after\n", "utf8");
    await writeFile(path.join(dir, "b.txt"), "after\n", "utf8");

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "discard",
      "--description",
      "Blocked pathspec discard",
      "--revert-paths",
      ":(top)",
    ]);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /pathspec magic/);
    assert.match(await git(dir, ["status", "--short"]), /M a\.txt/);
    assert.match(await git(dir, ["status", "--short"]), /M b\.txt/);
  });
});

test("keep logs allow tracked deletions in commit paths", async () => {
  await withTempDir("tracked-deletion-commit-path", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "delete tracked", "--metric-name", "seconds"]);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await rm(path.join(dir, "tracked.txt"));

    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Delete tracked file",
      "--commit-paths",
      "tracked.txt",
    ]);
    assert.equal(logged.code, 0, logged.stderr);
    const latestCommit = JSON.parse(logged.stdout).experiment.commit;
    assert.match(latestCommit, /^[0-9a-f]{7,12}$/);
    assert.match(
      await git(dir, ["show", "--name-status", "--format=", "HEAD"]),
      /D\s+tracked\.txt/,
    );
  });
});

test("keep logs report structured git index lock recovery", async () => {
  await withTempDir("git-index-lock", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "lock", "--metric-name", "seconds"]);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await writeFile(path.join(dir, "tracked.txt"), "after\n", "utf8");
    await writeFile(path.join(dir, ".git", "index.lock"), "stale lock\n", "utf8");

    const blocked = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Blocked lock",
      "--commit-paths",
      "tracked.txt",
    ]);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /Git index lock blocked git add/);
    assert.match(blocked.stderr, /Live git process check/);
    assert.match(blocked.stderr, /has not staged or committed anything/);
  });
});

test("logged packets do not leave .git autoresearch runtime dirs as stale artifacts", async () => {
  await withTempDir("git-runtime-dir-not-stale", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "runtime dir", "--metric-name", "seconds"]);
    await writeFile(
      path.join(dir, "packet.command"),
      "node -e \"console.log('METRIC seconds=1')\"\n",
      "utf8",
    );
    await git(dir, ["add", "autoresearch.jsonl", "packet.command"]);
    await git(dir, ["commit", "-m", "session"]);

    const packet = await runCli(["next", "--cwd", dir, "--command-file", "packet.command"]);
    assert.equal(packet.code, 0, packet.stderr);
    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Record clean packet",
      "--allow-add-all",
    ]);
    assert.equal(logged.code, 0, logged.stderr);
    await access(path.join(dir, ".git", "autoresearch"));

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const warningCodes = JSON.parse(state.stdout).warningDetails.map((warning) => warning.code);
    assert.ok(!warningCodes.includes("stale_benchmark_artifacts"));
  });
});

test("keep logs can record an existing commit without staging dirty work", async () => {
  await withTempDir("keep-existing-commit", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "existing commit", "--metric-name", "seconds"]);
    await writeFile(path.join(dir, "tracked.txt"), "after\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "manual experiment"]);
    const manualCommit = await git(dir, ["rev-parse", "HEAD"]);
    await writeFile(path.join(dir, "scratch.txt"), "leave dirty\n", "utf8");

    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Record existing commit",
      "--commit",
      manualCommit,
    ]);
    assert.equal(logged.code, 0, logged.stderr);
    const payload = JSON.parse(logged.stdout);
    assert.equal(payload.experiment.commit, manualCommit.slice(0, 12));
    assert.match(payload.git, /recorded existing commit/);
    assert.match(await git(dir, ["status", "--short"]), /\?\? autoresearch\.jsonl/);
    assert.match(await git(dir, ["status", "--short"]), /\?\? scratch\.txt/);
  });
});

test("doctor and dashboard stay quiet about empty commit paths until keep logging needs them", async () => {
  await withTempDir("empty-commit-path-warning", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "warning", "--metric-name", "seconds"]);
    const doctor = await runCli(["doctor", "--cwd", dir]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctorPayload = JSON.parse(doctor.stdout);
    assert.ok(
      !doctorPayload.warningDetails.some(
        (warning) => warning.code === "empty_commit_paths_in_git_repo",
      ),
    );

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.ok(
      !statePayload.warningDetails.some(
        (warning) => warning.code === "empty_commit_paths_in_git_repo",
      ),
    );

    const exported = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exported.code, 0, exported.stderr);
    const exportPayload = JSON.parse(exported.stdout);
    assert.ok(
      !exportPayload.viewModel.warnings.some(
        (warning) => warning.code === "empty_commit_paths_in_git_repo",
      ),
    );
  });
});

test("dashboard export decision envelope carries dirty source drift", async () => {
  await withTempDir("dashboard-dirty-envelope", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "dirty dashboard", "--metric-name", "seconds"]);
    await writeFile(path.join(dir, "tracked.txt"), "changed\n", "utf8");

    const exported = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exported.code, 0, exported.stderr);
    const payload = JSON.parse(exported.stdout);
    assert.equal(payload.viewModel.decisionEnvelope.dirtySourceDrift.dirty, true);
    assert.ok(
      payload.viewModel.decisionEnvelope.dirtySourceDrift.warnings.some(
        (warning) => warning.code === "git_dirty",
      ),
    );
  });
});

test("export treats missing keep commits as finalization backlog instead of trust warnings", async () => {
  await withTempDir("missing-keep-commit-preview", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "preview quiet", "--metric-name", "seconds"]);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await git(dir, ["branch", "-M", "main"]);
    await git(dir, ["checkout", "-b", "experiment"]);

    const sessionLog = [
      JSON.stringify({
        type: "config",
        name: "preview quiet",
        metricName: "seconds",
        metricUnit: "s",
        bestDirection: "lower",
      }),
      JSON.stringify({
        run: 1,
        metric: 10,
        status: "keep",
        description: "Keep baseline without commit metadata",
        timestamp: Date.now(),
        segment: 0,
        confidence: 1,
        asi: {
          evidence: "seconds=10",
          next_action_hint: "Confirm correctness before review packaging.",
        },
      }),
      "",
    ].join("\n");
    await writeFile(path.join(dir, "autoresearch.jsonl"), sessionLog, "utf8");
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "keep without commit metadata"]);

    const exported = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exported.code, 0, exported.stderr);
    const exportPayload = JSON.parse(exported.stdout);
    const trustReasons = exportPayload.viewModel.trustState.reasons.join("\n");
    assert.doesNotMatch(trustReasons, /has no commit/i);
    const previewPacket = exportPayload.viewModel.finalizationChecklist.find(
      (item) => item.label === "Preview packet",
    );
    assert.equal(previewPacket.state, "idle");
    assert.match(previewPacket.detail, /commit-backed keep logs/i);
  });
});

test("keep logs fail instead of recording success when git add fails", async () => {
  await withTempDir("keep-add-failure", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "git add failure", "--metric-name", "seconds"]);
    await writeFile(path.join(dir, "tracked.txt"), "after\n", "utf8");

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Should not be logged",
      "--commit-paths",
      "missing.txt",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Configured commitPaths do not exist before git add/);

    const log = await readFile(path.join(dir, "autoresearch.jsonl"), "utf8");
    assert.doesNotMatch(log, /Should not be logged/);
  });
});

test("keep logs fail instead of recording success when git commit fails", async () => {
  await withTempDir("keep-commit-failure", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);
    await mkdir(path.join(dir, ".git", "hooks"), { recursive: true });
    const hookPath = path.join(dir, ".git", "hooks", "pre-commit");
    await writeFile(hookPath, "#!/bin/sh\nexit 1\n", "utf8");
    await chmod(hookPath, 0o755);

    await runCli(["init", "--cwd", dir, "--name", "commit failure", "--metric-name", "seconds"]);
    await writeFile(path.join(dir, "tracked.txt"), "after\n", "utf8");

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Should not commit",
      "--commit-paths",
      "tracked.txt",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Git commit failed/);

    const log = await readFile(path.join(dir, "autoresearch.jsonl"), "utf8");
    assert.doesNotMatch(log, /Should not commit/);
  });
});

test("discard reverts scoped experiment paths without deleting unrelated dirty work", async () => {
  await withTempDir("safe-discard", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "value.txt"), "base\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "safe discard", "--metric-name", "seconds"]);
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({ commitPaths: ["src"] }, null, 2),
    );
    await git(dir, ["add", "autoresearch.jsonl", "autoresearch.config.json"]);
    await git(dir, ["commit", "-m", "session"]);

    await writeFile(path.join(dir, "src", "value.txt"), "experiment\n", "utf8");
    await writeFile(path.join(dir, "notes.txt"), "unrelated dirty work\n", "utf8");

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "2",
      "--status",
      "discard",
      "--description",
      "Discard scoped experiment",
    ]);
    assert.equal(result.code, 0, result.stderr);

    assert.equal(await readFile(path.join(dir, "src", "value.txt"), "utf8"), "base\n");
    assert.equal(await readFile(path.join(dir, "notes.txt"), "utf8"), "unrelated dirty work\n");
  });
});

test("discard without scoped paths refuses to clean a dirty git tree", async () => {
  await withTempDir("unsafe-discard", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "unsafe discard", "--metric-name", "seconds"]);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await writeFile(path.join(dir, "scratch.txt"), "unrelated\n", "utf8");

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "2",
      "--status",
      "discard",
      "--description",
      "Unsafe discard",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Refusing broad discard cleanup/);
    assert.equal(await readFile(path.join(dir, "scratch.txt"), "utf8"), "unrelated\n");
  });
});

test("clear removes deep research scratchpads", async () => {
  await withTempDir("clear-research", async (dir) => {
    await runCli([
      "research-setup",
      "--cwd",
      dir,
      "--slug",
      "cleanup",
      "--goal",
      "Cleanup research",
    ]);
    const researchRoot = path.join(dir, "autoresearch.research");
    await access(researchRoot);

    const result = await runCli(["clear", "--cwd", dir, "--yes"]);
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(access(researchRoot));
  });
});

test("clear dry-run previews deletion targets without removing files", async () => {
  await withTempDir("clear-dry-run", async (dir) => {
    await runCli([
      "research-setup",
      "--cwd",
      dir,
      "--slug",
      "preview",
      "--goal",
      "Preview cleanup",
    ]);
    const researchRoot = path.join(dir, "autoresearch.research");
    await access(researchRoot);

    const result = await runCli(["clear", "--cwd", dir, "--dry-run"]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.deleted.length, 0);
    assert.ok(payload.targets.includes(researchRoot));
    assert.ok(payload.wouldDelete.includes(researchRoot));
    await access(researchRoot);
  });
});

test("clear removes active progress snapshots in fallback and Git-private modes", async () => {
  await withTempDir("clear-progress-snapshots", async (dir) => {
    const fallbackProgress = path.join(dir, "autoresearch.progress.json");
    const fallbackLastRun = path.join(dir, "autoresearch.last-run.json");
    const fallbackPending = path.join(dir, "autoresearch.pending-transaction.json");
    await writeFile(fallbackProgress, JSON.stringify({ exitState: "running" }), "utf8");
    await writeFile(fallbackLastRun, JSON.stringify({ run: 1 }), "utf8");
    await writeFile(fallbackPending, JSON.stringify({ run: 1 }), "utf8");

    const fallbackPreview = await runCli(["clear", "--cwd", dir, "--dry-run"]);
    assert.equal(fallbackPreview.code, 0, fallbackPreview.stderr);
    const fallbackPayload = JSON.parse(fallbackPreview.stdout);
    assert.ok(fallbackPayload.wouldDelete.includes(fallbackProgress));
    assert.ok(fallbackPayload.wouldDelete.includes(fallbackLastRun));
    assert.ok(fallbackPayload.wouldDelete.includes(fallbackPending));
    await access(fallbackProgress);

    const fallbackClear = await runCli(["clear", "--cwd", dir, "--yes"]);
    assert.equal(fallbackClear.code, 0, fallbackClear.stderr);
    await assert.rejects(access(fallbackProgress));
    await assert.rejects(access(fallbackLastRun));
    await assert.rejects(access(fallbackPending));
  });

  await withTempDir("clear-git-progress-snapshots", async (dir) => {
    await git(dir, ["init", "-b", "main"]);
    const gitPrivateDir = path.join(dir, ".git", "autoresearch");
    const gitProgress = path.join(gitPrivateDir, "progress.json");
    const gitLastRun = path.join(gitPrivateDir, "last-run.json");
    const fallbackProgress = path.join(dir, "autoresearch.progress.json");
    await mkdir(gitPrivateDir, { recursive: true });
    await writeFile(gitProgress, JSON.stringify({ exitState: "running" }), "utf8");
    await writeFile(gitLastRun, JSON.stringify({ run: 1 }), "utf8");
    await writeFile(fallbackProgress, JSON.stringify({ exitState: "running" }), "utf8");

    const gitPreview = await runCli(["clear", "--cwd", dir, "--dry-run"]);
    assert.equal(gitPreview.code, 0, gitPreview.stderr);
    const gitPayload = JSON.parse(gitPreview.stdout);
    assert.ok(gitPayload.wouldDelete.includes(gitProgress));
    assert.ok(gitPayload.wouldDelete.includes(gitLastRun));
    assert.ok(gitPayload.wouldDelete.includes(fallbackProgress));
    await access(gitProgress);

    const gitClear = await runCli(["clear", "--cwd", dir, "--yes"]);
    assert.equal(gitClear.code, 0, gitClear.stderr);
    await assert.rejects(access(gitProgress));
    await assert.rejects(access(gitLastRun));
    await assert.rejects(access(fallbackProgress));
  });
});

test("setup-plan preserves explicit command, state inputs, and baseline measure guidance", async () => {
  await withTempDir("setup-plan-inputs", async (dir) => {
    const benchmark = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1')"`;
    const checks = `${quoteForShell(process.execPath)} -e "process.exit(0)"`;
    const result = await runCli([
      "setup-plan",
      "--cwd",
      dir,
      "--name",
      "explicit setup",
      "--metric-name",
      "seconds",
      "--benchmark-command",
      benchmark,
      "--checks-command",
      checks,
      "--commit-paths",
      "src,tests",
      "--max-iterations",
      "7",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.match(payload.nextCommand, /--benchmark-command/);
    assert.match(payload.nextCommand, /METRIC seconds=1/);
    assert.match(payload.nextCommand, /--checks-command/);
    assert.match(payload.nextCommand, /process\.exit\(0\)/);
    assert.match(payload.nextCommand, /--commit-paths ['"]?src,tests['"]?/);
    assert.match(payload.nextCommand, /--max-iterations ['"]?7['"]?/);
    assert.equal(payload.benchmarkMode.printsMetric, true);
    assert.match(payload.benchmarkLintCommand, /benchmark-lint/);
    assert.equal(payload.missingEssentials.length, 0);
    assert.equal(payload.nextStep.stage, "setup-repair");
    assert.equal(payload.nextStep.nextAction.title, "Create session setup");
    assert.equal(payload.nextStep.nextAction.safety, "state_mutation");
    assert.match(payload.nextStep.nextAction.command, / setup /);
    assert.equal(payload.nextStep.nextAction.toolName, "setup_session");
    assert.deepEqual(
      payload.firstRunChecklist.map((step) => step.step),
      ["setup", "benchmark-lint", "doctor", "checkpoint", "baseline", "log"],
    );
    const logStep = payload.firstRunChecklist.find((step) => step.step === "log");
    assert.match(logStep.command, /--status measure --description ['"]Baseline measurement['"]/);

    await runCli(["init", "--cwd", dir, "--name", "guide setup", "--metric-name", "seconds"]);
    const guide = await runCli(["guide", "--cwd", dir, "--benchmark-command", benchmark]);
    assert.equal(guide.code, 0, guide.stderr);
    const guidePayload = JSON.parse(guide.stdout);
    assert.equal(guidePayload.nextStep.stage, "baseline-packet");
    assert.equal(guidePayload.nextStep.nextAction.title, "Run baseline packet");
    assert.equal(guidePayload.nextStep.nextAction.safety, "process_start");
    assert.match(guidePayload.nextStep.nextAction.command, / next /);
  });
});

test("setup-plan on configured session recommends doctor instead of setup repair", async () => {
  await withTempDir("setup-plan-configured-session", async (dir) => {
    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      `${JSON.stringify({
        type: "config",
        name: "demo",
        metricName: "seconds",
        bestDirection: "lower",
      })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({ maxIterations: 5 }),
      "utf8",
    );
    await writeFile(
      path.join(dir, "autoresearch.ps1"),
      "Write-Output 'METRIC seconds=1'\n",
      "utf8",
    );

    const result = await runCli([
      "setup-plan",
      "--cwd",
      dir,
      "--name",
      "demo",
      "--metric-name",
      "seconds",
      "--benchmark-command",
      "powershell -NoProfile -ExecutionPolicy Bypass -File ./autoresearch.ps1",
    ]);

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.configured, true);
    assert.deepEqual(payload.missingEssentials, []);
    assert.match(payload.nextCommand, /doctor|state/);
    assert.doesNotMatch(payload.nextCommand, /\ssetup\s/);
    assert.equal(payload.nextStep.stage, "configured-session");
    assert.match(payload.nextStep.nextAction.command, /doctor|state/);
    assert.doesNotMatch(payload.nextStep.nextAction.command, /\ssetup\s/);
  });
});

test("setup-plan renders benchmark command arguments for the requested shell", async () => {
  await withTempDir("setup-plan-shell-quoting", async (dir) => {
    const benchmark =
      "node -e \"console.log('METRIC seconds=1 $HOME $(whoami) `whoami` C:\\bench path')\"";

    const powershellResult = await runCli([
      "setup-plan",
      "--cwd",
      dir,
      "--name",
      "shell quoting",
      "--metric-name",
      "seconds",
      "--shell",
      "powershell",
      "--benchmark-command",
      benchmark,
    ]);
    assert.equal(powershellResult.code, 0, powershellResult.stderr);
    const powershellPayload = JSON.parse(powershellResult.stdout);
    assert.match(
      powershellPayload.nextCommand,
      /^& \{ \$PSNativeCommandArgumentPassing = 'Legacy'; /,
    );
    assert.match(
      powershellPayload.nextCommand,
      /--benchmark-command 'node -e \\"console\.log\(''METRIC seconds=1 \$HOME \$\(whoami\) `whoami` C:\\bench path''\)\\"/,
    );
    assert.doesNotMatch(powershellPayload.nextCommand, /--benchmark-command "/);
    assert.match(
      powershellPayload.benchmarkLintCommand,
      /--command 'node -e \\"console\.log\(''METRIC seconds=1 \$HOME \$\(whoami\) `whoami` C:\\bench path''\)\\"/,
    );

    const bashResult = await runCli([
      "setup-plan",
      "--cwd",
      dir,
      "--name",
      "shell quoting",
      "--metric-name",
      "seconds",
      "--shell",
      "bash",
      "--benchmark-command",
      benchmark,
    ]);
    assert.equal(bashResult.code, 0, bashResult.stderr);
    const bashPayload = JSON.parse(bashResult.stdout);
    assert.match(bashPayload.nextCommand, /--benchmark-command 'node -e "console\.log\('/);
    assert.match(
      bashPayload.nextCommand,
      /'"'"'METRIC seconds=1 \$HOME \$\(whoami\) `whoami` C:\\bench path'"'"'/,
    );
    assert.doesNotMatch(bashPayload.nextCommand, /--benchmark-command "/);
  });
});

test("setup-plan treats recommended recipe benchmark as configured", async () => {
  await withTempDir("setup-plan-recipe-defaults", async (dir) => {
    await writeFile(
      path.join(dir, "package.json"),
      '{"scripts":{"test":"node -e \\"process.exit(0)\\""}}\n',
      "utf8",
    );

    const result = await runCli(["setup-plan", "--cwd", dir]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.recommendedRecipe.id, "node-test-runtime");
    assert.deepEqual(payload.missing, []);
    assert.deepEqual(payload.missingEssentials, []);
    assert.doesNotMatch(payload.nextStep.nextAction.reason, /benchmark_command/);
    assert.match(
      payload.nextCommand,
      /--recipe (?:'node-test-runtime'|"node-test-runtime"|node-test-runtime)\b/,
    );
  });
});

test("setup-plan warns when files in scope and commit paths diverge", async () => {
  await withTempDir("setup-plan-scope-warning", async (dir) => {
    const result = await runCli([
      "setup-plan",
      "--cwd",
      dir,
      "--name",
      "scope warning",
      "--metric-name",
      "seconds",
      "--benchmark-command",
      `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1')"`,
      "--files-in-scope",
      "src",
      "--commit-paths",
      "src,tests",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.match(payload.scopeWarnings.join("\n"), /tests/);
    assert.match(payload.notes.join("\n"), /Scope warning/);
  });
});

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
    await runCli(["init", "--cwd", dir, "--name", "lf", "--metric-name", "seconds"]);
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
    await runCli(["init", "--cwd", dir, "--name", "inspect", "--metric-name", "score"]);
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
    await runCli(["init", "--cwd", dir, "--name", "gate", "--metric-name", "score"]);
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

    await runCli(["init", "--cwd", dir, "--name", "config limit", "--metric-name", "seconds"]);
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
    await runCli(["init", "--cwd", dir, "--name", "config clears", "--metric-name", "seconds"]);

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
    assert.match(missingPacketBudget.stderr, /Expected a number, got true/);

    const missingWallClockBudget = await runCli([
      "config",
      "--cwd",
      dir,
      "--wall-clock-budget-seconds",
    ]);
    assert.notEqual(missingWallClockBudget.code, 0);
    assert.match(missingWallClockBudget.stderr, /Expected a number, got true/);

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
    await runCli(["init", "--cwd", dir, "--name", "asi file", "--metric-name", "seconds"]);
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
    await runCli(["init", "--cwd", dir, "--name", "asi json file", "--metric-name", "seconds"]);
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
    const init = await runCli([
      "init",
      `--cwd=${dir}`,
      "--name=equals options",
      "--metric-name=seconds",
    ]);
    assert.equal(init.code, 0, init.stderr);
    const state = await runCli(["state", `--cwd=${dir}`]);
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
    import("../lib/tool-schemas.js"),
    import("../lib/tool-contracts.js"),
    import("../lib/tool-registry.js"),
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
  assert.ok(configureSession);
  assert.ok(ledgerDoctor);
  assert.ok(startResearch);
  assert.match(guided.description, /first-run or resume action packet/);
  assert.equal(guided.outputSchema.type, "object");
  assert.equal(next.outputSchema.type, "object");
  assert.match(next.description, /normal measured loop iteration/);
  assert.match(serve.description, /live local dashboard/);
  assert.equal(
    doctor.annotations.safety,
    "Read-only unless benchmark check runs configured commands.",
  );
  assert.equal(
    guided.annotations.safety,
    "Read-only by default; starts a local dashboard only when start_dashboard=true.",
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
  assert.equal(guided.outputSchema.properties.commands.type, "array");
  assert.equal(guided.outputSchema.properties.commands.items.type, "string");
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
  assert.equal(richDoctor.outputSchema.properties.loopContract.type, "object");
  assert.equal(richDoctor.outputSchema.properties.canonicalNextAction.type, "object");
  assert.equal(richDoctor.outputSchema.properties.runtimeProvenance.type, "object");
  assert.equal(richDoctor.outputSchema.properties.decisionEnvelope.type, "object");
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
    "Read-only unless benchmark check runs configured commands.",
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

test("CLI and tool argument normalization share runtime contracts", async () => {
  const {
    normalizeCliCommandArguments,
    normalizeRuntimeToolArguments,
    normalizeToolArguments,
    requireUnsafeCommandGate,
    validateToolArguments,
  } = await import("../lib/tool-schemas.js");

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
  });
  assert.deepEqual(doctorArgs, {
    working_dir: "C:/repo",
    allow_fixed_control_rerun: true,
  });
  assert.deepEqual(normalizeRuntimeToolArguments("doctor_session", doctorArgs), {
    cwd: "C:/repo",
    allowFixedControlRerun: true,
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
    await runCli(["init", "--cwd", dir, "--name", "log contract", "--metric-name", "seconds"]);
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

test("metric names must match the METRIC parser grammar", async () => {
  await withTempDir("bad-metric-name", async (dir) => {
    const result = await runCli([
      "init",
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

test("export refuses to write outside the working directory", async () => {
  await withTempDir("contained-export", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "contained export", "--metric-name", "seconds"]);
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

    const result = await runCli(["export", "--cwd", dir, "--output", "../escape.html"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /outside the working directory/);
  });
});

test("export refuses to write through linked directories outside the working directory", async (t) => {
  await withTempDir("linked-contained-export", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "linked export", "--metric-name", "seconds"]);
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
    const outsideDir = path.join(path.dirname(dir), `${path.basename(dir)}-outside`);
    await mkdir(outsideDir, { recursive: true });
    try {
      const linkPath = path.join(dir, "linked-output");
      try {
        await symlink(outsideDir, linkPath, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        t.skip(
          `directory symlink creation unavailable: ${error instanceof Error ? error.message : error}`,
        );
        return;
      }

      const result = await runCli([
        "export",
        "--cwd",
        dir,
        "--output",
        "linked-output/escape.html",
      ]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /outside the working directory/);
      await assert.rejects(readFile(path.join(outsideDir, "escape.html"), "utf8"));
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

test("export is compact by default and full with json-full", async () => {
  await withTempDir("compact-export", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "compact export", "--metric-name", "seconds"]);
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

    const compact = await runCli(["export", "--cwd", dir]);
    assert.equal(compact.code, 0, compact.stderr);
    const compactPayload = JSON.parse(compact.stdout);
    assert.equal(compactPayload.ok, true);
    assert.equal(compactPayload.summary.runs, 1);
    assert.equal(compactPayload.best, 1);
    assert.equal(compactPayload.viewModel, undefined);
    assert.equal(compactPayload.progress.stages[0].stage, "export");

    const full = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(full.code, 0, full.stderr);
    const fullPayload = JSON.parse(full.stdout);
    assert.equal(fullPayload.viewModel.summary.runs, 1);
  });
});

test("export progress writes stderr heartbeats without corrupting JSON stdout", async () => {
  await withTempDir("export-progress-json", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "export progress", "--metric-name", "seconds"]);

    const result = await runSpawnedCli(["export", "--cwd", dir, "--json-full", "--progress"]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.match(result.stderr, /\[autoresearch:export]/);
  });
});

test("large benchmark output is capped and marked truncated", async () => {
  await withTempDir("large-output", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "large output", "--metric-name", "seconds"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('x'.repeat(30000)); console.log('METRIC seconds=1')"`;
    const result = await runCli(["run", "--cwd", dir, "--command", command]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.outputTruncated, true);
    assert.ok(payload.tailOutput.length < 9000);
    assert.equal(payload.parsedPrimary, 1);
  });
});

test("large no-newline benchmark tails do not hide early metrics", async () => {
  await withTempDir("large-no-newline-output", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "large no newline", "--metric-name", "seconds"]);
    const command = `${quoteForShell(process.execPath)} -e "process.stdout.write('METRIC seconds=2\\n'); process.stdout.write('x'.repeat(300000))"`;
    const result = await runCli(["run", "--cwd", dir, "--command", command]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.outputTruncated, true);
    assert.ok(payload.tailOutput.length < 9000);
    assert.equal(payload.parsedPrimary, 2);
  });
});

test("large metric streams retain bounded metrics and primary evidence", async () => {
  await withTempDir("large-metric-stream", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "large metric stream",
      "--metric-name",
      "seconds",
    ]);
    const command = `${quoteForShell(process.execPath)} -e "for (let i = 0; i < 20000; i++) console.log('METRIC m' + i + '=' + i); console.log('METRIC seconds=1')"`;
    const result = await runCli(["run", "--cwd", dir, "--command", command]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.metricsTruncated, true);
    assert.equal(payload.parsedPrimary, 1);
    assert.equal(payload.parsedMetrics.seconds, 1);
    assert.ok(Object.keys(payload.parsedMetrics).length <= 513);
  });
});

test("large metric streams keep a primary metric outside retained output tails", async () => {
  await withTempDir("large-metric-primary-middle", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "large primary stream",
      "--metric-name",
      "seconds",
    ]);
    const emitter = path.join(dir, "emit-metrics.mjs");
    await writeFile(
      emitter,
      [
        "function writeMetrics(prefix, count) {",
        "  let chunk = '';",
        "  for (let i = 0; i < count; i += 1) {",
        "    chunk += `METRIC ${prefix}${i}=${i}\\n`;",
        "    if (chunk.length > 65536) { process.stdout.write(chunk); chunk = ''; }",
        "  }",
        "  if (chunk) process.stdout.write(chunk);",
        "}",
        "writeMetrics('pre', 12000);",
        "process.stdout.write('METRIC seconds=7\\n');",
        "writeMetrics('post', 90000);",
      ].join("\n"),
      "utf8",
    );
    const command = `${quoteForShell(process.execPath)} ${quoteForShell(emitter)}`;
    const result = await runCli(["run", "--cwd", dir, "--command", command]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.metricsTruncated, true);
    assert.equal(payload.parsedPrimary, 7);
    assert.equal(payload.parsedMetrics.seconds, 7);
    assert.ok(Object.keys(payload.parsedMetrics).length <= 513);
  });
});

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
    assert.doesNotMatch(String(payload.viewModel.nextBestAction.command || ""), /\bnext\b/);
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
        assert.doesNotMatch(payload.canonicalNextAction.command || "", /\bnext\b/, status);
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

    assert.equal(payload.action.kind, "preflight");
    assert.match(payload.nextAction, /benchmark command/i);
    assert.match(payload.operatorChecklist.blocker, /benchmark command/i);
    assert.match(command, /autoresearch\.mjs\b.*\b(setup-plan|state)\b/);
    assert.match(command, /--cwd\b/);
    assert.doesNotMatch(command, /\bdoctor\b.*--explain\b/);
    assert.doesNotMatch(payload.commands.primary || "", /\bdoctor\b.*--explain\b/);
  });
});

test("state and recommend-next expose advisory portfolio guidance", async () => {
  await withTempDir("portfolio-guidance", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "portfolio", "--metric-name", "seconds"]);

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.portfolioRecommendation.kind, "trust-blocker");
    assert.equal(typeof statePayload.portfolioRecommendation.nextActionHint, "string");

    const recommend = await runCli(["recommend-next", "--cwd", dir, "--compact"]);
    assert.equal(recommend.code, 0, recommend.stderr);
    const recommendPayload = JSON.parse(recommend.stdout);
    assert.equal(recommendPayload.portfolioRecommendation.kind, "trust-blocker");
    assert.deepEqual(
      recommendPayload.portfolioRecommendation,
      statePayload.portfolioRecommendation,
    );
  });
});

test("drift report treats installed routing as removed", async () => {
  const { buildDriftReport } = await import("../lib/drift-doctor.js");
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

test("runShell configures a POSIX process group for timeout cleanup", async () => {
  const [cliShim, bootstrap, releaseIntegrity, runner] = await Promise.all([
    readFile(cli, "utf8"),
    readFile(path.join(pluginRoot, "scripts", "bootstrap-runtime.mjs"), "utf8"),
    readFile(path.join(pluginRoot, "scripts", "release-integrity.mjs"), "utf8"),
    readFile(path.join(pluginRoot, "lib", "runner.ts"), "utf8"),
  ]);
  assert.match(
    cliShim,
    /import \{ ensureRuntime, isDirectScript \} from "\.\/bootstrap-runtime\.mjs"/,
  );
  assert.match(cliShim, /isDirectScript\(import\.meta\.url\)/);
  assert.match(
    cliShim,
    /await import\(await ensureRuntime\("autoresearch\.mjs", import\.meta\.url\)\)/,
  );
  const checkShim = await readFile(path.join(pluginRoot, "scripts", "check.mjs"), "utf8");
  assert.match(checkShim, /import \{ ensureRuntime \} from "\.\/bootstrap-runtime\.mjs"/);
  assert.match(checkShim, /await import\(await ensureRuntime\("check\.mjs", import\.meta\.url\)\)/);
  assert.match(bootstrap, /path\.join\(pluginRoot, "dist", "scripts", entrypoint\)/);
  assert.match(bootstrap, /verifyRuntimeTarballIntegrity/);
  assert.match(bootstrap, /\.tgz\.sha256/);
  assert.match(releaseIntegrity, /Checksum manifest expected asset/);
  assert.match(bootstrap, /Release tarball package version mismatch/);
  assert.match(bootstrap, /node scripts\/autoresearch\.mjs --help/);
  assert.match(runner, /detached:\s*process\.platform !== "win32"/);
});

test("source launcher direct-script detection survives normalized paths", async () => {
  await withTempDir("launcher-direct", async (dir) => {
    const script = path.join(dir, "autoresearch.mjs");
    const other = path.join(dir, "other.mjs");
    await writeFile(script, "");
    await writeFile(other, "");

    const bootstrap = await import(
      pathToFileURL(path.join(pluginRoot, "scripts", "bootstrap-runtime.mjs")).href
    );
    assert.equal(typeof bootstrap.isDirectScript, "function");
    assert.equal(bootstrap.isDirectScript(pathToFileURL(script).href, script), true);
    assert.equal(bootstrap.isDirectScript(pathToFileURL(script).href, other), false);

    const link = path.join(dir, "autoresearch-link.mjs");
    try {
      await symlink(script, link);
      assert.equal(bootstrap.isDirectScript(pathToFileURL(script).href, link), true);
    } catch (error) {
      if (process.platform !== "win32") throw error;
    }
  });
});

test("source launcher rebuilds local source runtime before use", async () => {
  await withTempDir("runtime-stale-source-build", async (dir) => {
    const { pluginDir, importerUrl } = await writeFakeSourcePlugin(dir);
    await writeFile(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        {
          name: "codex-autoresearch",
          version: PLUGIN_VERSION,
          scripts: {
            build: "node scripts/write-runtime.mjs --dashboard",
            "build:node": "node scripts/write-runtime.mjs",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await mkdir(path.join(pluginDir, "node_modules"), { recursive: true });
    await mkdir(path.join(pluginDir, "dist", "scripts"), { recursive: true });
    const target = path.join(pluginDir, "dist", "scripts", "autoresearch.mjs");
    await writeFile(target, "export const staleRuntime = true;\n", "utf8");
    await writeFile(path.join(pluginDir, "tsdown.config.ts"), "export default {};\n", "utf8");
    await writeFile(path.join(pluginDir, "scripts", "autoresearch.ts"), "export {};\n", "utf8");
    await writeFile(
      path.join(pluginDir, "scripts", "write-runtime.mjs"),
      [
        'import { mkdir, writeFile } from "node:fs/promises";',
        'import path from "node:path";',
        'import { fileURLToPath } from "node:url";',
        'const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");',
        'const includeDashboard = process.argv.includes("--dashboard");',
        'await mkdir(path.join(root, "dist", "scripts"), { recursive: true });',
        'await writeFile(path.join(root, "dist", "scripts", "autoresearch.mjs"), "export const rebuiltRuntime = true;\\n", "utf8");',
        "if (includeDashboard) {",
        '  await mkdir(path.join(root, "assets", "dashboard-build"), { recursive: true });',
        '  await writeFile(path.join(root, "assets", "dashboard-build", "dashboard-app.js"), "window.__rebuiltDashboard = true;\\n", "utf8");',
        '  await writeFile(path.join(root, "assets", "dashboard-build", "dashboard-app.css"), "#dashboard-root { color: rgb(1, 2, 3); }\\n", "utf8");',
        "}",
      ].join("\n"),
      "utf8",
    );

    const bootstrap = await import(
      pathToFileURL(path.join(pluginRoot, "scripts", "bootstrap-runtime.mjs")).href
    );
    const runtimeHref = await bootstrap.ensureRuntime("autoresearch.mjs", importerUrl, {
      releaseBaseUrl: "http://127.0.0.1:1",
    });

    assert.equal(
      await readFile(new URL(runtimeHref), "utf8"),
      "export const rebuiltRuntime = true;\n",
    );
    assert.match(
      await readFile(path.join(pluginDir, "assets", "dashboard-build", "dashboard-app.js"), "utf8"),
      /rebuiltDashboard/,
    );
  });
});

test("source launcher hydrates runtime only after release checksum verification", async () => {
  await withTempDir("runtime-hydration-integrity", async (dir) => {
    const { pluginDir, importerUrl } = await writeFakeSourcePlugin(dir);
    const release = await createRuntimeReleaseAsset(dir);
    const bootstrap = await import(
      pathToFileURL(path.join(pluginRoot, "scripts", "bootstrap-runtime.mjs")).href
    );

    await withReleaseServer(release.releaseDir, PLUGIN_VERSION, async (releaseBaseUrl) => {
      const runtimeHref = await bootstrap.ensureRuntime("autoresearch.mjs", importerUrl, {
        releaseBaseUrl,
      });
      const runtimeText = await readFile(new URL(runtimeHref), "utf8");
      assert.equal(runtimeText, "export const hydratedRuntime = true;\n");

      const runtime = await import(`${runtimeHref}?integrity=${Date.now()}`);
      assert.equal(runtime.hydratedRuntime, true);
      await access(path.join(pluginDir, "dist", "scripts", "autoresearch.mjs"));
    });
  });
});

test("source launcher hydrates packaged dashboard assets before source-shaped export", async () => {
  await withTempDir("runtime-hydration-dashboard-export", async (dir) => {
    const { pluginDir, importerUrl } = await writeFakeSourcePlugin(dir);
    await mkdir(path.join(pluginDir, "assets"), { recursive: true });
    await writeFile(
      path.join(pluginDir, "assets", "template.html"),
      [
        "<!doctype html>",
        '<div id="dashboard-root"></div>',
        "<style>__AUTORESEARCH_DASHBOARD_CSS__</style>",
        "<script>__AUTORESEARCH_DASHBOARD_APP__</script>",
        '<script type="application/json">__AUTORESEARCH_DATA_PAYLOAD__</script>',
        '<script type="application/json">__AUTORESEARCH_META_PAYLOAD__</script>',
      ].join("\n"),
      "utf8",
    );
    await assert.rejects(
      access(path.join(pluginDir, "assets", "dashboard-build", "dashboard-app.js")),
    );

    const runtimeText = [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'import { fileURLToPath } from "node:url";',
      "export const hydratedRuntime = true;",
      "export function exportDashboardHtml(workDir) {",
      '  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");',
      '  const template = fs.readFileSync(path.join(pluginRoot, "assets", "template.html"), "utf8");',
      '  const app = fs.readFileSync(path.join(pluginRoot, "assets", "dashboard-build", "dashboard-app.js"), "utf8");',
      '  const css = fs.readFileSync(path.join(pluginRoot, "assets", "dashboard-build", "dashboard-app.css"), "utf8");',
      "  const html = template",
      '    .replace("__AUTORESEARCH_DASHBOARD_CSS__", css)',
      '    .replace("__AUTORESEARCH_DASHBOARD_APP__", app)',
      '    .replace("__AUTORESEARCH_DATA_PAYLOAD__", JSON.stringify([{ name: "package dashboard smoke" }]))',
      '    .replace("__AUTORESEARCH_META_PAYLOAD__", JSON.stringify({ deliveryMode: "static-export" }));',
      '  const outputPath = path.join(workDir, "autoresearch-dashboard.html");',
      '  fs.writeFileSync(outputPath, html, "utf8");',
      "  return outputPath;",
      "}",
    ].join("\n");
    const release = await createRuntimeReleaseAsset(dir, {
      dashboardAppText: 'window.__hydratedDashboardAsset = "release-dashboard-app";\n',
      dashboardCssText: "#dashboard-root { color: rgb(12, 34, 56); }\n",
      runtimeText: `${runtimeText}\n`,
    });
    const bootstrap = await import(
      pathToFileURL(path.join(pluginRoot, "scripts", "bootstrap-runtime.mjs")).href
    );

    await withReleaseServer(release.releaseDir, PLUGIN_VERSION, async (releaseBaseUrl) => {
      const runtimeHref = await bootstrap.ensureRuntime("autoresearch.mjs", importerUrl, {
        releaseBaseUrl,
      });
      await access(path.join(pluginDir, "assets", "dashboard-build", "dashboard-app.js"));
      await access(path.join(pluginDir, "assets", "dashboard-build", "dashboard-app.css"));

      const runtime = await import(`${runtimeHref}?dashboard=${Date.now()}`);
      const outputPath = runtime.exportDashboardHtml(dir);
      const dashboardHtml = await readFile(outputPath, "utf8");
      assert.match(dashboardHtml, /release-dashboard-app/);
      assert.match(dashboardHtml, /rgb\(12, 34, 56\)/);
      assert.match(dashboardHtml, /package dashboard smoke/);
    });
  });
});

test("source launcher does not treat source-shaped runtime as ready without dashboard assets", async () => {
  await withTempDir("runtime-hydration-existing-runtime-missing-dashboard", async (dir) => {
    const { pluginDir, importerUrl } = await writeFakeSourcePlugin(dir);
    await mkdir(path.join(pluginDir, "dist", "scripts"), { recursive: true });
    await writeFile(
      path.join(pluginDir, "dist", "scripts", "autoresearch.mjs"),
      "export const sourceRuntimeWithoutDashboardAssets = true;\n",
      "utf8",
    );
    await writeFile(path.join(pluginDir, "tsdown.config.ts"), "export default {};\n", "utf8");
    await writeFile(path.join(pluginDir, "scripts", "autoresearch.ts"), "export {};\n", "utf8");
    await assert.rejects(
      access(path.join(pluginDir, "assets", "dashboard-build", "dashboard-app.js")),
    );

    const release = await createRuntimeReleaseAsset(dir, {
      dashboardAppText: 'window.__hydratedDashboardAsset = "existing-runtime-missing-assets";\n',
      dashboardCssText: "#dashboard-root { color: rgb(98, 76, 54); }\n",
      runtimeText: "export const hydratedRuntime = true;\n",
    });
    const bootstrap = await import(
      pathToFileURL(path.join(pluginRoot, "scripts", "bootstrap-runtime.mjs")).href
    );

    await withReleaseServer(release.releaseDir, PLUGIN_VERSION, async (releaseBaseUrl) => {
      const runtimeHref = await bootstrap.ensureRuntime("autoresearch.mjs", importerUrl, {
        releaseBaseUrl,
      });

      assert.equal(
        await readFile(new URL(runtimeHref), "utf8"),
        "export const hydratedRuntime = true;\n",
      );
      assert.match(
        await readFile(
          path.join(pluginDir, "assets", "dashboard-build", "dashboard-app.js"),
          "utf8",
        ),
        /existing-runtime-missing-assets/,
      );
      assert.match(
        await readFile(
          path.join(pluginDir, "assets", "dashboard-build", "dashboard-app.css"),
          "utf8",
        ),
        /rgb\(98, 76, 54\)/,
      );
    });
  });
});

test("source launcher fails closed when release checksum metadata is missing", async () => {
  await withTempDir("runtime-hydration-missing-checksum", async (dir) => {
    const { pluginDir, importerUrl } = await writeFakeSourcePlugin(dir);
    const release = await createRuntimeReleaseAsset(dir, { writeChecksum: false });
    const bootstrap = await import(
      pathToFileURL(path.join(pluginRoot, "scripts", "bootstrap-runtime.mjs")).href
    );

    await withReleaseServer(release.releaseDir, PLUGIN_VERSION, async (releaseBaseUrl) => {
      await assert.rejects(
        () => bootstrap.ensureRuntime("autoresearch.mjs", importerUrl, { releaseBaseUrl }),
        /\.tgz\.sha256: HTTP 404/,
      );
    });
    await assert.rejects(access(path.join(pluginDir, "dist", "scripts", "autoresearch.mjs")));
  });
});

test("source launcher fails closed when release checksum mismatches", async () => {
  await withTempDir("runtime-hydration-bad-checksum", async (dir) => {
    const { pluginDir, importerUrl } = await writeFakeSourcePlugin(dir);
    const release = await createRuntimeReleaseAsset(dir, { checksumHash: "0".repeat(64) });
    const bootstrap = await import(
      pathToFileURL(path.join(pluginRoot, "scripts", "bootstrap-runtime.mjs")).href
    );

    await withReleaseServer(release.releaseDir, PLUGIN_VERSION, async (releaseBaseUrl) => {
      await assert.rejects(
        () => bootstrap.ensureRuntime("autoresearch.mjs", importerUrl, { releaseBaseUrl }),
        /Release tarball integrity mismatch/,
      );
    });
    await assert.rejects(access(path.join(pluginDir, "dist", "scripts", "autoresearch.mjs")));
  });
});

test("source launcher rejects multi-entry checksum manifests", async () => {
  await withTempDir("runtime-hydration-multi-checksum", async (dir) => {
    const { pluginDir, importerUrl } = await writeFakeSourcePlugin(dir);
    const release = await createRuntimeReleaseAsset(dir, {
      checksumText: ({ actualHash, tarballName }) =>
        `${actualHash}  ${tarballName}\n${"0".repeat(64)}  other.tgz\n`,
    });
    const bootstrap = await import(
      pathToFileURL(path.join(pluginRoot, "scripts", "bootstrap-runtime.mjs")).href
    );

    await withReleaseServer(release.releaseDir, PLUGIN_VERSION, async (releaseBaseUrl) => {
      await assert.rejects(
        () => bootstrap.ensureRuntime("autoresearch.mjs", importerUrl, { releaseBaseUrl }),
        /must contain exactly one asset entry; found 2/,
      );
    });
    await assert.rejects(access(path.join(pluginDir, "dist", "scripts", "autoresearch.mjs")));
  });
});

test("source launcher rejects unnamed checksum manifests", async () => {
  await withTempDir("runtime-hydration-unnamed-checksum", async (dir) => {
    const { pluginDir, importerUrl } = await writeFakeSourcePlugin(dir);
    const release = await createRuntimeReleaseAsset(dir, {
      checksumText: ({ actualHash }) => `${actualHash}\n`,
    });
    const bootstrap = await import(
      pathToFileURL(path.join(pluginRoot, "scripts", "bootstrap-runtime.mjs")).href
    );

    await withReleaseServer(release.releaseDir, PLUGIN_VERSION, async (releaseBaseUrl) => {
      await assert.rejects(
        () => bootstrap.ensureRuntime("autoresearch.mjs", importerUrl, { releaseBaseUrl }),
        /must contain a SHA-256 entry generated by sha256sum/,
      );
    });
    await assert.rejects(access(path.join(pluginDir, "dist", "scripts", "autoresearch.mjs")));
  });
});

test("source launcher rejects checksum manifests for the wrong release asset", async () => {
  await withTempDir("runtime-hydration-wrong-asset", async (dir) => {
    const { pluginDir, importerUrl } = await writeFakeSourcePlugin(dir);
    const release = await createRuntimeReleaseAsset(dir, {
      checksumFileName: "codex-autoresearch-0.0.0.tgz",
    });
    const bootstrap = await import(
      pathToFileURL(path.join(pluginRoot, "scripts", "bootstrap-runtime.mjs")).href
    );

    await withReleaseServer(release.releaseDir, PLUGIN_VERSION, async (releaseBaseUrl) => {
      await assert.rejects(
        () => bootstrap.ensureRuntime("autoresearch.mjs", importerUrl, { releaseBaseUrl }),
        new RegExp(
          `Checksum manifest expected asset codex-autoresearch-${escapeRegExp(PLUGIN_VERSION)}\\.tgz, got codex-autoresearch-0\\.0\\.0\\.tgz`,
        ),
      );
    });
    await assert.rejects(access(path.join(pluginDir, "dist", "scripts", "autoresearch.mjs")));
  });
});

test("source launcher rejects checksummed tarballs for the wrong package version", async () => {
  await withTempDir("runtime-hydration-wrong-version", async (dir) => {
    const { pluginDir, importerUrl } = await writeFakeSourcePlugin(dir);
    const release = await createRuntimeReleaseAsset(dir, { packageVersion: "0.0.0" });
    const bootstrap = await import(
      pathToFileURL(path.join(pluginRoot, "scripts", "bootstrap-runtime.mjs")).href
    );

    await withReleaseServer(release.releaseDir, PLUGIN_VERSION, async (releaseBaseUrl) => {
      await assert.rejects(
        () => bootstrap.ensureRuntime("autoresearch.mjs", importerUrl, { releaseBaseUrl }),
        new RegExp(
          `Release tarball package version mismatch: expected ${escapeRegExp(PLUGIN_VERSION)}, got 0\\.0\\.0`,
        ),
      );
    });
    await assert.rejects(access(path.join(pluginDir, "dist", "scripts", "autoresearch.mjs")));
  });
});
