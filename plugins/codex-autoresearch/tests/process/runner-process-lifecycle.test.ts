import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
import { runWithRequiredCleanup } from "../../lib/required-cleanup.js";
import { DASHBOARD_LEDGER_MAX_ENTRIES } from "../../lib/dashboard-ledger-bounds.js";
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

test("next reports missing primary metric as a failed experiment", async () => {
  await withTempDir("missing-metric", async (dir) => {
    await setupFixture(dir, { name: "missing metric" });

    const command = `${quoteForShell(process.execPath)} -e "console.log('no metric here')"`;
    const result = await runCli(["next", "--cwd", dir, "--command", command]);
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
    await setupFixture(dir, { name: "partial salvage" });
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
    assert.equal(statePayload.resolvedDecision.canonicalNextAction.kind, "partial-salvage");
    assert.equal(
      statePayload.resolvedDecision.nextAction,
      statePayload.resolvedDecision.canonicalNextAction.reason,
    );

    const recommend = await runCli(["recommend-next", "--cwd", dir, "--compact"]);
    assert.equal(recommend.code, 0, recommend.stderr);
    const recommendPayload = JSON.parse(recommend.stdout);
    assert.equal(recommendPayload.action.kind, "partial-salvage");
    assert.equal(
      recommendPayload.nextAction,
      statePayload.resolvedDecision.canonicalNextAction.reason,
    );
    assert.equal(
      recommendPayload.resolvedDecision.canonicalNextAction.kind,
      statePayload.resolvedDecision.canonicalNextAction.kind,
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
    await setupFixture(dir, { name: "partial bounds" });
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
    await setupFixture(dir, { name: "partial outside" });
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
    await setupFixture(dir, { name: "active progress" });
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

test("next reports command-file ENOENT without mutating existing progress", async () => {
  await withTempDir("standalone-progress-cleanup", async (dir) => {
    await setupFixture(dir, { name: "cleanup" });
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

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /ENOENT/);
    assert.equal(await pathExists(progressPath), true);
  });
});

test("active progress deletion propagates wrong-entry-type failures", async () => {
  await withTempDir("progress-delete-failure", async (dir) => {
    await setupFixture(dir, { name: "delete failure" });
    const progressPath = path.join(dir, "autoresearch.progress.json");
    await mkdir(progressPath);

    const result = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      `${quoteForShell(process.execPath)} -e ${quoteForShell("console.log('METRIC seconds=1')")}`,
    ]);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Write target must be a regular file/);
    assert.match(result.stderr, /Failed to remove active progress snapshot/);
    assert.equal((await stat(progressPath)).isDirectory(), true);
  });
});

test("next removes active progress when terminal packet persistence fails", async () => {
  await withTempDir("terminal-packet-progress-cleanup", async (dir) => {
    await setupFixture(dir, { name: "terminal cleanup" });
    await mkdir(path.join(dir, "autoresearch.last-run.json"));

    const result = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      `${quoteForShell(process.execPath)} -e ${quoteForShell("console.log('METRIC seconds=1')")}`,
    ]);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Write target must be a regular file/);
    assert.equal(await pathExists(path.join(dir, "autoresearch.progress.json")), false);
  });
});

test("chatty completion and failure cannot resurrect active progress", async () => {
  for (const [name, exitCode, expectedState] of [
    ["completed", 0, "completed"],
    ["failed", 7, "failed"],
  ] as const) {
    await withTempDir(`chatty-progress-${name}`, async (dir) => {
      await setupFixture(dir, { name: name });
      const script = path.join(dir, "chatty.mjs");
      await writeFile(
        script,
        [
          "for (let index = 0; index < 2000; index += 1) process.stdout.write(`row-${index}\\n`);",
          "console.log('METRIC seconds=1');",
          `process.exitCode = ${exitCode};`,
        ].join("\n"),
      );

      const result = await runCli([
        "next",
        "--cwd",
        dir,
        "--command",
        `${quoteForShell(process.execPath)} ${quoteForShell(script)}`,
      ]);
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
    await setupFixture(dir, { name: "checks timeout" });
    const checks = path.join(dir, "checks.mjs");
    await writeFile(
      checks,
      [
        "for (let index = 0; index < 200; index += 1) process.stdout.write(`check-${index}\\n`);",
        "setTimeout(() => {}, 30000);",
      ].join("\n"),
    );

    const result = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      `${quoteForShell(process.execPath)} -e ${quoteForShell("console.log('METRIC seconds=1')")}`,
      "--checks-command",
      `${quoteForShell(process.execPath)} ${quoteForShell(checks)}`,
      "--checks-timeout-seconds",
      "1",
    ]);
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
    await setupFixture(dir, { name: "termination blocker" });
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
    assert.equal(statePayload.resolvedDecision.loopContract.canRunNextPacket, false);
    assert.equal(statePayload.resolvedDecision.loopContract.blockers[0].kind, "termination-failed");
    assert.equal(statePayload.experimentEconomics.progress.exitState, "termination_failed");

    const next = await runCli(["next", "--cwd", dir, "--command", command]);
    assert.equal(next.code, 0, next.stderr);
    const nextPayload = JSON.parse(next.stdout);
    assert.equal(nextPayload.code, "termination_failed");
    assert.equal(nextPayload.loopContract.canRunNextPacket, false);
    assert.equal(nextPayload.progress.termination.pid, 4242);

    assert.equal(await pathExists(progressPath), true);
    assert.equal(await pathExists(sideEffect), false);
  });
});

test("non-packet termination failure persists the same packet brake", async () => {
  await withTempDir("external-termination-failed-blocker", async (dir) => {
    await setupFixture(dir, { name: "external termination blocker" });
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

    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      `${quoteForShell(process.execPath)} -e ${quoteForShell("console.log('METRIC seconds=1')")}`,
    ]);
    assert.equal(next.code, 0, next.stderr);
    const payload = JSON.parse(next.stdout);
    assert.equal(payload.code, "termination_failed");
    assert.equal(payload.progress.termination.pid, 5151);
  });
});

test("benchmark inspection holds the session lock through process execution", async () => {
  await withTempDir("inspect-session-lock", async (dir) => {
    await setupFixture(dir, { name: "inspect lock" });
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
    await setupFixture(dir, { name: "process lifecycle" });
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1')"`;
    const next = await runCli(["next", "--cwd", dir, "--command", command]);
    assert.equal(next.code, 0, next.stderr);
    const packetLifecycle = JSON.parse(next.stdout).packetEvidence.processLifecycle;
    assert.deepEqual(
      packetLifecycle.map((record: any) => record.event),
      ["started", "observed-live", "terminated"],
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
      ["started", "observed-live", "terminated"],
    );
    assert.deepEqual(
      loggedLifecycle.map((record: any) => record.identity.processId),
      ["benchmark", "benchmark", "benchmark"],
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

    const statePreflight = JSON.parse(state.stdout).resourcePreflight;
    const doctorPreflight = JSON.parse(doctor.stdout).state.resourcePreflight;
    const dashboardPayload = JSON.parse(dashboard.stdout);
    const dashboardPreflight = dashboardPayload.viewModel.decisionEnvelope.resourcePreflight;
    for (const preflight of [statePreflight, doctorPreflight, dashboardPreflight]) {
      assert.equal(preflight.status, "blocked");
      assert.equal(preflight.canStart, false);
      assert.equal(preflight.residue.length, 1);
      assert.equal(preflight.residue[0].status, "process-active");
    }
    assert.equal(statePreflight.nextAction, doctorPreflight.nextAction);
    assert.equal(statePreflight.nextAction, dashboardPreflight.nextAction);
    assert.equal(dashboardPayload.viewModel.summary.runs, DASHBOARD_LEDGER_MAX_ENTRIES + 8);
    const dashboardHtml = await readFile(path.join(dir, "autoresearch-dashboard.html"), "utf8");
    assert.doesNotMatch(dashboardHtml, /packet-unclosed/);
  });
});

test("unknown packet runner rejection retains a termination-failed brake", async () => {
  await withTempDir("runner-rejection-process-brake", async (dir) => {
    await setupFixture(dir, { name: "runner rejection" });
    await writeFile(path.join(dir, "hostile.command"), "node\0unexpected", "utf8");

    const run = await runCli(["next", "--cwd", dir, "--command-file", "hostile.command"]);
    assert.notEqual(run.code, 0);
    const progress = JSON.parse(
      await readFile(path.join(dir, "autoresearch.progress.json"), "utf8"),
    );
    assert.equal(progress.exitState, "termination_failed");
    assert.equal(progress.termination.proven, false);
    assert.equal(progress.termination.reason, "runner_rejected_before_outcome");

    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.equal(payload.resourcePreflight.canStart, false);
    assert.equal(payload.resourcePreflight.residue[0].status, "termination-failed");
    assert.equal(payload.resolvedDecision.loopContract.canRunNextPacket, false);
  });
});
