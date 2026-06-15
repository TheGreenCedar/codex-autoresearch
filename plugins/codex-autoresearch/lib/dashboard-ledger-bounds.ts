export interface DashboardLedgerBounds {
  maxEntries: number;
  omittedEntries: number;
  truncated: boolean;
}

export interface BoundedDashboardLedgerEntries<T> extends DashboardLedgerBounds {
  entries: T[];
}

export function boundDashboardLedgerEntries<T extends Record<string, unknown>>(
  entries: T[],
  maxEntries: number,
): BoundedDashboardLedgerEntries<T> {
  const safeEntries = Array.isArray(entries) ? entries : [];
  const safeMaxEntries = Math.max(0, Math.floor(Number(maxEntries) || 0));
  if (safeEntries.length <= safeMaxEntries) {
    return {
      entries: safeEntries,
      maxEntries: safeMaxEntries,
      omittedEntries: 0,
      truncated: false,
    };
  }
  if (safeMaxEntries <= 0) {
    return {
      entries: [],
      maxEntries: safeMaxEntries,
      omittedEntries: safeEntries.length,
      truncated: safeEntries.length > 0,
    };
  }

  const tailStart = Math.max(0, safeEntries.length - safeMaxEntries);
  const tail = safeEntries.slice(tailStart);
  const governingConfig = configForFirstVisibleRun(safeEntries, tail, tailStart);
  const prefixedTail =
    safeMaxEntries > 1 && governingConfig && !tail.includes(governingConfig)
      ? [governingConfig, ...tail]
      : tail;
  const bounded = trimToMaxEntries(prefixedTail, safeMaxEntries);

  return {
    entries: bounded,
    maxEntries: safeMaxEntries,
    omittedEntries: Math.max(0, safeEntries.length - bounded.length),
    truncated: true,
  };
}

function configForFirstVisibleRun<T extends Record<string, unknown>>(
  entries: T[],
  tail: T[],
  tailStart: number,
): T | null {
  const firstRunOffset = tail.findIndex(isRunEntry);
  if (firstRunOffset < 0) return null;
  const firstRunIndex = tailStart + firstRunOffset;
  for (let index = firstRunIndex; index >= 0; index -= 1) {
    if (isConfigEntry(entries[index])) return entries[index];
  }
  return null;
}

function trimToMaxEntries<T extends Record<string, unknown>>(entries: T[], maxEntries: number) {
  const bounded = [...entries];
  while (bounded.length > maxEntries) {
    const removable = bounded.findIndex((entry, index) => index > 0 && !isConfigEntry(entry));
    bounded.splice(removable >= 0 ? removable : bounded.length - 1, 1);
  }
  return bounded;
}

function isConfigEntry(entry: unknown): boolean {
  return isRecord(entry) && entry.type === "config";
}

function isRunEntry(entry: unknown): boolean {
  return (
    isRecord(entry) &&
    (entry.type === "run" ||
      (!entry.type && ("run" in entry || "metric" in entry || "status" in entry)))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
