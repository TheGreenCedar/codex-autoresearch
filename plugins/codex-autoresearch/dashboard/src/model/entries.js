import { numericOrNull } from "./metrics.js";

export function normalizeEntries(entries) {
  const segments = [];
  let segment = 0;
  let config = defaultConfig();
  const ensureSegment = (index) => {
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
      config = { ...defaultConfig(), ...entry };
      ensureSegment(segment).config = { ...config };
      continue;
    }
    if (entry.type && entry.type !== "run") continue;
    if (!("metric" in entry) && !("status" in entry)) continue;
    const runSegment = entry.segment == null ? segment : Number(entry.segment);
    const target = ensureSegment(Number.isFinite(runSegment) ? runSegment : segment);
    target.runs.push({
      run: Number(entry.run) || target.runs.length + 1,
      metric: numericOrNull(entry.metric),
      status: entry.status || "keep",
      description: entry.description || "",
      confidence: entry.confidence,
      asi: entry.asi || {},
      segment: target.segment,
    });
  }
  return {
    segments,
    latestSegment: segments.length ? segments[segments.length - 1].segment : 0,
  };
}

export function defaultConfig() {
  return {
    name: "Autoresearch",
    metricName: "metric",
    metricUnit: "",
    bestDirection: "lower",
  };
}
