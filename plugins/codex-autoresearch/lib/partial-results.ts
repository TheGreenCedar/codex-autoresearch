import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { evidenceClaim, type EvidenceClaim } from "./evidence-index.js";
import { finiteMetric } from "./session-core.js";

type LooseRecord = Record<string, unknown>;

export type PartialResultCandidateStatus = "scored" | "manual_review";

export interface PartialResultSalvagerOptions {
  workDir: string;
  primaryMetricName?: string;
}

export interface DiscoverPartialResultCandidatesOptions extends PartialResultSalvagerOptions {
  lastRunPacket: unknown;
}

export interface PartialResultCandidate {
  id: string;
  artifactName: string;
  artifactPath: string;
  rowIndex: number;
  status: PartialResultCandidateStatus;
  reason: string;
  metricName: string | null;
  metricValue: number | null;
  provenance: PartialResultCandidateProvenance;
}

export interface PartialResultCandidateProvenance {
  source: "packetEvidence.artifacts";
  commandHash: string | null;
  artifactName: string;
  artifactPath: string;
  rowIndex: number;
  schemaVersion: string | number | null;
  formulaVersion: string | null;
  diagnosticOnly: true;
}

export interface PartialResultArtifactNotice {
  artifactName: string;
  artifactPath: string;
  reason: string;
}

export interface PartialResultDiscovery {
  candidates: PartialResultCandidate[];
  skippedArtifacts: PartialResultArtifactNotice[];
}

interface ArtifactEntry {
  name: string;
  path: string;
  exists: boolean | null;
  quarantined: boolean;
}

interface ResolvedArtifact {
  absolutePath: string;
  relativePath: string;
}

type ArtifactResolution = { ok: true; artifact: ResolvedArtifact } | { ok: false; reason: string };

interface ParsedArtifact {
  rows: unknown[];
  schemaVersion: string | number | null;
  formulaVersion: string | null;
  metricName: string | null;
}

export class PartialResultSalvager {
  readonly workDir: string;
  readonly primaryMetricName: string | null;

  constructor(options: PartialResultSalvagerOptions) {
    this.workDir = path.resolve(options.workDir || process.cwd());
    this.primaryMetricName = stringValue(options.primaryMetricName);
  }

  async discover(lastRunPacket: unknown): Promise<PartialResultDiscovery> {
    const packetMetricName = packetPrimaryMetricName(lastRunPacket);
    const commandHash = packetCommandHash(lastRunPacket);
    const candidates: PartialResultCandidate[] = [];
    const skippedArtifacts: PartialResultArtifactNotice[] = [];

    for (const artifact of packetArtifactEntries(lastRunPacket)) {
      const displayedPath = displayArtifactPath(this.workDir, artifact.path);
      if (artifact.quarantined) {
        skippedArtifacts.push({
          artifactName: artifact.name,
          artifactPath: displayedPath,
          reason: "artifact_quarantined",
        });
        continue;
      }
      if (artifact.exists === false) {
        skippedArtifacts.push({
          artifactName: artifact.name,
          artifactPath: displayedPath,
          reason: "artifact_missing",
        });
        continue;
      }

      const resolved = await resolveArtifactPath(this.workDir, artifact.path);
      if (!resolved.ok) {
        skippedArtifacts.push({
          artifactName: artifact.name,
          artifactPath: displayedPath,
          reason: resolved.reason,
        });
        continue;
      }

      const parsed = await readPartialResultArtifact(resolved.artifact.absolutePath);
      if (!parsed.ok) {
        skippedArtifacts.push({
          artifactName: artifact.name,
          artifactPath: resolved.artifact.relativePath,
          reason: parsed.reason,
        });
        continue;
      }

      for (const [rowIndex, row] of parsed.artifact.rows.entries()) {
        if (!isRecord(row)) continue;
        candidates.push(
          candidateFromRow({
            artifact,
            artifactPath: resolved.artifact.relativePath,
            artifactMetadata: parsed.artifact,
            commandHash,
            packetMetricName,
            primaryMetricName: this.primaryMetricName,
            row,
            rowIndex,
          }),
        );
      }
    }

    return {
      candidates: candidates.sort(compareCandidates),
      skippedArtifacts: skippedArtifacts.sort(compareNotices),
    };
  }

  buildEvidenceClaim(candidate: PartialResultCandidate): EvidenceClaim {
    return buildPartialResultEvidenceClaim(candidate);
  }
}

export async function discoverPartialResultCandidates(
  options: DiscoverPartialResultCandidatesOptions,
): Promise<PartialResultDiscovery> {
  return new PartialResultSalvager(options).discover(options.lastRunPacket);
}

export function buildPartialResultEvidenceClaim(candidate: PartialResultCandidate): EvidenceClaim {
  const metric =
    candidate.metricName && candidate.metricValue != null
      ? `${candidate.metricName}=${candidate.metricValue}`
      : "metric unavailable";
  return evidenceClaim({
    claim: `Partial result row ${candidate.rowIndex} from ${candidate.artifactName} is ${candidate.status}: ${metric}. Diagnostic only; not promotion-grade evidence.`,
    source: `${candidate.artifactPath}#row-${candidate.rowIndex}`,
    evidenceType: "benchmark-artifact",
    freshness: "current",
    confidence: candidate.status === "scored" ? "medium" : "low",
    promotionRelevance: "diagnostic",
    validatedBy: "partial-results",
  });
}

async function readPartialResultArtifact(
  artifactPath: string,
): Promise<{ ok: true; artifact: ParsedArtifact } | { ok: false; reason: string }> {
  let body: string;
  try {
    body = await fsp.readFile(artifactPath, "utf8");
  } catch (error: unknown) {
    return {
      ok: false,
      reason: missingFileError(error) ? "artifact_missing" : "artifact_unreadable",
    };
  }

  try {
    return { ok: true, artifact: parsePartialResultArtifact(JSON.parse(body)) };
  } catch {
    return { ok: false, reason: "artifact_invalid_json" };
  }
}

function parsePartialResultArtifact(value: unknown): ParsedArtifact {
  if (Array.isArray(value)) {
    return {
      rows: value,
      schemaVersion: null,
      formulaVersion: null,
      metricName: null,
    };
  }
  if (!isRecord(value)) {
    throw new Error("partial result artifact must be an object or array");
  }
  const rows = Array.isArray(value.rows) ? value.rows : [];
  return {
    rows,
    schemaVersion: versionValue(value.schemaVersion),
    formulaVersion: stringValue(value.formulaVersion),
    metricName: stringValue(value.metricName),
  };
}

function candidateFromRow({
  artifact,
  artifactPath,
  artifactMetadata,
  commandHash,
  packetMetricName,
  primaryMetricName,
  row,
  rowIndex,
}: {
  artifact: ArtifactEntry;
  artifactPath: string;
  artifactMetadata: ParsedArtifact;
  commandHash: string | null;
  packetMetricName: string | null;
  primaryMetricName: string | null;
  row: LooseRecord;
  rowIndex: number;
}): PartialResultCandidate {
  const metricName =
    primaryMetricName ||
    artifactMetadata.metricName ||
    stringValue(row.metricName) ||
    packetMetricName;
  const metricValue = metricName ? metricValueForRow(row, metricName) : null;
  const reasons: string[] = [];
  if (metricName == null || metricValue == null) reasons.push("finite primary metric missing");
  if (!commandHash) reasons.push("command hash missing");
  if (artifactMetadata.schemaVersion == null) reasons.push("artifact schema version missing");
  if (!artifactMetadata.formulaVersion) reasons.push("artifact formula version missing");

  const status: PartialResultCandidateStatus = reasons.length === 0 ? "scored" : "manual_review";
  const provenance: PartialResultCandidateProvenance = {
    source: "packetEvidence.artifacts",
    commandHash,
    artifactName: artifact.name,
    artifactPath,
    rowIndex,
    schemaVersion: artifactMetadata.schemaVersion,
    formulaVersion: artifactMetadata.formulaVersion,
    diagnosticOnly: true,
  };

  return {
    id: partialResultCandidateId({
      artifactName: artifact.name,
      artifactPath,
      rowIndex,
      metricName,
      metricValue,
      commandHash,
      schemaVersion: artifactMetadata.schemaVersion,
      formulaVersion: artifactMetadata.formulaVersion,
    }),
    artifactName: artifact.name,
    artifactPath,
    rowIndex,
    status,
    reason:
      status === "scored"
        ? "Finite primary metric, command hash, and artifact version provenance are present."
        : reasons.join("; "),
    metricName,
    metricValue,
    provenance,
  };
}

function metricValueForRow(row: LooseRecord, metricName: string): number | null {
  if (Object.hasOwn(row, metricName)) return finiteMetric(row[metricName]);
  const metrics = isRecord(row.metrics) ? row.metrics : null;
  if (metrics && Object.hasOwn(metrics, metricName)) return finiteMetric(metrics[metricName]);
  if (stringValue(row.metricName) === metricName) {
    return finiteMetric(row.metricValue ?? row.metric);
  }
  return null;
}

function packetArtifactEntries(lastRunPacket: unknown): ArtifactEntry[] {
  const packet = isRecord(lastRunPacket) ? lastRunPacket : {};
  const packetEvidence = isRecord(packet.packetEvidence) ? packet.packetEvidence : {};
  const artifacts = packetEvidence.artifacts;
  const entries: ArtifactEntry[] = [];

  if (Array.isArray(artifacts)) {
    for (const [index, item] of artifacts.entries()) {
      const artifact = isRecord(item) ? item : {};
      const artifactPath = stringValue(artifact.path) || "";
      entries.push({
        name: stringValue(artifact.name) || fallbackArtifactName(artifactPath, index),
        path: artifactPath,
        exists: typeof artifact.exists === "boolean" ? artifact.exists : null,
        quarantined: artifact.quarantined === true,
      });
    }
  } else if (isRecord(artifacts)) {
    for (const [name, artifactPath] of Object.entries(artifacts)) {
      entries.push({
        name,
        path: stringValue(artifactPath) || "",
        exists: null,
        quarantined: false,
      });
    }
  }

  return entries.sort(
    (left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path),
  );
}

function packetPrimaryMetricName(lastRunPacket: unknown): string | null {
  const packet = isRecord(lastRunPacket) ? lastRunPacket : {};
  const packetEvidence = isRecord(packet.packetEvidence) ? packet.packetEvidence : {};
  const run = isRecord(packet.run) ? packet.run : {};
  const config = isRecord(packet.config) ? packet.config : {};
  return (
    stringValue(packetEvidence.metricName) ||
    stringValue(packetEvidence.primaryMetricName) ||
    stringValue(run.metricName) ||
    stringValue(config.metricName) ||
    stringValue(packet.metricName)
  );
}

function packetCommandHash(lastRunPacket: unknown): string | null {
  const packet = isRecord(lastRunPacket) ? lastRunPacket : {};
  const packetEvidence = isRecord(packet.packetEvidence) ? packet.packetEvidence : {};
  const packetCommandIdentity = isRecord(packetEvidence.commandIdentity)
    ? packetEvidence.commandIdentity
    : {};
  const run = isRecord(packet.run) ? packet.run : {};
  const runCommandIdentity = isRecord(run.commandIdentity) ? run.commandIdentity : {};
  return (
    stringValue(packetCommandIdentity.commandHash) ||
    stringValue(run.commandHash) ||
    stringValue(runCommandIdentity.commandHash) ||
    stringValue(packet.commandHash)
  );
}

async function resolveArtifactPath(
  workDir: string,
  artifactPath: string,
): Promise<ArtifactResolution> {
  if (!artifactPath || artifactPath === "<outside-workdir>") {
    return { ok: false, reason: "artifact_path_outside_workdir" };
  }
  const workDirAbsolute = path.resolve(workDir || process.cwd());
  const lexicalPath = path.isAbsolute(artifactPath)
    ? path.resolve(artifactPath)
    : path.resolve(workDirAbsolute, artifactPath);
  const lexicalRelative = relativeInside(workDirAbsolute, lexicalPath);
  if (!lexicalRelative) return { ok: false, reason: "artifact_path_outside_workdir" };

  try {
    const [realWorkDir, realArtifactPath] = await Promise.all([
      fsp.realpath(workDirAbsolute),
      fsp.realpath(lexicalPath),
    ]);
    const realRelative = relativeInside(realWorkDir, realArtifactPath);
    if (!realRelative) return { ok: false, reason: "artifact_path_outside_workdir" };
  } catch (error: unknown) {
    if (missingFileError(error)) return { ok: false, reason: "artifact_missing" };
    return { ok: false, reason: "artifact_unreadable" };
  }

  return { ok: true, artifact: { absolutePath: lexicalPath, relativePath: lexicalRelative } };
}

function relativeInside(workDir: string, candidatePath: string): string | null {
  const relative = path.relative(workDir, candidatePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.replace(/\\/g, "/");
}

function displayArtifactPath(workDir: string, artifactPath: string): string {
  if (!artifactPath || artifactPath === "<outside-workdir>") return "<outside-workdir>";
  const workDirAbsolute = path.resolve(workDir || process.cwd());
  const resolved = path.isAbsolute(artifactPath)
    ? path.resolve(artifactPath)
    : path.resolve(workDirAbsolute, artifactPath);
  return relativeInside(workDirAbsolute, resolved) || "<outside-workdir>";
}

function partialResultCandidateId(input: {
  artifactName: string;
  artifactPath: string;
  rowIndex: number;
  metricName: string | null;
  metricValue: number | null;
  commandHash: string | null;
  schemaVersion: string | number | null;
  formulaVersion: string | null;
}): string {
  return `partial-${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 12)}`;
}

function compareCandidates(left: PartialResultCandidate, right: PartialResultCandidate): number {
  return (
    left.artifactPath.localeCompare(right.artifactPath) ||
    left.artifactName.localeCompare(right.artifactName) ||
    left.rowIndex - right.rowIndex ||
    left.id.localeCompare(right.id)
  );
}

function compareNotices(
  left: PartialResultArtifactNotice,
  right: PartialResultArtifactNotice,
): number {
  return (
    left.artifactPath.localeCompare(right.artifactPath) ||
    left.artifactName.localeCompare(right.artifactName) ||
    left.reason.localeCompare(right.reason)
  );
}

function fallbackArtifactName(artifactPath: string, index: number): string {
  return path.basename(artifactPath || "") || `artifact-${index}`;
}

function versionValue(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return stringValue(value);
}

function stringValue(value: unknown): string | null {
  const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  return text || null;
}

function missingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is LooseRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
