type LooseObject = Record<string, unknown>;

export const DASHBOARD_TRANSPORT_MEMORY_LIST_LIMIT = 100;
export const DASHBOARD_TRANSPORT_ARRAY_LIMIT = 100;

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
