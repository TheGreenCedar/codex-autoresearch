import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeEntries } from "../../dashboard/src/model/entries.js";
import { buildReadout } from "../../dashboard/src/model/readout.js";
import { exportDashboard } from "../../lib/commands/dashboard.js";
import { foldDashboardLedgerFile } from "../../lib/dashboard-ledger.js";
import { dashboardEntriesForClient, dashboardHtml } from "../../lib/dashboard-transport.js";
import { buildDashboardViewModel } from "../../lib/dashboard-view-model.js";
import { evidenceStatusForRun, isAcceptedCurrentRun } from "../../lib/evidence-registry.js";
import { serveAutoresearch } from "../../lib/live-server.js";

const config = {
  type: "config" as const,
  name: "Readout parity",
  metricName: "seconds",
  metricUnit: "s",
  bestDirection: "lower" as const,
};

test("dashboard client entries project effective evidence acceptance from the registry", () => {
  for (const evidenceStatus of [undefined, "accepted"]) {
    for (const acknowledged of [false, true]) {
      const run = {
        type: "run" as const,
        run: 1,
        metric: 1,
        status: "keep",
        segment: 0,
        evidenceStatus,
        metrics: { review_required: 1 },
        asi: { review_acknowledged: acknowledged },
      };
      const projected = dashboardEntriesForClient([config, run]);
      const session = normalizeEntries(projected).segments[0]!;
      const readout = buildReadout(session);
      assert.equal(projected[1]?.evidenceStatus, evidenceStatusForRun(run));
      assert.equal(readout.best, isAcceptedCurrentRun(run) ? 1 : null);
      assert.equal(run.evidenceStatus, evidenceStatus);
    }
  }
});

test("static and live dashboard transports reject unacknowledged review-required keeps", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dashboard-review-parity-"));
  const entries = [
    config,
    {
      type: "run" as const,
      run: 1,
      metric: 1,
      status: "keep",
      evidenceStatus: "accepted",
      segment: 0,
      metrics: { review_required: 1 },
    },
  ];
  try {
    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      entries.map((entry) => JSON.stringify(entry)).join("\n"),
    );
    const html = dashboardHtml(entries, { deliveryMode: "static-export" });
    const payload = html.match(/window\.__AUTORESEARCH_DATA__ = (.*);/);
    assert.ok(payload);
    const staticEntries = JSON.parse(payload[1]!);
    const server = await serveAutoresearch({
      cwd: dir,
      dashboardHtml: async () => "read-only",
      viewModel: async () => ({}),
    });
    try {
      const live = await fetch(`${server.url}view-model.json`).then((response) => response.json());
      assert.deepEqual(live.ledgerEntries, staticEntries);
      assert.equal(staticEntries[1].evidenceStatus, "provisional");
      const session = normalizeEntries(live.ledgerEntries).segments[0]!;
      assert.equal(buildReadout(session).best, null);
    } finally {
      await new Promise<void>((resolve) => server.server.close(() => resolve()));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dashboard raw readout retains the canonical best outside the streamed ledger window", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dashboard-best-parity-"));
  const entries = [
    config,
    { type: "run", run: 1, metric: 1, status: "keep", segment: 0, description: "Old best" },
    ...Array.from({ length: 5_001 }, (_, index) => ({
      type: "run",
      run: index + 2,
      metric: 100 + index,
      status: "discard",
      segment: 0,
    })),
  ];
  try {
    const ledgerPath = path.join(dir, "autoresearch.jsonl");
    await writeFile(ledgerPath, entries.map((entry) => JSON.stringify(entry)).join("\n"));
    const fold = await foldDashboardLedgerFile(ledgerPath);
    const current = fold.analysisRecords.filter((record) => record.run != null);
    const viewModel = buildDashboardViewModel({
      state: {
        config,
        current,
        segment: fold.summary.segment,
        baseline: fold.summary.baseline,
        best: fold.summary.best,
        dashboardLedgerSummary: fold.summary,
      },
    });
    const session = normalizeEntries(dashboardEntriesForClient(fold.entries)).segments[0]!;
    const readout = buildReadout(session, viewModel);
    assert.equal(
      fold.entries.some((entry) => entry.run === 1),
      false,
    );
    assert.equal(
      fold.analysisRecords.some((entry) => entry.run === 1),
      true,
    );
    assert.equal(fold.summary.best, 1);
    assert.equal(readout.best, fold.summary.best);
    assert.equal(readout.bestRun?.run, 1);
    assert.equal(readout.bestRun?.description, "Old best");
    assert.equal(readout.baseline, fold.summary.baseline);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("default dashboard export preserves a symlink target outside the project", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dashboard-linked-export-"));
  const outside = path.join(os.tmpdir(), `${path.basename(dir)}-outside.html`);
  try {
    await writeFile(outside, "Preserve this file.");
    try {
      await symlink(outside, path.join(dir, "autoresearch-dashboard.html"), "file");
    } catch (error) {
      t.skip(`File symlink unavailable: ${String(error)}`);
      return;
    }
    await writeFile(path.join(dir, "autoresearch.jsonl"), JSON.stringify(config));
    await assert.rejects(
      exportDashboard(
        { cwd: dir },
        {
          dashboardViewModel: async () => ({}),
          serveAutoresearch,
        },
      ),
      /outside the working directory/,
    );
    assert.equal(await readFile(outside, "utf8"), "Preserve this file.");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});

for (const missingComponent of [false, true]) {
  test(`weighted ledger anchors preserve ${missingComponent ? "old missing-component fallback" : "the old baseline and distinct weighted best"}`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dashboard-weighted-parity-"));
    const weightedConfig = {
      ...config,
      metricDefinition: { mode: "weighted_cost", weights: { time: 0.7, memory: 0.3 } },
    };
    const entries = [
      weightedConfig,
      {
        type: "run",
        run: 1,
        metric: 10,
        status: "measure",
        segment: 0,
        metrics: { memory_mb: 100 },
        description: "Original baseline",
      },
      {
        type: "run",
        run: 2,
        metric: 8,
        status: "keep",
        segment: 0,
        metrics: { memory_mb: 100 },
        description: "Raw best",
      },
      {
        type: "run",
        run: 3,
        metric: 9,
        status: "keep",
        segment: 0,
        metrics: { memory_mb: 10 },
        description: "Weighted best",
      },
      {
        type: "run",
        run: 4,
        metric: 2,
        status: "discard",
        segment: 0,
        metrics: missingComponent ? {} : { memory_mb: 100 },
      },
      ...Array.from({ length: 5_001 }, (_, index) => ({
        type: "run",
        run: index + 5,
        metric: 12,
        status: "discard",
        segment: 0,
        metrics: { memory_mb: 200 },
      })),
    ];
    try {
      const ledgerPath = path.join(dir, "autoresearch.jsonl");
      await writeFile(ledgerPath, entries.map((entry) => JSON.stringify(entry)).join("\n"));
      const fold = await foldDashboardLedgerFile(ledgerPath);
      const viewModel = buildDashboardViewModel({
        state: {
          config: weightedConfig,
          current: fold.analysisRecords.filter((record) => record.run != null),
          segment: fold.summary.segment,
          baseline: fold.summary.baseline,
          best: fold.summary.best,
          dashboardLedgerSummary: fold.summary,
        },
      });
      const session = normalizeEntries(dashboardEntriesForClient(fold.entries)).segments[0]!;
      const readout = buildReadout(session, viewModel);
      assert.equal(
        fold.entries.some((entry) => [1, 2, 3, 4].includes(entry.run)),
        false,
      );
      assert.equal(fold.summary.bestRun?.run, 2);
      assert.equal(fold.summary.weightedBestRun?.run ?? null, missingComponent ? null : 3);
      assert.equal(readout.metricDefinition.mode, missingComponent ? "raw" : "weighted_cost");
      assert.equal(readout.metricDefinition.baselineTime, 10);
      assert.equal(readout.metricDefinition.baselineMemory, 100);
      assert.equal(readout.baselineRun?.run, 1);
      assert.equal(readout.bestRun?.run, missingComponent ? 2 : 3);
      assert.equal(readout.best, missingComponent ? 8 : 0.66);
      assert.equal(readout.baseline, missingComponent ? 10 : 1);
      assert.equal(viewModel.readout.baselineRun?.metrics.memory_mb, 100);
      if (missingComponent) assert.match(readout.metricDefinition.fallbackNote, /run #4/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
