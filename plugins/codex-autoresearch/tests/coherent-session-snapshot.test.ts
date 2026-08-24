import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  captureGitVersion,
  generationIdForVersionVector,
  loadCoherentSessionSnapshot,
  type CapturedSessionSources,
  type CoherentSnapshotIo,
  type SessionSnapshotVersionVector,
} from "../lib/coherent-session-snapshot.js";
import type { ProcessRunResult } from "../lib/runner.js";

const BASE_VECTOR: SessionSnapshotVersionVector = {
  ledger: { size: 10, mtimeNs: "100", tailHash: "ledger-a" },
  config: { storage: "session", hash: "config-a" },
  packet: { storage: "git-private", hash: "packet-a" },
  receipt: { storage: "git-private", hash: "receipt-a" },
  process: { storage: "git-private", hash: "process-a" },
  git: { head: "head-a", indexTree: "index-a", statusHash: "status-a" },
};

const BASE_SOURCES: CapturedSessionSources = {
  ledger: Buffer.from('{"type":"config","metricName":"seconds"}\n'),
  config: Buffer.from('{"name":"coherent","metricName":"seconds"}\n'),
  packet: Buffer.from('{"schemaVersion":1,"run":{"parsedPrimary":2}}\n'),
  receipt: Buffer.from(
    '{"type":"autoresearch.log.transaction","schemaVersion":2,"status":"pending","transaction":{"id":"tx-1"}}\n',
  ),
  process: Buffer.from('{"generation":3,"status":"running"}\n'),
};

const MEMBERS = [
  ["ledger", (vector: SessionSnapshotVersionVector) => (vector.ledger.tailHash = "ledger-b")],
  ["config", (vector: SessionSnapshotVersionVector) => (vector.config.hash = "config-b")],
  ["packet", (vector: SessionSnapshotVersionVector) => (vector.packet.hash = "packet-b")],
  ["receipt", (vector: SessionSnapshotVersionVector) => (vector.receipt.hash = "receipt-b")],
  ["process", (vector: SessionSnapshotVersionVector) => (vector.process.hash = "process-b")],
  ["HEAD", (vector: SessionSnapshotVersionVector) => (vector.git.head = "head-b")],
  ["index", (vector: SessionSnapshotVersionVector) => (vector.git.indexTree = "index-b")],
  ["status", (vector: SessionSnapshotVersionVector) => (vector.git.statusHash = "status-b")],
] as const;

test("coherent snapshot retries every raw source race and accepts only an equal A/load/B vector", async () => {
  for (const [name, mutate] of MEMBERS) {
    const changed = structuredClone(BASE_VECTOR);
    mutate(changed);
    const io = sequenceIo([BASE_VECTOR, changed, changed, changed], [BASE_SOURCES, BASE_SOURCES]);

    const result = await loadCoherentSessionSnapshot({
      requestedCwd: "/worktree",
      io,
    });

    assert.equal(result.ok, true, name);
    if (!result.ok) continue;
    assert.equal(result.attempts, 2, name);
    assert.deepEqual(result.snapshot.vector, changed, name);
  }
});

test("coherent snapshot returns typed exhaustion after exactly three unequal attempts", async () => {
  const vectors = Array.from({ length: 6 }, (_, index) => {
    const vector = structuredClone(BASE_VECTOR);
    vector.git.statusHash = `status-${index}`;
    return vector;
  });
  const io = sequenceIo(vectors, [BASE_SOURCES, BASE_SOURCES, BASE_SOURCES]);

  const result = await loadCoherentSessionSnapshot({
    requestedCwd: "/worktree",
    io,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.attempts, 3);
  assert.equal(result.diagnostic.code, "coherent-snapshot-unavailable");
  assert.equal(io.vectorReads(), 6);
  assert.equal(io.sourceReads(), 3);
});

test("coherent snapshot parses the bytes captured inside the accepted attempt", async () => {
  const sources = structuredClone(BASE_SOURCES);
  sources.config = Buffer.from('{"name":"captured","metricName":"score"}\n');
  sources.packet = Buffer.from('{"schemaVersion":1,"run":{"parsedPrimary":7}}\n');
  const io = sequenceIo([BASE_VECTOR, BASE_VECTOR], [sources]);

  const result = await loadCoherentSessionSnapshot({
    requestedCwd: "/worktree",
    io,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.snapshot.config.name, "captured");
  assert.equal(result.snapshot.config.metricName, "score");
  assert.equal(result.snapshot.lastRunPacket?.run?.parsedPrimary, 7);
  assert.equal(result.snapshot.pendingTransaction?.transactionId, "tx-1");
  assert.equal(result.snapshot.processProgress?.generation, 3);
  assert.equal(io.sourceReads(), 1);
});

test("routing config bytes and accepted config bytes must identify the same target cwd", async () => {
  const wrongRouting = Buffer.from('{"workingDir":"wrong"}\n');
  const stableRouting = Buffer.from('{"workingDir":"right"}\n');
  const stableSources = { ...BASE_SOURCES, config: stableRouting };
  const io = sequenceIo(
    [BASE_VECTOR, BASE_VECTOR, BASE_VECTOR, BASE_VECTOR],
    [stableSources, stableSources],
    [wrongRouting, stableRouting],
  );

  const result = await loadCoherentSessionSnapshot({ requestedCwd: "/session", io });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.attempts, 2);
  assert.equal(result.snapshot.sessionCwd, "/session");
  assert.equal(result.snapshot.workDir, "/session/right");
  assert.deepEqual(io.resolvedWorkDirs(), ["/session/wrong", "/session/right"]);
});

test("generation identity changes for every member of the raw version vector", () => {
  const baseline = generationIdForVersionVector(BASE_VECTOR);
  for (const [name, mutate] of MEMBERS) {
    const changed = structuredClone(BASE_VECTOR);
    mutate(changed);
    assert.notEqual(generationIdForVersionVector(changed), baseline, name);
  }
  for (const field of ["size", "mtimeNs"] as const) {
    const changed = structuredClone(BASE_VECTOR);
    changed.ledger[field] = field === "size" ? 11 : "101";
    assert.notEqual(generationIdForVersionVector(changed), baseline, `ledger.${field}`);
  }
  for (const member of ["packet", "receipt", "process"] as const) {
    const changed = structuredClone(BASE_VECTOR);
    changed[member].storage = "worktree";
    assert.notEqual(generationIdForVersionVector(changed), baseline, `${member}.storage`);
  }
});

test("Git version capture does not overlap commands that may contend on the index", async () => {
  let active = 0;
  let maxActive = 0;
  const resultFor = (stdout: string): ProcessRunResult => ({
    code: 0,
    signal: null,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 1,
  });
  const result = await captureGitVersion("/worktree", {
    insideGitRepo: async () => true,
    runGit: async (args) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return resultFor(args[0] === "write-tree" ? "tree\n" : args[0] === "status" ? "" : "head\n");
    },
  });

  assert.equal(maxActive, 1);
  assert.deepEqual(result, {
    head: "head",
    indexTree: "tree",
    statusHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  });
});

test("coherent snapshot uses one private store and fails closed on independently populated copies", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coherent-private-store-"));
  try {
    await promisify(execFile)("git", ["init"], { cwd: root });
    const gitPrivate = path.join(root, ".git", "autoresearch");
    await mkdir(gitPrivate, { recursive: true });
    await writeFile(
      path.join(gitPrivate, "last-run.json"),
      '{"schemaVersion":1,"run":{"parsedPrimary":1}}\n',
    );

    const selected = await loadCoherentSessionSnapshot({ requestedCwd: root });
    assert.equal(selected.ok, true);
    if (selected.ok) {
      assert.equal(selected.snapshot.vector.packet.storage, "git-private");
      assert.equal(selected.snapshot.lastRunPacket?.run?.parsedPrimary, 1);
    }

    await writeFile(
      path.join(root, "autoresearch.last-run.json"),
      '{"schemaVersion":1,"run":{"parsedPrimary":2}}\n',
    );
    await assert.rejects(
      loadCoherentSessionSnapshot({ requestedCwd: root }),
      /Conflicting last-run packet state exists in both Git-private and worktree storage/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function sequenceIo(
  vectors: SessionSnapshotVersionVector[],
  sources: CapturedSessionSources[],
  routingConfigs: Array<Uint8Array | null> = sources.map((source) => source.config),
): CoherentSnapshotIo & {
  vectorReads(): number;
  sourceReads(): number;
  resolvedWorkDirs(): string[];
} {
  let vectorIndex = 0;
  let sourceIndex = 0;
  let routingIndex = 0;
  const workDirs: string[] = [];
  return {
    async captureRoutingConfig() {
      return structuredClone(routingConfigs[routingIndex++]);
    },
    async resolveLocations({ workDir }) {
      workDirs.push(workDir);
      return {
        ledgerPath: "/session/autoresearch.jsonl",
        configPath: "/session/autoresearch.config.json",
        packet: { path: "/git/last-run.json", storage: "git-private" },
        receipt: { path: "/git/pending-log-transaction.json", storage: "git-private" },
        process: { path: "/git/progress.json", storage: "git-private" },
      };
    },
    async readVersionVector() {
      return structuredClone(vectors[vectorIndex++]);
    },
    async captureSources() {
      return structuredClone(sources[sourceIndex++]);
    },
    vectorReads: () => vectorIndex,
    sourceReads: () => sourceIndex,
    resolvedWorkDirs: () => workDirs,
  };
}
