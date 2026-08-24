import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  insideGitRepo,
  resolvePrivateStateTarget,
  runGit,
  type PrivateStateStorageMode,
} from "./git-private-state.js";
import { lastRunStateSpec } from "./last-run-store.js";
import {
  parsePendingLogTransactionBytes,
  pendingLogTransactionStateSpec,
  type PendingLogTransactionSnapshot,
} from "./pending-log-transaction-store.js";
import { progressStateSpec } from "./active-progress-store.js";
import {
  ledgerRecordIssue,
  parseJsonlRecord,
  type LedgerRecordIssue,
  type SessionRecord,
} from "./session-records.js";
import { resolveSessionPaths } from "./session-paths.js";
import { isPathInside } from "./path-containment.js";
import { isUnknownRecord, type UnknownRecord } from "./types/json.js";

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
}

export interface SessionSnapshotVersionVector {
  ledger: LedgerVersion;
  config: StoredSourceVersion;
  packet: StoredSourceVersion;
  receipt: StoredSourceVersion;
  process: StoredSourceVersion;
  git: GitVersion;
}

export interface CapturedSessionSources {
  ledger: Uint8Array | null;
  config: Uint8Array | null;
  packet: Uint8Array | null;
  receipt: Uint8Array | null;
  process: Uint8Array | null;
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
  captureSources(locations: ResolvedSnapshotLocations): Promise<CapturedSessionSources>;
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
  sourceDiagnostics: {
    ledgerIssues: LedgerRecordIssue[];
  };
  semanticFacts: SnapshotSemanticFacts;
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
    };

export async function loadCoherentSessionSnapshot({
  requestedCwd,
  allowOutsideWorkdir = false,
  io = nodeSnapshotIo,
}: {
  requestedCwd: string;
  allowOutsideWorkdir?: boolean;
  io?: CoherentSnapshotIo;
}): Promise<CoherentSnapshotLoadResult> {
  const sessionCwd = path.resolve(requestedCwd);
  let lastVectorA: SessionSnapshotVersionVector | null = null;
  let lastVectorB: SessionSnapshotVersionVector | null = null;
  for (let attempt = 1; attempt <= MAX_COHERENCE_ATTEMPTS; attempt += 1) {
    const routingConfigBytes = await io.captureRoutingConfig(sessionCwd);
    const routingConfig = parseObject(routingConfigBytes, "routing config") || {};
    const workDir = routingConfig.workingDir
      ? path.resolve(sessionCwd, String(routingConfig.workingDir))
      : sessionCwd;
    if (!allowOutsideWorkdir && !isPathInside(sessionCwd, workDir)) {
      throw new Error(
        `Configured working directory is outside --cwd: ${workDir}. Pass --allow-outside-workdir to authorize it explicitly.`,
      );
    }
    const locations = await io.resolveLocations({ sessionCwd, workDir });
    const vectorA = await io.readVersionVector(locations, { sessionCwd, workDir });
    const captured = await io.captureSources(locations);
    const vectorB = await io.readVersionVector(locations, { sessionCwd, workDir });
    lastVectorA = vectorA;
    lastVectorB = vectorB;
    if (
      !vectorsEqual(vectorA, vectorB) ||
      !optionalBytesEqual(routingConfigBytes, captured.config)
    ) {
      continue;
    }
    return {
      ok: true,
      attempts: attempt,
      snapshot: parseCapturedSnapshot({
        captured,
        generationId: generationIdForVersionVector(vectorA),
        sessionCwd,
        vector: vectorA,
        workDir,
      }),
    };
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
  const pendingTransaction = parsePendingLogTransactionBytes(captured.receipt);
  const processProgress = parseObject(captured.process, "active process progress");
  return {
    kind: "coherent-session-snapshot",
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generationId,
    sessionCwd,
    workDir,
    vector,
    records,
    config,
    lastRunPacket,
    pendingTransaction,
    processProgress,
    git: vector.git,
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
    const [packet, receipt, process] = await Promise.all([
      resolvePrivateStateTarget(workDir, lastRunStateSpec(workDir)),
      resolvePrivateStateTarget(workDir, pendingLogTransactionStateSpec(workDir)),
      resolvePrivateStateTarget(workDir, progressStateSpec(workDir)),
    ]);
    return {
      ledgerPath: paths.ledgerPath,
      configPath: paths.configPath,
      packet: { path: packet.path, storage: packet.storageMode },
      receipt: { path: receipt.path, storage: receipt.storageMode },
      process: { path: process.path, storage: process.storageMode },
    };
  },
  async readVersionVector(locations, { workDir }) {
    const [ledger, config, packet, receipt, process, git] = await Promise.all([
      ledgerVersion(locations.ledgerPath),
      storedVersion(locations.configPath, "session"),
      storedVersion(locations.packet.path, locations.packet.storage),
      storedVersion(locations.receipt.path, locations.receipt.storage),
      storedVersion(locations.process.path, locations.process.storage),
      captureGitVersion(workDir),
    ]);
    return { ledger, config, packet, receipt, process, git };
  },
  async captureSources(locations) {
    const [ledger, config, packet, receipt, process] = await Promise.all([
      readOptionalFile(locations.ledgerPath),
      readOptionalFile(locations.configPath),
      readOptionalFile(locations.packet.path),
      readOptionalFile(locations.receipt.path),
      readOptionalFile(locations.process.path),
    ]);
    return { ledger, config, packet, receipt, process };
  },
};

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

export async function captureGitVersion(
  workDir: string,
  io: {
    insideGitRepo: typeof insideGitRepo;
    runGit: typeof runGit;
  } = { insideGitRepo, runGit },
): Promise<GitVersion> {
  if (!(await io.insideGitRepo(workDir))) {
    return {
      head: "not-a-repository",
      indexTree: "not-a-repository",
      statusHash: sha256("not-a-repository"),
    };
  }
  const headResult = await io.runGit(["rev-parse", "--verify", "HEAD"], workDir);
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
  return {
    head: headResult.code === 0 ? headResult.stdout.trim() : "unborn",
    indexTree: indexResult.stdout.trim() || "empty-index",
    statusHash: sha256(statusResult.stdout),
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
  } catch {
    throw new Error(`${label} contains invalid JSON.`);
  }
  if (!isUnknownRecord(parsed)) throw new Error(`${label} must contain a JSON object.`);
  return parsed;
}

function semanticFactsFromRecords(records: SessionRecord[]): SnapshotSemanticFacts {
  const accepted = [...records]
    .reverse()
    .find((record) => record.type === "experiment-contract-accepted");
  const contract = isUnknownRecord(accepted?.contract) ? accepted.contract : null;
  const evaluator = isUnknownRecord(contract?.evaluator) ? contract.evaluator : null;
  const execution = isUnknownRecord(evaluator?.execution) ? evaluator.execution : null;
  const latestEpochRecord = [...records]
    .reverse()
    .find((record) => typeof record.preconditionEpoch === "string");
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
    preconditionEpoch:
      typeof latestEpochRecord?.preconditionEpoch === "string"
        ? latestEpochRecord.preconditionEpoch
        : typeof accepted?.eventId === "string"
          ? accepted.eventId
          : "",
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
