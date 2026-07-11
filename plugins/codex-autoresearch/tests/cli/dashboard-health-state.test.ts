import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { PLUGIN_VERSION } from "../../lib/plugin-version.js";
import { resolveSessionPaths, sessionPathIdentity } from "../../lib/session-paths.js";
import { writeServeRegistry } from "../../lib/dashboard-server-registry.js";
import { renderExportedDashboard } from "../helpers/dashboard-export.js";
import { quoteForShell } from "../helpers/process.js";
import { addressPort, closeServer, listenOnRandomPort } from "../helpers/server.js";

import { runCli, withTempDir, git } from "../helpers/cli-test-context.js";

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
    assert.equal(Object.hasOwn(compactPayload.dashboardHealth, "registryPath"), false);
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
    const expectedSessionIdentity = sessionPathIdentity(
      resolveSessionPaths({ sessionCwd: dir, workDir: dir }),
    );
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

    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
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

    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
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
