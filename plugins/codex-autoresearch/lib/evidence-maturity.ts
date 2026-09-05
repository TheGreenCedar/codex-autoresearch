import { isAcceptedCurrentRun } from "./evidence-registry.js";
import { isUnknownRecord, type UnknownRecord } from "./types/json.js";

export interface EvidenceMaturityStatus {
  blockers: string[];
  blocksFinalization: boolean;
  blocksPacket: boolean;
  counts: {
    accepted: number;
    diagnostic: number;
    holdout: number;
    protectedProbe: number;
    rowSpecific: number;
  };
  weakerClaim: string;
  status: "broad" | "diagnostic" | "empty" | "provisional";
  warnings: string[];
}

export function classifyEvidenceMaturity({
  requestedClaim = "",
  runs = [],
}: {
  requestedClaim?: unknown;
  runs?: unknown[];
} = {}): EvidenceMaturityStatus {
  const accepted = runs.filter(isAcceptedRun);
  const diagnostic = accepted.filter(isDiagnosticRun);
  const rowSpecific = accepted.filter(hasRowSpecificMarkers);
  const protectedProbe = accepted.filter(hasProtectedProbeMarkers);
  const holdout = accepted.filter(hasHoldoutMarkers);
  const broadRequested =
    /\b(broad|general|shippable|product[- ]grade|superiority|merge[- ]ready)\b/i.test(
      stringValue(requestedClaim),
    );
  const warnings: string[] = [];
  const blockers: string[] = [];

  if (accepted.length === 0) {
    return {
      status: "empty",
      blocksPacket: false,
      blocksFinalization: broadRequested,
      blockers: broadRequested ? ["Broad finalization claim has no accepted evidence."] : [],
      warnings: ["No accepted current evidence is available."],
      weakerClaim: "No product claim is supportable yet.",
      counts: emptyCounts(),
    };
  }

  if (rowSpecific.length > 0 || protectedProbe.length > 0 || diagnostic.length > 0) {
    warnings.push(
      "Accepted evidence includes row-specific detectors, protected probes, static citations, manifests, or answer-key steering.",
    );
  }
  if (broadRequested) {
    blockers.push(
      "Recorded measurements do not establish broad superiority. Report the measured result and leave the broader claim unverified.",
    );
  }

  const status =
    rowSpecific.length > 0 || protectedProbe.length > 0 || diagnostic.length > 0
      ? "diagnostic"
      : "provisional";

  return {
    status,
    blocksPacket: false,
    blocksFinalization: blockers.length > 0,
    blockers,
    warnings,
    weakerClaim:
      "Recorded measurements support only the evaluated contract; broader product claims remain unverified.",
    counts: {
      accepted: accepted.length,
      diagnostic: diagnostic.length,
      holdout: holdout.length,
      protectedProbe: protectedProbe.length,
      rowSpecific: rowSpecific.length,
    },
  };
}

function emptyCounts() {
  return { accepted: 0, diagnostic: 0, holdout: 0, protectedProbe: 0, rowSpecific: 0 };
}

function isAcceptedRun(value: unknown): boolean {
  if (!isUnknownRecord(value)) return false;
  return isAcceptedCurrentRun(value);
}

function isDiagnosticRun(value: unknown): boolean {
  const text = runText(value);
  return /\b(diagnostic|provisional|experimental review|not product-grade)\b/i.test(text);
}

function hasRowSpecificMarkers(value: unknown): boolean {
  const text = runText(value);
  return /\b(row[- ]specific|task[- ]family|detector|static citation|manifest|answer[- ]key|protected probe)\b/i.test(
    text,
  );
}

function hasProtectedProbeMarkers(value: unknown): boolean {
  return /\b(protected probe|protected benchmark|protected row|fixture row|answer[- ]key)\b/i.test(
    runText(value),
  );
}

function hasHoldoutMarkers(value: unknown): boolean {
  return isUnknownRecord(value) && value.runPurpose === "holdout";
}

function runText(value: unknown): string {
  if (!isUnknownRecord(value)) return "";
  const pieces = [
    value.description,
    value.evidenceStatus,
    value.evidence_status,
    value.claim,
    value.summary,
    value.asi,
    value.metadata,
  ];
  return pieces.map(stringifyBounded).join(" ");
}

function stringifyBounded(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isUnknownRecord(value) && !Array.isArray(value)) return stringValue(value);
  try {
    return JSON.stringify(value).slice(0, 4000);
  } catch {
    return "";
  }
}

function stringValue(value: unknown): string {
  return String(value ?? "").trim();
}

export function runsFromState(state: unknown): UnknownRecord[] {
  if (!isUnknownRecord(state)) return [];
  const current = Array.isArray(state.current) ? state.current : [];
  return current.filter(isUnknownRecord);
}
