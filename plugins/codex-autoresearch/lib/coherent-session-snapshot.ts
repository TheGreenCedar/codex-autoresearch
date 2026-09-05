import { createHash } from "node:crypto";
import type { InputFingerprint } from "./investigation-records.js";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  insideGitRepo,
  resolvePrivateStateTarget,
  runGit,
  type PrivateStateStorageMode,
} from "./git-private-state.js";
import { captureVerifiedGitHead } from "./git-head.js";
import { lastRunGitSnapshot, lastRunStateSpec } from "./last-run-store.js";
import {
  parsePendingLogTransactionBytes,
  pendingLogTransactionStateSpec,
  type PendingLogTransactionSnapshot,
} from "./pending-log-transaction-store.js";
import { progressStateSpec } from "./active-progress-store.js";
import {
  activeSessionSegment,
  ledgerRecordIssue,
  parseJsonlRecord,
  type LedgerRecordIssue,
  type SessionRecord,
} from "./session-records.js";
import { resolveSessionPaths } from "./session-paths.js";
import { REPORT_DIRNAME } from "./session-artifacts.js";
import { isPathInside } from "./path-containment.js";
import { isUnknownRecord, type UnknownRecord } from "./types/json.js";
import { parseOutcomeState, type OutcomeState } from "./outcome-contract.js";
import { outcomeStateLocation, readOutcomeLocation } from "./outcome-store.js";
import {
  buildFinalizationEvidenceState,
  type FinalizationEvidenceFingerprint,
} from "./finalization-plan.js";

const SNAPSHOT_SCHEMA_VERSION = 1 as const;
const MAX_COHERENCE_ATTEMPTS = 3;
const LEDGER_TAIL_BYTES = 64 * 1024;
const MISSING_HASH = "missing";

export interface LedgerVersion {
  size: number;
  mtimeNs: string;
  tailHash: string;
}

export interface StoredSourceVersion {
  storage: "session" | PrivateStateStorageMode;
  hash: string;
}

export interface GitVersion {
  head: string;
  indexTree: string;
  statusHash: string;
  trustHash?: string;
}

export interface SessionSnapshotVersionVector {
  ledger: LedgerVersion;
  config: StoredSourceVersion;
  packet: StoredSourceVersion;
  receipt: StoredSourceVersion;
  process: StoredSourceVersion;
  completionAudit?: StoredSourceVersion;
  git: GitVersion;
  outcome?: StoredSourceVersion;
}

export interface CapturedCompletionAudit {
  branchHeads: Record<string, string | null>;
  summaryHash: string | null;
  acceptedEvidenceBase: string | null;
  acceptedEvidenceCommitDomain: string[] | null;
  acceptedEvidenceFingerprint: FinalizationEvidenceFingerprint | null;
}

export interface CapturedSessionSources {
  ledger: Uint8Array | null;
  config: Uint8Array | null;
  packet: Uint8Array | null;
  receipt: Uint8Array | null;
  process: Uint8Array | null;
  gitTrust?: UnknownRecord | null;
  completionAudit?: CapturedCompletionAudit | null;
  outcome?: Uint8Array | null;
}

export interface ResolvedSnapshotSource {
  path: string;
  storage: PrivateStateStorageMode;
}

export interface ResolvedSnapshotLocations {
  ledgerPath: string;
  configPath: string;
  packet: ResolvedSnapshotSource;
  receipt: ResolvedSnapshotSource;
  process: ResolvedSnapshotSource;
  outcome?: ResolvedSnapshotSource & { root: string };
}

export interface CoherentSnapshotIo {
  captureRoutingConfig(requestedCwd: string): Promise<Uint8Array | null>;
  resolveLocations(input: {
    sessionCwd: string;
    workDir: string;
  }): Promise<ResolvedSnapshotLocations>;
  readVersionVector(
    locations: ResolvedSnapshotLocations,
    input: { sessionCwd: string; workDir: string },
  ): Promise<SessionSnapshotVersionVector>;
  captureSources(
    locations: ResolvedSnapshotLocations,
    input: { sessionCwd: string; workDir: string },
  ): Promise<CapturedSessionSources>;
}

export interface SnapshotSemanticFacts {
  contractDigest: string;
  evaluatorIdentity: string;
  acceptedCheckIdentities: string[];
  preconditionEpoch: string;
}

export interface CoherentSessionSnapshot {
  kind: "coherent-session-snapshot";
  schemaVersion: 1;
  generationId: string;
  sessionCwd: string;
  workDir: string;
  vector: SessionSnapshotVersionVector;
  records: SessionRecord[];
  config: UnknownRecord;
  lastRunPacket: UnknownRecord | null;
  pendingTransaction: PendingLogTransactionSnapshot | null;
  processProgress: UnknownRecord | null;
  git: GitVersion;
  gitTrust?: UnknownRecord | null;
  completionAudit?: CapturedCompletionAudit | null;
  sourceDiagnostics: {
    ledgerIssues: LedgerRecordIssue[];
  };
  semanticFacts: SnapshotSemanticFacts;
  outcome?: OutcomeState | null;
  outcomeFacts?: { input: InputFingerprint | null; drift: string | null };
}

export type CoherentSnapshotLoadResult =
  | { ok: true; attempts: number; snapshot: CoherentSessionSnapshot }
  | {
      ok: false;
      attempts: 3;
      diagnostic: {
        code: "coherent-snapshot-unavailable";
        message: string;
        lastVectorA: SessionSnapshotVersionVector;
        lastVectorB: SessionSnapshotVersionVector;
      };
    }
  | {
      ok: false;
      attempts: number;
      diagnostic: {
        code: "coherent-snapshot-source-invalid";
        message: string;
      };
    };

export class CoherentSnapshotSourceError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CoherentSnapshotSourceError";
  }
}

export async function resolveInitialSessionMutationRoute({
  requestedCwd,
  allowOutsideWorkdir = false,
}: {
  requestedCwd: string;
  allowOutsideWorkdir?: boolean;
}): Promise<{ sessionCwd: string; workDir: string }> {
  const sessionCwd = path.resolve(requestedCwd);
  const routingConfigBytes = await nodeSnapshotIo.captureRoutingConfig(sessionCwd);
  let routingConfig: UnknownRecord;
  try {
    routingConfig = parseObject(routingConfigBytes, "routing config") || {};
  } catch (error) {
    if (error instanceof CoherentSnapshotSourceError) {
      return { sessionCwd, workDir: sessionCwd };
    }
    throw error;
  }
  const workDir = routingConfig.workingDir
    ? path.resolve(sessionCwd, String(routingConfig.workingDir))
    : sessionCwd;
  if (!allowOutsideWorkdir && !isPathInside(sessionCwd, workDir)) {
    throw new Error(
      `Configured working directory is outside --cwd: ${workDir}. Pass --allow-outside-workdir to authorize it explicitly.`,
    );
  }
  return { sessionCwd, workDir };
}

export async function loadCoherentSessionSnapshot({
  requestedCwd,
  allowOutsideWorkdir = false,
  io = nodeSnapshotIo,
  inspectCapturedSnapshot,
}: {
  requestedCwd: string;
  allowOutsideWorkdir?: boolean;
  io?: CoherentSnapshotIo;
  inspectCapturedSnapshot?: (
    snapshot: CoherentSessionSnapshot,
  ) => void | string | Promise<void | string>;
}): Promise<CoherentSnapshotLoadResult> {
  const sessionCwd = path.resolve(requestedCwd);
  let lastVectorA: SessionSnapshotVersionVector | null = null;
  let lastVectorB: SessionSnapshotVersionVector | null = null;
  for (let attempt = 1; attempt <= MAX_COHERENCE_ATTEMPTS; attempt += 1) {
    const routingConfigBytes = await io.captureRoutingConfig(sessionCwd);
    let routingConfig: UnknownRecord;
    try {
      routingConfig = parseObject(routingConfigBytes, "routing config") || {};
    } catch (error) {
      if (error instanceof CoherentSnapshotSourceError) {
        return snapshotSourceFailure(attempt, error);
      }
      throw error;
    }
    const workDir = routingConfig.workingDir
      ? path.resolve(sessionCwd, String(routingConfig.workingDir))
      : sessionCwd;
    if (!allowOutsideWorkdir && !isPathInside(sessionCwd, workDir)) {
      throw new Error(
        `Configured working directory is outside --cwd: ${workDir}. Pass --allow-outside-workdir to authorize it explicitly.`,
      );
    }
    const locationsA = await io.resolveLocations({ sessionCwd, workDir });
    let vectorA: SessionSnapshotVersionVector;
    let captured: CapturedSessionSources;
    try {
      vectorA = await io.readVersionVector(locationsA, { sessionCwd, workDir });
      captured = await io.captureSources(locationsA, { sessionCwd, workDir });
    } catch (error) {
      return snapshotSourceFailure(attempt, error);
    }
    let inspectedSnapshot: CoherentSessionSnapshot | null = null;
    let inspectionVersionA = "";
    let inspectionError: unknown = null;
    if (inspectCapturedSnapshot) {
      try {
        inspectedSnapshot = parseCapturedSnapshot({
          captured,
          generationId: generationIdForVersionVector(vectorA),
          sessionCwd,
          vector: vectorA,
          workDir,
        });
        inspectionVersionA = (await inspectCapturedSnapshot(inspectedSnapshot)) || "";
      } catch (error) {
        inspectionError = error;
      }
    }
    let vectorB: SessionSnapshotVersionVector;
    let locationsB: ResolvedSnapshotLocations;
    try {
      locationsB = await io.resolveLocations({ sessionCwd, workDir });
      vectorB = await io.readVersionVector(locationsB, { sessionCwd, workDir });
    } catch (error) {
      return snapshotSourceFailure(attempt, error);
    }
    lastVectorA = vectorA;
    lastVectorB = vectorB;
    if (
      !vectorsEqual(vectorA, vectorB) ||
      !snapshotLocationsEqual(locationsA, locationsB) ||
      !optionalBytesEqual(routingConfigBytes, captured.config)
    ) {
      continue;
    }
    if (inspectionError) {
      if (inspectionError instanceof CoherentSnapshotSourceError) {
        return snapshotSourceFailure(attempt, inspectionError);
      }
      throw inspectionError;
    }
    if (inspectCapturedSnapshot && inspectedSnapshot && inspectionVersionA) {
      let inspectionVersionB = "";
      try {
        inspectionVersionB = (await inspectCapturedSnapshot(inspectedSnapshot)) || "";
      } catch (error) {
        inspectionError = error;
      }
      if (inspectionError) {
        if (inspectionError instanceof CoherentSnapshotSourceError) {
          return snapshotSourceFailure(attempt, inspectionError);
        }
        throw inspectionError;
      }
      if (inspectionVersionA !== inspectionVersionB) {
        continue;
      }
    }
    try {
      return {
        ok: true,
        attempts: attempt,
        snapshot: parseCapturedSnapshot({
          captured,
          generationId: generationIdForVersionVector(vectorB),
          sessionCwd,
          vector: vectorB,
          workDir,
        }),
      };
    } catch (error) {
      if (error instanceof CoherentSnapshotSourceError) {
        return snapshotSourceFailure(attempt, error);
      }
      throw error;
    }
  }
  return {
    ok: false,
    attempts: 3,
    diagnostic: {
      code: "coherent-snapshot-unavailable",
      message:
        "Session inputs changed during three coherent snapshot attempts; retry after the active writer finishes.",
      lastVectorA: lastVectorA as SessionSnapshotVersionVector,
      lastVectorB: lastVectorB as SessionSnapshotVersionVector,
    },
  };
}

export function generationIdForVersionVector(vector: SessionSnapshotVersionVector): string {
  return sha256(canonicalJson(vector));
}

function snapshotLocationsEqual(
  left: ResolvedSnapshotLocations,
  right: ResolvedSnapshotLocations,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function snapshotSourceFailure(
  attempts: number,
  error: unknown,
): Extract<
  CoherentSnapshotLoadResult,
  { ok: false; diagnostic: { code: "coherent-snapshot-source-invalid" } }
> {
  return {
    ok: false,
    attempts,
    diagnostic: {
      code: "coherent-snapshot-source-invalid",
      message: `A coherent session source could not be captured: ${error instanceof Error ? error.message : String(error)}`,
    },
  };
}

export function parseCapturedSnapshot({
  captured,
  generationId,
  sessionCwd,
  vector,
  workDir,
}: {
  captured: CapturedSessionSources;
  generationId: string;
  sessionCwd: string;
  vector: SessionSnapshotVersionVector;
  workDir: string;
}): CoherentSessionSnapshot {
  const ledger = parseCapturedLedger(captured.ledger, `${workDir}/autoresearch.jsonl`);
  const records = ledger.records;
  const config = parseObject(captured.config, "accepted config") || {};
  const lastRunPacket = parseObject(captured.packet, "last-run packet");
  const pendingTransaction = parsePendingLogTransactionBytes(captured.receipt, captured.ledger);
  const processProgress = parseObject(captured.process, "active process progress");
  const outcomeSource = parseObject(captured.outcome ?? null, "outcome state");
  return {
    kind: "coherent-session-snapshot",
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generationId,
    sessionCwd,
    workDir,
    vector,
    outcome: outcomeSource === null ? null : parseOutcomeState(outcomeSource),
    records,
    config,
    lastRunPacket,
    pendingTransaction,
    processProgress,
    git: vector.git,
    gitTrust: captured.gitTrust || null,
    completionAudit: captured.completionAudit || null,
    sourceDiagnostics: { ledgerIssues: ledger.issues },
    semanticFacts: semanticFactsFromRecords(records),
  };
}

function parseCapturedLedger(
  bytes: Uint8Array | null,
  filePath: string,
): { records: SessionRecord[]; issues: LedgerRecordIssue[] } {
  if (bytes == null) return { records: [], issues: [] };
  const records: SessionRecord[] = [];
  const issues: LedgerRecordIssue[] = [];
  Buffer.from(bytes)
    .toString("utf8")
    .split(/\r?\n/)
    .forEach((rawLine, index) => {
      const line = rawLine.trim();
      if (!line) return;
      try {
        records.push(parseJsonlRecord(line, filePath, index + 1));
      } catch (error) {
        const issue = ledgerRecordIssue(error);
        if (!issue) throw error;
        issues.push(issue);
      }
    });
  return { records, issues };
}

const nodeSnapshotIo: CoherentSnapshotIo = {
  async captureRoutingConfig(requestedCwd) {
    const configPath = resolveSessionPaths({
      sessionCwd: requestedCwd,
      workDir: requestedCwd,
    }).configPath;
    return await readOptionalFile(configPath);
  },
  async resolveLocations({ sessionCwd, workDir }) {
    const paths = resolveSessionPaths({ sessionCwd, workDir });
    const [packet, receipt, process, outcome] = await Promise.all([
      resolvePrivateStateTarget(workDir, lastRunStateSpec(workDir)),
      resolvePrivateStateTarget(workDir, pendingLogTransactionStateSpec(workDir)),
      resolvePrivateStateTarget(workDir, progressStateSpec(workDir)),
      outcomeStateLocation(workDir),
    ]);
    return {
      ledgerPath: paths.ledgerPath,
      configPath: paths.configPath,
      packet: { path: packet.path, storage: packet.storageMode },
      receipt: { path: receipt.path, storage: receipt.storageMode },
      process: { path: process.path, storage: process.storageMode },
      outcome: { path: outcome.path, storage: outcome.storageMode, root: outcome.root },
    };
  },
  async readVersionVector(locations, { workDir }) {
    const [ledgerBytes, configBytes, packetBytes] = await Promise.all([
      readOptionalFile(locations.ledgerPath),
      readOptionalFile(locations.configPath),
      readOptionalFile(locations.packet.path),
    ]);
    const trustConfig = parseObject(configBytes, "accepted config") || {};
    const [ledger, config, packet, receipt, process, completionAudit, git, outcome] =
      await Promise.all([
        ledgerVersion(locations.ledgerPath),
        storedVersion(locations.configPath, "session"),
        storedVersion(locations.packet.path, locations.packet.storage),
        storedVersion(locations.receipt.path, locations.receipt.storage),
        storedVersion(locations.process.path, locations.process.storage),
        completionAuditVersion(workDir, ledgerBytes),
        captureGitVersion(workDir, undefined, packetBytes ? trustConfig : undefined),
        locations.outcome ? storedOutcomeVersion(locations.outcome) : Promise.resolve(undefined),
      ]);
    return {
      ledger,
      config,
      packet,
      receipt,
      process,
      completionAudit,
      git,
      ...(outcome ? { outcome } : {}),
    };
  },
  async captureSources(locations, { workDir }) {
    const [ledger, config, packet, receipt, process, outcome] = await Promise.all([
      readOptionalFile(locations.ledgerPath),
      readOptionalFile(locations.configPath),
      readOptionalFile(locations.packet.path),
      readOptionalFile(locations.receipt.path),
      readOptionalFile(locations.process.path),
      locations.outcome ? readOutcomeLocation(locations.outcome) : Promise.resolve(null),
    ]);
    const [gitTrust, completionAudit] = await Promise.all([
      packet ? lastRunGitSnapshot(workDir, parseObject(config, "accepted config") || {}) : null,
      captureCompletionAudit(workDir, ledger),
    ]);
    return { ledger, config, packet, receipt, process, gitTrust, completionAudit, outcome };
  },
};

async function storedOutcomeVersion(
  location: ResolvedSnapshotSource & { root: string },
): Promise<StoredSourceVersion> {
  const bytes = await readOutcomeLocation(location);
  return { storage: location.storage, hash: bytes === null ? MISSING_HASH : sha256(bytes) };
}

async function ledgerVersion(filePath: string): Promise<LedgerVersion> {
  try {
    const [stat, bytes] = await Promise.all([
      fsp.stat(filePath, { bigint: true }),
      fsp.readFile(filePath),
    ]);
    const tail = bytes.subarray(Math.max(0, bytes.byteLength - LEDGER_TAIL_BYTES));
    return {
      size: Number(stat.size),
      mtimeNs: stat.mtimeNs.toString(),
      tailHash: sha256(tail),
    };
  } catch (error) {
    if (isMissing(error)) return { size: 0, mtimeNs: MISSING_HASH, tailHash: MISSING_HASH };
    throw error;
  }
}

async function storedVersion(
  filePath: string,
  storage: StoredSourceVersion["storage"],
): Promise<StoredSourceVersion> {
  const bytes = await readOptionalFile(filePath);
  return { storage, hash: bytes == null ? MISSING_HASH : sha256(bytes) };
}

async function completionAuditVersion(
  workDir: string,
  ledgerBytes: Uint8Array | null,
): Promise<StoredSourceVersion> {
  const audit = await captureCompletionAudit(workDir, ledgerBytes);
  return {
    storage: "session",
    hash: audit ? sha256(canonicalJson(audit)) : MISSING_HASH,
  };
}

async function captureCompletionAudit(
  workDir: string,
  ledgerBytes: Uint8Array | null,
): Promise<CapturedCompletionAudit | null> {
  const completed = latestCompletionRecord(ledgerBytes);
  if (!completed || !Array.isArray(completed.evidence)) return null;
  const branchHeads: Record<string, string | null> = {};
  for (const item of completed.evidence) {
    const match = String(item || "").match(/^review-branch:(.+)@([0-9a-f]{40}(?:[0-9a-f]{24})?)$/);
    if (!match) continue;
    const branch = match[1];
    const format = await runGit(["check-ref-format", "--branch", branch], workDir);
    if (format.code !== 0 || format.stdoutTruncated) {
      branchHeads[branch] = null;
      continue;
    }
    const resolved = await runGit(["rev-parse", "--verify", `refs/heads/${branch}`], workDir);
    branchHeads[branch] =
      resolved.code === 0 && !resolved.stdoutTruncated && resolved.stdout.trim()
        ? resolved.stdout.trim()
        : null;
  }
  const summaryName = String(completed.reviewSummary || "");
  const summaryHash = await captureReviewSummaryHash(workDir, summaryName);
  const acceptedEvidenceBase =
    typeof completed.acceptedEvidenceBase === "string" &&
    /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(completed.acceptedEvidenceBase)
      ? completed.acceptedEvidenceBase
      : null;
  const acceptedEvidenceCommitDomain = acceptedEvidenceBase
    ? await captureCompletionCommitDomain(workDir, acceptedEvidenceBase)
    : null;
  const acceptedEvidenceFingerprint = acceptedEvidenceCommitDomain
    ? buildFinalizationEvidenceState(
        acceptedEvidenceCommitDomain,
        capturedLedgerObjects(ledgerBytes),
      ).fingerprint
    : null;
  return {
    branchHeads,
    summaryHash,
    acceptedEvidenceBase,
    acceptedEvidenceCommitDomain,
    acceptedEvidenceFingerprint,
  };
}

async function captureCompletionCommitDomain(
  workDir: string,
  base: string,
): Promise<string[] | null> {
  const verified = await runGit(["rev-parse", "--verify", `${base}^{commit}`], workDir);
  if (
    verified.code !== 0 ||
    verified.stdoutTruncated ||
    verified.stdout.trim().toLowerCase() !== base.toLowerCase()
  ) {
    return null;
  }
  const history = await runGit(["log", "--reverse", "--format=%H", `${base}..HEAD`], workDir);
  if (history.code !== 0 || history.stdoutTruncated) return null;
  const commits = history.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  return commits.every((value) => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value)) ? commits : null;
}

function capturedLedgerObjects(ledgerBytes: Uint8Array | null): UnknownRecord[] {
  if (!ledgerBytes) return [];
  return Buffer.from(ledgerBytes)
    .toString("utf8")
    .split(/\r?\n/)
    .flatMap((rawLine) => {
      const line = rawLine.trim();
      if (!line) return [];
      try {
        const parsed: unknown = JSON.parse(line);
        return isUnknownRecord(parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

async function captureReviewSummaryHash(
  workDir: string,
  summaryName: string,
): Promise<string | null> {
  if (!summaryName || path.basename(summaryName) !== summaryName) return null;
  const commonDir = await runGit(["rev-parse", "--git-common-dir"], workDir);
  if (commonDir.code !== 0 || commonDir.stdoutTruncated || !commonDir.stdout.trim()) return null;
  const resolvedCommonDir = path.isAbsolute(commonDir.stdout.trim())
    ? path.resolve(commonDir.stdout.trim())
    : path.resolve(workDir, commonDir.stdout.trim());
  const reportRoot = path.join(resolvedCommonDir, REPORT_DIRNAME);
  const summaryPath = path.join(reportRoot, summaryName);
  if (!isPathInside(reportRoot, summaryPath)) return null;
  try {
    const stats = await fsp.lstat(summaryPath);
    if (!stats.isFile() || stats.isSymbolicLink()) return null;
    return sha256(await fsp.readFile(summaryPath));
  } catch {
    return null;
  }
}

function latestCompletionRecord(ledgerBytes: Uint8Array | null): UnknownRecord | null {
  if (!ledgerBytes) return null;
  let latest: UnknownRecord | null = null;
  for (const rawLine of Buffer.from(ledgerBytes).toString("utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isUnknownRecord(parsed) && parsed.type === "finalization-completed") latest = parsed;
    } catch {
      // The ledger parser records structural issues separately; an invalid line cannot
      // contribute completion audit authority.
    }
  }
  return latest;
}

export async function captureGitVersion(
  workDir: string,
  io: {
    insideGitRepo: typeof insideGitRepo;
    runGit: typeof runGit;
  } = { insideGitRepo, runGit },
  trustConfig?: UnknownRecord,
): Promise<GitVersion> {
  if (!(await io.insideGitRepo(workDir))) {
    return {
      head: "not-a-repository",
      indexTree: "not-a-repository",
      statusHash: sha256("not-a-repository"),
    };
  }
  const head = await captureVerifiedGitHead(workDir, { runGit: io.runGit });
  const indexResult = await io.runGit(["write-tree"], workDir);
  const statusResult = await io.runGit(["status", "--porcelain=v1", "-z", "-uall"], workDir);
  if (indexResult.code !== 0 || indexResult.stdoutTruncated) {
    throw new Error(
      `Git index tree could not be captured for the coherent session snapshot: ${indexResult.stderr || indexResult.stdout || `exit ${String(indexResult.code)}`}${indexResult.stdoutTruncated ? " (output truncated)" : ""}`,
    );
  }
  if (statusResult.code !== 0 || statusResult.stdoutTruncated) {
    throw new Error("Git status could not be captured for the coherent session snapshot.");
  }
  const trust = trustConfig ? await lastRunGitSnapshot(workDir, trustConfig) : null;
  return {
    head,
    indexTree: indexResult.stdout.trim() || "empty-index",
    statusHash: sha256(statusResult.stdout),
    ...(trust ? { trustHash: sha256(canonicalJson(trust)) } : {}),
  };
}

async function readOptionalFile(filePath: string): Promise<Buffer | null> {
  try {
    return await fsp.readFile(filePath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function parseObject(bytes: Uint8Array | null, label: string): UnknownRecord | null {
  if (bytes == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new CoherentSnapshotSourceError(`${label} contains invalid JSON.`, error);
  }
  if (!isUnknownRecord(parsed)) {
    throw new CoherentSnapshotSourceError(`${label} must contain a JSON object.`);
  }
  return parsed;
}

function semanticFactsFromRecords(records: SessionRecord[]): SnapshotSemanticFacts {
  const activeSegment = activeSessionSegment(records);
  const accepted = [...records]
    .reverse()
    .find(
      (record) =>
        record.type === "experiment-contract-accepted" && Number(record.segment) === activeSegment,
    );
  const contract = isUnknownRecord(accepted?.contract) ? accepted.contract : null;
  const evaluator = isUnknownRecord(contract?.evaluator) ? contract.evaluator : null;
  const execution = isUnknownRecord(evaluator?.execution) ? evaluator.execution : null;
  const evaluatorId = typeof evaluator?.id === "string" ? evaluator.id : "";
  const evaluatorExecutionDigest =
    typeof execution?.executionDigest === "string" ? execution.executionDigest : "";
  const acceptedCheckIdentities = (Array.isArray(contract?.checks) ? contract.checks : [])
    .map((value) => {
      const check = isUnknownRecord(value) ? value : null;
      const checkExecution = isUnknownRecord(check?.execution) ? check.execution : null;
      const id = typeof check?.id === "string" ? check.id : "";
      const digest =
        typeof checkExecution?.executionDigest === "string" ? checkExecution.executionDigest : "";
      return [id, digest].filter(Boolean).join("@");
    })
    .filter(Boolean)
    .sort();
  return {
    contractDigest: typeof contract?.contractDigest === "string" ? contract.contractDigest : "",
    evaluatorIdentity: [evaluatorId, evaluatorExecutionDigest].filter(Boolean).join("@"),
    acceptedCheckIdentities,
    preconditionEpoch: typeof accepted?.eventId === "string" ? accepted.eventId : "",
  };
}

function vectorsEqual(
  left: SessionSnapshotVersionVector,
  right: SessionSnapshotVersionVector,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function optionalBytesEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left == null || right == null) return left === right;
  return Buffer.from(left).equals(Buffer.from(right));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isUnknownRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortValue(value[key])]),
  );
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isMissing(error: unknown): boolean {
  return isUnknownRecord(error) && error.code === "ENOENT";
}
