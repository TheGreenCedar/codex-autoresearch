import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PLUGIN_VERSION } from "../lib/plugin-version.js";
import { createDashboardCommands } from "../lib/commands/dashboard.js";
import { verifyDashboardHealthSummary } from "../lib/dashboard-health.js";
import { serveAutoresearch } from "../lib/live-server.js";
import {
  buildServeRegistryHealthInput,
  readServeRegistry,
  registryPathForWorkDir,
  summarizeServeRegistry,
  writeServeRegistry,
} from "../lib/dashboard-server-registry.js";
import { withTempDir } from "./helpers/process.js";

test("serve dashboard command reuses a healthy registry instead of starting another server", async () => {
  await withTempDir("autoresearch", "serve-registry-reuse", async (dir) => {
    const startedAt = "2026-06-08T00:00:00.000Z";
    const existing = await serveAutoresearch({
      cwd: dir,
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
      });

      let serveAttempts = 0;
      const { serveDashboard } = createDashboardCommands({
        boolOption: (value, fallback) => (typeof value === "boolean" ? value : fallback),
        buildDriftReport: async () => {
          throw new Error("registry reuse should not build drift before returning");
        },
        dashboardCommands: () => [],
        dashboardHtml: () => "",
        dashboardSettings: () => ({}),
        dashboardViewModel: async () => ({}),
        operationProgress: (options) => options,
        pluginRoot: process.cwd(),
        pluginVersion: PLUGIN_VERSION,
        readJsonl: () => [],
        resolveOutputInside: () => "",
        resolveWorkDir: () => ({ workDir: dir, config: {} }),
        serveAutoresearch: async () => {
          serveAttempts += 1;
          throw new Error("healthy registry should be reused");
        },
        shellQuote: JSON.stringify,
        writeFile: async () => {},
      });

      const result = await serveDashboard({ cwd: dir });

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
      assert.equal(payload.dashboard.startedAt, startedAt);
      assert.equal(payload.dashboard.actions, undefined);
    } finally {
      await new Promise<void>((resolve, reject) => {
        result.server.close((error: Error | undefined) => (error ? reject(error) : resolve()));
      });
    }
  });
});
