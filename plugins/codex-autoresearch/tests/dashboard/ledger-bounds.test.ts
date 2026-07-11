import assert from "node:assert/strict";
import { open, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import {
  DASHBOARD_LEDGER_MAX_ENTRIES,
  foldDashboardLedger,
  type DashboardLedgerFold,
} from "../../lib/dashboard-ledger.js";
import { dashboardHtml } from "../../lib/dashboard-transport.js";
import { serveAutoresearch } from "../../lib/live-server.js";
import {
  buildProcessLifecycleRecord,
  buildResourcePreflight,
  PROCESS_LIFECYCLE_PROJECTION_IDENTITY_LIMIT,
} from "../../lib/process-governor.js";

const LARGE_LEDGER_RECORDS = 100_000;
const HEAP_DELTA_BUDGET_BYTES = 96 * 1024 * 1024;
const WALL_TIME_BUDGET_MS = 15_000;
const RESPONSE_SIZE_BUDGET_BYTES = 2_500_000;

test("static and live dashboard transports share the streaming ledger fold", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autoresearch-ledger-parity-"));
  await writeRepresentativeLedger(dir, DASHBOARD_LEDGER_MAX_ENTRIES + 37);
  const staticFold = await foldDashboardLedger(dir);
  const staticSummary = summaryPayload(staticFold);
  const html = dashboardHtml(staticFold.entries, {
    deliveryMode: "static-export",
    ledgerBounds: staticFold.ledgerBounds,
    settings: { deliveryMode: "static-export", workDir: dir },
    viewModel: { summary: staticSummary },
    workDir: dir,
  });
  const staticEntries = embeddedPayload(html, "__AUTORESEARCH_DATA__");
  const staticMeta = embeddedPayload(html, "__AUTORESEARCH_META__");
  const server = await serveAutoresearch({
    cwd: dir,
    port: 0,
    pluginVersion: "0.test",
    dashboardHtml: async () => "<!doctype html><title>parity</title>",
    viewModel: async (context: Record<string, unknown> = {}) => ({
      summary: summaryPayload(context.ledgerFold as DashboardLedgerFold),
    }),
  });

  try {
    const live = await fetch(`${server.url}view-model.json`).then((response) => response.json());
    assert.deepEqual(live.ledgerEntries, staticEntries);
    assert.deepEqual(live.ledgerBounds, staticMeta.ledgerBounds);
    assert.deepEqual(live.summary, staticSummary);
    assert.equal(live.ledgerEntries[0].type, "config");
    assert.equal(live.ledgerBounds.summarySource, "full-ledger-stream");
    assert.equal(live.ledgerBounds.retention, "newest-rows-plus-governing-config");
  } finally {
    server.server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "static and live folds preserve full-ledger process trust with bounded fail-closed state",
  { timeout: 30_000 },
  async () => {
    const started = buildProcessLifecycleRecord({
      packetId: "packet-old",
      processId: "benchmark",
      event: "started",
      at: "2026-07-10T00:00:00.000Z",
    });
    const terminated = buildProcessLifecycleRecord({
      packetId: "packet-old",
      processId: "benchmark",
      event: "terminated",
      at: "2026-07-10T00:01:00.000Z",
      termination: { proven: true, reason: "exit_observed" },
    });
    const overflow = Array.from(
      { length: PROCESS_LIFECYCLE_PROJECTION_IDENTITY_LIMIT + 1 },
      (_, index) =>
        buildProcessLifecycleRecord({
          packetId: `packet-${index}`,
          processId: "benchmark",
          event: "started",
          at: "2026-07-10T00:00:00.000Z",
        }),
    );
    const scenarios = [
      {
        name: "old-active",
        lifecycle: [started],
        expectedStatus: "blocked",
        expectedResidue: "process-active",
        incomplete: false,
      },
      {
        name: "later-terminal",
        lifecycle: [started, terminated],
        expectedStatus: "ok",
        expectedResidue: "",
        incomplete: false,
      },
      {
        name: "old-malformed",
        secret: "secret-packet-must-not-leak",
        lifecycle: [
          {
            type: "process_lifecycle",
            identity: {
              packetId: "secret-packet-must-not-leak malformed",
              processId: "benchmark",
            },
            event: "started",
            at: "2026-07-10T00:00:00.000Z",
          },
        ],
        expectedStatus: "blocked",
        expectedResidue: "invalid-lifecycle",
        incomplete: false,
      },
      {
        name: "identity-overflow",
        lifecycle: overflow,
        expectedStatus: "blocked",
        expectedResidue: "invalid-lifecycle",
        incomplete: true,
      },
    ];

    for (const scenario of scenarios) {
      const dir = await mkdtemp(path.join(os.tmpdir(), `autoresearch-ledger-${scenario.name}-`));
      await writeLifecycleLedger(dir, scenario.lifecycle);
      const staticFold = await foldDashboardLedger(dir);
      const staticPreflight = processTrustPayload(staticFold);
      const server = await serveAutoresearch({
        cwd: dir,
        port: 0,
        pluginVersion: "0.test",
        dashboardHtml: async () => "<!doctype html><title>process trust</title>",
        viewModel: async (context: Record<string, unknown> = {}) => ({
          resourcePreflight: processTrustPayload(context.ledgerFold as DashboardLedgerFold),
        }),
      });

      try {
        const live = await fetch(`${server.url}view-model.json`).then((response) =>
          response.json(),
        );
        assert.deepEqual(live.resourcePreflight, staticPreflight, scenario.name);
        assert.equal(staticPreflight.status, scenario.expectedStatus, scenario.name);
        assert.equal(
          staticPreflight.residue[0]?.status || "",
          scenario.expectedResidue,
          scenario.name,
        );
        assert.equal(
          staticFold.processLifecycleProjection.incomplete,
          scenario.incomplete,
          scenario.name,
        );
        assert.equal(
          live.ledgerBounds.processLifecycleProjectionIncomplete === true,
          scenario.incomplete,
          scenario.name,
        );
        assert.ok(
          staticFold.processLifecycleProjection.trackedIdentityCount <=
            PROCESS_LIFECYCLE_PROJECTION_IDENTITY_LIMIT,
          scenario.name,
        );
        assert.equal(
          staticFold.entries.some((entry) => entry.type === "process_lifecycle"),
          false,
          `${scenario.name} must prove lifecycle trust is not coming from the retained tail`,
        );
        if (scenario.secret) {
          assert.doesNotMatch(
            JSON.stringify(staticFold.analysisRecords),
            new RegExp(scenario.secret),
          );
          assert.doesNotMatch(JSON.stringify(live), new RegExp(scenario.secret));
        }
      } finally {
        server.server.close();
        await rm(dir, { recursive: true, force: true });
      }
    }
  },
);

test(
  "100k dashboard ledger fold stays within bounded retention, heap, response, and time budgets",
  { timeout: 30_000 },
  async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "autoresearch-ledger-100k-"));
    await writeRepresentativeLedger(dir, LARGE_LEDGER_RECORDS);
    global.gc?.();
    const initialHeap = process.memoryUsage().heapUsed;
    let peakHeap = initialHeap;
    const sampler = setInterval(() => {
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    }, 2);
    const startedAt = performance.now();

    try {
      const fold = await foldDashboardLedger(dir);
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      const wallTimeMs = performance.now() - startedAt;
      const peakHeapDeltaBytes = Math.max(0, peakHeap - initialHeap);
      const responseSizeBytes = Buffer.byteLength(
        JSON.stringify({
          entries: fold.entries,
          ledgerBounds: fold.ledgerBounds,
          summary: fold.summary,
        }),
      );

      assert.equal(fold.summary.totalEntries, LARGE_LEDGER_RECORDS);
      assert.equal(fold.summary.currentRunCount, LARGE_LEDGER_RECORDS - 1);
      assert.equal(fold.summary.acceptedRunCount, 66_666);
      assert.equal(fold.summary.measurementRunCount, 33_333);
      assert.equal(fold.summary.baseline, 99_999);
      assert.equal(fold.summary.best, 2);
      assert.equal(fold.lines.length, DASHBOARD_LEDGER_MAX_ENTRIES);
      assert.equal(fold.ledgerBounds.retainedEntries, DASHBOARD_LEDGER_MAX_ENTRIES);
      assert.equal(
        fold.ledgerBounds.omittedEntries,
        LARGE_LEDGER_RECORDS - DASHBOARD_LEDGER_MAX_ENTRIES,
      );
      assert.equal(fold.entries[0].type, "config");
      assert.ok(
        peakHeapDeltaBytes <= HEAP_DELTA_BUDGET_BYTES,
        `peak heap delta ${peakHeapDeltaBytes} exceeded ${HEAP_DELTA_BUDGET_BYTES}`,
      );
      assert.ok(
        wallTimeMs <= WALL_TIME_BUDGET_MS,
        `wall time ${wallTimeMs} exceeded ${WALL_TIME_BUDGET_MS}`,
      );
      assert.ok(
        responseSizeBytes <= RESPONSE_SIZE_BUDGET_BYTES,
        `response ${responseSizeBytes} exceeded ${RESPONSE_SIZE_BUDGET_BYTES}`,
      );
      t.diagnostic(
        `100k ledger: peak_heap_delta_bytes=${peakHeapDeltaBytes} wall_time_ms=${wallTimeMs.toFixed(1)} response_bytes=${responseSizeBytes} retained=${fold.lines.length}`,
      );
    } finally {
      clearInterval(sampler);
      await rm(dir, { recursive: true, force: true });
    }
  },
);

async function writeRepresentativeLedger(dir: string, totalRecords: number): Promise<void> {
  const handle = await open(path.join(dir, "autoresearch.jsonl"), "w");
  try {
    await handle.writeFile(
      `${JSON.stringify({
        type: "config",
        name: "streaming ledger",
        metricName: "quality_gap",
        metricUnit: "gaps",
        bestDirection: "lower",
      })}\n`,
    );
    for (let start = 1; start < totalRecords; start += 1000) {
      const end = Math.min(totalRecords, start + 1000);
      const rows: string[] = [];
      for (let run = start; run < end; run += 1) {
        rows.push(
          JSON.stringify({
            type: "run",
            run,
            metric: totalRecords - run,
            status: run % 3 === 0 ? "measure" : "keep",
            evidenceStatus: run % 3 === 0 ? "provisional" : "accepted",
            description: `representative run ${run}`,
          }),
        );
      }
      await handle.write(`${rows.join("\n")}\n`);
    }
  } finally {
    await handle.close();
  }
}

async function writeLifecycleLedger(
  dir: string,
  lifecycle: Array<Record<string, unknown>>,
): Promise<void> {
  const handle = await open(path.join(dir, "autoresearch.jsonl"), "w");
  try {
    const prefix = [
      {
        type: "config",
        name: "process trust",
        metricName: "quality_gap",
        bestDirection: "lower",
      },
      ...lifecycle,
    ];
    await handle.writeFile(`${prefix.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    for (let start = 1; start <= DASHBOARD_LEDGER_MAX_ENTRIES + 7; start += 1000) {
      const end = Math.min(DASHBOARD_LEDGER_MAX_ENTRIES + 8, start + 1000);
      const rows: string[] = [];
      for (let run = start; run < end; run += 1) {
        rows.push(
          JSON.stringify({
            type: "run",
            run,
            metric: DASHBOARD_LEDGER_MAX_ENTRIES + 8 - run,
            status: "measure",
          }),
        );
      }
      await handle.write(`${rows.join("\n")}\n`);
    }
  } finally {
    await handle.close();
  }
}

function processTrustPayload(fold: DashboardLedgerFold): ReturnType<typeof buildResourcePreflight> {
  return buildResourcePreflight({ entries: fold.analysisRecords });
}

function summaryPayload(fold: DashboardLedgerFold): Record<string, unknown> {
  return {
    segment: fold.summary.segment,
    runs: fold.summary.currentRunCount,
    kept: fold.summary.acceptedRunCount,
    measured: fold.summary.measurementRunCount,
    failed: fold.summary.failedRunCount,
    baseline: fold.summary.baseline,
    best: fold.summary.best,
    statusCounts: fold.summary.statusCounts,
  };
}

function embeddedPayload(html: string, globalName: string): any {
  const match = html.match(new RegExp(`window\\.${globalName} = ([\\s\\S]*?);\\n`));
  assert.ok(match, `missing ${globalName}`);
  return JSON.parse(match[1]);
}
