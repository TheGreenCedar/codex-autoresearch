import { type JsonObject, type UnknownRecord, unknownRecordOrEmpty } from "./json.js";

export type PacketStatus = "pending" | "complete" | "failed" | "timed_out" | "crashed";
export type PacketEnvMode = "inherit" | "minimal";
export type CommandExecutionBoundary = "not_sandboxed";

export interface PacketCommand {
  args?: string[];
  cwd?: string;
  envKeys?: string[];
  envMode?: PacketEnvMode;
  executionBoundary?: CommandExecutionBoundary;
  shell?: boolean;
  value: string;
}

export interface PacketEvidence {
  command?: PacketCommand;
  commandExecutionBoundary?: CommandExecutionBoundary;
  durationSeconds?: number;
  exitCode?: number | null;
  finishedAt?: string;
  metrics?: Record<string, number>;
  packetId?: string;
  raw?: UnknownRecord;
  startedAt?: string;
  status?: PacketStatus | string;
  timedOut?: boolean;
}

export interface PacketRecord extends UnknownRecord {
  asi?: JsonObject | UnknownRecord;
  id?: string;
  packetEvidence?: PacketEvidence;
  packetId?: string;
  run?: number;
  status?: string;
}

export function normalizePacketEvidence(value: unknown): PacketEvidence {
  const record = unknownRecordOrEmpty(value);
  return {
    ...record,
    command: normalizePacketCommand(record.command),
    commandExecutionBoundary:
      record.commandExecutionBoundary === "not_sandboxed" ? "not_sandboxed" : undefined,
    durationSeconds: finiteNumberOrUndefined(record.durationSeconds),
    exitCode: normalizeExitCode(record.exitCode),
    finishedAt: stringOrUndefined(record.finishedAt),
    metrics: numberRecordOrUndefined(record.metrics),
    packetId: stringOrUndefined(record.packetId),
    startedAt: stringOrUndefined(record.startedAt),
    status: stringOrUndefined(record.status),
    timedOut: typeof record.timedOut === "boolean" ? record.timedOut : undefined,
  };
}

export function normalizePacketCommand(value: unknown): PacketCommand | undefined {
  const record = unknownRecordOrEmpty(value);
  const command = stringOrUndefined(record.value) ?? stringOrUndefined(record.command);
  if (!command) return undefined;
  return {
    args: stringArrayOrUndefined(record.args),
    cwd: stringOrUndefined(record.cwd),
    envKeys: stringArrayOrUndefined(record.envKeys),
    envMode:
      record.envMode === "minimal"
        ? "minimal"
        : record.envMode === "inherit"
          ? "inherit"
          : undefined,
    executionBoundary: record.executionBoundary === "not_sandboxed" ? "not_sandboxed" : undefined,
    shell: typeof record.shell === "boolean" ? record.shell : undefined,
    value: command,
  };
}

function finiteNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeExitCode(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function numberRecordOrUndefined(value: unknown): Record<string, number> | undefined {
  const record = unknownRecordOrEmpty(value);
  const entries = Object.entries(record).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function stringArrayOrUndefined(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.map((item) => String(item)).filter(Boolean);
  return values.length ? values : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
