import fs from "node:fs";
import path from "node:path";

import { redactPathDisplay } from "./evidence-redaction.js";

type LooseObject = Record<string, any>;

export type EvidenceStatus = "provisional" | "accepted" | "rejected" | "superseded";
export type EvidenceKind = "run" | "artifact";

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
  if (
    normalized === "provisional" ||
    normalized === "accepted" ||
    normalized === "rejected" ||
    normalized === "superseded"
  ) {
    return normalized;
  }
  return fallback;
}

export function defaultEvidenceStatusForRun(run: LooseObject): EvidenceStatus {
  const status = String(run?.status || "");
  if (status === "keep") return "accepted";
  if (status === "measure") return "provisional";
  return "rejected";
}

export function isAcceptedCurrentEvidence(value: LooseObject | null | undefined): boolean {
  const fallback =
    value?.kind === "artifact" ? "provisional" : defaultEvidenceStatusForRun(value || {});
  const evidenceStatus = normalizeEvidenceStatus(value?.evidenceStatus, fallback);
  return evidenceStatus === "accepted" && value?.quarantined !== true;
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
    const artifactEvidence = Array.isArray(run?.artifactEvidence)
      ? run.artifactEvidence
      : run?.artifacts && Object.keys(run.artifacts).length
        ? artifactEvidenceList(
            run.artifacts,
            workDir,
            normalizeEvidenceStatus(run.evidenceStatus, defaultEvidenceStatusForRun(run)),
          )
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
    currentRuns: (runs || []).filter((run) => isAcceptedCurrentEvidence(run)),
    currentArtifacts: acceptedCurrent.filter((entry) => entry.kind === "artifact"),
    counts: evidenceStatusCounts(normalized),
  };
}

export function acceptedCurrentRuns(runs: LooseObject[] = []): LooseObject[] {
  return runs.filter((run) => isAcceptedCurrentEvidence(run));
}

function runEvidenceEntry(run: LooseObject): EvidenceRegistryEntry {
  return normalizeEvidenceEntry({
    id: `run-${run.run ?? "unknown"}`,
    kind: "run",
    run: run.run ?? null,
    status: run.status || "",
    metric: run.metric ?? null,
    evidenceStatus: normalizeEvidenceStatus(run.evidenceStatus, defaultEvidenceStatusForRun(run)),
    description: run.description || "",
  });
}

function normalizeEvidenceEntry(value: LooseObject): EvidenceRegistryEntry {
  const kind: EvidenceKind = value.kind === "artifact" ? "artifact" : "run";
  const fallback =
    kind === "run" ? defaultEvidenceStatusForRun(value) : ("provisional" as EvidenceStatus);
  const evidenceStatus = normalizeEvidenceStatus(value.evidenceStatus, fallback);
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
    const quarantined = String(artifactPath || "") === "<outside-workdir>";
    return {
      id: `artifact-${name}`,
      name,
      path: quarantined
        ? "<outside-workdir>"
        : redactPathDisplay(String(artifactPath || ""), workDir),
      exists: quarantined ? false : artifactExists(String(artifactPath || ""), workDir),
      quarantined,
      warning: quarantined ? "Artifact path is outside the working directory." : "",
    };
  });
}

function artifactExists(artifactPath: string, workDir: string) {
  if (!artifactPath) return false;
  const resolved = path.isAbsolute(artifactPath)
    ? artifactPath
    : path.resolve(workDir || process.cwd(), artifactPath);
  return fs.existsSync(resolved);
}
