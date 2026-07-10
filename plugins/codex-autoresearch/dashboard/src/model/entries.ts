import type {
  DashboardEntry,
  NormalizedEntries,
  SessionConfig,
  SessionRun,
  SessionSegment,
} from "../types";
import { numericOrNull } from "./metrics";

const RUN_STATUSES = new Set(["keep", "discard", "crash", "checks_failed", "measure"]);

export function normalizeEntries(entries: DashboardEntry[] | undefined): NormalizedEntries {
  const segments = new Map<number, SessionSegment>();
  let segment = 0;
  let invalidLedgerEntryCount = 0;
  let config = defaultConfig();
  const ensureSegment = (index: number): SessionSegment => {
    const existing = segments.get(index);
    if (existing) return existing;
    const created = { segment: index, config: { ...config }, runs: [] };
    segments.set(index, created);
    return created;
  };
  ensureSegment(0);
  for (const entry of entries || []) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      invalidLedgerEntryCount += 1;
      continue;
    }
    if (entry.type === "config") {
      if (ensureSegment(segment).runs.length) {
        if (segment === Number.MAX_SAFE_INTEGER) {
          invalidLedgerEntryCount += 1;
          continue;
        }
        segment += 1;
      }
      config = { ...defaultConfig(), ...entry } as SessionConfig;
      ensureSegment(segment).config = { ...config };
      continue;
    }
    if (entry.type && entry.type !== "run") {
      continue;
    }
    if (!("metric" in entry) && !("status" in entry)) {
      invalidLedgerEntryCount += 1;
      continue;
    }
    if (!RUN_STATUSES.has(String(entry.status))) {
      invalidLedgerEntryCount += 1;
      continue;
    }
    const runSegment = entry.segment == null ? segment : Number(entry.segment);
    if (!Number.isSafeInteger(runSegment) || runSegment < 0) {
      invalidLedgerEntryCount += 1;
      continue;
    }
    segment = Math.max(segment, runSegment);
    const target = ensureSegment(runSegment);
    target.runs.push(normalizeRun(entry, target));
  }
  const normalizedSegments = [...segments.values()].sort(
    (left, right) => left.segment - right.segment,
  );
  return {
    segments: normalizedSegments,
    latestSegment: normalizedSegments.at(-1)?.segment ?? 0,
    invalidLedgerEntryCount,
  };
}

export function defaultConfig(): SessionConfig {
  return {
    name: "Autoresearch",
    metricName: "metric",
    metricUnit: "",
    bestDirection: "lower",
  };
}

function normalizeRun(entry: DashboardEntry, target: SessionSegment): SessionRun {
  return {
    ...(entry as SessionRun),
    run: Number(entry.run) || target.runs.length + 1,
    metric: numericOrNull(entry.metric),
    status: (entry.status as SessionRun["status"]) || "keep",
    description: String(entry.description || ""),
    confidence: numericOrNull(entry.confidence),
    metrics:
      entry.metrics && typeof entry.metrics === "object" && !Array.isArray(entry.metrics)
        ? { ...(entry.metrics as Record<string, unknown>) }
        : {},
    asi:
      entry.asi && typeof entry.asi === "object" && !Array.isArray(entry.asi)
        ? { ...(entry.asi as SessionRun["asi"]) }
        : {},
    timestamp: normalizeTimestamp(entry.timestamp),
    segment: target.segment,
  };
}

function normalizeTimestamp(value: unknown): string | number | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}
