import { createHash } from "node:crypto";
import { isUnknownRecord, type UnknownRecord } from "./types/json.js";

export interface ResourceBudgets {
  maxActiveProcesses: number;
  maxCommandOutputLines: number;
  maxCommandOutputTokens: number;
  maxRepeatedCommandHeads: number;
  maxWallClockSeconds: number;
  pollBudget: number;
}

export interface ResourcePreflightStatus {
  blockers: string[];
  budgets: ResourceBudgets;
  canStart: boolean;
  commandHead: string;
  nextAction: string;
  residue: ResourceResidueFact[];
  status: "ok" | "blocked" | "warning";
  warnings: string[];
}

export interface ResourceResidueFact {
  identity: string;
  reason: string;
  status: "invalid-lifecycle" | "process-active" | "termination-failed";
  timestamp: string;
  type: "process_lifecycle";
}

export type ProcessLifecycleEvent =
  | "started"
  | "observed-live"
  | "terminated"
  | "termination-failed";

export interface ProcessLifecycleRecord extends UnknownRecord {
  at: string;
  event: ProcessLifecycleEvent;
  identity: {
    packetId: string;
    processId: string;
  };
  termination?: {
    proven: boolean;
    reason: string;
  };
  type: "process_lifecycle";
}

const DEFAULT_BUDGETS: ResourceBudgets = {
  maxActiveProcesses: 4,
  maxCommandOutputLines: 1200,
  maxCommandOutputTokens: 24_000,
  maxRepeatedCommandHeads: 5,
  maxWallClockSeconds: 60 * 60,
  pollBudget: 80,
};

const ISO_UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const PROCESS_IDENTITY_MAX_LENGTH = 160;
const PROCESS_IDENTITY_PATTERN = /^[A-Za-z0-9._:-]+$/;
const PROCESS_LIFECYCLE_EVENTS = new Set<ProcessLifecycleEvent>([
  "started",
  "observed-live",
  "terminated",
  "termination-failed",
]);

export function buildResourcePreflight({
  activeProcesses = 0,
  budgets = {},
  command = "",
  entries = [],
  wallClockSeconds = 0,
}: {
  activeProcesses?: unknown;
  budgets?: Partial<ResourceBudgets>;
  command?: unknown;
  entries?: unknown[];
  wallClockSeconds?: unknown;
} = {}): ResourcePreflightStatus {
  const resolvedBudgets = { ...DEFAULT_BUDGETS, ...numericBudgetOverrides(budgets) };
  const blockers: string[] = [];
  const warnings: string[] = [];
  const residue = classifyProcessResidue(entries);
  const head = commandHead(command);
  const repeated = head ? repeatedCommandHeadCount(entries, head) : 0;
  const output = largestOutputBudget(entries);
  const polls = shellPollCount(entries);
  const active = numberValue(activeProcesses) ?? 0;
  const wallClock = numberValue(wallClockSeconds) ?? 0;

  if (active >= resolvedBudgets.maxActiveProcesses) {
    blockers.push(
      `Active process count ${active} meets or exceeds budget ${resolvedBudgets.maxActiveProcesses}.`,
    );
  }
  if (wallClock >= resolvedBudgets.maxWallClockSeconds) {
    blockers.push(
      `Wall-clock runtime ${wallClock}s meets or exceeds budget ${resolvedBudgets.maxWallClockSeconds}s.`,
    );
  }
  if (repeated >= resolvedBudgets.maxRepeatedCommandHeads) {
    warnings.push(
      `Command head repeated ${repeated} times: ${head}. Confirm this is intentional benchmark repetition before another packet.`,
    );
  }
  if (output.tokens >= resolvedBudgets.maxCommandOutputTokens) {
    warnings.push(
      `Prior command output reported ${output.tokens} tokens; prefer bounded summaries or compact forensics before another packet.`,
    );
  }
  if (output.lines >= resolvedBudgets.maxCommandOutputLines) {
    warnings.push(
      `Prior command output reported ${output.lines} lines; prefer bounded summaries or compact forensics before another packet.`,
    );
  }
  if (polls >= resolvedBudgets.pollBudget) {
    warnings.push(
      `Shell polling reached ${polls} polls; inspect progress instead of repeating polls.`,
    );
  }
  if (hasLegacyProcessResidueProse(entries)) {
    warnings.push(
      "Legacy process-residue prose was found and is warning-only; record typed process_lifecycle events for process trust decisions.",
    );
  }
  if (residue.length > 0) {
    blockers.push(
      "Typed process lifecycle state reports an active or unproven process; reconcile it before another packet.",
    );
  }

  return {
    status: blockers.length > 0 ? "blocked" : warnings.length > 0 ? "warning" : "ok",
    canStart: blockers.length === 0,
    blockers,
    warnings,
    residue,
    budgets: resolvedBudgets,
    commandHead: head,
    nextAction:
      blockers[0] ||
      warnings[0] ||
      "Resource budgets are clear for a bounded packet or lane command.",
  };
}

export function classifyProcessResidue(entries: unknown[]): ResourceResidueFact[] {
  const latestByIdentity = new Map<string, ParsedProcessLifecycleRecord>();
  const invalid: ResourceResidueFact[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (isUnknownRecord(entry) && entry.type === "process_lifecycle") {
      const parsed = parseProcessLifecycleRecord(entry);
      if (!parsed) {
        invalid.push({
          type: "process_lifecycle",
          identity: publicProcessIdentity(`invalid-ledger-entry\0${index}`),
          status: "invalid-lifecycle",
          timestamp: safeLedgerTimestamp(entry.at),
          reason: "typed process lifecycle entry is malformed or contradicts termination proof",
        });
        continue;
      }
      latestByIdentity.set(parsed.identityKey, parsed);
      continue;
    }
    for (const lifecycle of processLifecycleRecordsFromEntry(entry)) {
      latestByIdentity.set(lifecycle.identityKey, lifecycle);
    }
  }
  return [
    ...invalid,
    ...[...latestByIdentity.values()]
      .filter(
        (record) =>
          record.event === "started" ||
          record.event === "observed-live" ||
          record.event === "termination-failed",
      )
      .map((record) => ({
        type: "process_lifecycle" as const,
        identity: publicProcessIdentity(record.identityKey),
        status:
          record.event === "termination-failed"
            ? ("termination-failed" as const)
            : ("process-active" as const),
        timestamp: record.timestamp,
        reason:
          record.event === "termination-failed"
            ? "latest typed lifecycle event reports unproven termination"
            : "latest typed lifecycle event reports an active process",
      })),
  ].slice(0, 5);
}

export function buildProcessLifecycleRecord({
  packetId,
  processId,
  event,
  at = new Date().toISOString(),
  termination,
}: {
  packetId: string;
  processId: string;
  event: ProcessLifecycleEvent;
  at?: string;
  termination?: unknown;
}): ProcessLifecycleRecord {
  const identity = processIdentity(packetId, processId);
  if (!identity) throw new Error("Process lifecycle identity is invalid.");
  if (!PROCESS_LIFECYCLE_EVENTS.has(event)) throw new Error("Process lifecycle event is invalid.");
  if (!ISO_UTC_TIMESTAMP_PATTERN.test(at))
    throw new Error("Process lifecycle timestamp is invalid.");
  if (termination !== undefined) {
    if (
      !isUnknownRecord(termination) ||
      typeof termination.proven !== "boolean" ||
      typeof termination.reason !== "string"
    ) {
      throw new Error("Process lifecycle termination evidence is invalid.");
    }
    if (event !== "terminated" && event !== "termination-failed") {
      throw new Error("Only terminal lifecycle events may carry termination evidence.");
    }
  }
  const record: ProcessLifecycleRecord = {
    type: "process_lifecycle",
    identity: { packetId, processId },
    event,
    at,
  };
  const safeTermination = redactedTerminationSummary(termination);
  if (event === "terminated" && safeTermination?.proven === false) {
    throw new Error("A terminated lifecycle event cannot carry unproven termination evidence.");
  }
  if (event === "termination-failed" && safeTermination?.proven === true) {
    throw new Error(
      "A termination-failed lifecycle event cannot carry proven termination evidence.",
    );
  }
  if (safeTermination) record.termination = safeTermination;
  return record;
}

interface ParsedProcessLifecycleRecord {
  event: ProcessLifecycleEvent;
  identityKey: string;
  timestamp: string;
}

function processLifecycleRecordsFromEntry(entry: unknown): ParsedProcessLifecycleRecord[] {
  if (!isUnknownRecord(entry)) return [];
  const packetEvidence = isUnknownRecord(entry.packetEvidence) ? entry.packetEvidence : {};
  const progressSnapshot = isUnknownRecord(packetEvidence.progressSnapshot)
    ? packetEvidence.progressSnapshot
    : null;
  if (!progressSnapshot) return [];
  const packetId = stringValue(progressSnapshot.packetId);
  const processId = "packet";
  const identityKey = processIdentity(packetId, processId);
  const event = progressLifecycleEvent(progressSnapshot);
  if (!identityKey || !event) return [];
  return [
    {
      identityKey,
      event,
      timestamp: safeLedgerTimestamp(entry.timestamp || progressSnapshot.startedAt),
    },
  ];
}

function parseProcessLifecycleRecord(entry: unknown): ParsedProcessLifecycleRecord | null {
  if (!isUnknownRecord(entry) || entry.type !== "process_lifecycle") return null;
  const identity = isUnknownRecord(entry.identity) ? entry.identity : {};
  const identityKey = processIdentity(identity.packetId, identity.processId);
  const event = processLifecycleEvent(entry.event);
  const timestamp = safeLedgerTimestamp(entry.at);
  if (!identityKey || !event || !timestamp) return null;
  const terminationPresent = Object.hasOwn(entry, "termination");
  const termination = terminationPresent ? entry.termination : null;
  if (
    terminationPresent &&
    (!isUnknownRecord(termination) ||
      typeof termination.proven !== "boolean" ||
      typeof termination.reason !== "string" ||
      !/^[a-z0-9_]{0,160}$/.test(termination.reason))
  ) {
    return null;
  }
  if (terminationPresent && event !== "terminated" && event !== "termination-failed") return null;
  if (event === "terminated" && isUnknownRecord(termination) && termination.proven === false) {
    return null;
  }
  if (
    event === "termination-failed" &&
    isUnknownRecord(termination) &&
    termination.proven === true
  ) {
    return null;
  }
  return { identityKey, event, timestamp };
}

function progressLifecycleEvent(progress: UnknownRecord): ProcessLifecycleEvent | null {
  if (progress.commandClass === "autoresearch preflight") return null;
  if (progress.terminationFailed === true || progress.exitState === "termination_failed") {
    return "termination-failed";
  }
  if (progress.exitState === "running") return "observed-live";
  if (["completed", "failed", "timed_out", "crashed"].includes(stringValue(progress.exitState))) {
    return "terminated";
  }
  return null;
}

function processLifecycleEvent(value: unknown): ProcessLifecycleEvent | null {
  const event = stringValue(value) as ProcessLifecycleEvent;
  return PROCESS_LIFECYCLE_EVENTS.has(event) ? event : null;
}

function processIdentity(packetIdValue: unknown, processIdValue: unknown): string {
  const packetId = stringValue(packetIdValue);
  const processId = stringValue(processIdValue);
  if (
    !packetId ||
    !processId ||
    packetId.length > PROCESS_IDENTITY_MAX_LENGTH ||
    processId.length > PROCESS_IDENTITY_MAX_LENGTH ||
    !PROCESS_IDENTITY_PATTERN.test(packetId) ||
    !PROCESS_IDENTITY_PATTERN.test(processId)
  ) {
    return "";
  }
  return `${packetId}\0${processId}`;
}

function publicProcessIdentity(identityKey: string): string {
  return `process-${createHash("sha256").update(identityKey, "utf8").digest("hex").slice(0, 12)}`;
}

function redactedTerminationSummary(value: unknown): ProcessLifecycleRecord["termination"] | null {
  if (!isUnknownRecord(value)) return null;
  const reason = stringValue(value.reason);
  return {
    proven: value.proven === true,
    reason: /^[a-z0-9_]{1,160}$/.test(reason) ? reason : "",
  };
}

function hasLegacyProcessResidueProse(entries: unknown[]): boolean {
  return entries.some((entry) => {
    if (isUnknownRecord(entry) && entry.type === "process_lifecycle") return false;
    const text = safeStringify(entry).toLowerCase();
    return (
      /\b(process[-_ ]?manager|active_process|pid)\b/.test(text) &&
      /\b(stale|orphan|reboot|residue|zombie|unreconciled)\b/.test(text)
    );
  });
}

function repeatedCommandHeadCount(entries: unknown[], targetHead: string): number {
  return entries.filter((entry) => commandHead(commandFromEntry(entry)) === targetHead).length;
}

function commandFromEntry(entry: unknown): string {
  if (!isUnknownRecord(entry)) return "";
  const run = isUnknownRecord(entry.run) ? entry.run : {};
  const decision = isUnknownRecord(entry.decision) ? entry.decision : {};
  return stringValue(entry.command || run.command || decision.command);
}

function largestOutputBudget(entries: unknown[]): { lines: number; tokens: number } {
  let lines = 0;
  let tokens = 0;
  for (const entry of entries) {
    const text = safeStringify(entry);
    tokens = Math.max(tokens, Number(text.match(/Original token count:\s*(\d+)/i)?.[1] || 0));
    lines = Math.max(lines, Number(text.match(/Total output lines:\s*(\d+)/i)?.[1] || 0));
    const record = isUnknownRecord(entry) ? entry : null;
    const packetEvidence = isUnknownRecord(record?.packetEvidence) ? record?.packetEvidence : null;
    tokens = Math.max(tokens, numberValue(packetEvidence?.outputTokens) ?? 0);
    lines = Math.max(lines, numberValue(packetEvidence?.outputLines) ?? 0);
  }
  return { lines, tokens };
}

function shellPollCount(entries: unknown[]): number {
  return entries.filter((entry) => safeStringify(entry).includes('"name":"write_stdin"')).length;
}

function numericBudgetOverrides(value: Partial<ResourceBudgets>): Partial<ResourceBudgets> {
  const out: Partial<ResourceBudgets> = {};
  for (const key of Object.keys(DEFAULT_BUDGETS) as (keyof ResourceBudgets)[]) {
    const parsed = numberValue(value[key]);
    if (parsed != null && parsed > 0) out[key] = parsed;
  }
  return out;
}

function commandHead(value: unknown): string {
  return stringValue(value).split(/\s+/).filter(Boolean).slice(0, 5).join(" ");
}

function numberValue(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

function stringValue(value: unknown): string {
  return String(value ?? "").trim();
}

function safeLedgerTimestamp(value: unknown): string {
  const timestamp = stringValue(value);
  return ISO_UTC_TIMESTAMP_PATTERN.test(timestamp) ? timestamp : "";
}

export function resourceBudgetFromConfig(config: UnknownRecord = {}): Partial<ResourceBudgets> {
  return {
    maxActiveProcesses: numberValue(config.maxActiveProcesses) ?? undefined,
    maxCommandOutputLines: numberValue(config.outputCommandLineBudget) ?? undefined,
    maxCommandOutputTokens: numberValue(config.outputCommandTokenBudget) ?? undefined,
    maxRepeatedCommandHeads: numberValue(config.maxRepeatedCommandHeads) ?? undefined,
    maxWallClockSeconds: numberValue(config.maxPacketWallClockSeconds) ?? undefined,
    pollBudget: numberValue(config.shellPollBudget) ?? undefined,
  };
}

export function assertRunResourcePreflight({
  command,
  config,
  entries,
}: {
  command: string;
  config: UnknownRecord;
  entries: UnknownRecord[];
}): ResourcePreflightStatus {
  const resourcePreflight = buildResourcePreflight({
    command,
    entries,
    budgets: resourceBudgetFromConfig(config),
  });
  if (!resourcePreflight.canStart) {
    throw new Error(`Resource preflight blocked packet start: ${resourcePreflight.nextAction}`);
  }
  return resourcePreflight;
}

export function buildActiveRunPacketId(nextRun: unknown): string {
  return `packet-${nextRun}-active`;
}
