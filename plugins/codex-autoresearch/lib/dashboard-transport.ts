import fs from "node:fs";
import path from "node:path";

import { stripDashboardExportCommandFields } from "./dashboard-command-safety.js";
import { boundDashboardLedgerEntries } from "./dashboard-ledger-bounds.js";
import { redactEvidenceObject } from "./evidence-redaction.js";
import { resolvePackageRoot, resolveRepoRoot } from "./runtime-paths.js";
import { type UnknownRecord, unknownRecordOrNull } from "./types/json.js";

type LooseObject = UnknownRecord;

export const DASHBOARD_TRANSPORT_MEMORY_LIST_LIMIT = 100;
export const DASHBOARD_TRANSPORT_ARRAY_LIMIT = 100;
const DASHBOARD_STATIC_EXPORT_LEDGER_MAX_ENTRIES = 5000;
const PLUGIN_ROOT = resolvePackageRoot(import.meta.url);
const REPO_ROOT = resolveRepoRoot(import.meta.url);
const DASHBOARD_TEMPLATE_PATH = path.join(PLUGIN_ROOT, "assets", "template.html");
const DASHBOARD_BUILD_DIR = path.join(PLUGIN_ROOT, "assets", "dashboard-build");
const DASHBOARD_DATA_PLACEHOLDER = "__AUTORESEARCH_DATA_PAYLOAD__";
const DASHBOARD_META_PLACEHOLDER = "__AUTORESEARCH_META_PAYLOAD__";
const DASHBOARD_APP_PLACEHOLDER = "__AUTORESEARCH_DASHBOARD_APP__";
const DASHBOARD_CSS_PLACEHOLDER = "__AUTORESEARCH_DASHBOARD_CSS__";

const LATEST_TRANSPORT_KEYS = new Set([
  "current",
  "kept",
  "lastRuns",
  "measurementRuns",
  "measurements",
  "nextActions",
  "plottedRuns",
  "recentRuns",
  "rejected",
  "runs",
]);

export function compactDashboardTransportViewModel(value: LooseObject): LooseObject {
  const viewModel = recordOrNull(value);
  if (!viewModel) return {};
  const compacted = {
    ...viewModel,
    experimentMemory: compactExperimentMemoryForTransport(viewModel.experimentMemory),
    portfolio: compactPortfolioForTransport(viewModel.portfolio),
    partialResults: compactPartialResultsForTransport(viewModel.partialResults),
    transportBounds: {
      ...recordOrNull(viewModel.transportBounds),
      memoryListLimit: DASHBOARD_TRANSPORT_MEMORY_LIST_LIMIT,
      arrayLimit: DASHBOARD_TRANSPORT_ARRAY_LIMIT,
    },
  };
  return compactTransportValue(compacted) as LooseObject;
}

export function dashboardHtml(entries: LooseObject[], meta: LooseObject = {}) {
  const settings = unknownRecordOrNull(meta.settings);
  const offlineExport = ["static-export", "showcase"].includes(
    String(meta.deliveryMode || settings?.deliveryMode || ""),
  );
  const dashboardContext = { workDir: meta.workDir || settings?.workDir || "" };
  const publicExport = Boolean(
    meta.publicExport || meta.showcaseMode || settings?.publicExport || settings?.showcaseMode,
  );
  const entriesForClient = offlineExport ? stripDashboardCommandFields(entries) : entries;
  const boundedEntries = offlineExport
    ? boundDashboardStaticExportEntries(entriesForClient)
    : {
        entries: entriesForClient,
        truncated: false,
        omittedEntries: 0,
        maxEntries: Array.isArray(entriesForClient) ? entriesForClient.length : 0,
      };
  const dataForClient = redactEvidenceObject(
    publicExport ? scrubDashboardPublicExport(boundedEntries.entries) : boundedEntries.entries,
    dashboardContext,
  );
  const data = JSON.stringify(dataForClient).replace(/</g, "\\u003c");
  const metaForClient = stripDashboardCommandFields({
    ...meta,
    ledgerBounds: offlineExport
      ? {
          truncated: boundedEntries.truncated,
          omittedEntries: boundedEntries.omittedEntries,
          maxEntries: boundedEntries.maxEntries,
        }
      : undefined,
  });
  const metaData = JSON.stringify(
    redactEvidenceObject(
      publicExport ? scrubDashboardPublicExport(metaForClient) : metaForClient,
      dashboardContext,
    ),
  ).replace(/</g, "\\u003c");
  const template = fs.readFileSync(DASHBOARD_TEMPLATE_PATH, "utf8");
  if (!template.includes(DASHBOARD_DATA_PLACEHOLDER)) {
    throw new Error(`Dashboard template is missing ${DASHBOARD_DATA_PLACEHOLDER}`);
  }
  if (
    !template.includes(DASHBOARD_APP_PLACEHOLDER) ||
    !template.includes(DASHBOARD_CSS_PLACEHOLDER)
  ) {
    throw new Error("Dashboard template is missing React build placeholders.");
  }
  const dashboardApp = readDashboardBuildAsset("dashboard-app.js").replace(
    /<\/script/gi,
    "<\\/script",
  );
  const dashboardCss = readDashboardBuildAsset("dashboard-app.css").replace(
    /<\/style/gi,
    "<\\/style",
  );
  return template
    .replace(DASHBOARD_DATA_PLACEHOLDER, () => data)
    .replace(DASHBOARD_META_PLACEHOLDER, () => metaData)
    .replace(DASHBOARD_CSS_PLACEHOLDER, () => dashboardCss)
    .replace(DASHBOARD_APP_PLACEHOLDER, () => dashboardApp);
}

export function dashboardSafeGuidanceText(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!/autoresearch\.mjs|benchmark-lint|doctor --cwd/i.test(text)) return text;
  if (/runtime/i.test(text)) return "Inspect runtime drift with the CLI before acting.";
  if (/benchmark|metric|setup|gate/i.test(text)) {
    return "Run the CLI benchmark or doctor check before trusting the next packet.";
  }
  return "Use the CLI check before continuing.";
}

function boundDashboardStaticExportEntries(entries: LooseObject[]): {
  entries: LooseObject[];
  maxEntries: number;
  omittedEntries: number;
  truncated: boolean;
} {
  return boundDashboardLedgerEntries(
    Array.isArray(entries) ? entries : [],
    DASHBOARD_STATIC_EXPORT_LEDGER_MAX_ENTRIES,
  );
}

function readDashboardBuildAsset(fileName: string) {
  const filePath = path.join(DASHBOARD_BUILD_DIR, fileName);
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT") {
      throw new Error(
        `Dashboard build asset is missing: ${filePath}. Run npm run build:dashboard from ${PLUGIN_ROOT}.`,
      );
    }
    throw error;
  }
}

function stripDashboardCommandFields<T>(value: T): T {
  return stripDashboardExportCommandFields(value, {
    stringScrubber: dashboardSafeGuidanceText,
  }) as T;
}

function scrubDashboardPublicExport(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => scrubDashboardPublicExport(item));
  if (typeof value === "string") return scrubDashboardPublicExportString(value);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]: [string, unknown]) => {
      if (key === "dirtyFiles") return [key, scrubDashboardPublicExportDirtyFiles()];
      if (isDashboardPublicExportPathList(key, item)) {
        return [key, []];
      }
      return [key, scrubDashboardPublicExport(item)];
    }),
  );
}

function isDashboardPublicExportPathList(key: string, value: unknown) {
  return (
    (key === "files" || key.endsWith("Files")) &&
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
  );
}

function scrubDashboardPublicExportDirtyFiles() {
  return {
    sessionArtifacts: [],
    scopedExperimentFiles: [],
    unrelatedFiles: [],
  };
}

function scrubDashboardPublicExportString(value: string) {
  const placeholders = [
    [PLUGIN_ROOT, "<plugin-root>"],
    [REPO_ROOT, "<repo-root>"],
    [process.execPath, "node"],
  ];
  let scrubbed = value;
  for (const [needle, replacement] of placeholders) {
    if (!needle) continue;
    scrubbed = scrubbed.replaceAll(String(needle), replacement);
    scrubbed = scrubbed.replaceAll(String(needle).replaceAll("\\", "/"), replacement);
  }
  return scrubbed
    .replace(/[A-Za-z]:\\[^\r\n"]+/g, "<local-path>")
    .replace(/[A-Za-z]:\/[^\r\n" ]+/g, "<local-path>");
}

function compactExperimentMemoryForTransport(value: unknown) {
  const memory = recordOrNull(value);
  if (!memory) return value;
  return {
    ...memory,
    kept: latestTransportItems(memory.kept),
    rejected: latestTransportItems(memory.rejected),
    nextActions: latestTransportItems(memory.nextActions),
    families: firstTransportItems(memory.families),
    metricShelves: firstTransportItems(memory.metricShelves),
    exhaustedFamilies: firstTransportItems(memory.exhaustedFamilies),
    missingAsiDetails: latestTransportItems(memory.missingAsiDetails),
    lanePortfolio: firstTransportItems(memory.lanePortfolio),
  };
}

function compactPortfolioForTransport(value: unknown) {
  const portfolio = recordOrNull(value);
  if (!portfolio) return value;
  return {
    ...portfolio,
    families: firstTransportItems(portfolio.families),
    lanes: firstTransportItems(portfolio.lanes),
  };
}

function compactPartialResultsForTransport(value: unknown) {
  const partialResults = recordOrNull(value);
  if (!partialResults) return value;
  return {
    ...partialResults,
    candidates: firstTransportItems(partialResults.candidates),
    skippedArtifacts: firstTransportItems(partialResults.skippedArtifacts),
  };
}

function latestTransportItems(value: unknown) {
  return Array.isArray(value) && value.length > DASHBOARD_TRANSPORT_MEMORY_LIST_LIMIT
    ? value.slice(-DASHBOARD_TRANSPORT_MEMORY_LIST_LIMIT)
    : value;
}

function firstTransportItems(value: unknown) {
  return Array.isArray(value) && value.length > DASHBOARD_TRANSPORT_MEMORY_LIST_LIMIT
    ? value.slice(0, DASHBOARD_TRANSPORT_MEMORY_LIST_LIMIT)
    : value;
}

function compactTransportValue(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) {
    const bounded =
      value.length > DASHBOARD_TRANSPORT_ARRAY_LIMIT
        ? transportArraySlice(value, key, DASHBOARD_TRANSPORT_ARRAY_LIMIT)
        : value;
    return bounded.map((item) => compactTransportValue(item));
  }
  const record = recordOrNull(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record).map(([entryKey, item]) => [
      entryKey,
      compactTransportValue(item, entryKey),
    ]),
  );
}

function transportArraySlice(value: unknown[], key: string, limit: number): unknown[] {
  if (LATEST_TRANSPORT_KEYS.has(key) || value.some(isRunLikeRecord)) {
    return value.slice(-limit);
  }
  return value.slice(0, limit);
}

function isRunLikeRecord(value: unknown): boolean {
  const record = recordOrNull(value);
  return Boolean(record && ("run" in record || "metric" in record || "status" in record));
}

function recordOrNull(value: unknown): LooseObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as LooseObject)
    : null;
}
