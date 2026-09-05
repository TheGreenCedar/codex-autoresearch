import fs from "node:fs";

import { redactPathDisplay } from "./evidence-redaction.js";
import { reviewRequiredMetricSignals } from "./packet-diagnostics.js";
import { resolvePathInsideRootSync } from "./path-containment.js";
import { isKeepStatus, isRejectedRunStatus } from "./run-status.js";

type LooseObject = Record<string, any>;

export type EvidenceStatus = "provisional" | "accepted" | "rejected" | "superseded";
export type EvidenceKind = "run" | "artifact";
export const EVIDENCE_STATUS_VALUES: EvidenceStatus[] = [
  "provisional",
  "accepted",
  "rejected",
  "superseded",
];
export const EVIDENCE_STATUSES = new Set<EvidenceStatus>(EVIDENCE_STATUS_VALUES);

export interface EvidenceRegistryEntry extends LooseObject {
  id: string;
  kind: EvidenceKind;
  evidenceStatus: EvidenceStatus;
  accepted: boolean;
  current: boolean;
  auditVisible: boolean;
  run?: number | null;
  status?: string;
  name?: string;
  path?: string;
  exists?: boolean | null;
  quarantined?: boolean;
}

export interface EvidenceRegistry {
  schemaVersion: 1;
  entries: EvidenceRegistryEntry[];
  acceptedCurrent: EvidenceRegistryEntry[];
  audit: EvidenceRegistryEntry[];
  currentRuns: LooseObject[];
  currentArtifacts: EvidenceRegistryEntry[];
  counts: Record<EvidenceStatus, number>;
}

export function normalizeEvidenceStatus(
  value: unknown,
  fallback: EvidenceStatus = "provisional",
): EvidenceStatus {
  const normalized = String(value || "").toLowerCase();
  if (EVIDENCE_STATUSES.has(normalized as EvidenceStatus)) return normalized as EvidenceStatus;
  return fallback;
}

export function defaultEvidenceStatusForRun(run: LooseObject): EvidenceStatus {
  const status = String(run?.status || "");
  if (isKeepStatus(status))
    return reviewRequiredRunNeedsAcknowledgement(run) ? "provisional" : "accepted";
  if (status === "measure") return "provisional";
  return "rejected";
}

export function isAcceptedCurrentEvidence(value: LooseObject | null | undefined): boolean {
  const evidenceStatus =
    value?.kind === "artifact"
      ? normalizeEvidenceStatus(value?.evidenceStatus, "provisional")
      : evidenceStatusForRun(value || {});
  return evidenceStatus === "accepted" && value?.quarantined !== true;
}

export function isKeepRun(run: LooseObject | null | undefined): boolean {
  return isKeepStatus(run?.status);
}

export function isRejectedRun(run: LooseObject | null | undefined): boolean {
  return isRejectedRunStatus(run?.status);
}

export function isAcceptedCurrentRun(run: LooseObject | null | undefined): boolean {
  return isKeepRun(run) && isAcceptedCurrentEvidence(run);
}

export function artifactEvidenceList(
  artifacts: LooseObject = {},
  workDir = "",
  evidenceStatus: EvidenceStatus | string = "provisional",
): EvidenceRegistryEntry[] {
  const normalizedStatus = normalizeEvidenceStatus(evidenceStatus, "provisional");
  return artifactList(artifacts, workDir).map((artifact: LooseObject) =>
    normalizeEvidenceEntry({
      kind: "artifact",
      ...artifact,
      evidenceStatus: artifact.quarantined ? "rejected" : normalizedStatus,
      promotable: !artifact.quarantined && normalizedStatus === "accepted",
      promotionRelevance: artifact.quarantined
        ? "blocked_external_artifact"
        : normalizedStatus === "accepted"
          ? "supporting"
          : "context",
    }),
  );
}

export function buildEvidenceRegistry({
  runs = [],
  artifacts = [],
  workDir = "",
}: {
  runs?: LooseObject[];
  artifacts?: LooseObject[];
  workDir?: string;
} = {}): EvidenceRegistry {
  const entries: EvidenceRegistryEntry[] = [];
  for (const run of runs || []) {
    entries.push(runEvidenceEntry(run));
    const runEvidenceStatus = evidenceStatusForRun(run);
    const artifactEvidence = Array.isArray(run?.artifactEvidence)
      ? run.artifactEvidence.map((artifact) =>
          gateArtifactEvidenceStatus(artifact, runEvidenceStatus),
        )
      : run?.artifacts && Object.keys(run.artifacts).length
        ? artifactEvidenceList(run.artifacts, workDir, runEvidenceStatus)
        : [];
    for (const artifact of artifactEvidence) {
      entries.push(
        normalizeEvidenceEntry({
          run: run.run ?? null,
          status: run.status || "",
          ...artifact,
          kind: "artifact",
        }),
      );
    }
  }
  for (const artifact of artifacts || []) {
    entries.push(normalizeEvidenceEntry({ ...artifact, kind: "artifact" }));
  }
  const normalized = entries.map(normalizeEvidenceEntry);
  const acceptedCurrent = normalized.filter((entry) => entry.current);
  return {
    schemaVersion: 1,
    entries: normalized,
    acceptedCurrent,
    audit: normalized.filter((entry) => entry.auditVisible),
    currentRuns: (runs || []).filter((run) => isAcceptedCurrentRun(run)),
    currentArtifacts: acceptedCurrent.filter((entry) => entry.kind === "artifact"),
    counts: evidenceStatusCounts(normalized),
  };
}

export function acceptedCurrentRuns(runs: LooseObject[] = []): LooseObject[] {
  return runs.filter((run) => isAcceptedCurrentRun(run));
}

function runEvidenceEntry(run: LooseObject): EvidenceRegistryEntry {
  return normalizeEvidenceEntry({
    id: `run-${run.run ?? "unknown"}`,
    kind: "run",
    run: run.run ?? null,
    status: run.status || "",
    metric: run.metric ?? null,
    evidenceStatus: evidenceStatusForRun(run),
    description: run.description || "",
  });
}

function normalizeEvidenceEntry(value: LooseObject): EvidenceRegistryEntry {
  const kind: EvidenceKind = value.kind === "artifact" ? "artifact" : "run";
  const fallback =
    kind === "run" ? defaultEvidenceStatusForRun(value) : ("provisional" as EvidenceStatus);
  const evidenceStatus =
    kind === "run"
      ? evidenceStatusForRun(value)
      : normalizeEvidenceStatus(value.evidenceStatus, fallback);
  const quarantined = value.quarantined === true;
  const accepted = evidenceStatus === "accepted" && !quarantined;
  const current = accepted;
  const id =
    String(value.id || "").trim() ||
    (kind === "artifact"
      ? `artifact-${value.run ?? "manual"}-${value.name || value.path || "unknown"}`
      : `run-${value.run ?? "unknown"}`);
  return {
    ...value,
    id,
    kind,
    evidenceStatus: quarantined ? "rejected" : evidenceStatus,
    accepted,
    current,
    auditVisible: true,
    quarantined,
  };
}

export function evidenceStatusForRun(run: LooseObject): EvidenceStatus {
  const evidenceStatus = normalizeEvidenceStatus(
    run.evidenceStatus,
    defaultEvidenceStatusForRun(run),
  );
  if (evidenceStatus === "accepted" && reviewRequiredRunNeedsAcknowledgement(run)) {
    return "provisional";
  }
  return evidenceStatus;
}

function reviewRequiredRunNeedsAcknowledgement(run: LooseObject | null | undefined): boolean {
  if (!run || run.asi?.review_acknowledged === true) return false;
  return reviewRequiredMetricSignals(run).length > 0;
}

function gateArtifactEvidenceStatus(
  artifact: LooseObject,
  runEvidenceStatus: EvidenceStatus,
): LooseObject {
  const evidenceStatus = normalizeEvidenceStatus(artifact.evidenceStatus, runEvidenceStatus);
  return {
    ...artifact,
    evidenceStatus:
      runEvidenceStatus !== "accepted" && evidenceStatus === "accepted"
        ? runEvidenceStatus
        : evidenceStatus,
  };
}

function evidenceStatusCounts(entries: EvidenceRegistryEntry[]): Record<EvidenceStatus, number> {
  const counts: Record<EvidenceStatus, number> = {
    provisional: 0,
    accepted: 0,
    rejected: 0,
    superseded: 0,
  };
  for (const entry of entries) counts[entry.evidenceStatus] += 1;
  return counts;
}

export function artifactList(artifacts: LooseObject = {}, workDir = "") {
  return Object.entries(artifacts || {}).map(([name, artifactPath]) => {
    const value = String(artifactPath || "");
    const resolved =
      value && value !== "<outside-workdir>"
        ? resolvePathInsideRootSync(workDir || process.cwd(), value)
        : null;
    const quarantined = value === "<outside-workdir>" || Boolean(resolved && !resolved.inside);
    return {
      id: `artifact-${name}`,
      name,
      path: quarantined ? "<outside-workdir>" : redactPathDisplay(value, workDir),
      exists: quarantined ? false : artifactExists(value, workDir),
      quarantined,
      warning: quarantined ? "Artifact path is outside the working directory." : "",
    };
  });
}

function artifactExists(artifactPath: string, workDir: string) {
  if (!artifactPath) return false;
  const resolved = resolvePathInsideRootSync(workDir || process.cwd(), artifactPath);
  return resolved.inside && fs.existsSync(resolved.absolutePath);
}

export {
  buildOutcomeEvidenceRegistry,
  outcomeEvidenceDependencies,
  currentOutcomeEvaluator,
  readOutcomeDependencyManifest,
  type OutcomeEvidenceRegistry,
  type OutcomeDependencyManifest,
  type CriterionDependencyIdentity,
} from "./outcome-evidence.js";
