import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DASHBOARD_PAYLOAD_VERSION } from "../../dashboard/src/types.js";
import { LIVE_LEDGER_MAX_ENTRIES, serveAutoresearch } from "../../lib/live-server.js";
import { resolveSessionPaths } from "../../lib/session-paths.js";
import {
  createDashboardHarness,
  dashboardConfigEntry,
  emptyCommandMeta,
  waitFor,
} from ".././helpers/dashboard.js";

const dashboard = createDashboardHarness();
const { runDashboard } = dashboard;

test.before(async () => {
  await dashboard.buildDashboardAssets();
});

test.after(async () => {
  await dashboard.cleanupBuildAssets();
});

test.afterEach(() => {
  dashboard.closeDashboardWindows();
});

test("served dashboard live refresh starts by default and can be stopped", async () => {
  const entries = [
    {
      type: "config",
      name: "served dashboard",
      metricName: "quality_gap",
      bestDirection: "lower",
      metricUnit: "gaps",
    },
    { type: "run", run: 1, metric: 1, status: "keep", description: "Baseline", confidence: 1 },
  ];
  const viewModel = {
    summary: { segment: 0, baseline: 1, best: 1, confidence: 1 },
  };
  const refreshedEntries = [
    ...entries,
    { type: "run", run: 2, metric: 0, status: "keep", description: "Improved", confidence: 2 },
  ];
  const liveViewModel = {
    summary: { segment: 0, baseline: 1, best: 0, confidence: 2, runs: 2 },
    ledgerEntries: refreshedEntries,
    ledgerBounds: { truncated: true, omittedEntries: 25, maxEntries: 5000 },
  };
  const { getById, dom } = await runDashboard(
    entries,
    {
      deliveryMode: "live-server",
      liveRefreshAvailable: true,
      liveActionsAvailable: false,
      refreshMs: 1234,
      viewModel,
    },
    {
      beforeParse(window) {
        window.__refreshFetches = [];
        window.__liveIntervalCalls = 0;
        window.__clearedLiveIntervals = [];
        window.fetch = async (url) => {
          window.__refreshFetches.push(String(url));
          if (String(url).includes("view-model")) {
            return { ok: true, json: async () => liveViewModel };
          }
          return {
            ok: false,
            status: 404,
            statusText: "Not Found",
            text: async () => "",
          };
        };
        window.setInterval = (callback, ms) => {
          window.__liveIntervalCalls += 1;
          window.__liveInterval = { callback, id: window.__liveIntervalCalls, ms };
          return window.__liveIntervalCalls;
        };
        window.clearInterval = (id) => {
          window.__clearedLiveIntervals.push(id);
          window.__clearedLiveInterval = id;
        };
      },
    },
  );

  await waitFor(
    () => dom.window.__liveInterval,
    "Live dashboard did not start refresh automatically.",
  );

  assert.equal(dom.window.__liveInterval.ms, 1234);
  await waitFor(
    () => dom.window.__refreshFetches.length >= 1,
    "Live dashboard did not refresh immediately.",
  );
  await waitFor(
    () => getById("runs-value").textContent === "2 (2 kept)",
    "Live dashboard did not refresh from embedded view-model entries.",
  );
  assert.match(
    getById("ledger-note").textContent,
    /2 runs \/ newest first \/ 25 older ledger entries omitted from snapshot/,
  );
  assert.deepEqual(dom.window.__refreshFetches, ["view-model.json"]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(dom.window.__liveIntervalCalls, 1);
  assert.equal(dom.window.__refreshFetches.length, 1);
  assert.deepEqual(dom.window.__clearedLiveIntervals, []);

  getById("live-toggle").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await waitFor(
    () => dom.window.__clearedLiveInterval === 1,
    "Live toggle did not clear the interval.",
  );
  dom.window.close();
});

test("served dashboard empty bootstrap renders live view-model instead of demo data", async () => {
  const liveEntries = [
    {
      type: "config",
      name: "package live session",
      metricName: "quality_gap",
      bestDirection: "lower",
      metricUnit: "gaps",
    },
    {
      type: "run",
      run: 1,
      metric: 0,
      status: "keep",
      description: "Package gate passed",
      confidence: 4,
    },
  ];
  const liveViewModel = {
    summary: { segment: 0, baseline: 0, best: 0, confidence: 4, runs: 1 },
    ledgerEntries: liveEntries,
    ledgerBounds: { truncated: false, omittedEntries: 0, maxEntries: 5000 },
  };
  const { getById, dom } = await runDashboard(
    [],
    {
      deliveryMode: "live-server",
      liveRefreshAvailable: true,
      liveActionsAvailable: false,
      refreshMs: 60000,
      viewModel: {},
    },
    {
      beforeParse(window) {
        window.__refreshFetches = [];
        window.fetch = async (url) => {
          window.__refreshFetches.push(String(url));
          return { ok: true, json: async () => liveViewModel };
        };
        window.setInterval = () => 1;
        window.clearInterval = () => {};
      },
    },
  );

  await waitFor(
    () => getById("runs-value").textContent === "1 (1 kept)",
    "Live dashboard kept demo data after fetching view-model entries.",
  );
  assert.match(
    dom.window.document.querySelector(".toolbar-session strong")?.textContent || "",
    /package live session/i,
  );
  assert.deepEqual(dom.window.__refreshFetches, ["view-model.json"]);
  dom.window.close();
});

test("live dashboard view model reports ledger bounds when entries are capped", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "autoresearch-live-bounds-"));
  const server = await serveAutoresearch({
    cwd: dir,
    port: 0,
    viewModelCacheTtlMs: 60_000,
    pluginVersion: "0.test",
    dashboardHtml: async () => "<!doctype html><title>bounds</title>",
    viewModel: async () => ({ summary: { runs: LIVE_LEDGER_MAX_ENTRIES + 3 } }),
  });

  try {
    const lines = [
      JSON.stringify({ type: "config", name: "bounds", metricName: "seconds" }),
      ...Array.from({ length: LIVE_LEDGER_MAX_ENTRIES + 3 }, (_, index) =>
        JSON.stringify({ type: "run", run: index + 1, status: "keep", metric: index + 1 }),
      ),
      "",
    ];
    await writeFile(path.join(dir, "autoresearch.jsonl"), lines.join("\n"), "utf8");

    const snapshot = await fetch(`${server.url}view-model.json`).then((res) => res.json());

    assert.equal(snapshot.payloadVersion, DASHBOARD_PAYLOAD_VERSION);
    assert.equal(snapshot.ledgerEntries.length, LIVE_LEDGER_MAX_ENTRIES);
    assert.deepEqual(snapshot.ledgerBounds, {
      maxEntries: LIVE_LEDGER_MAX_ENTRIES,
      omittedEntries: 4,
      truncated: true,
      totalEntries: LIVE_LEDGER_MAX_ENTRIES + 4,
      validEntries: LIVE_LEDGER_MAX_ENTRIES + 4,
      retainedEntries: LIVE_LEDGER_MAX_ENTRIES,
      summarySource: "full-ledger-stream",
      retention: "newest-rows-plus-governing-config",
    });
    assert.equal(snapshot.ledgerEntries[0].type, "config");
    assert.equal(snapshot.ledgerEntries[1].run, 5);
  } finally {
    server.server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("live dashboard ledger bounds count omitted raw ledger history before parsing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "autoresearch-live-raw-bounds-"));
  const malformedLineCount = 6_000;
  const runCount = LIVE_LEDGER_MAX_ENTRIES + 3;
  const server = await serveAutoresearch({
    cwd: dir,
    port: 0,
    viewModelCacheTtlMs: 60_000,
    pluginVersion: "0.test",
    dashboardHtml: async () => "<!doctype html><title>raw bounds</title>",
    viewModel: async () => ({ summary: { runs: runCount } }),
  });

  try {
    const lines = [
      ...Array.from({ length: malformedLineCount }, (_, index) => `{malformed-${index}`),
      JSON.stringify({ type: "config", name: "raw bounds", metricName: "seconds" }),
      ...Array.from({ length: runCount }, (_, index) =>
        JSON.stringify({ type: "run", run: index + 1, status: "keep", metric: index + 1 }),
      ),
      "",
    ];
    await writeFile(path.join(dir, "autoresearch.jsonl"), lines.join("\n"), "utf8");

    const snapshot = await fetch(`${server.url}view-model.json`).then((res) => res.json());

    assert.equal(snapshot.ledgerEntries.length, LIVE_LEDGER_MAX_ENTRIES);
    assert.equal(snapshot.ledgerBounds.maxEntries, LIVE_LEDGER_MAX_ENTRIES);
    assert.equal(snapshot.ledgerBounds.omittedEntries, malformedLineCount + 4);
    assert.equal(snapshot.ledgerBounds.truncated, true);
    assert.equal(snapshot.ledgerBounds.totalEntries, malformedLineCount + runCount + 1);
    assert.equal(snapshot.ledgerBounds.validEntries, runCount + 1);
    assert.equal(snapshot.ledgerBounds.retainedEntries, LIVE_LEDGER_MAX_ENTRIES);
    assert.equal(snapshot.ledgerBounds.summarySource, "full-ledger-stream");
    assert.equal(snapshot.ledgerBounds.retention, "newest-rows-plus-governing-config");
    assert.equal(snapshot.ledgerBounds.invalidLedgerEntryCount, malformedLineCount);
    assert.equal(snapshot.ledgerBounds.invalidLedgerEntries.length, 20);
    assert.equal(snapshot.ledgerEntries[0].type, "config");
    assert.equal(snapshot.ledgerEntries[1].run, 5);
  } finally {
    server.server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("live dashboard reports malformed ledger rows inside the visible window", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "autoresearch-live-invalid-ledger-"));
  const server = await serveAutoresearch({
    cwd: dir,
    port: 0,
    viewModelCacheTtlMs: 60_000,
    pluginVersion: "0.test",
    dashboardHtml: async () => "<!doctype html><title>invalid ledger</title>",
    viewModel: async () => ({ summary: { runs: 1 } }),
  });

  try {
    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      [
        JSON.stringify({ type: "config", name: "invalid ledger", metricName: "seconds" }),
        "null",
        JSON.stringify({ type: "run", run: 1, status: "keep", metric: 1 }),
        "",
      ].join("\n"),
      "utf8",
    );

    const snapshot = await fetch(`${server.url}view-model.json`).then((res) => res.json());
    assert.equal(snapshot.ledgerEntries.length, 2);
    assert.equal(snapshot.ledgerBounds.invalidLedgerEntryCount, 1);
    assert.equal(snapshot.ledgerBounds.invalidLedgerEntries[0].line, 2);
    assert.equal(snapshot.ledgerBounds.invalidLedgerEntries[0].kind, "null");
    assert.match(snapshot.ledgerBounds.invalidLedgerEntries[0].file, /^<workdir>[\\/]/);
    assert.match(snapshot.ledgerBounds.invalidLedgerEntries[0].message, /ledger-doctor/);
    assert.equal(JSON.stringify(snapshot).includes(dir), false);
    assert.equal(JSON.stringify(snapshot).includes(dir.replaceAll("\\", "/")), false);
  } finally {
    server.server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("live dashboard ledger bounds preserve governing config by position", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "autoresearch-live-duplicate-config-"));
  const runCount = LIVE_LEDGER_MAX_ENTRIES + 3;
  const server = await serveAutoresearch({
    cwd: dir,
    port: 0,
    viewModelCacheTtlMs: 60_000,
    pluginVersion: "0.test",
    dashboardHtml: async () => "<!doctype html><title>duplicate config</title>",
    viewModel: async () => ({ summary: { runs: runCount } }),
  });

  try {
    const configLine = JSON.stringify({
      type: "config",
      name: "duplicate config",
      metricName: "seconds",
    });
    const runLines = Array.from({ length: runCount }, (_, index) =>
      JSON.stringify({ type: "run", run: index + 1, status: "keep", metric: index + 1 }),
    );
    const lines = [configLine, ...runLines.slice(0, 10), configLine, ...runLines.slice(10), ""];
    await writeFile(path.join(dir, "autoresearch.jsonl"), lines.join("\n"), "utf8");

    const snapshot = await fetch(`${server.url}view-model.json`).then((res) => res.json());

    assert.equal(snapshot.ledgerEntries.length, LIVE_LEDGER_MAX_ENTRIES);
    assert.deepEqual(snapshot.ledgerBounds, {
      maxEntries: LIVE_LEDGER_MAX_ENTRIES,
      omittedEntries: 5,
      truncated: true,
      totalEntries: LIVE_LEDGER_MAX_ENTRIES + 5,
      validEntries: LIVE_LEDGER_MAX_ENTRIES + 5,
      retainedEntries: LIVE_LEDGER_MAX_ENTRIES,
      summarySource: "full-ledger-stream",
      retention: "newest-rows-plus-governing-config",
    });
    assert.equal(snapshot.ledgerEntries[0].type, "config");
    assert.equal(snapshot.ledgerEntries[1].run, 6);
  } finally {
    server.server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("live dashboard view model cache invalidates on session state changes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "autoresearch-live-cache-"));
  let recomputes = 0;
  const server = await serveAutoresearch({
    cwd: dir,
    port: 0,
    viewModelCacheTtlMs: 60_000,
    pluginVersion: "0.test",
    dashboardHtml: async () => "<!doctype html><title>cache</title>",
    viewModel: async () => {
      recomputes += 1;
      return { summary: { runs: recomputes } };
    },
  });

  try {
    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      [
        JSON.stringify({ type: "config", name: "cache", metricName: "seconds" }),
        JSON.stringify({ type: "run", run: 1, status: "keep", metric: 1 }),
        "",
      ].join("\n"),
      "utf8",
    );

    const first = await fetch(`${server.url}view-model.json`).then((res) => res.json());
    const second = await fetch(`${server.url}view-model.json`).then((res) => res.json());

    assert.equal(first.summary.runs, 1);
    assert.equal(second.summary.runs, 1);
    assert.equal(recomputes, 1);

    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      [
        JSON.stringify({ type: "config", name: "cache", metricName: "seconds" }),
        JSON.stringify({ type: "run", run: 1, status: "keep", metric: 1 }),
        JSON.stringify({ type: "run", run: 2, status: "keep", metric: 0.5 }),
        "",
      ].join("\n"),
      "utf8",
    );

    const third = await fetch(`${server.url}view-model.json`).then((res) => res.json());

    assert.equal(third.summary.runs, 2);
    assert.equal(recomputes, 2);
    assert.equal(third.ledgerEntries.length, 3);
  } finally {
    server.server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("live dashboard view model cache invalidates on wrapper session config changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "autoresearch-live-wrapper-cache-"));
  const wrapper = path.join(root, "wrapper");
  const target = path.join(root, "target");
  await mkdir(wrapper, { recursive: true });
  await mkdir(target, { recursive: true });
  let recomputes = 0;
  const readWrapperRefreshSeconds = async () => {
    const config = JSON.parse(
      await readFile(path.join(wrapper, "autoresearch.config.json"), "utf8"),
    );
    return Number(config.dashboardRefreshSeconds);
  };
  const server = await serveAutoresearch({
    cwd: wrapper,
    sessionPaths: resolveSessionPaths({ sessionCwd: wrapper, workDir: target }),
    port: 0,
    viewModelCacheTtlMs: 60_000,
    pluginVersion: "0.test",
    dashboardHtml: async () => "<!doctype html><title>wrapper cache</title>",
    viewModel: async () => {
      recomputes += 1;
      return { summary: { runs: await readWrapperRefreshSeconds() } };
    },
  });

  try {
    await writeFile(
      path.join(wrapper, "autoresearch.config.json"),
      JSON.stringify({ workingDir: "../target", dashboardRefreshSeconds: 5 }),
      "utf8",
    );
    await writeFile(
      path.join(target, "autoresearch.jsonl"),
      [
        JSON.stringify({ type: "config", name: "wrapper cache", metricName: "seconds" }),
        JSON.stringify({ type: "run", run: 1, status: "keep", metric: 1 }),
        "",
      ].join("\n"),
      "utf8",
    );

    const first = await fetch(`${server.url}view-model.json`).then((res) => res.json());
    const second = await fetch(`${server.url}view-model.json`).then((res) => res.json());

    assert.equal(server.workDir, path.resolve(target));
    assert.equal(first.summary.runs, 5);
    assert.equal(second.summary.runs, 5);
    assert.equal(recomputes, 1);

    await writeFile(
      path.join(wrapper, "autoresearch.config.json"),
      JSON.stringify({ workingDir: "../target", dashboardRefreshSeconds: 9 }),
      "utf8",
    );

    const third = await fetch(`${server.url}view-model.json`).then((res) => res.json());

    assert.equal(third.summary.runs, 9);
    assert.equal(third.ledgerEntries.length, 2);
    assert.equal(recomputes, 2);
  } finally {
    server.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("live dashboard view model cache invalidates on nested research edits within ttl", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "autoresearch-live-research-cache-"));
  const researchDir = path.join(dir, "autoresearch.research", "project-study");
  const qualityGapsPath = path.join(researchDir, "quality-gaps.md");
  const decisionCapsulePath = path.join(researchDir, "decision-capsule.json");
  let recomputes = 0;
  const readResearchDigest = async () => {
    const [qualityGaps, decisionCapsule] = await Promise.all([
      readFile(qualityGapsPath, "utf8"),
      readFile(decisionCapsulePath, "utf8"),
    ]);
    return `${qualityGaps.trim()}|${decisionCapsule.trim()}`;
  };
  const server = await serveAutoresearch({
    cwd: dir,
    port: 0,
    viewModelCacheTtlMs: 60_000,
    pluginVersion: "0.test",
    dashboardHtml: async () => "<!doctype html><title>research cache</title>",
    viewModel: async () => {
      recomputes += 1;
      return { researchDigest: await readResearchDigest() };
    },
  });

  try {
    await mkdir(researchDir, { recursive: true });
    await writeFile(qualityGapsPath, "- [ ] first gap\n", "utf8");
    await writeFile(decisionCapsulePath, JSON.stringify({ bottleneck: "first" }), "utf8");

    const first = await fetch(`${server.url}view-model.json`).then((res) => res.json());
    const second = await fetch(`${server.url}view-model.json`).then((res) => res.json());

    assert.match(first.researchDigest, /first gap/);
    assert.equal(second.researchDigest, first.researchDigest);
    assert.equal(recomputes, 1);

    await writeFile(qualityGapsPath, "- [x] first gap\n- [ ] second gap\n", "utf8");

    const afterQualityGap = await fetch(`${server.url}view-model.json`).then((res) => res.json());

    assert.match(afterQualityGap.researchDigest, /second gap/);
    assert.equal(recomputes, 2);

    await writeFile(
      decisionCapsulePath,
      JSON.stringify({ bottleneck: "second", next: "inspect cache stamp" }),
      "utf8",
    );

    const afterDecisionCapsule = await fetch(`${server.url}view-model.json`).then((res) =>
      res.json(),
    );

    assert.match(afterDecisionCapsule.researchDigest, /inspect cache stamp/);
    assert.equal(recomputes, 3);
  } finally {
    server.server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("live dashboard view model cache starts its ttl after slow recomputes finish", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "autoresearch-live-cache-slow-"));
  let recomputes = 0;
  const server = await serveAutoresearch({
    cwd: dir,
    port: 0,
    viewModelCacheTtlMs: 25,
    pluginVersion: "0.test",
    dashboardHtml: async () => "<!doctype html><title>slow cache</title>",
    viewModel: async () => {
      recomputes += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { summary: { runs: recomputes } };
    },
  });

  try {
    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      [
        JSON.stringify({ type: "config", name: "slow cache", metricName: "seconds" }),
        JSON.stringify({ type: "run", run: 1, status: "keep", metric: 1 }),
        "",
      ].join("\n"),
      "utf8",
    );

    const first = await fetch(`${server.url}view-model.json`).then((res) => res.json());
    const second = await fetch(`${server.url}view-model.json`).then((res) => res.json());

    assert.equal(first.summary.runs, 1);
    assert.equal(second.summary.runs, 1);
    assert.equal(recomputes, 1);
  } finally {
    server.server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("live dashboard view model cache coalesces concurrent refreshes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "autoresearch-live-cache-concurrent-"));
  let recomputes = 0;
  const server = await serveAutoresearch({
    cwd: dir,
    port: 0,
    viewModelCacheTtlMs: 60_000,
    pluginVersion: "0.test",
    dashboardHtml: async () => "<!doctype html><title>concurrent cache</title>",
    viewModel: async () => {
      recomputes += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { summary: { runs: recomputes } };
    },
  });

  try {
    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      [
        JSON.stringify({ type: "config", name: "concurrent cache", metricName: "seconds" }),
        JSON.stringify({ type: "run", run: 1, status: "keep", metric: 1 }),
        "",
      ].join("\n"),
      "utf8",
    );

    const [first, second] = await Promise.all([
      fetch(`${server.url}view-model.json`).then((res) => res.json()),
      fetch(`${server.url}view-model.json`).then((res) => res.json()),
    ]);

    assert.equal(first.summary.runs, 1);
    assert.equal(second.summary.runs, 1);
    assert.equal(recomputes, 1);
  } finally {
    server.server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("live dashboard view model cache retries stale mid-refresh snapshots", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "autoresearch-live-cache-race-"));
  let recomputes = 0;
  const server = await serveAutoresearch({
    cwd: dir,
    port: 0,
    viewModelCacheTtlMs: 60_000,
    pluginVersion: "0.test",
    dashboardHtml: async () => "<!doctype html><title>cache race</title>",
    viewModel: async () => {
      recomputes += 1;
      if (recomputes === 1) {
        await appendFile(
          path.join(dir, "autoresearch.jsonl"),
          `${JSON.stringify({ type: "run", run: 2, status: "keep", metric: 0.5 })}\n`,
          "utf8",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { summary: { runs: recomputes } };
    },
  });

  try {
    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      [
        JSON.stringify({ type: "config", name: "cache race", metricName: "seconds" }),
        JSON.stringify({ type: "run", run: 1, status: "keep", metric: 1 }),
        "",
      ].join("\n"),
      "utf8",
    );

    const first = await fetch(`${server.url}view-model.json`).then((res) => res.json());
    const second = await fetch(`${server.url}view-model.json`).then((res) => res.json());

    assert.equal(first.summary.runs, 2);
    assert.equal(first.ledgerEntries.length, 3);
    assert.equal(second.summary.runs, 2);
    assert.equal(recomputes, 2);
  } finally {
    server.server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("live dashboard view model returns retry when refresh keeps changing files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "autoresearch-live-cache-retry-"));
  let recomputes = 0;
  const server = await serveAutoresearch({
    cwd: dir,
    port: 0,
    viewModelCacheTtlMs: 60_000,
    pluginVersion: "0.test",
    dashboardHtml: async () => "<!doctype html><title>cache retry</title>",
    viewModel: async () => {
      recomputes += 1;
      if (recomputes <= 2) {
        await appendFile(
          path.join(dir, "autoresearch.jsonl"),
          `${JSON.stringify({
            type: "run",
            run: recomputes + 1,
            status: "keep",
            metric: recomputes,
          })}\n`,
          "utf8",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { summary: { runs: recomputes } };
    },
  });

  try {
    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      [
        JSON.stringify({ type: "config", name: "cache retry", metricName: "seconds" }),
        JSON.stringify({ type: "run", run: 1, status: "keep", metric: 1 }),
        "",
      ].join("\n"),
      "utf8",
    );

    const retryResponse = await fetch(`${server.url}view-model.json`);
    const retryPayload = await retryResponse.json();
    const recovered = await fetch(`${server.url}view-model.json`).then((res) => res.json());

    assert.equal(retryResponse.status, 409);
    assert.equal(retryPayload.code, "live_view_model_changed_during_refresh");
    assert.equal(retryPayload.retryable, true);
    assert.equal(recomputes, 3);
    assert.equal(recovered.summary.runs, 3);
    assert.equal(recovered.ledgerEntries.length, 4);
  } finally {
    server.server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("served dashboard ignores stale live refresh responses that resolve out of order", async () => {
  const entries = [
    {
      type: "config",
      name: "served dashboard",
      metricName: "quality_gap",
      bestDirection: "lower",
      metricUnit: "gaps",
    },
    { type: "run", run: 1, metric: 2, status: "keep", description: "Baseline", confidence: 1 },
  ];
  const staleEntries = [
    ...entries,
    { type: "run", run: 2, metric: 1, status: "keep", description: "Older", confidence: 2 },
  ];
  const latestEntries = [
    ...staleEntries,
    { type: "run", run: 3, metric: 0, status: "keep", description: "Latest", confidence: 3 },
  ];
  const staleViewModel = {
    summary: { segment: 0, baseline: 2, best: 1, confidence: 2, runs: 2 },
    ledgerEntries: staleEntries,
  };
  const latestViewModel = {
    summary: { segment: 0, baseline: 2, best: 0, confidence: 3, runs: 3 },
    ledgerEntries: latestEntries,
  };
  const { getById, dom } = await runDashboard(
    entries,
    {
      deliveryMode: "live-server",
      liveRefreshAvailable: true,
      liveActionsAvailable: false,
      refreshMs: 60000,
      viewModel: { summary: { segment: 0, baseline: 2, best: 2, confidence: 1 } },
    },
    {
      beforeParse(window) {
        window.__refreshFetches = [];
        window.__refreshResolvers = {};
        window.fetch = async (url) => {
          const requestNumber = window.__refreshFetches.push(String(url));
          const viewModel = requestNumber === 1 ? staleViewModel : latestViewModel;
          return new Promise((resolve) => {
            window.__refreshResolvers[requestNumber] = () =>
              resolve({ ok: true, json: async () => viewModel });
          });
        };
        window.setInterval = (callback, ms) => {
          window.__liveInterval = { callback, id: 1, ms };
          return 1;
        };
        window.clearInterval = () => {};
      },
    },
  );

  await waitFor(() => dom.window.__refreshResolvers?.[1], "Initial live refresh did not start.");
  getById("refresh-now").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await waitFor(() => dom.window.__refreshResolvers?.[2], "Manual live refresh did not start.");

  dom.window.__refreshResolvers[2]();
  await waitFor(
    () => getById("runs-value").textContent === "3 (3 kept)",
    "Latest refresh response did not update the dashboard.",
  );
  dom.window.__refreshResolvers[1]();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(getById("runs-value").textContent, "3 (3 kept)");
  assert.deepEqual(dom.window.__refreshFetches, ["view-model.json", "view-model.json"]);
  dom.window.close();
});

test("served dashboard retries retryable live refresh conflicts before reporting failure", async () => {
  const entries = [
    {
      type: "config",
      name: "served dashboard",
      metricName: "quality_gap",
      bestDirection: "lower",
      metricUnit: "gaps",
    },
    { type: "run", run: 1, metric: 1, status: "keep", description: "Baseline", confidence: 1 },
  ];
  const refreshedEntries = [
    ...entries,
    {
      type: "run",
      run: 2,
      metric: 0,
      status: "keep",
      description: "Retry recovered",
      confidence: 2,
    },
  ];
  const liveViewModel = {
    summary: { segment: 0, baseline: 1, best: 0, confidence: 2, runs: 2 },
    ledgerEntries: refreshedEntries,
  };
  const { getById, dom } = await runDashboard(
    entries,
    {
      deliveryMode: "live-server",
      liveRefreshAvailable: true,
      liveActionsAvailable: false,
      refreshMs: 60000,
      viewModel: { summary: { segment: 0, baseline: 1, best: 1, confidence: 1 } },
    },
    {
      beforeParse(window) {
        window.__refreshFetches = [];
        window.fetch = async (url) => {
          const requestNumber = window.__refreshFetches.push(String(url));
          if (requestNumber === 1) {
            return {
              ok: false,
              status: 409,
              statusText: "Conflict",
              json: async () => ({
                ok: false,
                code: "live_view_model_changed_during_refresh",
                retryable: true,
                message:
                  "Session files changed while the live dashboard readout was refreshing. Retry to avoid a mixed ledger/readout snapshot.",
              }),
            };
          }
          return { ok: true, json: async () => liveViewModel };
        };
        window.setInterval = () => 42;
        window.clearInterval = () => {};
      },
    },
  );

  await waitFor(
    () => getById("runs-value").textContent === "2 (2 kept)",
    "Live dashboard did not retry a retryable view-model conflict.",
  );
  assert.deepEqual(dom.window.__refreshFetches, ["view-model.json", "view-model.json"]);
  assert.doesNotMatch(getById("live-title").textContent || "", /failed/i);
  assert.doesNotMatch(getById("live-detail").textContent || "", /409|Conflict/i);
  dom.window.close();
});

test("served dashboard live refresh reports endpoint failures without success", async () => {
  const entries = [
    {
      type: "config",
      name: "served dashboard",
      metricName: "quality_gap",
      bestDirection: "lower",
      metricUnit: "gaps",
    },
    { type: "run", run: 1, metric: 1, status: "keep", description: "Baseline", confidence: 1 },
  ];
  const viewModel = {
    summary: { segment: 0, baseline: 1, best: 1, confidence: 1 },
  };
  const { getById, dom } = await runDashboard(
    entries,
    {
      deliveryMode: "live-server",
      liveRefreshAvailable: true,
      liveActionsAvailable: false,
      refreshMs: 1234,
      viewModel,
    },
    {
      beforeParse(window) {
        window.fetch = async (url) => {
          if (String(url).includes("view-model")) {
            return { ok: false, status: 500, statusText: "Internal Server Error" };
          }
          return {
            ok: true,
            text: async () => entries.map((entry) => JSON.stringify(entry)).join("\n"),
          };
        };
        window.setInterval = () => 42;
        window.clearInterval = () => {};
      },
    },
  );

  await waitFor(
    () => /failed/i.test(getById("live-title").textContent || ""),
    "Live refresh failure was not announced.",
  );
  assert.match(getById("live-detail").textContent || "", /view-model\.json returned HTTP 500/);
  assert.doesNotMatch(getById("live-title").textContent || "", /refreshed/i);
  dom.window.close();
});

test("served dashboard rejects malformed refresh payloads and labels retained evidence", async () => {
  const entries = [
    dashboardConfigEntry({ name: "validated live snapshot", metricName: "seconds" }),
    { type: "run", run: 1, metric: 5, status: "keep", description: "Validated baseline" },
  ];
  const { getById, dom } = await runDashboard(
    entries,
    {
      deliveryMode: "live-server",
      liveRefreshAvailable: true,
      refreshMs: 60_000,
      viewModel: {},
    },
    {
      beforeParse(window) {
        window.fetch = async () => ({
          ok: true,
          json: async () => ({
            payloadVersion: DASHBOARD_PAYLOAD_VERSION,
            ledgerEntries: {},
          }),
        });
        window.setInterval = () => 1;
        window.clearInterval = () => {};
      },
    },
  );

  await waitFor(
    () => /failed/i.test(getById("live-title").textContent || ""),
    "Malformed live payload was not rejected.",
  );
  assert.match(getById("live-detail").textContent || "", /last known valid readout/);
  assert.match(getById("live-detail").textContent || "", /does not contain a ledger entry array/);
  assert.match(getById("live-detail").textContent || "", /serve --cwd <project>/);
  assert.equal(getById("runs-value").textContent, "1 (1 kept)");
  assert.match(
    dom.window.document.querySelector(".toolbar-session strong")?.textContent || "",
    /validated live snapshot/,
  );

  dom.window.fetch = async () => ({
    ok: true,
    json: async () => ({
      payloadVersion: DASHBOARD_PAYLOAD_VERSION + 1,
      ledgerEntries: entries,
    }),
  });
  getById("refresh-now").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await waitFor(
    () => /incompatible/i.test(getById("live-detail").textContent || ""),
    "Incompatible live payload did not produce a safe diagnostic.",
  );
  assert.match(getById("live-detail").textContent || "", /last known valid readout/);
  assert.match(getById("live-detail").textContent || "", /serve --cwd <project>/);
  assert.equal(getById("runs-value").textContent, "1 (1 kept)");

  dom.window.fetch = async () => ({
    ok: true,
    json: async () => {
      throw new Error("C:\\private\\payload.json could not be parsed");
    },
  });
  getById("refresh-now").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await waitFor(
    () => /not valid JSON/i.test(getById("live-detail").textContent || ""),
    "Malformed live JSON did not produce a safe diagnostic.",
  );
  assert.doesNotMatch(getById("live-detail").textContent || "", /private|payload\.json/i);
  dom.window.close();
});

test("live server redacts exception details before the endpoint and retained-readout UI", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "autoresearch-live-error-redaction-"));
  const secretValue = "supersecretvalue";
  const privateHomePath = "C:\\Users\\Alice\\Documents\\private.txt";
  const server = await serveAutoresearch({
    cwd: dir,
    port: 0,
    dashboardHtml: async () => "<!doctype html><title>redacted live error</title>",
    viewModel: async () => {
      throw new Error(
        `token=${secretValue} ${dir} ${privateHomePath}\n    at leak (${path.join(dir, "secret.ts")}:1:2)`,
      );
    },
  });

  try {
    const response = await fetch(`${server.url}view-model.json`);
    const responseText = await response.text();
    assert.equal(response.status, 500);
    assert.match(responseText, /token=<redacted>/);
    assert.match(responseText, /<workdir>/);
    assert.match(responseText, /at <stack-frame>/);
    assert.doesNotMatch(responseText, new RegExp(secretValue, "i"));
    assert.equal(responseText.includes(dir), false);
    assert.doesNotMatch(responseText, /Alice|secret\.ts/);

    const entries = [
      dashboardConfigEntry({ name: "retained redacted readout", metricName: "seconds" }),
      { type: "run", run: 1, metric: 5, status: "keep", description: "Validated baseline" },
    ];
    const { getById, dom } = await runDashboard(
      entries,
      {
        deliveryMode: "live-server",
        liveRefreshAvailable: true,
        liveActionsAvailable: false,
        refreshMs: 60_000,
        viewModel: {},
      },
      {
        url: server.url,
        beforeParse(window) {
          window.fetch = async (url) => fetch(new URL(String(url), server.url));
          window.setInterval = () => 1;
          window.clearInterval = () => {};
        },
      },
    );

    await waitFor(
      () => /failed/i.test(getById("live-title").textContent || ""),
      "Redacted live refresh failure was not rendered.",
    );
    const detail = getById("live-detail").textContent || "";
    assert.match(detail, /last known valid readout/);
    assert.match(detail, /token=<redacted>/);
    assert.match(detail, /serve --cwd <project>/);
    assert.doesNotMatch(detail, new RegExp(secretValue, "i"));
    assert.equal(detail.includes(dir), false);
    assert.doesNotMatch(detail, /Alice|secret\.ts/);
    assert.equal(getById("runs-value").textContent, "1 (1 kept)");
    dom.window.close();
  } finally {
    server.server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("dashboard readout uses the selected segment baseline", async () => {
  const entries = [
    {
      type: "config",
      name: "first segment",
      metricName: "seconds",
      bestDirection: "lower",
      metricUnit: "s",
    },
    {
      type: "run",
      run: 1,
      metric: 10,
      status: "keep",
      description: "First baseline",
      confidence: 1,
    },
    { type: "run", run: 2, metric: 8, status: "keep", description: "First best", confidence: 2 },
    {
      type: "config",
      name: "second segment",
      metricName: "seconds",
      bestDirection: "lower",
      metricUnit: "s",
    },
    {
      type: "run",
      run: 1,
      metric: 100,
      status: "keep",
      description: "Second baseline",
      confidence: 1,
    },
    { type: "run", run: 2, metric: 90, status: "keep", description: "Second best", confidence: 2 },
  ];

  const { getById, queryById, dom } = await runDashboard(entries, {
    deliveryMode: "static-export",
    liveActionsAvailable: false,
    viewModel: {
      summary: { segment: 1, baseline: 100, best: 90, confidence: 2 },
    },
  });

  assert.equal(getById("baseline-value").textContent, "100s");
  assert.equal(queryById("segment-tab-0"), null);
  const select = getById("segment-select") as HTMLSelectElement;
  assert.equal(select.value, "1");
  assert.match(select.options[0]?.textContent || "", /S1 - first segment/);
  assert.match(select.options[1]?.textContent || "", /S2 - second segment/);
  select.value = "0";
  select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await waitFor(
    () => getById("baseline-value").textContent === "10s",
    "Selected segment baseline did not update.",
  );
  assert.equal(getById("best-value").textContent, "8s");
  assert.match(getById("segment-summary").textContent || "", /first segment/);
  select.value = "1";
  select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await waitFor(
    () => getById("baseline-value").textContent === "100s",
    "Second segment selection did not update.",
  );
  assert.match(getById("segment-summary").textContent || "", /second segment/);
  dom.window.close();
});

test("dashboard defaults to audit view and can switch to operate", async () => {
  const entries = [
    dashboardConfigEntry({ name: "audit default", metricName: "seconds", metricUnit: "s" }),
    { type: "run", run: 1, metric: 5, status: "keep", description: "Baseline", confidence: 1 },
  ];

  const { getById, queryById, dom } = await runDashboard(entries, {
    deliveryMode: "live-server",
    liveRefreshAvailable: true,
    liveActionsAvailable: false,
    viewModel: {},
    commands: [],
  });
  const toggle = getById("view-toggle") as HTMLButtonElement;

  assert.equal(toggle.getAttribute("aria-pressed"), "true");
  assert.ok(getById("workspace-grid"));
  assert.ok(getById("research-truth-meter"));
  assert.ok(getById("strategy-memory"));
  assert.ok(getById("codex-brief"));

  toggle.click();
  await waitFor(
    () => queryById("workspace-grid") == null,
    "Operate view did not collapse audit context.",
  );
  assert.equal(queryById("research-truth-meter"), null);
  assert.equal(queryById("strategy-memory"), null);
  assert.equal(toggle.getAttribute("aria-pressed"), "false");
  assert.match(dom.window.location.search, /view=operate/);
  dom.window.close();
});

test("dashboard restores audit view and chart preferences from the URL", async () => {
  const entries = [
    dashboardConfigEntry({ name: "url state", metricName: "seconds", metricUnit: "s" }),
    { type: "run", run: 1, metric: 5, status: "keep", description: "Baseline", confidence: 1 },
    { type: "run", run: 2, metric: 4, status: "keep", description: "Improved", confidence: 2 },
  ];

  const { getById, dom } = await runDashboard(entries, emptyCommandMeta(), {
    url: "file:///autoresearch-dashboard.html?view=audit&value=percent",
  });

  assert.ok(getById("workspace-grid"));
  assert.equal(getById("view-toggle").getAttribute("aria-pressed"), "true");
  const percentButtons = Array.from(dom.window.document.querySelectorAll("button")).filter(
    (button) => button.getAttribute("aria-pressed") === "true",
  );
  assert.ok(
    percentButtons.some((button) => /%|percent/i.test(button.textContent || "")),
    "Percent value mode was not restored from the URL.",
  );
  dom.window.close();
});

test("dashboard decision rail shows newest runs first", async () => {
  const entries = [
    {
      type: "config",
      name: "recent rail",
      metricName: "score",
      bestDirection: "higher",
      metricUnit: "pt",
    },
    { type: "run", run: 1, metric: 1, status: "keep", description: "Run one", confidence: 1 },
    { type: "run", run: 2, metric: 2, status: "keep", description: "Run two", confidence: 1 },
    { type: "run", run: 3, metric: 3, status: "discard", description: "Run three", confidence: 1 },
    { type: "run", run: 4, metric: 4, status: "keep", description: "Run four", confidence: 1 },
    { type: "run", run: 5, metric: 5, status: "discard", description: "Run five", confidence: 1 },
    { type: "run", run: 6, metric: 6, status: "keep", description: "Run six", confidence: 1 },
  ];

  const { getById, dom } = await runDashboard(entries, {
    deliveryMode: "static-export",
    liveActionsAvailable: false,
  });

  const ledgerHtml = getById("ledger-body").innerHTML;
  assert.match(ledgerHtml, /#6/);
  assert.match(ledgerHtml, /Run six/);
  assert.match(ledgerHtml, /#5/);
  assert.ok(
    ledgerHtml.indexOf("#6") < ledgerHtml.indexOf("#1"),
    "Ledger should list newest runs before older runs.",
  );
  dom.window.close();
});
