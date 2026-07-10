import { DEMO_ENTRIES, DEMO_META } from "./demoData";
import {
  DASHBOARD_PAYLOAD_VERSION,
  type DashboardEntry,
  type DashboardMeta,
  type DashboardViewModel,
} from "./types";

type DashboardPayloadFailure = {
  mode: string;
  provenance: string;
  reason: string;
  recovery: string;
};

export type DashboardBootstrapResult =
  | { ok: true; entries: DashboardEntry[]; meta: DashboardMeta }
  | { ok: false; failure: DashboardPayloadFailure };

export type LiveDashboardPayloadResult =
  | { ok: true; entries: DashboardEntry[]; viewModel: DashboardViewModel }
  | { ok: false; reason: string };

const RUN_STATUSES = new Set(["keep", "discard", "crash", "checks_failed", "measure"]);
const AUXILIARY_ENTRY_TYPES = new Set(["research_fanout", "lane_result", "approval"]);
const DELIVERY_MODES = new Set(["static-export", "live-server", "showcase"]);

export function bootstrapDashboardPayload(
  entriesValue: unknown,
  metaValue: unknown,
  { developmentShowcase = false }: { developmentShowcase?: boolean } = {},
): DashboardBootstrapResult {
  if (developmentShowcase) {
    return {
      ok: true,
      entries: DEMO_ENTRIES,
      meta: {
        ...DEMO_META,
        deliveryMode: "showcase",
        showcaseMode: true,
        settings: { ...DEMO_META.settings, deliveryMode: "showcase", showcaseMode: true },
      },
    };
  }

  const meta = recordOrNull(metaValue);
  const failureContext = payloadFailureContext(meta);
  if (!Array.isArray(entriesValue)) {
    return failure(failureContext, "Dashboard data injection is missing or is not an array.");
  }
  if (!meta) {
    return failure(failureContext, "Dashboard metadata injection is missing or is not an object.");
  }
  const metaIssue = dashboardMetaIssue(meta);
  if (metaIssue) return failure(failureContext, metaIssue);
  const entryIssue = dashboardEntryIssue(entriesValue);
  if (entryIssue) return failure(failureContext, entryIssue);
  return {
    ok: true,
    entries: entriesValue as DashboardEntry[],
    meta: meta as DashboardMeta,
  };
}

export function developmentShowcaseEnabled(isDevelopment: boolean, search: string): boolean {
  return isDevelopment && new URLSearchParams(search).get("showcase") === "1";
}

export function validateLiveDashboardPayload(payload: unknown): LiveDashboardPayloadResult {
  const viewModel = recordOrNull(payload);
  if (!viewModel) {
    return { ok: false, reason: "Live readout payload is not an object." };
  }
  const versionIssue = payloadVersionIssue(viewModel.payloadVersion);
  if (versionIssue) return { ok: false, reason: versionIssue };

  const entries = firstEntryArray(viewModel);
  if (!entries) {
    return { ok: false, reason: "Live readout payload does not contain a ledger entry array." };
  }
  const entryIssue = dashboardEntryIssue(entries);
  if (entryIssue) return { ok: false, reason: entryIssue };
  return {
    ok: true,
    entries: entries as DashboardEntry[],
    viewModel: viewModel as DashboardViewModel,
  };
}

function dashboardMetaIssue(meta: Record<string, unknown>): string | null {
  const versionIssue = payloadVersionIssue(meta.payloadVersion);
  if (versionIssue) return versionIssue;
  if (meta.deliveryMode !== undefined && typeof meta.deliveryMode !== "string") {
    return "Dashboard delivery mode is not a string.";
  }
  for (const key of ["liveRefreshAvailable", "liveActionsAvailable", "showcaseMode"]) {
    if (meta[key] !== undefined && typeof meta[key] !== "boolean") {
      return `Dashboard metadata ${key} flag is not a boolean.`;
    }
  }
  if (meta.settings !== undefined && !recordOrNull(meta.settings)) {
    return "Dashboard metadata settings are not an object.";
  }
  if (meta.modeGuidance !== undefined && !recordOrNull(meta.modeGuidance)) {
    return "Dashboard mode guidance is not an object.";
  }
  if (meta.viewModel !== undefined && !recordOrNull(meta.viewModel)) {
    return "Dashboard view model is not an object.";
  }
  if (
    meta.refreshMs !== undefined &&
    (typeof meta.refreshMs !== "number" || !Number.isFinite(meta.refreshMs) || meta.refreshMs < 1)
  ) {
    return "Dashboard refresh interval is not a positive finite number.";
  }

  const settings = recordOrNull(meta.settings);
  if (settings?.deliveryMode !== undefined && typeof settings.deliveryMode !== "string") {
    return "Dashboard settings delivery mode is not a string.";
  }
  if (settings?.showcaseMode !== undefined && typeof settings.showcaseMode !== "boolean") {
    return "Dashboard settings showcaseMode flag is not a boolean.";
  }

  const guidance = recordOrNull(meta.modeGuidance);
  for (const key of ["title", "detail"]) {
    if (guidance?.[key] !== undefined && typeof guidance[key] !== "string") {
      return `Dashboard mode guidance ${key} is not a string.`;
    }
  }

  return dashboardModeIssue(meta, settings);
}

function dashboardModeIssue(
  meta: Record<string, unknown>,
  settings: Record<string, unknown> | null,
): string | null {
  const deliveryMode = meta.deliveryMode as string | undefined;
  const settingsDeliveryMode = settings?.deliveryMode as string | undefined;
  for (const mode of [deliveryMode, settingsDeliveryMode]) {
    if (mode !== undefined && !DELIVERY_MODES.has(mode)) {
      return "Dashboard delivery mode is not supported.";
    }
  }
  if (
    deliveryMode !== undefined &&
    settingsDeliveryMode !== undefined &&
    deliveryMode !== settingsDeliveryMode
  ) {
    return "Dashboard delivery mode conflicts with dashboard settings.";
  }

  const showcaseMode = meta.showcaseMode as boolean | undefined;
  const settingsShowcaseMode = settings?.showcaseMode as boolean | undefined;
  if (
    showcaseMode !== undefined &&
    settingsShowcaseMode !== undefined &&
    showcaseMode !== settingsShowcaseMode
  ) {
    return "Dashboard showcase mode conflicts with dashboard settings.";
  }

  const mode = deliveryMode ?? settingsDeliveryMode;
  const showcase = showcaseMode ?? settingsShowcaseMode;
  if (mode === "showcase" && showcase !== true) {
    return "Dashboard showcase delivery is missing its explicit showcase marker.";
  }
  if (showcase === true && mode !== "showcase") {
    return "Dashboard showcase marker conflicts with the delivery mode.";
  }
  if (meta.liveRefreshAvailable === true && mode !== "live-server") {
    return "Dashboard live refresh conflicts with the delivery mode.";
  }
  if (meta.liveActionsAvailable === true) {
    return "Dashboard live actions are not supported by this read-only dashboard.";
  }
  return null;
}

function payloadVersionIssue(value: unknown): string | null {
  if (value === undefined) return null;
  if (value === DASHBOARD_PAYLOAD_VERSION) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return "Dashboard payload version marker is invalid.";
  }
  return `Dashboard payload version ${value} is incompatible; this dashboard supports version ${DASHBOARD_PAYLOAD_VERSION}.`;
}

function dashboardEntryIssue(entries: unknown[]): string | null {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = recordOrNull(entries[index]);
    if (!entry) return `Dashboard data contains an invalid ledger entry at position ${index + 1}.`;
    if (entry.type === "config") {
      if (
        (entry.name !== undefined && typeof entry.name !== "string") ||
        (entry.metricName !== undefined && typeof entry.metricName !== "string") ||
        (entry.bestDirection !== undefined &&
          !["lower", "higher"].includes(String(entry.bestDirection)))
      ) {
        return `Dashboard data contains a malformed config entry at position ${index + 1}.`;
      }
      continue;
    }
    if (entry.type !== undefined && entry.type !== "run") {
      if (!AUXILIARY_ENTRY_TYPES.has(String(entry.type)) || auxiliaryEntryIssue(entry)) {
        return `Dashboard data contains an invalid auxiliary ledger entry at position ${index + 1}.`;
      }
      continue;
    }
    if (!("metric" in entry) && !("status" in entry)) {
      return `Dashboard data contains a malformed run entry at position ${index + 1}.`;
    }
    if (!RUN_STATUSES.has(String(entry.status))) {
      return `Dashboard data contains a run with an invalid status at position ${index + 1}.`;
    }
    if (
      entry.segment !== undefined &&
      (!Number.isSafeInteger(entry.segment) || Number(entry.segment) < 0)
    ) {
      return `Dashboard data contains a run with an invalid segment at position ${index + 1}.`;
    }
  }
  return null;
}

function auxiliaryEntryIssue(entry: Record<string, unknown>): boolean {
  if (entry.type === "research_fanout") return !recordOrNull(entry.fanoutPlan);
  if (entry.type === "lane_result") {
    return !recordOrNull(entry.lane) || !recordOrNull(entry.result);
  }
  return (
    entry.type !== "approval" ||
    typeof entry.gate !== "string" ||
    !entry.gate.trim() ||
    typeof entry.scope !== "string" ||
    !entry.scope.trim()
  );
}

function firstEntryArray(value: Record<string, unknown>): unknown[] | null {
  for (const key of ["ledgerEntries", "entries", "dashboardEntries"]) {
    if (!(key in value)) continue;
    return Array.isArray(value[key]) ? value[key] : null;
  }
  return null;
}

function payloadFailureContext(meta: Record<string, unknown> | null) {
  const deliveryMode = typeof meta?.deliveryMode === "string" ? meta.deliveryMode : "";
  if (deliveryMode === "live-server") {
    return {
      mode: "Live Readout",
      provenance: "Rejected live bootstrap payload",
      recovery: "Run the Autoresearch CLI: serve --cwd <project>. Then open the newly printed URL.",
    };
  }
  if (meta?.showcaseMode === true || deliveryMode === "showcase") {
    return {
      mode: "Showcase Demo",
      provenance: "Rejected showcase payload",
      recovery:
        "Run the Autoresearch CLI: export --cwd <project> --showcase. Then open the new HTML file.",
    };
  }
  if (deliveryMode === "static-export") {
    return {
      mode: "Static Snapshot",
      provenance: "Rejected embedded snapshot payload",
      recovery: "Run the Autoresearch CLI: export --cwd <project>. Then open the new HTML file.",
    };
  }
  return {
    mode: "Unknown Delivery Mode",
    provenance: "Dashboard payload unavailable",
    recovery:
      "Run the Autoresearch CLI: export --cwd <project>, or serve --cwd <project>. Then reload.",
  };
}

function failure(
  context: Omit<DashboardPayloadFailure, "reason">,
  reason: string,
): DashboardBootstrapResult {
  return { ok: false, failure: { ...context, reason } };
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
