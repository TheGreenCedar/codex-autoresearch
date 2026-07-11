import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PLUGIN_VERSION } from "../lib/plugin-version.js";
import { serveDashboard } from "../lib/commands/dashboard.js";
import { verifyDashboardHealthSummary } from "../lib/dashboard-health.js";
import {
  LIVE_LEDGER_MAX_ENTRIES,
  LIVE_RESEARCH_FINGERPRINT_MAX_ENTRIES,
  liveSessionFingerprint,
  serveAutoresearch,
} from "../lib/live-server.js";
import {
  buildServeRegistryHealthInput,
  readServeRegistry,
  registryPathForWorkDir,
  summarizeServeRegistry,
  writeServeRegistry,
} from "../lib/dashboard-server-registry.js";
import { resolveSessionPaths, sessionPathIdentity } from "../lib/session-paths.js";
import { withTempDir } from "./helpers/process.js";

async function requestText(url: string, headers: Record<string, string> = {}) {
  return await new Promise<{
    body: string;
    headers: http.IncomingHttpHeaders;
    status: number;
  }>((resolve, reject) => {
    const req = http.request(url, { headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve({ body, headers: res.headers, status: res.statusCode || 0 }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("serve dashboard command reuses a healthy registry instead of starting another server", async () => {
  await withTempDir("autoresearch", "serve-registry-reuse", async (dir) => {
    const startedAt = "2026-06-08T00:00:00.000Z";
    const sessionPaths = resolveSessionPaths({ workDir: dir });
    const existing = await serveAutoresearch({
      cwd: dir,
      sessionPaths,
      port: 0,
      pluginVersion: PLUGIN_VERSION,
      startedAt,
      dashboardHtml: async () => "<!doctype html><title>existing</title>",
      viewModel: async () => ({ ok: true }),
    });

    try {
      await writeServeRegistry(dir, {
        pid: existing.pid,
        port: existing.port,
        cwd: dir,
        startedAt,
        version: PLUGIN_VERSION,
        healthUrl: new URL("health", existing.url).toString(),
        sessionCwd: sessionPaths.sessionCwd,
        sessionPathIdentity: sessionPathIdentity(sessionPaths),
      });

      let serveAttempts = 0;
      const runtime = {
        buildDriftReport: async () => {
          throw new Error("registry reuse should not build drift before returning");
        },
        dashboardViewModel: async () => ({}),
        resolveWorkDir: () => ({ workDir: dir, config: {}, sessionPaths }),
        serveAutoresearch: async () => {
          serveAttempts += 1;
          throw new Error("healthy registry should be reused");
        },
      };

      const result = await serveDashboard({ cwd: dir }, runtime);

      assert.equal(serveAttempts, 0);
      assert.equal(result.ok, true);
      assert.equal(result.mode, "live");
      assert.equal(result.registryReused, true);
      assert.equal(result.detached, true);
      assert.equal(result.url, existing.url);
      assert.equal(result.dashboardUrl, existing.url);
      assert.equal(result.healthUrl, new URL("health", existing.url).toString());
      assert.equal(result.pid, process.pid);
      assert.match(result.recoveryCommand, /node scripts\/autoresearch\.mjs serve --cwd /);
    } finally {
      await new Promise<void>((resolve, reject) => {
        existing.server.close((error: Error | undefined) => (error ? reject(error) : resolve()));
      });
    }
  });
});

test("serve dashboard command does not reuse target-cwd registry for wrapper session cwd", async () => {
  await withTempDir("autoresearch", "serve-registry-wrapper-session", async (root) => {
    const wrapper = path.join(root, "wrapper");
    const target = path.join(root, "target");
    await mkdir(wrapper, { recursive: true });
    await mkdir(target, { recursive: true });
    const targetSessionPaths = resolveSessionPaths({ workDir: target });
    const wrapperSessionPaths = resolveSessionPaths({ sessionCwd: wrapper, workDir: target });
    const startedAt = "2026-06-08T00:00:00.000Z";
    const existing = await serveAutoresearch({
      cwd: target,
      sessionPaths: targetSessionPaths,
      port: 0,
      pluginVersion: PLUGIN_VERSION,
      startedAt,
      dashboardHtml: async () => "<!doctype html><title>target session</title>",
      viewModel: async () => ({ ok: true }),
    });
    const fakeServer = {
      on() {
        return fakeServer;
      },
    };

    try {
      await writeServeRegistry(target, {
        pid: existing.pid,
        port: existing.port,
        cwd: target,
        startedAt,
        version: PLUGIN_VERSION,
        healthUrl: new URL("health", existing.url).toString(),
        sessionCwd: targetSessionPaths.sessionCwd,
        sessionPathIdentity: sessionPathIdentity(targetSessionPaths),
      });

      let serveAttempts = 0;
      const runtime = {
        buildDriftReport: async () => ({ ok: true }),
        dashboardViewModel: async () => ({}),
        resolveWorkDir: () => ({ workDir: target, config: {}, sessionPaths: wrapperSessionPaths }),
        serveAutoresearch: async () => {
          serveAttempts += 1;
          return {
            debugLedger: false,
            port: 9,
            server: fakeServer,
            url: "http://127.0.0.1:9/",
            workDir: target,
          };
        },
      };

      const result = await serveDashboard({ cwd: wrapper }, runtime);

      assert.equal(serveAttempts, 1);
      assert.equal(result.registryReused, false);
      assert.equal(result.url, "http://127.0.0.1:9/");
      const record = await readServeRegistry(target);
      assert.equal(record?.sessionCwd, path.resolve(wrapper));
      assert.equal(record?.sessionPathIdentity, sessionPathIdentity(wrapperSessionPaths));
    } finally {
      await new Promise<void>((resolve, reject) => {
        existing.server.close((error: Error | undefined) => (error ? reject(error) : resolve()));
      });
    }
  });
});

test("serve dashboard resolves config fresh for deferred live view model", async () => {
  await withTempDir("autoresearch", "serve-fresh-config", async (dir) => {
    let configVersion = 1;
    let capturedViewModel: (() => Promise<Record<string, any>>) | null = null;
    const fakeServer = {
      on() {
        return fakeServer;
      },
    };
    const runtime = {
      buildDriftReport: async () => ({ ok: true, status: "fresh" }),
      dashboardViewModel: async (_workDir, config) => ({ summary: { runs: config.version } }),
      resolveWorkDir: () => ({
        workDir: dir,
        config: { dashboardRefreshSeconds: 1, version: configVersion },
        sessionPaths: resolveSessionPaths({ workDir: dir }),
      }),
      serveAutoresearch: async (options) => {
        capturedViewModel = options.viewModel;
        return {
          debugLedger: false,
          port: 9,
          server: fakeServer,
          url: "http://127.0.0.1:9/",
          workDir: dir,
        };
      },
    };

    await serveDashboard({ cwd: dir, port: 0 }, runtime);
    assert.ok(capturedViewModel);
    const first = await capturedViewModel();
    configVersion = 2;
    const second = await capturedViewModel();

    assert.equal(first.summary.runs, 1);
    assert.equal(second.summary.runs, 2);
  });
});

test("serve registry writes pid port cwd and version in git repos", async () => {
  await withTempDir("autoresearch", "serve-registry-git", async (dir) => {
    await mkdir(path.join(dir, ".git"), { recursive: true });
    const registryPath = registryPathForWorkDir(dir);

    await writeServeRegistry(dir, {
      pid: process.pid,
      port: 60123,
      cwd: dir,
      startedAt: "2026-05-31T00:00:00.000Z",
      version: PLUGIN_VERSION,
      healthUrl: "http://127.0.0.1:60123/health",
    });

    const parsed = JSON.parse(await readFile(registryPath, "utf8"));
    assert.equal(registryPath, path.join(dir, ".git", "autoresearch", "serve-registry.json"));
    assert.equal(parsed.pid, process.pid);
    assert.equal(parsed.port, 60123);
    assert.equal(parsed.cwd, path.resolve(dir));
    assert.equal(parsed.version, PLUGIN_VERSION);
    assert.equal(parsed.healthUrl, "http://127.0.0.1:60123/health");
  });
});

test("serve registry falls back to runtime directory outside git", async () => {
  await withTempDir("autoresearch", "serve-registry-non-git", async (dir) => {
    const registryPath = registryPathForWorkDir(dir);

    await writeServeRegistry(dir, {
      pid: process.pid,
      port: 60124,
      cwd: dir,
      startedAt: "2026-05-31T00:00:00.000Z",
      version: PLUGIN_VERSION,
      healthUrl: "http://127.0.0.1:60124/health",
    });

    const record = await readServeRegistry(dir);
    assert.equal(
      registryPath,
      path.join(dir, "autoresearch.research", ".runtime", "serve-registry.json"),
    );
    assert.equal(record?.port, 60124);
  });
});

test("serve registry summary distinguishes same and different cwd", () => {
  const record = {
    pid: process.pid,
    port: 60125,
    cwd: "C:/work/current",
    startedAt: "2026-05-31T00:00:00.000Z",
    version: PLUGIN_VERSION,
    healthUrl: "http://127.0.0.1:60125/health",
  };

  const same = summarizeServeRegistry(record, {
    currentPid: process.pid,
    currentCwd: "C:/work/current",
  });
  const different = summarizeServeRegistry(record, {
    currentPid: process.pid,
    currentCwd: "C:/work/other",
  });

  assert.equal(same.stale, false);
  assert.equal(same.cwdRelation, "same-cwd");
  assert.equal(same.currentProcess, true);
  assert.equal(different.stale, true);
  assert.equal(different.cwdRelation, "different-cwd");
});

test("serve registry health input verifies the requested child cwd in shared git roots", async () => {
  await withTempDir("autoresearch", "serve-registry-shared-git", async (dir) => {
    await mkdir(path.join(dir, ".git"), { recursive: true });
    const firstChild = path.join(dir, "packages", "first");
    const secondChild = path.join(dir, "packages", "second");
    await mkdir(firstChild, { recursive: true });
    await mkdir(secondChild, { recursive: true });

    await writeServeRegistry(firstChild, {
      pid: process.pid,
      port: 60126,
      cwd: firstChild,
      startedAt: "2026-05-31T00:00:00.000Z",
      version: PLUGIN_VERSION,
      healthUrl: "http://127.0.0.1:60126/health",
    });

    const record = await readServeRegistry(secondChild);
    const healthInput = buildServeRegistryHealthInput(secondChild, record, { timeoutMs: 1000 });
    assert.equal(healthInput.cwd, path.resolve(secondChild));
    assert.equal(healthInput.previous.stale, true);
    assert.equal(healthInput.previous.cwdRelation, "different-cwd");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          dashboard: {
            port: 60126,
            cwd: path.resolve(firstChild),
            version: PLUGIN_VERSION,
            liveness: "alive",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    try {
      const summary = await verifyDashboardHealthSummary(healthInput);
      assert.equal(summary.liveness, "unknown");
      assert.equal(summary.stale, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("serve registry health verification uses the current plugin version expectation", async () => {
  await withTempDir("autoresearch", "serve-registry-old-version", async (dir) => {
    const oldVersion = "0.1.0";
    const record = {
      pid: process.pid,
      port: 60127,
      cwd: dir,
      startedAt: "2026-05-31T00:00:00.000Z",
      version: oldVersion,
      healthUrl: "http://127.0.0.1:60127/health",
    };

    const healthInput = buildServeRegistryHealthInput(dir, record, {
      expectedVersion: PLUGIN_VERSION,
      timeoutMs: 1000,
    });
    assert.equal(healthInput.version, PLUGIN_VERSION);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          dashboard: {
            port: 60127,
            cwd: path.resolve(dir),
            version: oldVersion,
            liveness: "alive",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    try {
      const summary = await verifyDashboardHealthSummary(healthInput);
      assert.equal(summary.liveness, "unknown");
      assert.equal(summary.stale, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("live dashboard health endpoint exposes read-only process metadata", async () => {
  await withTempDir("autoresearch", "serve-health", async (dir) => {
    const startedAt = "2026-06-01T00:00:00.000Z";
    const result = await serveAutoresearch({
      cwd: dir,
      port: 0,
      pluginVersion: PLUGIN_VERSION,
      startedAt,
      dashboardHtml: async () => "<!doctype html><title>Autoresearch</title>",
      viewModel: async () => ({ ok: true }),
    });

    try {
      assert.equal(result.pid, process.pid);
      assert.equal(result.cwd, path.resolve(dir));
      assert.equal(result.version, PLUGIN_VERSION);
      assert.equal(result.startedAt, startedAt);

      const response = await fetch(new URL("health", result.url));
      assert.equal(response.ok, true);
      const payload = await response.json();
      assert.equal(payload.ok, true);
      assert.equal(payload.dashboard.pid, process.pid);
      assert.equal(payload.dashboard.port, result.port);
      assert.equal(payload.dashboard.version, PLUGIN_VERSION);
      assert.equal(
        payload.dashboard.sessionIdentity,
        sessionPathIdentity(resolveSessionPaths({ workDir: dir })),
      );
      assert.deepEqual(Object.keys(payload.dashboard).sort(), [
        "liveness",
        "mode",
        "pid",
        "port",
        "sessionIdentity",
        "version",
      ]);
      assert.doesNotMatch(JSON.stringify(payload), new RegExp(dir.replaceAll("\\", "\\\\"), "i"));
    } finally {
      await new Promise<void>((resolve, reject) => {
        result.server.close((error: Error | undefined) => (error ? reject(error) : resolve()));
      });
    }
  });
});

test("live dashboard validates Host and sends defensive headers", async () => {
  await withTempDir("autoresearch", "serve-host-headers", async (dir) => {
    const result = await serveAutoresearch({
      cwd: dir,
      port: 0,
      pluginVersion: PLUGIN_VERSION,
      dashboardHtml: async () => "<!doctype html><title>Autoresearch</title>",
      viewModel: async () => ({ ok: true }),
    });

    try {
      const hostile = await requestText(`${result.url}health`, {
        Host: `evil.example:${result.port}`,
      });
      assert.equal(hostile.status, 403);
      assert.match(hostile.body, /Host header is not allowed/);

      const loopback = await requestText(`${result.url}health`, {
        Host: `localhost:${result.port}`,
      });
      assert.equal(loopback.status, 200);
      assert.equal(loopback.headers["x-content-type-options"], "nosniff");
      assert.equal(loopback.headers["x-frame-options"], "DENY");
      assert.equal(loopback.headers["referrer-policy"], "no-referrer");
      assert.match(String(loopback.headers["content-security-policy"]), /frame-ancestors 'none'/);
      assert.equal(loopback.headers["cache-control"], "no-store");
    } finally {
      await new Promise<void>((resolve, reject) => {
        result.server.close((error: Error | undefined) => (error ? reject(error) : resolve()));
      });
    }
  });
});

test("live dashboard fingerprints research trees with a bounded traversal", async () => {
  await withTempDir("autoresearch", "serve-fingerprint-cap", async (dir) => {
    const researchRoot = path.join(dir, "autoresearch.research");
    await mkdir(researchRoot, { recursive: true });
    for (let index = 0; index < LIVE_RESEARCH_FINGERPRINT_MAX_ENTRIES + 25; index += 1) {
      await writeFile(path.join(researchRoot, `artifact-${index}.json`), "{}\n", "utf8");
    }

    const fingerprint = await liveSessionFingerprint(dir, {
      cached: null,
      nowMs: Date.now(),
      ttlMs: 0,
    });

    assert.match(fingerprint, /autoresearch\.research:truncated:/);
  });
});

test("live dashboard keeps debug ledger disabled unless explicitly enabled", async () => {
  await withTempDir("autoresearch", "serve-debug-ledger", async (dir) => {
    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      `${JSON.stringify({ type: "config", secret: "abcdefghijklmnop" })}\n`,
      "utf8",
    );
    const disabled = await serveAutoresearch({
      cwd: dir,
      port: 0,
      pluginVersion: PLUGIN_VERSION,
      dashboardHtml: async () => "<!doctype html><title>Autoresearch</title>",
      viewModel: async () => ({ ok: true }),
    });
    const enabled = await serveAutoresearch({
      cwd: dir,
      port: 0,
      pluginVersion: PLUGIN_VERSION,
      debugLedger: true,
      dashboardHtml: async () => "<!doctype html><title>Autoresearch</title>",
      viewModel: async () => ({ ok: true }),
    });

    try {
      const disabledLedger = await requestText(`${disabled.url}autoresearch.jsonl`, {
        Host: `127.0.0.1:${disabled.port}`,
      });
      assert.equal(disabledLedger.status, 404);
      assert.match(disabledLedger.body, /disabled/);

      const enabledLedger = await requestText(`${enabled.url}autoresearch.jsonl`, {
        Host: `127.0.0.1:${enabled.port}`,
      });
      assert.equal(enabledLedger.status, 200);
      assert.doesNotMatch(enabledLedger.body, /abcdefghijklmnop/);
      assert.match(enabledLedger.body, /"<redacted>"/);
    } finally {
      await Promise.all(
        [disabled, enabled].map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              server.server.close((error: Error | undefined) =>
                error ? reject(error) : resolve(),
              );
            }),
        ),
      );
    }
  });
});

test("live dashboard debug ledger response is bounded before redaction", async () => {
  await withTempDir("autoresearch", "serve-debug-ledger-bounds", async (dir) => {
    const malformedLineCount = 6_000;
    const runCount = LIVE_LEDGER_MAX_ENTRIES + 3;
    const lines = [
      ...Array.from({ length: malformedLineCount }, (_, index) => `{malformed-${index}`),
      JSON.stringify({ type: "config", name: "debug bounds", metricName: "seconds" }),
      ...Array.from({ length: runCount }, (_, index) =>
        JSON.stringify({ type: "run", run: index + 1, status: "keep", metric: index + 1 }),
      ),
      "",
    ];
    await writeFile(path.join(dir, "autoresearch.jsonl"), lines.join("\n"), "utf8");
    const server = await serveAutoresearch({
      cwd: dir,
      port: 0,
      pluginVersion: PLUGIN_VERSION,
      debugLedger: true,
      dashboardHtml: async () => "<!doctype html><title>Autoresearch</title>",
      viewModel: async () => ({ ok: true }),
    });

    try {
      const response = await requestText(`${server.url}autoresearch.jsonl`, {
        Host: `127.0.0.1:${server.port}`,
      });
      const responseLines = response.body.split(/\r?\n/).filter(Boolean);

      assert.equal(response.status, 200);
      assert.equal(responseLines.length, LIVE_LEDGER_MAX_ENTRIES);
      assert.doesNotMatch(response.body, /malformed-0/);
      assert.match(response.body, /"type":"config"/);
      assert.match(response.body, /"run":5/);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.server.close((error: Error | undefined) => (error ? reject(error) : resolve()));
      });
    }
  });
});
