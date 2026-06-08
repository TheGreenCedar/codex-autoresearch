import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDashboardHealthSummary,
  verifyDashboardHealthSummary,
} from "../lib/dashboard-health.js";

const baseInput = {
  url: "http://127.0.0.1:60106/",
  port: 60106,
  pid: 1234,
  cwd: "C:/work/project",
  version: "2.0.2",
  startedAt: "2026-06-01T00:00:00.000Z",
  registryPath: "C:/work/project/.git/autoresearch/serve-registry.json",
  previous: {
    stale: false,
    liveness: "alive",
  },
};

test("dashboard health summary derives read-only health metadata", () => {
  const summary = buildDashboardHealthSummary(baseInput);

  assert.equal(summary.url, "http://127.0.0.1:60106/");
  assert.equal(summary.port, 60106);
  assert.equal(summary.pid, 1234);
  assert.equal(summary.cwd, "C:/work/project");
  assert.equal(summary.version, "2.0.2");
  assert.equal(summary.startedAt, "2026-06-01T00:00:00.000Z");
  assert.equal(summary.registryPath, "C:/work/project/.git/autoresearch/serve-registry.json");
  assert.equal(summary.healthUrl, "http://127.0.0.1:60106/health");
  assert.equal(summary.liveness, "alive");
  assert.equal(summary.stale, false);
  assert.deepEqual(summary.previous, { stale: false, liveness: "alive" });
  assert.equal(Object.hasOwn(summary, "actions"), false);
});

test("dashboard health summary names serve as the stale registry recovery command", () => {
  const summary = buildDashboardHealthSummary({
    ...baseInput,
    cwd: "C:/work/project with spaces",
    previous: {
      stale: true,
      liveness: "dead",
    },
  });

  assert.equal(
    summary.recoveryCommand,
    'node scripts/autoresearch.mjs serve --cwd "C:/work/project with spaces"',
  );
  assert.doesNotMatch(summary.recoveryCommand, /^curl /);
});

test("dashboard health summary normalizes missing and invalid numeric values to null", () => {
  const summary = buildDashboardHealthSummary({
    ...baseInput,
    port: "not-a-port",
    pid: -1,
  });
  const missing = buildDashboardHealthSummary({
    url: "http://127.0.0.1:60106/",
    cwd: "C:/work/project",
    version: "2.0.2",
    startedAt: "2026-06-01T00:00:00.000Z",
    registryPath: "C:/work/project/.git/autoresearch/serve-registry.json",
    previous: null,
  });
  const coercible = buildDashboardHealthSummary({
    ...baseInput,
    port: true,
    pid: [1],
  });
  const objectValues = buildDashboardHealthSummary({
    ...baseInput,
    port: { valueOf: () => 60106 },
    pid: { toString: () => "1234" },
  });
  const numericStrings = buildDashboardHealthSummary({
    ...baseInput,
    port: "60106",
    pid: "1234",
  });
  const invalidNumbers = buildDashboardHealthSummary({
    ...baseInput,
    port: 0,
    pid: 1.5,
  });
  const nonFiniteNumbers = buildDashboardHealthSummary({
    ...baseInput,
    port: Number.NaN,
    pid: Number.POSITIVE_INFINITY,
  });

  assert.equal(summary.port, null);
  assert.equal(summary.pid, null);
  assert.equal(missing.port, null);
  assert.equal(missing.pid, null);
  assert.equal(coercible.port, null);
  assert.equal(coercible.pid, null);
  assert.equal(objectValues.port, null);
  assert.equal(objectValues.pid, null);
  assert.equal(numericStrings.port, null);
  assert.equal(numericStrings.pid, null);
  assert.equal(invalidNumbers.port, null);
  assert.equal(invalidNumbers.pid, null);
  assert.equal(nonFiniteNumbers.port, null);
  assert.equal(nonFiniteNumbers.pid, null);
});

test("dashboard health summary preserves previous stale and liveness conservatively", () => {
  const staleSummary = buildDashboardHealthSummary({
    ...baseInput,
    previous: {
      stale: true,
      liveness: "dead",
    },
  });
  const unknownSummary = buildDashboardHealthSummary({
    ...baseInput,
    previous: {
      stale: null,
      liveness: "unknown",
    },
  });
  const invalidSummary = buildDashboardHealthSummary({
    ...baseInput,
    previous: {
      stale: "maybe",
      liveness: "warming",
    },
  });

  assert.equal(staleSummary.stale, true);
  assert.equal(staleSummary.liveness, "dead");
  assert.equal(unknownSummary.stale, null);
  assert.equal(unknownSummary.liveness, "unknown");
  assert.equal(invalidSummary.stale, null);
  assert.equal(invalidSummary.liveness, "unknown");
});

test("dashboard health verification treats version mismatch as stale", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        ok: true,
        dashboard: {
          port: 60106,
          cwd: "C:/work/project",
          version: "2.0.1",
          liveness: "alive",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  try {
    const summary = await verifyDashboardHealthSummary({
      ...baseInput,
      timeoutMs: 1000,
    });

    assert.equal(summary.liveness, "unknown");
    assert.equal(summary.stale, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dashboard health verification requires the requested cwd", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        ok: true,
        dashboard: {
          port: 60106,
          version: "2.0.2",
          liveness: "alive",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  try {
    const summary = await verifyDashboardHealthSummary({
      ...baseInput,
      timeoutMs: 1000,
    });

    assert.equal(summary.liveness, "unknown");
    assert.equal(summary.stale, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dashboard health verification requires ok=true even when dashboard says alive", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        ok: false,
        dashboard: {
          port: 60106,
          cwd: "C:/work/project",
          version: "2.0.2",
          liveness: "alive",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  try {
    const summary = await verifyDashboardHealthSummary({
      ...baseInput,
      timeoutMs: 1000,
    });

    assert.equal(summary.liveness, "unknown");
    assert.equal(summary.stale, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
