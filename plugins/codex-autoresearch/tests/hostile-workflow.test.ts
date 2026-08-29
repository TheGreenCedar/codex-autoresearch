import assert from "node:assert/strict";
import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { buildProtectedBenchmarkGuard } from "../lib/benchmark/contract-guards.js";
import { parseNameStatusZ, parsePorcelainV1Z } from "../lib/git-paths.js";
import { resolvePackageRoot } from "../lib/runtime-paths.js";
import {
  createCliRunner,
  quoteForAcceptedShell,
  runGit,
  runProcess,
  testGitArgs,
  withTempDir as withNamedTempDir,
} from "./helpers/process.js";

const pluginRoot = resolvePackageRoot(import.meta.url);
const cli = path.join(pluginRoot, "scripts", "autoresearch.mjs");
const runCli = createCliRunner(cli, pluginRoot);
const withTempDir = (name, fn) => withNamedTempDir("autoresearch-hostile", name, fn);

test("Git -z path parsers round-trip hostile names and both sides of renames", async (t) => {
  await withTempDir("git-path-round-trip", async (dir) => {
    await initGit(dir);
    const portablePaths = ["literal arrow 雪.txt", " leading 雪.txt"];
    const posixOnlyPaths = [
      "trailing 雪.txt ",
      "line\nbreak.txt",
      'quote"name.txt',
      "back\\slash.txt",
    ];
    if (process.platform === "win32") {
      t.diagnostic(
        "Literal arrow, trailing-space, newline, quote, and backslash filenames are omitted because Win32 forbids them.",
      );
    }
    const hostilePaths = [
      ...portablePaths,
      ...(process.platform === "win32" ? [] : ["literal -> arrow 雪.txt", ...posixOnlyPaths]),
    ];
    for (const file of hostilePaths) await writeFile(path.join(dir, file), "before\n", "utf8");
    const original = process.platform === "win32" ? "rename old 雪.txt" : "rename old -> 雪.txt";
    const current = process.platform === "win32" ? "rename new 雪.txt" : "rename new -> 雪.txt";
    await writeFile(path.join(dir, original), "rename me\n", "utf8");
    await runGit(dir, ["add", "-A"]);
    await runGit(dir, ["commit", "-m", "hostile paths"]);

    for (const file of hostilePaths) await writeFile(path.join(dir, file), "after\n", "utf8");
    await rename(path.join(dir, original), path.join(dir, current));
    await runGit(dir, ["add", "-A"]);

    const status = await runProcess(
      "git",
      testGitArgs(["status", "--porcelain=v1", "-z", "-uall"]),
      dir,
    );
    assert.equal(status.code, 0, status.stderr);
    const statusEntries = parsePorcelainV1Z(status.stdout);
    assert.deepEqual(
      new Set(statusEntries.flatMap((entry) => entry.paths)),
      new Set([...hostilePaths, original, current]),
    );
    assert.deepEqual(statusEntries.find((entry) => entry.status.includes("R"))?.paths, [
      original,
      current,
    ]);

    const diff = await runProcess(
      "git",
      testGitArgs(["diff", "--cached", "--name-status", "-z", "-M", "HEAD"]),
      dir,
    );
    assert.equal(diff.code, 0, diff.stderr);
    assert.deepEqual(
      parseNameStatusZ(diff.stdout).find((entry) => entry.status.startsWith("R"))?.paths,
      [original, current],
    );
  });
});

test("protected benchmark edits block next and keep until a new segment", async () => {
  await withTempDir("protected-benchmark-mutation", async (dir) => {
    await initGit(dir);
    const benchmarkPath = path.join(dir, "bench.mjs");
    await writeFile(benchmarkPath, "console.log('METRIC seconds=1')\n", "utf8");
    await runGit(dir, ["add", "bench.mjs"]);
    await runGit(dir, ["commit", "-m", "baseline benchmark"]);

    const benchmarkCommand = `node ${quoteForAcceptedShell(benchmarkPath)}`;
    await setupProtectedBenchmarkSession(dir, {
      name: "protected",
      benchmarkCommand,
      protectedBenchmarkPath: "bench.mjs",
    });
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
    assertEvaluatorDriftDecision(doctorPayload, /Protected benchmark paths changed/i);

    const next = await runCli(["next", "--cwd", dir]);
    assertEvaluatorDriftMutationFailure(next);

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
    assertEvaluatorDriftMutationFailure(keep);

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
    assert.notEqual(
      postSegmentPayload.decisionPlanProjection.primaryBlockerCode,
      "evaluator-drift",
    );
  });
});

test("missing protected benchmark paths block trusted baseline capture", async () => {
  await withTempDir("protected-benchmark-missing-baseline", async (dir) => {
    const guard = await buildProtectedBenchmarkGuard({
      workDir: dir,
      config: { protectedBenchmarkPaths: ["fixtures/bench.mjs"] },
      state: { current: [] },
    });

    assert.equal(guard.ok, false);
    assert.equal(guard.status, "missing");
    assert.match(guard.message, /missing/i);
    assert.match(guard.action, /Create the protected benchmark paths/i);
  });
});

test("dirty protected benchmark paths block the first keep baseline", async () => {
  await withTempDir("protected-benchmark-dirty-baseline", async (dir) => {
    await initGit(dir);
    const benchmarkPath = path.join(dir, "bench.mjs");
    await writeFile(benchmarkPath, "console.log('METRIC seconds=1')\n", "utf8");
    await runGit(dir, ["add", "bench.mjs"]);
    await runGit(dir, ["commit", "-m", "benchmark contract"]);

    await setupProtectedBenchmarkSession(dir, {
      name: "dirty protected baseline",
      benchmarkCommand: `node ${quoteForAcceptedShell(benchmarkPath)}`,
      protectedBenchmarkPath: "bench.mjs",
    });

    await writeFile(benchmarkPath, "console.log('METRIC seconds=0.5')\n", "utf8");

    const doctor = await runCli(["doctor", "--cwd", dir]);
    assert.equal(doctor.code, 0, doctor.stderr);
    assertEvaluatorDriftDecision(JSON.parse(doctor.stdout), /dirty before the first baseline/i);

    const keep = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "0.5",
      "--status",
      "keep",
      "--description",
      "dirty first baseline",
    ]);
    assertEvaluatorDriftMutationFailure(keep);

    const next = await runCli(["next", "--cwd", dir]);
    assertEvaluatorDriftMutationFailure(next);
  });
});

test("ordinary editable source dirt blocks keep without blocking packet execution", async () => {
  await withTempDir("ordinary-editable-source", async (dir) => {
    await initGit(dir);
    const benchmarkPath = path.join(dir, "bench.mjs");
    await writeFile(benchmarkPath, "console.log('METRIC seconds=1')\n", "utf8");
    await runGit(dir, ["add", "bench.mjs"]);
    await runGit(dir, ["commit", "-m", "benchmark contract"]);
    await setupProtectedBenchmarkSession(dir, {
      name: "ordinary editable source",
      benchmarkCommand: `node ${quoteForAcceptedShell(benchmarkPath)}`,
      protectedBenchmarkPath: "bench.mjs",
    });

    await writeFile(path.join(dir, "src", "candidate.txt"), "candidate\n", "utf8");
    const doctor = await runCli(["doctor", "--cwd", dir]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const payload = JSON.parse(doctor.stdout);
    const plan = payload.decisionPlanProjection;
    assert.equal(plan.primaryBlockerCode, "dirty-source");
    assert.equal(plan.requiredEvidence.diagnosticCodes.includes("evaluator-drift"), false);
    assert.equal(plan.capabilities["run-packet"], "allowed");
    assert.equal(plan.capabilities["authorize-keep"], "blocked");
  });
});

test("renaming a protected hostile path out of scope blocks the first baseline", async () => {
  await withTempDir("protected-benchmark-hostile-rename", async (dir) => {
    await initGit(dir);
    const protectedRelative = process.platform === "win32" ? "bench 雪" : "bench -> 雪";
    const protectedDir = path.join(dir, protectedRelative);
    const original = path.join(protectedDir, "score.mjs");
    const current = path.join(
      dir,
      "src",
      process.platform === "win32" ? "score moved 雪.mjs" : "score -> moved 雪.mjs",
    );
    await mkdir(protectedDir, { recursive: true });
    await mkdir(path.dirname(current), { recursive: true });
    await writeFile(original, "console.log('METRIC seconds=1')\n", "utf8");
    await runGit(dir, ["add", "-A"]);
    await runGit(dir, ["commit", "-m", "protected benchmark"]);

    await setupProtectedBenchmarkSession(dir, {
      name: "hostile protected rename",
      benchmarkCommand: `node ${quoteForAcceptedShell(original)}`,
      protectedBenchmarkPath: protectedRelative,
    });
    await rename(original, current);

    const doctor = await runCli(["doctor", "--cwd", dir]);
    assert.equal(doctor.code, 0, doctor.stderr);
    assertEvaluatorDriftDecision(JSON.parse(doctor.stdout), /dirty before the first baseline/i);

    const keep = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "must not bless moved benchmark",
    ]);
    assertEvaluatorDriftMutationFailure(keep);
  });
});

test("protected benchmark guard quarantines oversized directory snapshots", async () => {
  await withTempDir("protected-benchmark-oversized-dir", async (dir) => {
    const fixturesDir = path.join(dir, "fixtures");
    await mkdir(fixturesDir, { recursive: true });
    for (let index = 0; index < 501; index += 1) {
      await writeFile(path.join(fixturesDir, `row-${String(index).padStart(3, "0")}.txt`), "x\n");
    }

    const guard = await buildProtectedBenchmarkGuard({
      workDir: dir,
      config: { protectedBenchmarkPaths: ["fixtures"] },
      state: { current: [] },
    });

    assert.equal(guard.ok, false);
    assert.equal(guard.status, "quarantined");
    assert.match(
      JSON.stringify(guard.current?.quarantined || []),
      /protected_benchmark_entry_limit/,
    );
    assert.match(guard.message, /quarantined/i);
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

async function setupProtectedBenchmarkSession(
  dir,
  { name, benchmarkCommand, protectedBenchmarkPath },
) {
  await mkdir(path.join(dir, "contract"), { recursive: true });
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "contract", "checks.mjs"), "process.exit(0);\n", "utf8");
  await runGit(dir, ["add", "contract/checks.mjs"]);
  await runGit(dir, ["commit", "-m", "authoritative checks"]);

  await assertCliOk([
    "setup",
    "--cwd",
    dir,
    "--name",
    name,
    "--metric-name",
    "seconds",
    "--benchmark-command",
    benchmarkCommand,
    "--benchmark-prints-metric",
    "true",
    "--checks-command",
    `${quoteForAcceptedShell(process.execPath)} contract/checks.mjs`,
    "--scope",
    "src",
    "--commit-paths",
    "src",
    "--protected-benchmark-paths",
    protectedBenchmarkPath,
    "--packet-budget",
    "6",
    "--max-iterations",
    "6",
  ]);

  const configPath = path.join(dir, "autoresearch.config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.checkImplementationPaths = ["contract/checks.mjs"];
  config.checksAuthoritative = true;
  config.noiseModel = { kind: "deterministic" };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await assertCliOk([
    "new-segment",
    "--cwd",
    dir,
    "--reason",
    "Accept the protected benchmark contract",
    "--yes",
  ]);
}

function assertEvaluatorDriftDecision(payload, message) {
  const plan = payload.decisionPlanProjection;
  assert.equal(plan.primaryBlockerCode, "legacy-contract-conflict");
  assert.equal(plan.requiredEvidence.diagnosticCodes.includes("evaluator-drift"), true);
  assert.equal(plan.capabilities["run-packet"], "blocked");
  assert.equal(plan.capabilities["authorize-keep"], "blocked");
  assert.match(JSON.stringify([payload.issues, payload.warnings]), message);
}

function assertEvaluatorDriftMutationFailure(result) {
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.code, "mutation-precondition-blocked");
  const plan = failure.preconditionDecision;
  assert.equal(plan.requiredEvidence.diagnosticCodes.includes("evaluator-drift"), true);
  assert.equal(plan.capabilities["run-packet"], "blocked");
  assert.equal(plan.capabilities["authorize-keep"], "blocked");
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
