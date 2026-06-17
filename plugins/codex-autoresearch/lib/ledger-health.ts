import fs from "node:fs";

import { jsonlPath } from "./session-records.js";
import { isUnknownRecord, type UnknownRecord } from "./types/json.js";

export type LedgerRecord = UnknownRecord;

export interface LedgerRunRange {
  start: number;
  end: number;
  count: number;
}

export interface LedgerParseError {
  line: number;
  message: string;
}

export interface LedgerHealth {
  ok: boolean;
  totalRecords: number;
  duplicateRuns: number[];
  duplicateRunCount: number;
  duplicateRunsOmitted: number;
  missingRuns: number[];
  missingRunCount: number;
  missingRunsOmitted: number;
  missingRunRanges: LedgerRunRange[];
  missingRunRangeCount: number;
  missingRunRangesOmitted: number;
  nonMonotonicRuns: Array<{ previous: number; current: number; index: number }>;
  nonMonotonicRunCount: number;
  nonMonotonicRunsOmitted: number;
  malformedRecords: number[];
  malformedRecordCount: number;
  malformedRecordsOmitted: number;
  parseErrors: LedgerParseError[];
  parseErrorCount: number;
  parseErrorsOmitted: number;
  bounded: {
    sampleLimit: number;
    truncated: boolean;
  };
  warnings: string[];
}

export interface LedgerRepair {
  changed: boolean;
  records: LedgerRecord[];
  repairs: Array<{ index: number; previousRun: number; repairedRun: number }>;
}

export interface TolerantLedgerRead {
  ledgerPath: string;
  records: LedgerRecord[];
  parseErrors: LedgerParseError[];
}

const DEFAULT_SAMPLE_LIMIT = 20;

export function readLedgerRecordsTolerant(workDir: string): TolerantLedgerRead {
  const ledgerPath = jsonlPath(workDir);
  if (!fs.existsSync(ledgerPath)) return { ledgerPath, records: [], parseErrors: [] };
  const records: LedgerRecord[] = [];
  const parseErrors: LedgerParseError[] = [];
  const lines = fs.readFileSync(ledgerPath, "utf8").split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isUnknownRecord(parsed)) {
        records.push(parsed);
        return;
      }
      parseErrors.push({
        line: index + 1,
        message: "Expected JSON object ledger entry.",
      });
    } catch (error) {
      parseErrors.push({
        line: index + 1,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return { ledgerPath, records, parseErrors };
}

export function analyzeLedgerHealth(
  records: LedgerRecord[],
  options: { parseErrors?: LedgerParseError[]; sampleLimit?: number } = {},
): LedgerHealth {
  const sampleLimit = positiveSampleLimit(options.sampleLimit);
  const runCounts = new Map<number, number>();
  const numericRuns: Array<{ run: number; index: number }> = [];
  const malformedRecordSamples: number[] = [];
  let malformedRecordCount = 0;

  records.forEach((record, index) => {
    if (!Object.hasOwn(record, "run")) return;
    const run = record.run;
    if (!isValidRunNumber(run)) {
      malformedRecordCount += 1;
      pushSample(malformedRecordSamples, index, sampleLimit);
      return;
    }
    numericRuns.push({ run, index });
    runCounts.set(run, (runCounts.get(run) || 0) + 1);
  });

  const allDuplicateRuns = [...runCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([run]) => run)
    .sort((left, right) => left - right);
  const duplicateRuns = allDuplicateRuns.slice(0, sampleLimit);

  const missing = missingRunSummary(
    [...runCounts.keys()].sort((left, right) => left - right),
    {
      sampleLimit,
    },
  );
  const nonMonotonic = nonMonotonicRunTransitions(numericRuns, { sampleLimit });
  const parseErrors = (options.parseErrors || []).slice(0, sampleLimit);
  const parseErrorCount = options.parseErrors?.length || 0;
  const truncated =
    allDuplicateRuns.length > duplicateRuns.length ||
    missing.missingRunCount > missing.missingRuns.length ||
    missing.missingRunRangeCount > missing.missingRunRanges.length ||
    nonMonotonic.nonMonotonicRunCount > nonMonotonic.nonMonotonicRuns.length ||
    malformedRecordCount > malformedRecordSamples.length ||
    parseErrorCount > parseErrors.length;
  const warnings = ledgerWarnings({
    duplicateRuns,
    duplicateRunCount: allDuplicateRuns.length,
    duplicateRunsOmitted: allDuplicateRuns.length - duplicateRuns.length,
    missing,
    nonMonotonic,
    malformedRecords: malformedRecordSamples,
    malformedRecordCount,
    malformedRecordsOmitted: malformedRecordCount - malformedRecordSamples.length,
    parseErrors,
    parseErrorCount,
    parseErrorsOmitted: parseErrorCount - parseErrors.length,
  });

  return {
    ok: warnings.length === 0 && parseErrorCount === 0,
    totalRecords: records.length,
    duplicateRuns,
    duplicateRunCount: allDuplicateRuns.length,
    duplicateRunsOmitted: allDuplicateRuns.length - duplicateRuns.length,
    missingRuns: missing.missingRuns,
    missingRunCount: missing.missingRunCount,
    missingRunsOmitted: missing.missingRunsOmitted,
    missingRunRanges: missing.missingRunRanges,
    missingRunRangeCount: missing.missingRunRangeCount,
    missingRunRangesOmitted: missing.missingRunRangesOmitted,
    nonMonotonicRuns: nonMonotonic.nonMonotonicRuns,
    nonMonotonicRunCount: nonMonotonic.nonMonotonicRunCount,
    nonMonotonicRunsOmitted: nonMonotonic.nonMonotonicRunsOmitted,
    malformedRecords: malformedRecordSamples,
    malformedRecordCount,
    malformedRecordsOmitted: malformedRecordCount - malformedRecordSamples.length,
    parseErrors,
    parseErrorCount,
    parseErrorsOmitted: parseErrorCount - parseErrors.length,
    bounded: {
      sampleLimit,
      truncated,
    },
    warnings,
  };
}

export function repairLedgerRecords(records: LedgerRecord[]): LedgerRepair {
  const health = analyzeLedgerHealth(records);
  const recordsCopy = records.map((record) => ({ ...record }));
  if (health.duplicateRuns.length === 0) {
    return { changed: false, records: recordsCopy, repairs: [] };
  }

  const repairs: LedgerRepair["repairs"] = [];
  let nextRun = 1;
  const repairedRecords = recordsCopy.map((record, index) => {
    if (!isValidRunNumber(record.run)) return record;
    const previousRun = record.run;
    const repairedRun = nextRun;
    nextRun += 1;
    if (previousRun !== repairedRun) {
      repairs.push({ index, previousRun, repairedRun });
      return { ...record, run: repairedRun };
    }
    return record;
  });

  return {
    changed: repairs.length > 0,
    records: repairedRecords,
    repairs,
  };
}

function isValidRunNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function missingRunSummary(
  sortedRuns: number[],
  { sampleLimit }: { sampleLimit: number },
): {
  missingRuns: number[];
  missingRunCount: number;
  missingRunsOmitted: number;
  missingRunRanges: LedgerRunRange[];
  missingRunRangeCount: number;
  missingRunRangesOmitted: number;
} {
  const missingRuns: number[] = [];
  const missingRunRanges: LedgerRunRange[] = [];
  let missingRunCount = 0;
  let missingRunRangeCount = 0;
  let previous = 0;
  for (const run of sortedRuns) {
    const start = previous + 1;
    const end = run - 1;
    if (end >= start) {
      const count = end - start + 1;
      missingRunCount += count;
      missingRunRangeCount += 1;
      pushSample(missingRunRanges, { start, end, count }, sampleLimit);
      for (
        let candidate = start;
        candidate <= end && missingRuns.length < sampleLimit;
        candidate += 1
      ) {
        missingRuns.push(candidate);
      }
    }
    previous = run;
  }
  return {
    missingRuns,
    missingRunCount,
    missingRunsOmitted: Math.max(0, missingRunCount - missingRuns.length),
    missingRunRanges,
    missingRunRangeCount,
    missingRunRangesOmitted: Math.max(0, missingRunRangeCount - missingRunRanges.length),
  };
}

function nonMonotonicRunTransitions(
  numericRuns: Array<{ run: number; index: number }>,
  { sampleLimit }: { sampleLimit: number },
): {
  nonMonotonicRuns: Array<{ previous: number; current: number; index: number }>;
  nonMonotonicRunCount: number;
  nonMonotonicRunsOmitted: number;
} {
  const nonMonotonicRuns: Array<{ previous: number; current: number; index: number }> = [];
  let nonMonotonicRunCount = 0;
  let previous: number | null = null;
  for (const { run, index } of numericRuns) {
    if (previous != null && run <= previous) {
      nonMonotonicRunCount += 1;
      pushSample(nonMonotonicRuns, { previous, current: run, index }, sampleLimit);
    }
    previous = run;
  }
  return {
    nonMonotonicRuns,
    nonMonotonicRunCount,
    nonMonotonicRunsOmitted: Math.max(0, nonMonotonicRunCount - nonMonotonicRuns.length),
  };
}

function ledgerWarnings({
  duplicateRuns,
  duplicateRunCount,
  duplicateRunsOmitted,
  missing,
  nonMonotonic,
  malformedRecords,
  malformedRecordCount,
  malformedRecordsOmitted,
  parseErrors,
  parseErrorCount,
  parseErrorsOmitted,
}: {
  duplicateRuns: number[];
  duplicateRunCount: number;
  duplicateRunsOmitted: number;
  missing: ReturnType<typeof missingRunSummary>;
  nonMonotonic: ReturnType<typeof nonMonotonicRunTransitions>;
  malformedRecords: number[];
  malformedRecordCount: number;
  malformedRecordsOmitted: number;
  parseErrors: LedgerParseError[];
  parseErrorCount: number;
  parseErrorsOmitted: number;
}): string[] {
  const warnings: string[] = [];
  if (duplicateRunCount) {
    warnings.push(`Duplicate run numbers: ${formatSample(duplicateRuns, duplicateRunsOmitted)}`);
  }
  if (missing.missingRunCount) {
    warnings.push(`Missing run numbers: ${formatMissingSummary(missing)}`);
  }
  if (nonMonotonic.nonMonotonicRunCount) {
    warnings.push(
      `Non-monotonic run numbers at record indexes: ${formatSample(
        nonMonotonic.nonMonotonicRuns.map((entry) => entry.index).map(String),
        nonMonotonic.nonMonotonicRunsOmitted,
      )}`,
    );
  }
  if (malformedRecordCount) {
    warnings.push(
      `Malformed run fields at record indexes: ${formatSample(
        malformedRecords,
        malformedRecordsOmitted,
      )}`,
    );
  }
  if (parseErrorCount) {
    warnings.push(
      `Malformed JSONL lines: ${formatSample(
        parseErrors.map((error) => error.line),
        parseErrorsOmitted,
      )}`,
    );
  }
  return warnings;
}

function positiveSampleLimit(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : DEFAULT_SAMPLE_LIMIT;
}

function pushSample<T>(target: T[], value: T, sampleLimit: number): void {
  if (target.length < sampleLimit) target.push(value);
}

function formatSample(values: Array<string | number>, omitted: number): string {
  const suffix = omitted > 0 ? ` (+${omitted} more)` : "";
  return `${values.join(", ")}${suffix}`;
}

function formatMissingSummary(missing: ReturnType<typeof missingRunSummary>): string {
  const sample = formatSample(missing.missingRuns, missing.missingRunsOmitted);
  const firstRange = missing.missingRunRanges[0];
  if (!firstRange) return sample;
  const rangeText =
    firstRange.start === firstRange.end
      ? String(firstRange.start)
      : `${firstRange.start}-${firstRange.end}`;
  const rangeSuffix =
    missing.missingRunRangesOmitted > 0 ? `, +${missing.missingRunRangesOmitted} more ranges` : "";
  return `${sample}; ranges=${missing.missingRunRangeCount} first=${rangeText}${rangeSuffix}`;
}
