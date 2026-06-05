import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { buildProtectedBenchmarkGuard } from "../lib/benchmark/contract-guards.js";
import { resolvePackageRoot } from "../lib/runtime-paths.js";
import {
  createCliRunner,
  quoteForShell,
  runGit,
  withTempDir as withNamedTempDir,
} from "./helpers/process.js";

const pluginRoot = resolvePackageRoot(import.meta.url);
const cli = path.join(pluginRoot, "scripts", "autoresearch.mjs");
const runCli = createCliRunner(cli, pluginRoot);
const withTempDir = (name, fn) => withNamedTempDir("autoresearch-hostile", name, fn);

test("protected benchmark edits block next and keep until a new segment", async () => {
  await withTempDir("protected-benchmark-mutation", async (dir) => {
    await initGit(dir);
    const benchmarkPath = path.join(dir, "bench.mjs");
    await writeFile(benchmarkPath, "console.log('METRIC seconds=1')\n", "utf8");
    await runGit(dir, ["add", "bench.mjs"]);
    await runGit(dir, ["commit", "-m", "baseline benchmark"]);

    const benchmarkCommand = `node ${quoteForShell(benchmarkPath)}`;
    await assertCliOk([
      "setup",
      "--cwd",
      dir,
      "--name",
      "protected",
      "--metric-name",
      "seconds",
      "--benchmark-command",
      benchmarkCommand,
      "--benchmark-prints-metric",
      "true",
      "--protected-benchmark-paths",
      "bench.mjs",
    ]);
    await assertCliOk([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "measure",
      "--description",
      "baseline",
    ]);
    const baselineEntry = await lastLedgerEntry(dir);
    assert.equal(baselineEntry.protectedBenchmarkSnapshot?.configured?.[0], "bench.mjs");

    await writeFile(benchmarkPath, "console.log('METRIC seconds=0.1')\n", "utf8");

    const doctor = await runCli(["doctor", "--cwd", dir]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctorPayload = JSON.parse(doctor.stdout);
    assert.equal(doctorPayload.ok, false);
    assert.match(doctorPayload.issues.join("\n"), /Protected benchmark paths changed/i);

    const next = await runCli(["next", "--cwd", dir]);
    assert.equal(next.code, 0, next.stderr);
    const nextPayload = JSON.parse(next.stdout);
    assert.equal(nextPayload.ok, false);
    assert.match(JSON.stringify(nextPayload), /Protected benchmark paths changed/i);

    const keep = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "0.1",
      "--status",
      "keep",
      "--description",
      "mutated benchmark",
    ]);
    assert.notEqual(keep.code, 0);
    assert.match(keep.stderr, /Protected benchmark paths changed/i);

    await assertCliOk([
      "new-segment",
      "--cwd",
      dir,
      "--reason",
      "benchmark contract intentionally changed",
      "--yes",
    ]);
    const postSegmentDoctor = await runCli(["doctor", "--cwd", dir]);
    assert.equal(postSegmentDoctor.code, 0, postSegmentDoctor.stderr);
    const postSegmentPayload = JSON.parse(postSegmentDoctor.stdout);
    assert.doesNotMatch(postSegmentPayload.issues.join("\n"), /Protected benchmark paths changed/i);
  });
});

test("protected benchmark guard quarantines symlink realpath escapes", async (t) => {
  await withTempDir("protected-benchmark-symlink", async (dir) => {
    const outsideDir = path.join(path.dirname(dir), `${path.basename(dir)}-outside`);
    await mkdir(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, "bench.mjs");
    await writeFile(outsideFile, "console.log('METRIC seconds=1')\n", "utf8");
    const linkPath = path.join(dir, "bench-link.mjs");
    try {
      await symlink(outsideFile, linkPath, "file");
    } catch (error) {
      t.skip(`symlink creation unavailable: ${error instanceof Error ? error.message : error}`);
      return;
    }

    const guard = await buildProtectedBenchmarkGuard({
      workDir: dir,
      config: { protectedBenchmarkPaths: ["bench-link.mjs"] },
      state: { current: [] },
    });

    assert.equal(guard.ok, false);
    assert.equal(guard.status, "quarantined");
    assert.match(guard.message, /quarantined/i);
    assert.match(guard.action, /realpath stays inside/i);
  });
});

test("protected benchmark guard quarantines symlinked directories", async (t) => {
  await withTempDir("protected-benchmark-symlink-dir", async (dir) => {
    const fixturesDir = path.join(dir, "fixtures");
    await mkdir(fixturesDir, { recursive: true });
    await writeFile(
      path.join(fixturesDir, "bench.mjs"),
      "console.log('METRIC seconds=1')\n",
      "utf8",
    );
    const linkPath = path.join(dir, "linked-fixtures");
    try {
      await symlink(fixturesDir, linkPath, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      t.skip(
        `directory symlink creation unavailable: ${error instanceof Error ? error.message : error}`,
      );
      return;
    }

    const guard = await buildProtectedBenchmarkGuard({
      workDir: dir,
      config: { protectedBenchmarkPaths: ["linked-fixtures"] },
      state: { current: [] },
    });

    assert.equal(guard.ok, false);
    assert.equal(guard.status, "quarantined");
    assert.match(JSON.stringify(guard.current?.quarantined || []), /symlink_directory/);
  });
});

async function assertCliOk(args) {
  const result = await runCli(args);
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  return result;
}

async function initGit(dir) {
  await runGit(dir, ["init"]);
  await runGit(dir, ["config", "user.email", "codex@example.test"]);
  await runGit(dir, ["config", "user.name", "Codex Test"]);
}

async function lastLedgerEntry(dir) {
  const ledger = await readFile(path.join(dir, "autoresearch.jsonl"), "utf8");
  const lines = ledger.trim().split(/\r?\n/);
  return JSON.parse(lines.at(-1) || "{}");
}
