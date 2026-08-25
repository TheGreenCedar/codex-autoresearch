import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { PLUGIN_VERSION } from "../../lib/plugin-version.js";
import { resolveSessionPaths, sessionPathIdentity } from "../../lib/session-paths.js";
import { writeServeRegistry } from "../../lib/dashboard-server-registry.js";
import { renderExportedDashboard } from "../helpers/dashboard-export.js";
import { quoteForAcceptedShell } from "../helpers/process.js";
import { addressPort, closeServer, listenOnRandomPort } from "../helpers/server.js";

import { runCli, withTempDir, git, setupFixture } from "../helpers/cli-test-context.js";

async function appendLegacyLedgerRows(dir: string, rows: Record<string, unknown>[]) {
  const ledgerPath = path.join(dir, "autoresearch.jsonl");
  const ledger = await readFile(ledgerPath, "utf8");
  await writeFile(
    ledgerPath,
    `${ledger}${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
}

test("state report marks registry-only dashboard health dead until HTTP responds", async () => {
  await withTempDir("state-report-dashboard-health", async (dir) => {
    await setupFixture(dir, { name: "dashboard health" });
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
    assert.equal(Object.hasOwn(compactPayload.dashboardHealth, "registryPath"), false);
  });
});

test("state report does not call a fake same-process registry a live dashboard", async () => {
  await withTempDir("state-report-dashboard-fake-same-process", async (dir) => {
    await setupFixture(dir, { name: "fake dashboard health" });
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
    await setupFixture(dir, { name: "static fake dashboard health" });
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
    const expectedSessionIdentity = sessionPathIdentity(
      resolveSessionPaths({ sessionCwd: dir, workDir: dir }),
    );
    await mkdir(otherDir, { recursive: true });
    await setupFixture(dir, { name: "wrong cwd dashboard health" });
    const server = createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: true,
            dashboard: {
              pid: process.pid,
              port: addressPort(server),
              sessionIdentity: sessionPathIdentity(
                resolveSessionPaths({ sessionCwd: otherDir, workDir: otherDir }),
              ),
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
        sessionCwd: dir,
        sessionPathIdentity: expectedSessionIdentity,
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
    const expectedSessionIdentity = sessionPathIdentity(
      resolveSessionPaths({ sessionCwd: dir, workDir: dir }),
    );
    await setupFixture(dir, { name: "alive dashboard health" });
    const server = createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: true,
            dashboard: {
              pid: process.pid,
              port: addressPort(server),
              sessionIdentity: expectedSessionIdentity,
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
        sessionCwd: dir,
        sessionPathIdentity: expectedSessionIdentity,
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
    const command = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=5')"`;
    await setupFixture(dir, {
      name: "legacy sentinel",
      acceptedContract: true,
      benchmarkCommand: command,
    });
    await appendLegacyLedgerRows(dir, [
      {
        run: 1,
        metric: -999,
        status: "crash",
        description: "Legacy sentinel failure",
      },
    ]);

    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(state.code, 0, state.stderr);
    assert.equal(JSON.parse(state.stdout).baseline, null);

    const next = await runCli(["next", "--cwd", dir, "--checks-policy", "manual"]);
    assert.equal(next.code, 0, next.stderr);
    const payload = JSON.parse(next.stdout);
    assert.equal(payload.decision.rawSuggestedStatus, "measure");
    assert.equal(payload.decision.safeSuggestedStatus, "measure");
  });
});

test("metricless failed last-run packets log cleanly and preserve packet on invalid status", async () => {
  await withTempDir("metricless-last-run", async (dir) => {
    const command = `${quoteForAcceptedShell(process.execPath)} -e "process.exit(1)"`;
    await setupFixture(dir, {
      name: "metricless last run",
      acceptedContract: true,
      benchmarkCommand: command,
    });

    const next = await runCli(["next", "--cwd", dir, "--checks-policy", "manual"]);
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
    const refusal = JSON.parse(invalid.stderr);
    assert.equal(refusal.code, "mutation-precondition-blocked");
    assert.equal(refusal.preconditionDecision.capabilities["authorize-keep"], "blocked");
    assert.ok(
      refusal.preconditionDecision.requiredEvidence.diagnosticCodes.includes(
        "packet-keep-not-authorized",
      ),
    );
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
    await setupFixture(dir, { name: "metric required", acceptedContract: true });

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

    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
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

test("last-run packet keeps source clean while contract acceptance dirties only the session ledger", async () => {
  await withTempDir("git-last-run", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial"]);

    const command = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    await setupFixture(dir, {
      name: "git last run",
      completeContract: true,
      benchmarkCommand: command,
    });
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "session"]);
    const accepted = await runCli([
      "new-segment",
      "--cwd",
      dir,
      "--reason",
      "Accept the clean Git packet fixture",
      "--yes",
    ]);
    assert.equal(accepted.code, 0, accepted.stderr);

    const next = await runCli(["next", "--cwd", dir, "--checks-policy", "manual"]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.doesNotMatch(packet.lastRunPath, /autoresearch\.last-run\.json$/);

    const statusBeforeLog = await git(dir, ["status", "--short"]);
    assert.equal(statusBeforeLog, "M autoresearch.jsonl");
    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.sourceCleanliness.sourceDirty, false);
    assert.equal(statePayload.sourceCleanliness.status, "session-artifacts-dirty");

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

test("no-change packet cannot record a fake kept commit", async () => {
  await withTempDir("no-change-keep", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    const command = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=1')"`;
    await mkdir(path.join(dir, "contract"), { recursive: true });
    await writeFile(path.join(dir, "contract", "checks.mjs"), "process.exit(0);\n", "utf8");
    await setupFixture(dir, {
      name: "no change keep",
      benchmarkCommand: command,
      checksCommand: `${quoteForAcceptedShell(process.execPath)} contract/checks.mjs`,
      completeContract: true,
    });
    const configPath = path.join(dir, "autoresearch.config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          ...config,
          checkImplementationPaths: ["contract/checks.mjs"],
          checksAuthoritative: true,
          noiseModel: { kind: "deterministic" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "session"]);
    const headBefore = await git(dir, ["rev-parse", "HEAD"]);
    const segment = await runCli([
      "new-segment",
      "--cwd",
      dir,
      "--reason",
      "Accept no-change test contract",
      "--yes",
    ]);
    assert.equal(segment.code, 0, segment.stderr);
    const baseline = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "2",
      "--status",
      "measure",
      "--description",
      "Accepted reference observation",
    ]);
    assert.equal(baseline.code, 0, baseline.stderr);

    const next = await runCli(["next", "--cwd", dir]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.decision.allowedStatuses.includes("keep"), true);

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Keep evidence without file changes",
    ]);
    assert.notEqual(log.code, 0);
    assert.match(log.stderr, /Refusing a no-op keep/);
    assert.equal(await git(dir, ["rev-parse", "HEAD"]), headBefore);
  });
});

test("config extend is based on the active segment run count", async () => {
  await withTempDir("segment-extend", async (dir) => {
    await setupFixture(dir, { name: "first segment" });
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
    await setupFixture(dir, { name: "second segment" });

    const result = await runCli(["config", "--cwd", dir, "--extend", "4"]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.config.maxIterations, 4);

    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.limit.maxIterations, 4);
    assert.equal(statePayload.limit.remainingIterations, 4);
  });
});

test("dashboard script renders zero and negative metric points", async () => {
  await withTempDir("dashboard-runtime", async (dir) => {
    const benchmarkCommand = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC delta=0')"`;
    await setupFixture(dir, {
      name: "runtime dashboard",
      metricName: "delta",
      direction: "lower",
      completeContract: true,
      benchmarkCommand,
    });
    await appendLegacyLedgerRows(dir, [
      { type: "run", run: 1, metric: 0, status: "keep", description: "Zero baseline" },
      { type: "run", run: 2, metric: -2, status: "keep", description: "Negative improvement" },
    ]);

    const exportResult = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const dashboard = await readFile(path.join(dir, "autoresearch-dashboard.html"), "utf8");
    const dom = await renderExportedDashboard(dashboard);
    const chart = dom.window.document.getElementById("trend-chart").innerHTML;
    assert.match(chart, /2 chart-eligible runs out of 2 logged runs/);
    assert.match(chart, /#2 · Keep · -2/);
    dom.window.close();
  });
});
