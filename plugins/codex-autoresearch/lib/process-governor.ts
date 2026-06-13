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
  reason: string;
  status: "stale-process-residue";
  timestamp: string;
  type: string;
}

const DEFAULT_BUDGETS: ResourceBudgets = {
  maxActiveProcesses: 4,
  maxCommandOutputLines: 1200,
  maxCommandOutputTokens: 24_000,
  maxRepeatedCommandHeads: 5,
  maxWallClockSeconds: 60 * 60,
  pollBudget: 80,
};

const SAFE_LEDGER_TYPES = new Set([
  "approval",
  "autoresearch.log.pending",
  "compacted",
  "config",
  "event_msg",
  "lane_result",
  "process_manager",
  "research_fanout",
  "response_item",
  "run",
  "session_meta",
  "turn_context",
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
  if (residue.length > 0) {
    blockers.push(
      "Stale process-manager or reboot residue is present; reconcile active process state before another packet.",
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
  const residue: ResourceResidueFact[] = [];
  for (const entry of entries) {
    const text = safeStringify(entry).toLowerCase();
    if (
      /\b(process[-_ ]?manager|active_process|pid)\b/.test(text) &&
      /\b(stale|orphan|reboot|residue|zombie|unreconciled)\b/.test(text)
    ) {
      const record = isUnknownRecord(entry) ? entry : {};
      residue.push({
        type: safeLedgerType(record.type),
        status: "stale-process-residue",
        timestamp: safeLedgerTimestamp(record.timestamp),
        reason: "ledger entry matched process residue keywords",
      });
    }
  }
  return uniqueResidue(residue).slice(0, 5);
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

function safeLedgerType(value: unknown): string {
  const type = stringValue(value);
  return SAFE_LEDGER_TYPES.has(type) ? type : "ledger-entry";
}

function safeLedgerTimestamp(value: unknown): string {
  const timestamp = stringValue(value);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(timestamp)
    ? timestamp
    : "";
}

function uniqueResidue(items: ResourceResidueFact[]): ResourceResidueFact[] {
  const seen = new Set<string>();
  const out: ResourceResidueFact[] = [];
  for (const item of items) {
    const key = `${item.type}\0${item.status}\0${item.timestamp}\0${item.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
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
