import { type JsonObject, type UnknownRecord, unknownRecordOrEmpty } from "./json.js";
import { type PacketRecord } from "./packet.js";

export type MetricDirection = "lower" | "higher";
export type RunStatus =
  | "baseline"
  | "keep"
  | "discard"
  | "crash"
  | "checks_failed"
  | "partial"
  | string;

export interface SessionConfig extends UnknownRecord {
  benchmarkCommand?: string;
  checksCommand?: string;
  commitPaths?: string[];
  goal?: string;
  metricName?: string;
  metricUnit?: string;
  name?: string | null;
  packetBudget?: number;
  wallClockBudgetSeconds?: number;
  workingDir?: string;
  bestDirection?: MetricDirection;
}

export interface RunRecord extends UnknownRecord {
  asi?: JsonObject | UnknownRecord;
  metric?: number | string | null;
  metrics?: Record<string, number>;
  packetEvidence?: PacketRecord["packetEvidence"];
  run?: number;
  segment?: number;
  status?: RunStatus;
}

export interface SessionState extends UnknownRecord {
  config: SessionConfig;
  current: RunRecord[];
  results: RunRecord[];
  segment: number;
}

export interface SessionLedgerEntry extends UnknownRecord {
  asi?: JsonObject | UnknownRecord;
  at?: string;
  id?: string;
  packetEvidence?: PacketRecord["packetEvidence"];
  run?: number;
  status?: RunStatus;
  type?: string;
}

export function normalizeSessionConfig(value: unknown): SessionConfig {
  const record = unknownRecordOrEmpty(value);
  return {
    ...record,
    benchmarkCommand: stringOrUndefined(record.benchmarkCommand),
    bestDirection: normalizeMetricDirection(record.bestDirection),
    checksCommand: stringOrUndefined(record.checksCommand),
    commitPaths: stringArrayOrUndefined(record.commitPaths),
    goal: stringOrUndefined(record.goal),
    metricName: stringOrUndefined(record.metricName),
    metricUnit: stringOrUndefined(record.metricUnit),
    name: typeof record.name === "string" || record.name === null ? record.name : undefined,
    packetBudget: positiveIntegerOrUndefined(record.packetBudget),
    wallClockBudgetSeconds: positiveIntegerOrUndefined(record.wallClockBudgetSeconds),
    workingDir: stringOrUndefined(record.workingDir),
  };
}

export function normalizeSessionState(value: unknown): SessionState {
  const record = unknownRecordOrEmpty(value);
  return {
    ...record,
    config: normalizeSessionConfig(record.config),
    current: normalizeRunRecords(record.current),
    results: normalizeRunRecords(record.results),
    segment: positiveIntegerOrUndefined(record.segment) ?? 0,
  };
}

function normalizeRunRecords(value: unknown): RunRecord[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => unknownRecordOrEmpty(item));
}

function normalizeMetricDirection(value: unknown): MetricDirection | undefined {
  return value === "lower" || value === "higher" ? value : undefined;
}

function positiveIntegerOrUndefined(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function stringArrayOrUndefined(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.map((item) => String(item)).filter(Boolean);
  return values.length ? values : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
