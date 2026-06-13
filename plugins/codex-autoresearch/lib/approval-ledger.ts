import { isUnknownRecord, type UnknownRecord } from "./types/json.js";

export interface ApprovalRecord {
  approved: boolean;
  evidence: string[];
  expiresAt: string;
  gate: string;
  scope: string;
  source: string;
  timestamp: string;
  type: "approval";
}

export interface ApprovalRequirement {
  action?: string;
  gate: string;
  scope: string;
}

export interface ApprovalResolution {
  approved: boolean;
  blocker: string;
  gate: string;
  matched: ApprovalRecord | null;
  scope: string;
  status: "approved" | "expired" | "missing";
}

export interface ApprovalLedgerStatus {
  approved: boolean;
  blockers: string[];
  records: ApprovalRecord[];
  required: ApprovalRequirement[];
  resolutions: ApprovalResolution[];
  status: "approved" | "blocked" | "not-required";
  warnings: string[];
}

export function buildApprovalRecord(input: {
  approved?: unknown;
  evidence?: unknown;
  expiresAt?: unknown;
  gate: unknown;
  scope: unknown;
  source?: unknown;
  timestamp?: unknown;
}): ApprovalRecord {
  return {
    type: "approval",
    timestamp: stringValue(input.timestamp) || new Date().toISOString(),
    source: stringValue(input.source) || "codex-autoresearch",
    gate: stringValue(input.gate),
    scope: stringValue(input.scope),
    expiresAt: stringValue(input.expiresAt),
    evidence: stringList(input.evidence),
    approved: input.approved !== false,
  };
}

export function approvalRecordsFromLedger(entries: unknown[]): ApprovalRecord[] {
  const records: ApprovalRecord[] = [];
  for (const entry of entries) {
    if (!isUnknownRecord(entry) || entry.type !== "approval") continue;
    const record = buildApprovalRecord({
      approved: entry.approved,
      evidence: entry.evidence,
      expiresAt: entry.expiresAt,
      gate: entry.gate,
      scope: entry.scope,
      source: entry.source,
      timestamp: entry.timestamp,
    });
    if (!record.gate || !record.scope) continue;
    records.push(record);
  }
  return records.sort((left, right) => compareTime(right.timestamp, left.timestamp));
}

export function approvalRequirementsFromLaneResults(entries: unknown[]): ApprovalRequirement[] {
  const requirements: ApprovalRequirement[] = [];
  for (const entry of entries) {
    if (!isUnknownRecord(entry) || entry.type !== "lane_result") continue;
    const result = isUnknownRecord(entry.result) ? entry.result : {};
    const gate = isUnknownRecord(result.approvalGate) ? result.approvalGate : {};
    if (gate.required !== true) continue;
    const lane = isUnknownRecord(entry.lane) ? entry.lane : {};
    const gateName = stringValue(gate.gate);
    const scope = stringValue(gate.scope || lane.id || lane.title);
    if (!gateName || !scope) continue;
    requirements.push({
      gate: gateName,
      scope,
      action:
        stringValue(gate.action) ||
        "Approve big-idea lane before implementation or measured packets.",
    });
  }
  return requirements;
}

export function dedupeApprovalRequirements(
  requirements: ApprovalRequirement[],
): ApprovalRequirement[] {
  const seen = new Set<string>();
  const out: ApprovalRequirement[] = [];
  for (const requirement of requirements) {
    const gate = stringValue(requirement.gate);
    const scope = stringValue(requirement.scope);
    if (!gate || !scope) continue;
    const key = `${gate}\0${scope}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      gate,
      scope,
      ...(stringValue(requirement.action) ? { action: stringValue(requirement.action) } : {}),
    });
  }
  return out;
}

export function resolveApproval(
  records: ApprovalRecord[],
  requirement: ApprovalRequirement,
  options: { now?: unknown } = {},
): ApprovalResolution {
  const gate = stringValue(requirement.gate);
  const scope = stringValue(requirement.scope);
  const now = timeValue(options.now) ?? Date.now();
  const matches = records.filter((record) => record.gate === gate && record.scope === scope);
  const unexpired = matches.find((record) => !isExpired(record.expiresAt, now));
  if (unexpired?.approved === true) {
    return { approved: true, blocker: "", gate, scope, matched: unexpired, status: "approved" };
  }
  if (matches.length > 0) {
    return {
      approved: false,
      blocker: `Approval for ${gate} (${scope}) expired or was rejected.`,
      gate,
      scope,
      matched: matches[0],
      status: "expired",
    };
  }
  return {
    approved: false,
    blocker: `Missing approval for ${gate} (${scope}).`,
    gate,
    scope,
    matched: null,
    status: "missing",
  };
}

export function buildApprovalLedgerStatus({
  entries = [],
  required = [],
  now,
}: {
  entries?: unknown[];
  now?: unknown;
  required?: ApprovalRequirement[];
} = {}): ApprovalLedgerStatus {
  const records = approvalRecordsFromLedger(entries);
  const requirements = required
    .map((requirement) => ({
      gate: stringValue(requirement.gate),
      scope: stringValue(requirement.scope),
      ...(stringValue(requirement.action) ? { action: stringValue(requirement.action) } : {}),
    }))
    .filter((requirement) => requirement.gate && requirement.scope);
  const resolutions = requirements.map((requirement) =>
    resolveApproval(records, requirement, { now }),
  );
  const blockers = resolutions.filter((resolution) => !resolution.approved).map((r) => r.blocker);
  const missingActionWarnings = requirements
    .filter((requirement) => !requirement.action)
    .map(
      (requirement) => `Approval ${requirement.gate} (${requirement.scope}) has no action label.`,
    );
  return {
    status:
      requirements.length === 0 ? "not-required" : blockers.length === 0 ? "approved" : "blocked",
    approved: requirements.length > 0 && blockers.length === 0,
    required: requirements,
    resolutions,
    records,
    blockers,
    warnings: missingActionWarnings,
  };
}

function isExpired(expiresAt: string, now: number): boolean {
  if (!expiresAt) return false;
  const expires = timeValue(expiresAt);
  return expires != null && expires <= now;
}

function timeValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(stringValue(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function compareTime(left: unknown, right: unknown): number {
  return (timeValue(left) ?? 0) - (timeValue(right) ?? 0);
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(stringValue).filter(Boolean);
  const text = stringValue(value);
  return text ? [text] : [];
}

function stringValue(value: unknown): string {
  return String(value ?? "").trim();
}

export function approvalRequirementFromLane(lane: unknown): ApprovalRequirement | null {
  if (!isUnknownRecord(lane)) return null;
  const mode = stringValue(lane.mode);
  if (mode !== "big_idea") return null;
  const id = stringValue(lane.id || lane.label);
  if (!id) return null;
  return {
    gate: "big_idea_architecture",
    scope: id,
    action: "Approve big-idea lane before implementation or measured packets.",
  };
}

export function unknownRecordEntries(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(isUnknownRecord) : [];
}
