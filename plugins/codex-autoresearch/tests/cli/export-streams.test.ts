import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { quoteForShell } from "../helpers/process.js";

import { runCli, runSpawnedCli, withTempDir, setupFixture } from "../helpers/cli-test-context.js";

async function appendLegacyLedgerRows(dir: string, rows: Record<string, unknown>[]) {
  const ledgerPath = path.join(dir, "autoresearch.jsonl");
  const ledger = await readFile(ledgerPath, "utf8");
  await writeFile(
    ledgerPath,
    `${ledger}${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
}

test("export refuses to write outside the working directory", async () => {
  await withTempDir("contained-export", async (dir) => {
    await setupFixture(dir, { name: "contained export" });
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
    await setupFixture(dir, { name: "linked export" });
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
    await setupFixture(dir, { name: "compact export", acceptedContract: true });
    await appendLegacyLedgerRows(dir, [
      { run: 1, metric: 1, status: "keep", description: "Baseline" },
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
    await setupFixture(dir, { name: "export progress" });

    const result = await runSpawnedCli(["export", "--cwd", dir, "--json-full", "--progress"]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.match(result.stderr, /\[autoresearch:export]/);
  });
});

test("large benchmark output is capped and marked truncated", async () => {
  await withTempDir("large-output", async (dir) => {
    const command = `${quoteForShell(process.execPath)} -e "console.log('x'.repeat(30000)); console.log('METRIC seconds=1')"`;
    await setupFixture(dir, {
      name: "large output",
      completeContract: true,
      benchmarkCommand: command,
    });
    const result = await runCli(["next", "--cwd", dir]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout).run;
    assert.equal(payload.outputTruncated, true);
    assert.ok(payload.tailOutput.length < 9000);
    assert.equal(payload.parsedPrimary, 1);
  });
});

test("large no-newline benchmark tails do not hide early metrics", async () => {
  await withTempDir("large-no-newline-output", async (dir) => {
    const command = `${quoteForShell(process.execPath)} -e "process.stdout.write('METRIC seconds=2\\n'); process.stdout.write('x'.repeat(300000))"`;
    await setupFixture(dir, {
      name: "large no newline",
      completeContract: true,
      benchmarkCommand: command,
    });
    const result = await runCli(["next", "--cwd", dir]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout).run;
    assert.equal(payload.outputTruncated, true);
    assert.ok(payload.tailOutput.length < 9000);
    assert.equal(payload.parsedPrimary, 2);
  });
});

test("large metric streams retain bounded metrics and primary evidence", async () => {
  await withTempDir("large-metric-stream", async (dir) => {
    const command = `${quoteForShell(process.execPath)} -e "for (let i = 0; i < 20000; i++) console.log('METRIC m' + i + '=' + i); console.log('METRIC seconds=1')"`;
    await setupFixture(dir, {
      name: "large metric stream",
      completeContract: true,
      benchmarkCommand: command,
    });
    const result = await runCli(["next", "--cwd", dir]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout).run;
    assert.equal(payload.metricsTruncated, true);
    assert.equal(payload.parsedPrimary, 1);
    assert.equal(payload.parsedMetrics.seconds, 1);
    assert.ok(Object.keys(payload.parsedMetrics).length <= 513);
  });
});

test("large metric streams keep a primary metric outside retained output tails", async () => {
  await withTempDir("large-metric-primary-middle", async (dir) => {
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
        "writeMetrics('post', 20000);",
      ].join("\n"),
      "utf8",
    );
    const command = `${quoteForShell(process.execPath)} ${quoteForShell(emitter)}`;
    await setupFixture(dir, {
      name: "large primary stream",
      completeContract: true,
      benchmarkCommand: command,
    });
    const result = await runCli(["next", "--cwd", dir]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout).run;
    assert.equal(payload.ok, true);
    assert.equal(payload.metricsTruncated, true);
    assert.equal(payload.parsedPrimary, 7);
    assert.equal(payload.parsedMetrics.seconds, 7);
    assert.ok(Object.keys(payload.parsedMetrics).length <= 513);
  });
});
