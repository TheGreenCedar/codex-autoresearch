import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { renderExportedDashboard } from "../helpers/dashboard-export.js";
import { quoteForShell } from "../helpers/process.js";

import {
  runCli,
  withTempDir,
  setupFixture as setupSessionFixture,
} from "../helpers/cli-test-context.js";

async function setupFixture(dir: string, options: Parameters<typeof setupSessionFixture>[1] = {}) {
  const result = await setupSessionFixture(dir, options);
  await mkdir(path.join(dir, "src"), { recursive: true });
  const checksFile =
    process.platform === "win32" ? "autoresearch.checks.ps1" : "autoresearch.checks.sh";
  await writeFile(
    path.join(dir, checksFile),
    process.platform === "win32" ? "exit 0\n" : "#!/usr/bin/env bash\nexit 0\n",
  );
  await writeFile(
    path.join(dir, "autoresearch.config.json"),
    `${JSON.stringify(
      {
        checksAuthoritative: true,
        commitPaths: ["src"],
        maxIterations: 100,
        noiseModel: { kind: "deterministic" },
      },
      null,
      2,
    )}\n`,
  );
  return result;
}

async function appendLegacyLedgerRows(dir: string, rows: Record<string, unknown>[]) {
  const ledgerPath = path.join(dir, "autoresearch.jsonl");
  const ledger = await readFile(ledgerPath, "utf8");
  await writeFile(
    ledgerPath,
    `${ledger}${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
}

test("next returns only mechanically eligible decision options instead of a fake status", async () => {
  await withTempDir("decision-hint", async (dir) => {
    await setupFixture(dir, { name: "decision hint" });

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1.25')"`;
    const result = await runCli(["next", "--cwd", dir, "--command", command]);
    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout).run;
    assert.equal(payload.ok, true);
    assert.equal(payload.logHint.status, null);
    assert.equal(payload.logHint.needsDecision, true);
    assert.deepEqual(payload.logHint.allowedStatuses, ["discard", "measure"]);
  });
});

test("state and dashboard math keep zero-valued metrics visible", async () => {
  await withTempDir("zero-metric", async (dir) => {
    await setupFixture(dir, { name: "zero metric", metricName: "failures" });
    await appendLegacyLedgerRows(dir, [
      { run: 1, metric: 0, status: "keep", description: "Reach zero failures" },
    ]);

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
    await setupFixture(dir, { name: "public scrub" });
    const localPath = "D:\\Sensitive\\client\\file.txt";
    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "measure",
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
    await setupFixture(dir, { name: "metrics file" });
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
      "measure",
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
    assert.equal(payload.experiment.evidenceStatus, "provisional");
    assert.equal(payload.experiment.promotion.label, "measurement");
  });
});

test("log succeeds with recovery warning when session note update fails", async () => {
  await withTempDir("log-note-warning", async (dir) => {
    await setupFixture(dir, { name: "note warning" });
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
    await setupFixture(dir, { name: "negative metric", metricName: "delta", direction: "lower" });
    await appendLegacyLedgerRows(dir, [
      { run: 1, metric: 1, status: "keep", description: "Baseline positive delta" },
      { run: 2, metric: -2, status: "keep", description: "Beat baseline below zero" },
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
    assert.match(chart, /2 chart-eligible runs out of 2 logged runs/);
    assert.match(chart, /#2 · Keep · -2/);
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
    assert.equal(payload.parseErrors.length, 1);
    assert.equal(payload.parseErrors[0].line, 2);
    assert.match(payload.resolvedDecision.canonicalNextAction.command, /ledger-doctor\b.*--json/);
    for (const alias of [
      "resumeAudit",
      "decisionEnvelope",
      "canonicalNextAction",
      "loopContract",
    ]) {
      assert.equal(Object.hasOwn(payload, alias), false, alias);
    }

    const full = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(full.code, 0, full.stderr);
    const fullPayload = JSON.parse(full.stdout);
    assert.equal(fullPayload.resolvedDecision.status, "blocked");
    assert.equal(Object.hasOwn(fullPayload, "decisionEnvelope"), false);

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

    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
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
    assert.equal(payload.goalContract.status, "warning");
  });
});

test("discarded metrics do not become best or suppress on-improvement checks", async () => {
  await withTempDir("discarded-best", async (dir) => {
    await setupFixture(dir, { name: "discarded best", direction: "lower" });
    const checksFile =
      process.platform === "win32" ? "autoresearch.checks.ps1" : "autoresearch.checks.sh";
    const checksBody = process.platform === "win32" ? "exit 1\n" : "#!/bin/sh\nexit 1\n";
    await writeFile(path.join(dir, checksFile), checksBody, "utf8");
    await appendLegacyLedgerRows(dir, [
      { run: 1, metric: 10, status: "keep", description: "Legacy accepted baseline" },
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

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=7')"`;
    const result = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "on-improvement",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout).run;
    assert.equal(payload.improvesPrimary, true);
    assert.equal(payload.checks?.passed, false);
    assert.equal(payload.ok, false);
    assert.deepEqual(payload.logHint.allowedStatuses, ["checks_failed"]);
  });
});
