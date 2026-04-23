import type {
  DashboardEntry,
  NormalizedEntries,
  SessionConfig,
  SessionRun,
  SessionSegment,
} from "../types";
import { numericOrNull } from "./metrics";

export function normalizeEntries(entries: DashboardEntry[] | undefined): NormalizedEntries {
  const segments: SessionSegment[] = [];
  let segment = 0;
  let config = defaultConfig();
  const ensureSegment = (index: number): SessionSegment => {
    while (segments.length <= index) {
      segments.push({ segment: segments.length, config: { ...config }, runs: [] });
    }
    return segments[index];
  };
  ensureSegment(0);
  for (const entry of entries || []) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "config") {
      if (ensureSegment(segment).runs.length) segment += 1;
      config = { ...defaultConfig(), ...entry } as SessionConfig;
      ensureSegment(segment).config = { ...config };
      continue;
    }
    if (entry.type && entry.type !== "run") continue;
    if (!("metric" in entry) && !("status" in entry)) continue;
    const runSegment = entry.segment == null ? segment : Number(entry.segment);
    const target = ensureSegment(Number.isFinite(runSegment) ? runSegment : segment);
    target.runs.push(normalizeRun(entry, target));
  }
  return {
    segments,
    latestSegment: segments.length ? segments[segments.length - 1].segment : 0,
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
    timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
    segment: target.segment,
  };
}
