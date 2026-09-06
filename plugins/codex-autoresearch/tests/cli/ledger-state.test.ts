import assert from "node:assert/strict";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { analyzeLedgerHealth, repairLedgerRecords } from "../../lib/ledger-health.js";
import { parseLedger, writeLedger } from "../helpers/ledger.js";
import { pathExists } from "../helpers/cli-session.js";

import { runCli, withTempDir, git } from "../helpers/cli-test-context.js";

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
    assert.equal(payload.parseErrors.length, 1);
    assert.equal(payload.ledgerHealth.parseErrors[0].line, 2);
    assert.equal(payload.ledgerHealth.bounded.truncated, false);
    assert.match(payload.ledgerHealth.warnings.join("\n"), /Malformed JSONL lines: 2/);
    assert.equal(await readFile(ledgerPath, "utf8"), before);
  });
});

test("wrong-shaped ledger evidence stays diagnostic and blocks accepted state", async () => {
  await withTempDir("ledger-record-shape", async (dir) => {
    const ledgerPath = path.join(dir, "autoresearch.jsonl");
    await writeFile(
      ledgerPath,
      [
        JSON.stringify({ type: "config", metricName: "seconds", bestDirection: "lower" }),
        "null",
        JSON.stringify({ run: 1, metric: 5, status: "keep" }),
        "",
      ].join("\n"),
    );

    const result = await runCli(["state", "--cwd", dir]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout.trim(), "");
    assert.match(
      result.stderr,
      /Corrupt autoresearch\.jsonl at line 2 .*Expected a non-array JSON object ledger record.*Observed JSON kind: null.*ledger-doctor/s,
    );

    const exported = await runCli(["export", "--cwd", dir]);
    assert.notEqual(exported.code, 0);
    assert.match(
      `${exported.stdout}\n${exported.stderr}`,
      /Corrupt autoresearch\.jsonl at line 2 .*Observed JSON kind: null.*ledger-doctor/,
    );
    assert.equal(await pathExists(path.join(dir, "autoresearch-dashboard.html")), false);
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

    const result = await runCli(["doctor", "--cwd", dir, "--json-full"]);

    assert.equal(result.code, 1);
    assert.equal(result.stdout.trim(), "");
    assert.match(
      result.stderr,
      /Corrupt autoresearch\.jsonl at line 2 .*Invalid JSON syntax.*Observed JSON kind: invalid-json.*ledger-doctor/s,
    );
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
    if (process.platform !== "win32") {
      assert.equal((await stat(payload.backupPath)).mode & 0o777, 0o600);
    }
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

    const result = await runCli(["state", "--cwd", dir, "--json-full"]);

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ledgerHealth.ok, false);
    assert.deepEqual(payload.ledgerHealth.duplicateRuns, [1]);
    assert.match(payload.ledgerHealth.warnings.join("\n"), /Duplicate run numbers: 1/);
    assert.equal(payload.decisionPlan.kind, "decision-plan");
    assert.equal(payload.decisionPlan.primaryBlockerCode, "ledger-integrity");
    assert.equal(payload.decisionPlan.action.kind, "recover-session");
    assert.match(payload.decisionPlan.action.command, /ledger-doctor\b.*--json/);
    assert.equal(payload.decisionPlan.capabilities["mutate-session"], "recovery-only");
    assert.equal(payload.decisionPlan.capabilities["run-packet"], "blocked");
    assert.ok(payload.decisionPlan.requiredEvidence.diagnosticCodes.includes("ledger-integrity"));

    const report = await runCli(["state", "--cwd", dir, "--report", "--json"]);
    assert.equal(report.code, 0, report.stderr);
    const reportPayload = JSON.parse(report.stdout);
    assert.equal(reportPayload.report.json.status, "blocked");
    assert.equal(reportPayload.report.json.blocker, "ledger-integrity");
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

    const result = await runCli(["state", "--cwd", dir, "--json-full"]);

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

test("state exposes explicit missing product proof despite narrative success claims", async () => {
  await withTempDir("product-claim-coverage-state", async (dir) => {
    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "semantic retrieval",
          goal: "Deliver a shippable lazy semantic retrieval performance improvement.",
          productProofRequirements: [
            {
              id: "independent_product_review",
              label: "Independent product review",
              requiredForProductGrade: true,
            },
          ],
          metricName: "seconds",
          bestDirection: "lower",
        }),
        JSON.stringify({
          run: 1,
          metric: 20,
          status: "keep",
          evidenceStatus: "accepted",
          description: "Independent product review passed",
        }),
      ].join("\n") + "\n",
    );

    const result = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    const coverage = payload.productClaimCoverage;
    assert.equal(coverage.productGradeReady, false);
    assert.deepEqual(
      coverage.missingRequiredProof.map((proof) => proof.id),
      ["independent_product_review"],
    );
  });
});

test("finalize-preview exposes explicit missing product proof", async () => {
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
          productProofRequirements: [
            {
              id: "independent_product_review",
              label: "Independent product review",
              requiredForProductGrade: true,
            },
          ],
          metricName: "seconds",
          bestDirection: "lower",
        }),
        JSON.stringify({
          run: 1,
          status: "keep",
          metric: 1,
          description: "Independent product review passed",
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
    assert.deepEqual(
      payload.productClaimCoverage.missingRequiredProof.map((proof) => proof.id),
      ["independent_product_review"],
    );
    assert.match(result.stdout, /Product-grade evidence is missing/);
    assert.deepEqual(payload.productClaimCoverage.coveredProof, []);
    assert.match(result.stdout, /Experimental review branch only/);
  });
});
