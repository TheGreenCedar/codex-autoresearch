import assert from "node:assert/strict";
import test from "node:test";
import {
  bootstrapDashboardPayload,
  developmentShowcaseEnabled,
  validateLiveDashboardPayload,
} from "../../dashboard/src/bootstrap.js";
import { DASHBOARD_PAYLOAD_VERSION } from "../../dashboard/src/types.js";
import { createDashboardHarness, dashboardConfigEntry } from ".././helpers/dashboard.js";

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

test("dashboard bootstrap fails closed outside an explicit development showcase", () => {
  const missing = bootstrapDashboardPayload(undefined, undefined);
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.failure.mode, "Unknown Delivery Mode");
    assert.match(missing.failure.reason, /data injection is missing/);
    assert.match(missing.failure.recovery, /export --cwd <project>/);
  }

  for (const [entries, meta, reason] of [
    [{}, {}, /not an array/],
    [[], [], /metadata injection/],
    [[], "invalid", /metadata injection/],
    [[], { viewModel: [] }, /view model is not an object/],
    [[], { deliveryMode: [] }, /delivery mode is not a string/],
    [[], { showcaseMode: "yes" }, /showcaseMode flag is not a boolean/],
    [[], { liveRefreshAvailable: "yes" }, /liveRefreshAvailable flag is not a boolean/],
    [[], { liveActionsAvailable: 1 }, /liveActionsAvailable flag is not a boolean/],
    [[], { refreshMs: "5000" }, /refresh interval is not a positive finite number/],
    [[], { settings: { showcaseMode: "false" } }, /settings showcaseMode flag/],
    [[], { settings: { deliveryMode: [] } }, /settings delivery mode is not a string/],
    [[], { modeGuidance: { detail: {} } }, /mode guidance detail is not a string/],
    [
      [],
      { deliveryMode: "static-export", showcaseMode: true },
      /showcase marker conflicts with the delivery mode/,
    ],
    [
      [],
      {
        deliveryMode: "live-server",
        liveRefreshAvailable: true,
        settings: { deliveryMode: "static-export" },
      },
      /delivery mode conflicts with dashboard settings/,
    ],
    [[{ type: "config", name: 42 }], {}, /malformed config entry/],
    [[{ type: "event", message: "unknown" }], {}, /invalid auxiliary ledger entry/],
    [
      [dashboardConfigEntry({ name: "invalid payload", metricName: "seconds" }), null],
      {},
      /invalid ledger entry/,
    ],
    [
      [
        dashboardConfigEntry({ name: "invalid payload", metricName: "seconds" }),
        { type: "run", metric: 1, status: "not-a-status" },
      ],
      {},
      /invalid status/,
    ],
    [[], { payloadVersion: DASHBOARD_PAYLOAD_VERSION + 1 }, /incompatible/],
  ] as const) {
    const result = bootstrapDashboardPayload(entries, meta);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.failure.reason, reason);
  }

  assert.equal(developmentShowcaseEnabled(false, "?showcase=1"), false);
  assert.equal(developmentShowcaseEnabled(true, ""), false);
  assert.equal(developmentShowcaseEnabled(true, "?showcase=1"), true);
  const showcase = bootstrapDashboardPayload(undefined, undefined, { developmentShowcase: true });
  assert.equal(showcase.ok, true);
  if (showcase.ok) {
    assert.equal(showcase.meta.deliveryMode, "showcase");
    assert.equal(showcase.meta.showcaseMode, true);
    assert.ok(showcase.entries.length > 1);
  }

  const auxiliary = bootstrapDashboardPayload(
    [
      { type: "research_fanout", fanoutPlan: { status: "planned" } },
      { type: "lane_result", lane: { id: "scout" }, result: { status: "complete" } },
      { type: "approval", gate: "big_idea_architecture", scope: "scout" },
      {
        type: "process_lifecycle",
        identity: { packetId: "packet-1", processId: "benchmark" },
        event: "terminated",
        at: "2026-07-10T12:00:00.000Z",
        termination: { proven: true, reason: "terminated" },
      },
    ],
    {},
  );
  assert.equal(auxiliary.ok, true);

  const sensitiveMode = "token=supersecretvalue C:\\Users\\Alice\\private.txt";
  const unsupportedMode = bootstrapDashboardPayload([], { deliveryMode: sensitiveMode });
  assert.equal(unsupportedMode.ok, false);
  if (!unsupportedMode.ok) {
    assert.equal(unsupportedMode.failure.reason, "Dashboard delivery mode is not supported.");
    assert.doesNotMatch(unsupportedMode.failure.reason, /supersecretvalue|Alice|private\.txt/);
  }
});

test("dashboard bootstrap accepts the legacy, static, live, and explicit showcase mode matrix", () => {
  for (const meta of [
    {},
    {
      deliveryMode: "static-export",
      liveActionsAvailable: false,
      refreshMs: 5_000,
      settings: { deliveryMode: "static-export", showcaseMode: false },
      modeGuidance: { title: "Static Snapshot", detail: "Read-only snapshot." },
    },
    {
      deliveryMode: "live-server",
      liveRefreshAvailable: true,
      liveActionsAvailable: false,
      refreshMs: 5_000,
      settings: { deliveryMode: "live-server", showcaseMode: false },
      modeGuidance: { title: "Live Readout", detail: "Live refresh is available." },
    },
    {
      deliveryMode: "showcase",
      showcaseMode: true,
      liveRefreshAvailable: false,
      liveActionsAvailable: false,
      settings: { deliveryMode: "showcase", showcaseMode: true },
      modeGuidance: { title: "Demo Snapshot", detail: "Explicit showcase data." },
    },
  ]) {
    assert.equal(bootstrapDashboardPayload([], meta).ok, true, JSON.stringify(meta));
  }
});

test("dashboard live payload validation rejects missing, malformed, and incompatible evidence", () => {
  for (const [payload, reason] of [
    [null, /not an object/],
    [[], /not an object/],
    [{}, /does not contain a ledger entry array/],
    [{ ledgerEntries: {} }, /does not contain a ledger entry array/],
    [{ ledgerEntries: [null] }, /invalid ledger entry/],
    [{ payloadVersion: DASHBOARD_PAYLOAD_VERSION + 1, ledgerEntries: [] }, /incompatible/],
  ] as const) {
    const result = validateLiveDashboardPayload(payload);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, reason);
  }

  const valid = validateLiveDashboardPayload({
    payloadVersion: DASHBOARD_PAYLOAD_VERSION,
    ledgerEntries: [
      dashboardConfigEntry({ name: "live", metricName: "seconds" }),
      {
        type: "process_lifecycle",
        identity: { packetId: "packet-live", processId: "checks" },
        event: "termination-failed",
        at: "2026-07-10T12:00:00.000Z",
        termination: { proven: false, reason: "remaining_processes_alive" },
      },
    ],
  });
  assert.equal(valid.ok, true);

  for (const malformed of [
    {
      type: "process_lifecycle",
      identity: { packetId: "packet-1", processId: "benchmark" },
      event: "terminated",
      at: "2026-07-10T12:00:00.000Z",
      termination: { proven: false, reason: "remaining_processes_alive" },
    },
    {
      type: "process_lifecycle",
      identity: { packetId: "packet-1" },
      event: "started",
      at: "not-a-time",
    },
    {
      type: "process_lifecycle",
      identity: { packetId: "packet-1", processId: "benchmark" },
      event: "started",
      at: "2026-07-10T12:00:00.000Z",
      termination: { proven: false, reason: "remaining_processes_alive" },
    },
    {
      type: "process_lifecycle",
      identity: { packetId: "packet-1", processId: "benchmark" },
      event: "termination-failed",
      at: "2026-07-10T12:00:00.000Z",
      termination: { proven: true, reason: "terminated" },
    },
  ]) {
    assert.equal(bootstrapDashboardPayload([malformed], {}).ok, false);
    assert.equal(
      validateLiveDashboardPayload({
        payloadVersion: DASHBOARD_PAYLOAD_VERSION,
        ledgerEntries: [malformed],
      }).ok,
      false,
    );
  }
});

test("production dashboard renders a payload-unavailable state instead of demo evidence", async () => {
  const { dom, getById, queryById } = await runDashboard([], {}, { omitPayloadGlobals: true });
  const alert = dom.window.document.querySelector('[role="alert"]');

  assert.equal(getById("dashboard-root").dataset.dashboardState, "payload-unavailable");
  assert.equal(alert?.getAttribute("aria-live"), "assertive");
  assert.equal(getById("payload-failure-title").textContent, "Dashboard Payload Unavailable");
  assert.match(getById("payload-failure-reason").textContent || "", /data injection is missing/);
  assert.match(getById("payload-failure-recovery").textContent || "", /export --cwd <project>/);
  assert.equal(queryById("trend-panel") === null, true);
  assert.doesNotMatch(getById("dashboard-root").textContent || "", /Indexing Pipeline Speed/);
});

test("static and served bootstrap failures show mode-specific recovery", async () => {
  for (const { entries, meta, mode, recovery } of [
    {
      entries: [],
      meta: { deliveryMode: "static-export", payloadVersion: DASHBOARD_PAYLOAD_VERSION + 1 },
      mode: "Static Snapshot",
      recovery: /export --cwd <project>/,
    },
    {
      entries: {},
      meta: { deliveryMode: "live-server" },
      mode: "Live Readout",
      recovery: /serve --cwd <project>/,
    },
  ]) {
    const { dom, getById, queryById } = await runDashboard(entries, meta);
    assert.match(getById("dashboard-root").textContent || "", new RegExp(mode));
    assert.match(getById("payload-failure-recovery").textContent || "", recovery);
    assert.equal(queryById("trend-panel") === null, true);
    dom.window.close();
  }
});
