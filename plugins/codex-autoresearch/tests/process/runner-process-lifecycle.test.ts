import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { persistTerminationFailure } from "../../scripts/autoresearch.js";
import {
  PARTIAL_RESULT_ARTIFACT_MAX_BYTES,
  PARTIAL_RESULT_ARTIFACT_MAX_ROWS,
} from "../../lib/partial-results.js";
import { createCoalescingProgressWriter } from "../../lib/active-progress-writer.js";
import { createActiveProgressWriter } from "../../lib/active-progress-store.js";
import { createProgressSnapshot } from "../../lib/runner-progress.js";
import { runProcess } from "../../lib/runner.js";
import { runWithRequiredCleanup } from "../../lib/required-cleanup.js";
import { DASHBOARD_LEDGER_MAX_ENTRIES } from "../../lib/dashboard-ledger-bounds.js";
import { createExecutionSpec, createExperimentContract } from "../../lib/experiment-contract.js";
import { parseLedger, writeLedger } from "../helpers/ledger.js";
import { pathExists } from "../helpers/cli-session.js";
import { quoteForShell } from "../helpers/process.js";

import {
  cli,
  runCli,
  runSpawnedCli,
  withTempDir,
  setupFixture,
} from "../helpers/cli-test-context.js";

async function setupRunnerFixture(
  dir: string,
  options: Parameters<typeof setupFixture>[1],
  checksCommand = `${quoteForShell(process.execPath)} -e "process.exit(0)"`,
) {
  const setup = await setupFixture(dir, {
    ...options,
    acceptedContract: true,
    completeContract: false,
    checksCommand,
    packetBudget: 100,
    scope: "src",
  });
  assert.equal(setup.code, 0, setup.stderr);
  await mkdir(path.join(dir, "src"), { recursive: true });
}

test("next reports missing primary metric as a failed experiment", async () => {
  await withTempDir("missing-metric", async (dir) => {
    const command = `${quoteForShell(process.execPath)} -e "console.log('no metric here')"`;
    await setupRunnerFixture(dir, { name: "missing metric", benchmarkCommand: command });

    const result = await runCli(["next", "--cwd", dir]);
    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout).run;
    assert.equal(payload.ok, false);
    assert.equal(payload.parsedPrimary, null);
    assert.match(payload.metricError, /seconds/);
    assert.equal(payload.logHint.status, "crash");
    assert.deepEqual(payload.logHint.allowedStatuses, ["crash"]);
  });
});

test("partial-results records diagnostic measure evidence from a failed packet artifact", async () => {
  await withTempDir("partial-results-record", async (dir) => {
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
    const benchmarkCommand = `${quoteForShell(process.execPath)} ${quoteForShell(script)}`;
    await setupRunnerFixture(dir, {
      name: "partial salvage",
      completeContract: true,
      benchmarkCommand,
    });

    const packet = await runCli(["next", "--cwd", dir]);
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
    const statePlan = statePayload.decisionPlanProjection;
    assert.equal(statePlan.kind, "decision-plan-projection");
    assert.equal(statePlan.primaryBlockerCode, "pending-packet");
    assert.equal(statePlan.action.kind, "log-decision");
    assert.equal(statePlan.capabilities["run-packet"], "blocked");

    const recommend = await runCli(["recommend-next", "--cwd", dir, "--compact"]);
    assert.equal(recommend.code, 0, recommend.stderr);
    const recommendPayload = JSON.parse(recommend.stdout);
    const recommendPlan = recommendPayload.decisionPlanProjection;
    assert.equal(recommendPlan.decisionId, statePlan.decisionId);
    assert.equal(recommendPlan.action.kind, statePlan.action.kind);
    assert.equal(recommendPlan.primaryBlockerCode, statePlan.primaryBlockerCode);
    assert.equal(recommendPlan.capabilities["run-packet"], "blocked");

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

test("partial-results refuses to record or clear a packet after trust configuration drifts", async () => {
  await withTempDir("partial-results-stale-trust", async (dir) => {
    const script = path.join(dir, "partial-stale.mjs");
    await writeFile(
      script,
      [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "mkdirSync('out', { recursive: true });",
        "writeFileSync('out/rows.json', JSON.stringify({ schemaVersion: 1, metricName: 'seconds', formulaVersion: 'v1', rows: [{ seconds: 3.5 }] }));",
        "console.log('ARTIFACT rows=out/rows.json');",
        "process.exit(1);",
      ].join("\n"),
    );
    await setupRunnerFixture(dir, {
      name: "partial stale trust",
      acceptedContract: true,
      benchmarkCommand: `${quoteForShell(process.execPath)} ${quoteForShell(script)}`,
    });
    const packet = await runCli(["next", "--cwd", dir]);
    assert.equal(packet.code, 0, packet.stderr);
    const packetPath = JSON.parse(packet.stdout).lastRunPath;
    const list = await runCli(["partial-results", "--cwd", dir, "--from-last"]);
    assert.equal(list.code, 0, list.stderr);
    const candidateId = JSON.parse(list.stdout).candidates[0].id;
    await mkdir(path.join(dir, "other"));
    const configured = await runCli(["config", "--cwd", dir, "--commit-paths", "other"]);
    assert.equal(configured.code, 0, configured.stderr);
    const ledgerBefore = await readFile(path.join(dir, "autoresearch.jsonl"), "utf8");

    const record = await runCli(["partial-results", "--cwd", dir, "--record", candidateId]);

    assert.equal(record.code, 1);
    const refusal = JSON.parse(record.stderr);
    assert.equal(refusal.code, "mutation-precondition-blocked");
    assert.equal(refusal.preconditionDecision.primaryBlockerCode, "legacy-contract-conflict");
    assert.equal(refusal.preconditionDecision.capabilities["run-packet"], "recovery-only");
    assert.equal(refusal.mutation, undefined);
    assert.equal(await readFile(path.join(dir, "autoresearch.jsonl"), "utf8"), ledgerBefore);
    await access(packetPath);
  });
});

test("partial-results treats missing accepted packet trust metadata as stale", async () => {
  await withTempDir("partial-results-missing-trust", async (dir) => {
    const script = path.join(dir, "partial-missing-trust.mjs");
    await writeFile(
      script,
      [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "mkdirSync('out', { recursive: true });",
        "writeFileSync('out/rows.json', JSON.stringify({ schemaVersion: 1, metricName: 'seconds', formulaVersion: 'v1', rows: [{ seconds: 3.5 }] }));",
        "console.log('ARTIFACT rows=out/rows.json');",
        "process.exit(1);",
      ].join("\n"),
    );
    await setupRunnerFixture(dir, {
      name: "partial missing trust",
      acceptedContract: true,
      benchmarkCommand: `${quoteForShell(process.execPath)} ${quoteForShell(script)}`,
    });
    const packetResult = await runCli(["next", "--cwd", dir]);
    assert.equal(packetResult.code, 0, packetResult.stderr);
    const packetPath = JSON.parse(packetResult.stdout).lastRunPath;
    const listed = await runCli(["partial-results", "--cwd", dir, "--from-last"]);
    assert.equal(listed.code, 0, listed.stderr);
    const candidateId = JSON.parse(listed.stdout).candidates[0].id;
    const packet = JSON.parse(await readFile(packetPath, "utf8"));
    delete packet.history.trustConfig;
    await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
    const ledgerBefore = await readFile(path.join(dir, "autoresearch.jsonl"), "utf8");

    const record = await runCli(["partial-results", "--cwd", dir, "--record", candidateId]);

    assert.equal(record.code, 1);
    const refusal = JSON.parse(record.stderr);
    assert.equal(refusal.code, "mutation-precondition-blocked");
    assert.equal(refusal.preconditionDecision.primaryBlockerCode, "stale-packet");
    assert.equal(await readFile(path.join(dir, "autoresearch.jsonl"), "utf8"), ledgerBefore);
    await access(packetPath);
  });
});

test("partial-results bounds oversized malformed missing and truncated artifacts", async () => {
  await withTempDir("partial-results-bounds", async (dir) => {
    await setupRunnerFixture(dir, { name: "partial bounds" });
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
    await setupRunnerFixture(dir, { name: "partial outside" });
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
    const benchmarkCommand = `${quoteForShell(process.execPath)} ${quoteForShell(script)} ${quoteForShell(releaseFile)}`;
    await setupRunnerFixture(dir, { name: "active progress", benchmarkCommand });

    const child = spawn(process.execPath, [cli, "next", "--cwd", dir]);
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
      const state = await runCli(["state", "--cwd", dir, "--json-full"]);
      assert.equal(state.code, 0, state.stderr);
      const payload = JSON.parse(state.stdout);
      progress = payload.experimentEconomics?.progress || null;
      if (progress?.exitState === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await writeFile(releaseFile, "go\n", "utf8");
    assert.equal(progress?.exitState, "running");
    assert.equal(Number.isSafeInteger(progress?.generation), true);
    assert.match(progress?.packetId || "", /active/);

    const exitCode = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(exitCode, 0, stderr);
    const packetPayload = JSON.parse(stdout);
    assert.equal(packetPayload.packetEvidence.progressSnapshot.exitState, "completed");
    await assert.rejects(access(path.join(dir, "autoresearch.progress.json")));
  });
});

test("active progress writer serializes delayed writes and coalesces newer generations", async () => {
  const writes: number[] = [];
  let releaseFirstWrite = () => {};
  let markFirstWriteStarted = () => {};
  const firstWriteStarted = new Promise<void>((resolve) => {
    markFirstWriteStarted = resolve;
  });
  const firstWriteReleased = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve;
  });
  const writer = createCoalescingProgressWriter({
    initialGeneration: 4,
    minWriteIntervalMs: 0,
    write: async (snapshot) => {
      if (snapshot.generation === 5) {
        markFirstWriteStarted();
        await firstWriteReleased;
      }
      writes.push(snapshot.generation);
    },
  });

  assert.equal(writer.queue({ exitState: "running" }).generation, 5);
  await firstWriteStarted;
  assert.equal(writer.queue({ exitState: "running" }).generation, 6);
  assert.equal(writer.queue({ exitState: "running" }).generation, 7);
  const closing = writer.close();
  releaseFirstWrite();
  await closing;

  assert.deepEqual(writes, [5, 7]);
  assert.throws(() => writer.queue({ exitState: "running" }), /closed/);
});

test("active progress writer closes after rejection without replaying pending generations", async () => {
  const writes: number[] = [];
  let markWriteStarted = () => {};
  let releaseWrite = () => {};
  const writeStarted = new Promise<void>((resolve) => {
    markWriteStarted = resolve;
  });
  const writeReleased = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const writer = createCoalescingProgressWriter({
    minWriteIntervalMs: 0,
    write: async (snapshot) => {
      writes.push(snapshot.generation);
      markWriteStarted();
      await writeReleased;
      throw new Error("hostile progress write rejection");
    },
  });

  writer.queue({ exitState: "running" });
  await writeStarted;
  writer.queue({ exitState: "running" });
  const closing = writer.close();
  releaseWrite();

  await assert.rejects(closing, /hostile progress write rejection/);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(writes, [1]);
  assert.throws(() => writer.queue({ exitState: "running" }), /closed/);
});

test("active progress store preserves legacy partial generation safety", async () => {
  await withTempDir("legacy-partial-progress", async (dir) => {
    const progressPath = path.join(dir, "autoresearch.progress.json");
    await writeFile(
      progressPath,
      JSON.stringify({ exitState: "running", generation: 7, packetId: "legacy-partial" }),
    );

    const writer = await createActiveProgressWriter(dir);
    writer.queue(
      createProgressSnapshot({
        packetId: "current-packet",
        command: "benchmark",
        startedAt: new Date().toISOString(),
      }),
    );
    await writer.close();

    const persisted = JSON.parse(await readFile(progressPath, "utf8"));
    assert.equal(persisted.generation, 8);
    assert.equal(persisted.packetId, "current-packet");
    assert.equal(persisted.stateStorage.storageMode, "worktree");
    assert.equal(persisted.stateStorage.path, progressPath);
  });
});

test("required cleanup preserves falsy failures and both aggregate identities", async () => {
  let caught: unknown = Symbol("not-caught");
  try {
    await runWithRequiredCleanup(
      async () => {
        throw 0;
      },
      async () => {
        throw "";
      },
      "cleanup failed",
    );
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof AggregateError);
  assert.deepEqual(caught.errors, [0, ""]);
});

test("next preserves existing active progress before resolving its command file", async () => {
  await withTempDir("standalone-progress-cleanup", async (dir) => {
    await setupRunnerFixture(dir, { name: "cleanup" });
    const progressPath = path.join(dir, "autoresearch.progress.json");
    await writeFile(
      progressPath,
      JSON.stringify({ exitState: "running", generation: 7, packetId: "stale-active" }),
    );

    const result = await runCli([
      "next",
      "--cwd",
      dir,
      "--command-file",
      "missing-command-file.txt",
    ]);

    assert.notEqual(result.code, 0);
    const refusal = JSON.parse(result.stderr);
    assert.equal(refusal.code, "mutation-precondition-blocked");
    assert.equal(refusal.preconditionDecision.primaryBlockerCode, "active-process");
    assert.equal(refusal.preconditionDecision.capabilities["run-packet"], "blocked");
    assert.equal(refusal.mutation, undefined);
    assert.equal(await pathExists(progressPath), true);
  });
});

test("coherent pre-snapshot rejects a wrong-entry progress path before execution", async () => {
  await withTempDir("progress-delete-failure", async (dir) => {
    await setupRunnerFixture(dir, { name: "delete failure", acceptedContract: true });
    const progressPath = path.join(dir, "autoresearch.progress.json");
    await mkdir(progressPath);
    const sideEffect = path.join(dir, "wrong-entry-command-ran.txt");

    const result = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      `${quoteForShell(process.execPath)} -e ${quoteForShell(
        `require('node:fs').writeFileSync(${JSON.stringify(sideEffect)}, 'ran'); console.log('METRIC seconds=1')`,
      )}`,
    ]);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /EISDIR.*illegal operation on a directory, read/i);
    assert.doesNotMatch(result.stderr, /Failed to remove active progress snapshot/);
    assert.equal((await stat(progressPath)).isDirectory(), true);
    assert.equal(await pathExists(sideEffect), false);
  });
});

test("coherent pre-snapshot rejects a wrong-entry packet path before progress starts", async () => {
  await withTempDir("terminal-packet-progress-cleanup", async (dir) => {
    await setupRunnerFixture(dir, { name: "terminal cleanup", acceptedContract: true });
    await mkdir(path.join(dir, "autoresearch.last-run.json"));

    const result = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      `${quoteForShell(process.execPath)} -e ${quoteForShell("console.log('METRIC seconds=1')")}`,
    ]);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /EISDIR.*illegal operation on a directory, read/i);
    assert.equal(await pathExists(path.join(dir, "autoresearch.progress.json")), false);
  });
});

test("chatty completion and failure cannot resurrect active progress", async () => {
  for (const [name, exitCode, expectedState] of [
    ["completed", 0, "completed"],
    ["failed", 7, "failed"],
  ] as const) {
    await withTempDir(`chatty-progress-${name}`, async (dir) => {
      const script = path.join(dir, "chatty.mjs");
      await writeFile(
        script,
        [
          "for (let index = 0; index < 2000; index += 1) process.stdout.write(`row-${index}\\n`);",
          "console.log('METRIC seconds=1');",
          `process.exitCode = ${exitCode};`,
        ].join("\n"),
      );
      const benchmarkCommand = `${quoteForShell(process.execPath)} ${quoteForShell(script)}`;
      await setupRunnerFixture(dir, { name, benchmarkCommand });

      const result = await runCli(["next", "--cwd", dir]);
      assert.equal(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.packetEvidence.progressSnapshot.exitState, expectedState);
      assert.ok(payload.packetEvidence.progressSnapshot.generation >= 2);
      assert.equal(await pathExists(path.join(dir, "autoresearch.progress.json")), false);
    });
  }
});

test("checks-phase timeout flushes its newest generation before cleanup", async () => {
  await withTempDir("checks-progress-timeout", async (dir) => {
    const checks = path.join(dir, "checks.mjs");
    await writeFile(
      checks,
      [
        "for (let index = 0; index < 200; index += 1) process.stdout.write(`check-${index}\\n`);",
        "setTimeout(() => {}, 30000);",
      ].join("\n"),
    );
    const checksCommand = `${quoteForShell(process.execPath)} ${quoteForShell(checks)}`;
    const benchmarkCommand = `${quoteForShell(process.execPath)} -e ${quoteForShell("console.log('METRIC seconds=1')")}`;
    await setupRunnerFixture(dir, { name: "checks timeout", benchmarkCommand }, checksCommand);
    const configPath = path.join(dir, "autoresearch.config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    await writeFile(
      configPath,
      `${JSON.stringify({ ...config, checksTimeoutSeconds: 1 }, null, 2)}\n`,
    );
    const accepted = await runCli([
      "new-segment",
      "--cwd",
      dir,
      "--reason",
      "Accept the checks timeout fixture",
      "--yes",
    ]);
    assert.equal(accepted.code, 0, accepted.stderr);

    const result = await runCli(["next", "--cwd", dir]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    const progress = payload.packetEvidence.progressSnapshot;
    assert.equal(progress.exitState, "timed_out", JSON.stringify(progress.termination));
    assert.equal(progress.timeoutPhase, "checks");
    assert.equal(progress.terminationFailed, false);
    assert.equal(payload.run.checks.termination.proven, true);
    assert.deepEqual(progress.termination, payload.run.checks.termination);
    assert.ok(progress.generation >= 4);
    assert.equal(await pathExists(path.join(dir, "autoresearch.progress.json")), false);
  });
});

test("unproven process-tree termination blocks state and next", async () => {
  await withTempDir("termination-failed-blocker", async (dir) => {
    await setupRunnerFixture(dir, { name: "termination blocker", acceptedContract: true });
    const progressPath = path.join(dir, "autoresearch.progress.json");
    await writeFile(
      progressPath,
      JSON.stringify({
        generation: 3,
        packetId: "packet-1-active",
        commandClass: "node script",
        startedAt: new Date().toISOString(),
        lastOutputAt: new Date().toISOString(),
        timeoutSeconds: 1,
        timeoutPhase: "benchmark",
        exitState: "termination_failed",
        artifactRoot: ".",
        latestArtifactRow: "heartbeat=heartbeat.txt",
        elapsedSeconds: 1,
        staleProgressReason: "",
        finalArtifactSummary: "1 artifact linked",
        terminationFailed: true,
        termination: {
          attempted: true,
          escalated: true,
          method: process.platform === "win32" ? "windows-taskkill-tree" : "posix-process-group",
          pid: 4242,
          platform: process.platform,
          proven: false,
          reason: "injected_termination_failure",
          remainingPids: [4242],
          trackedPids: [4242],
        },
      }),
    );
    const sideEffect = path.join(dir, "should-not-run.txt");
    const command = `${quoteForShell(process.execPath)} -e ${quoteForShell(
      `require('node:fs').writeFileSync(${JSON.stringify(sideEffect)}, 'ran')`,
    )}`;

    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.decisionPlan.primaryBlockerCode, "process-integrity");
    assert.equal(statePayload.decisionPlan.action.kind, "recover-session");
    assert.equal(statePayload.decisionPlan.capabilities["mutate-session"], "recovery-only");
    assert.equal(statePayload.decisionPlan.capabilities["run-packet"], "blocked");
    assert.equal(statePayload.decisionPlan.loopDisposition.canRunPacket, false);
    assert.equal(statePayload.experimentEconomics.progress.exitState, "termination_failed");

    const next = await runCli(["next", "--cwd", dir, "--command", command]);
    assert.equal(next.code, 1);
    assert.equal(next.stdout.trim(), "");
    const refusal = JSON.parse(next.stderr);
    assert.equal(refusal.code, "mutation-precondition-blocked");
    assert.equal(refusal.preconditionDecision.primaryBlockerCode, "process-integrity");
    assert.equal(refusal.preconditionDecision.capabilities["mutate-session"], "recovery-only");
    assert.equal(refusal.preconditionDecision.action.kind, "recover-session");
    assert.match(refusal.preconditionDecision.action.command, /process-recover/);
    assert.equal(refusal.mutation, undefined);

    assert.equal(await pathExists(progressPath), true);
    assert.equal(await pathExists(sideEffect), false);
  });
});

test("process recovery proves the recorded tree is dead and removes only its marker", async () => {
  await withTempDir("termination-failed-recovery", async (dir) => {
    await setupRunnerFixture(dir, { name: "termination recovery", acceptedContract: true });
    const progressPath = path.join(dir, "autoresearch.progress.json");
    const ledgerPath = path.join(dir, "autoresearch.jsonl");
    const configPath = path.join(dir, "autoresearch.config.json");
    const preservedPath = path.join(dir, "preserved.txt");
    await writeFile(preservedPath, "preserve me\n");
    const beforeLedger = await readFile(ledgerPath, "utf8");
    const beforeConfig = await readFile(configPath, "utf8");
    const deadPid = 2_147_483_647;
    await writeFile(
      progressPath,
      `${JSON.stringify({
        generation: 9,
        packetId: "packet-dead-tree",
        commandClass: "node script",
        startedAt: new Date().toISOString(),
        exitState: "termination_failed",
        terminationFailed: true,
        termination: {
          pid: deadPid,
          trackedPids: [deadPid],
          remainingPids: [deadPid],
          proven: false,
          reason: "injected_termination_failure",
        },
      })}\n`,
    );

    const recovered = await runCli(["process-recover", "--cwd", dir]);
    assert.equal(recovered.code, 0, recovered.stderr);
    const payload = JSON.parse(recovered.stdout);
    assert.equal(payload.mutation.command, "process-recover");
    assert.equal(payload.recovered, true);
    assert.deepEqual(payload.provenDeadPids, [deadPid]);
    assert.equal(await pathExists(progressPath), false);
    assert.equal(await readFile(ledgerPath, "utf8"), beforeLedger);
    assert.equal(await readFile(configPath, "utf8"), beforeConfig);
    assert.equal(await readFile(preservedPath, "utf8"), "preserve me\n");

    await writeFile(
      progressPath,
      `${JSON.stringify({
        generation: 10,
        packetId: "packet-live-tree",
        commandClass: "node script",
        startedAt: new Date().toISOString(),
        exitState: "termination_failed",
        terminationFailed: true,
        termination: {
          pid: process.pid,
          trackedPids: [process.pid],
          remainingPids: [process.pid],
          proven: false,
          reason: "injected_live_process",
        },
      })}\n`,
    );
    const refused = await runCli(["process-recover", "--cwd", dir]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /recorded process tree is still live/i);
    assert.equal(await pathExists(progressPath), true);
  });
});

test("process recovery requires producer-captured failed-before-spawn authority for zero-PID markers", async () => {
  await withTempDir("termination-missing-root-pid", async (dir) => {
    await setupRunnerFixture(dir, { name: "missing root pid recovery", acceptedContract: true });
    const progressPath = path.join(dir, "autoresearch.progress.json");
    const marker = {
      generation: 11,
      packetId: "packet-missing-root-pid",
      commandClass: "node script",
      startedAt: new Date().toISOString(),
      exitState: "termination_failed",
      terminationFailed: true,
      termination: {
        attempted: false,
        escalated: false,
        method: "none",
        pid: null,
        platform: process.platform,
        proven: false,
        reason: "missing_root_pid",
        remainingPids: [],
        trackedPids: [],
      },
    };
    const hostileMarkers = [
      marker,
      { ...marker, spawnState: "unknown", spawnError: "spawn outcome unavailable" },
      { ...marker, spawnState: "pending", spawnError: "spawn still pending" },
      { ...marker, spawnState: "timed-out", spawnError: "spawn outcome timed out" },
      { ...marker, spawnState: "failed-before-spawn", spawnError: "" },
      {
        ...marker,
        spawnState: "failed-before-spawn",
        spawnError: "spawn failed",
        termination: { ...marker.termination, attempted: true },
      },
      {
        ...marker,
        spawnState: "failed-before-spawn",
        spawnError: "spawn failed",
        termination: { ...marker.termination, reason: "runner_rejected_before_start" },
      },
    ];
    for (const hostileMarker of hostileMarkers) {
      const bytes = `${JSON.stringify(hostileMarker)}\n`;
      await writeFile(progressPath, bytes);
      const refused = await runCli(["process-recover", "--cwd", dir]);
      assert.equal(refused.code, 1);
      assert.match(
        refused.stderr,
        /cannot prove a dead tree|failed-before-spawn|no-process-started proof/i,
      );
      assert.equal(await readFile(progressPath, "utf8"), bytes);
    }

    await writeFile(
      progressPath,
      `${JSON.stringify({
        ...marker,
        spawnState: "failed-before-spawn",
        spawnError: "spawn /missing/autoresearch-runner ENOENT",
      })}\n`,
    );
    const recovered = await runCli(["process-recover", "--cwd", dir]);
    assert.equal(recovered.code, 0, recovered.stderr);
    const payload = JSON.parse(recovered.stdout);
    assert.equal(payload.recovered, true);
    assert.deepEqual(payload.provenDeadPids, []);
    assert.equal(payload.proof.kind, "no-process-started");
    assert.equal(payload.proof.spawnState, "failed-before-spawn");
    assert.equal(await pathExists(progressPath), false);
  });
});

test("runner records failed-before-spawn authority from a real spawn error", async () => {
  await withTempDir("failed-before-spawn-authority", async (dir) => {
    const result = await runProcess(path.join(dir, "missing-autoresearch-runner"), [], {
      cwd: dir,
      timeoutSeconds: 1,
    });

    assert.equal(result.exitCode, null);
    assert.equal((result as any).spawnState, "failed-before-spawn");
    assert.match(String((result as any).spawnError || ""), /\S/);
    assert.equal(result.termination, null);
  });
});

test("non-packet termination failure persists the same packet brake", async () => {
  await withTempDir("external-termination-failed-blocker", async (dir) => {
    await setupRunnerFixture(dir, {
      name: "external termination blocker",
      acceptedContract: true,
    });
    await persistTerminationFailure(dir, "benchmark-inspect", {
      terminationFailed: true,
      termination: {
        attempted: true,
        escalated: true,
        method: "none",
        pid: 5151,
        platform: process.platform,
        proven: false,
        reason: "injected_termination_failure",
        remainingPids: [5151],
        trackedPids: [5151],
      },
    });

    const progress = JSON.parse(
      await readFile(path.join(dir, "autoresearch.progress.json"), "utf8"),
    );
    assert.equal(progress.exitState, "termination_failed");
    assert.equal(progress.termination.pid, 5151);

    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(state.code, 0, state.stderr);
    const statePlan = JSON.parse(state.stdout).decisionPlan;
    assert.equal(statePlan.primaryBlockerCode, "process-integrity");
    assert.equal(statePlan.action.kind, "recover-session");
    assert.equal(statePlan.capabilities["mutate-session"], "recovery-only");
    assert.equal(statePlan.capabilities["run-packet"], "blocked");

    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      `${quoteForShell(process.execPath)} -e ${quoteForShell("console.log('METRIC seconds=1')")}`,
    ]);
    assert.equal(next.code, 1);
    assert.equal(next.stdout.trim(), "");
    const refusal = JSON.parse(next.stderr);
    assert.equal(refusal.code, "mutation-precondition-blocked");
    assert.equal(refusal.preconditionDecision.primaryBlockerCode, "process-integrity");
    assert.equal(refusal.preconditionDecision.capabilities["mutate-session"], "recovery-only");
    assert.equal(refusal.preconditionDecision.action.kind, "recover-session");
    assert.match(refusal.preconditionDecision.action.command, /process-recover/);
    assert.equal(refusal.mutation, undefined);
    assert.equal(await pathExists(path.join(dir, "autoresearch.progress.json")), true);
  });
});

test("benchmark inspection holds the session lock through process execution", async () => {
  await withTempDir("inspect-session-lock", async (dir) => {
    await setupRunnerFixture(dir, { name: "inspect lock" });
    const ready = path.join(dir, "inspect-ready.txt");
    const release = path.join(dir, "inspect-release.txt");
    const sideEffect = path.join(dir, "overlap.txt");
    const inspectScript = [
      "const fs = require('node:fs')",
      `fs.writeFileSync(${JSON.stringify(ready)}, 'ready')`,
      `const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); console.log('METRIC seconds=1'); } }, 25)`,
    ].join(";");
    let inspected: Awaited<ReturnType<typeof runSpawnedCli>>;
    const inspect = runSpawnedCli([
      "benchmark-inspect",
      "--cwd",
      dir,
      "--command",
      `${quoteForShell(process.execPath)} -e ${quoteForShell(inspectScript)}`,
      "--timeout-seconds",
      "30",
    ]);
    try {
      for (let attempt = 0; attempt < 100 && !(await pathExists(ready)); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(await pathExists(ready), true, "inspect command did not start");

      const overlap = await runSpawnedCli([
        "next",
        "--cwd",
        dir,
        "--command",
        `${quoteForShell(process.execPath)} -e ${quoteForShell(
          `require('node:fs').writeFileSync(${JSON.stringify(sideEffect)}, 'ran'); console.log('METRIC seconds=1')`,
        )}`,
      ]);
      assert.notEqual(overlap.code, 0);
      assert.match(overlap.stderr, /mutation is already running/i);
      assert.equal(await pathExists(sideEffect), false);
    } finally {
      await writeFile(release, "release", "utf8");
      inspected = await inspect;
    }
    assert.equal(inspected.code, 0, inspected.stderr);
  });
});

test("packet lifecycle records keep state doctor and dashboard process trust aligned", async () => {
  await withTempDir("typed-process-lifecycle", async (dir) => {
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1')"`;
    await setupRunnerFixture(dir, {
      name: "process lifecycle",
      completeContract: true,
      benchmarkCommand: command,
    });
    const next = await runCli(["next", "--cwd", dir]);
    assert.equal(next.code, 0, next.stderr);
    const packetLifecycle = JSON.parse(next.stdout).packetEvidence.processLifecycle;
    assert.deepEqual(
      packetLifecycle.map((record: any) => record.event),
      ["started", "observed-live", "terminated", "started", "observed-live", "terminated"],
    );
    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "measure",
      "--description",
      "Record completed packet lifecycle",
    ]);
    assert.equal(logged.code, 0, logged.stderr);

    const ledgerPath = path.join(dir, "autoresearch.jsonl");
    const records = parseLedger(await readFile(ledgerPath, "utf8"));
    const loggedLifecycle = records.filter((record) => record.type === "process_lifecycle");
    assert.deepEqual(
      loggedLifecycle.map((record) => record.event),
      ["started", "observed-live", "terminated", "started", "observed-live", "terminated"],
    );
    assert.deepEqual(
      loggedLifecycle.map((record: any) => record.identity.processId),
      ["benchmark", "benchmark", "benchmark", "checks", "checks", "checks"],
    );
    assert.doesNotMatch(JSON.stringify(loggedLifecycle), /console\.log|METRIC|seconds=1/);

    records.push({
      type: "process_lifecycle",
      identity: { packetId: "packet-unclosed", processId: "benchmark" },
      event: "started",
      at: "2026-07-10T12:00:00.000Z",
    });
    for (let index = 0; index < DASHBOARD_LEDGER_MAX_ENTRIES + 7; index += 1) {
      records.push({
        type: "run",
        run: 10_000 + index,
        metric: index + 2,
        status: "measure",
        description: `tail run ${index + 1}`,
      });
    }
    await writeLedger(dir, records);

    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
    const doctor = await runCli(["doctor", "--cwd", dir, "--json-full"]);
    const dashboard = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(state.code, 0, state.stderr);
    assert.equal(doctor.code, 0, doctor.stderr);
    assert.equal(dashboard.code, 0, dashboard.stderr);

    const statePayload = JSON.parse(state.stdout);
    const doctorPayload = JSON.parse(doctor.stdout);
    const statePreflight = statePayload.resourcePreflight;
    const doctorPreflight = doctorPayload.state.resourcePreflight;
    const dashboardPayload = JSON.parse(dashboard.stdout);
    for (const preflight of [statePreflight, doctorPreflight]) {
      assert.equal(preflight.status, "blocked");
      assert.equal(preflight.canStart, false);
      assert.equal(preflight.residue.length, 1);
      assert.equal(preflight.residue[0].status, "process-active");
    }
    assert.equal(statePreflight.nextAction, doctorPreflight.nextAction);
    const statePlan = statePayload.decisionPlan;
    const doctorPlan = doctorPayload.decisionPlan;
    const dashboardPlan = dashboardPayload.viewModel.decisionPlanProjection;
    assert.equal(statePlan.kind, "decision-plan");
    assert.equal(doctorPlan.decisionId, statePlan.decisionId);
    assert.equal(dashboardPlan.decisionId, statePlan.decisionId);
    assert.equal(dashboardPlan.primaryBlockerCode, statePlan.primaryBlockerCode);
    assert.equal(dashboardPlan.action.kind, statePlan.action.kind);
    assert.equal(dashboardPlan.capabilities["run-packet"], statePlan.capabilities["run-packet"]);
    assert.equal(dashboardPayload.viewModel.summary.runs, DASHBOARD_LEDGER_MAX_ENTRIES + 8);
    const dashboardHtml = await readFile(path.join(dir, "autoresearch-dashboard.html"), "utf8");
    assert.doesNotMatch(dashboardHtml, /packet-unclosed/);
  });
});

test("a pre-spawn runner rejection proves no process started and leaves no recovery brake", async () => {
  await withTempDir("runner-rejection-process-brake", async (dir) => {
    await setupRunnerFixture(dir, { name: "runner rejection", acceptedContract: true });
    const records = parseLedger(await readFile(path.join(dir, "autoresearch.jsonl"), "utf8"));
    const acceptedIndex = records.findLastIndex(
      (record) => record.type === "experiment-contract-accepted",
    );
    assert.notEqual(acceptedIndex, -1);
    const accepted = records[acceptedIndex] as any;
    const originalContract = accepted.contract;
    const { executionDigest: _executionDigest, ...executionInput } =
      originalContract.evaluator.execution;
    const envName = "AUTORESEARCH_PRESPAWN_PROOF";
    const envValue = "accepted-value";
    const valueDigest = createHash("sha256")
      .update(
        `environment-value\0${originalContract.repository.worktreeIdentity}\0${envName}\0${envValue}`,
      )
      .digest("hex");
    const execution = createExecutionSpec({
      ...executionInput,
      environment: {
        inheritance: "minimal",
        declared: [{ name: envName, valueDigest }],
        source: { kind: "process" },
      },
    });
    const { contractDigest: _contractDigest, ...contractInput } = originalContract;
    const contract = createExperimentContract({
      ...contractInput,
      evaluator: { ...contractInput.evaluator, execution },
    });
    records[acceptedIndex] = {
      ...accepted,
      eventId: `experiment-contract-accepted:${accepted.segment}:${contract.contractDigest}`,
      contract,
    };
    await writeLedger(dir, records);

    const childEnv = { ...process.env };
    delete childEnv[envName];
    const run = await runSpawnedCli(["next", "--cwd", dir], { env: childEnv });
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /Accepted environment value is unavailable/);
    assert.equal(await pathExists(path.join(dir, "autoresearch.progress.json")), false);

    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.equal(
      payload.decisionPlan.requiredEvidence.diagnosticCodes.includes("process-integrity"),
      false,
    );
  });
});
