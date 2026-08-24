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

test("coherent snapshot re-resolves private-store locations across the A/load/B boundary", async () => {
  let resolves = 0;
  let sourceReads = 0;
  const gitLocations = snapshotLocations("/git");
  const movedLocations = snapshotLocations("/moved-git");
  const io: CoherentSnapshotIo = {
    async captureRoutingConfig() {
      return structuredClone(BASE_SOURCES.config);
    },
    async resolveLocations() {
      resolves += 1;
      return structuredClone(resolves === 1 ? gitLocations : movedLocations);
    },
    async readVersionVector() {
      return structuredClone(BASE_VECTOR);
    },
    async captureSources(locations) {
      sourceReads += 1;
      assert.equal(
        locations.packet.path,
        sourceReads === 1 ? gitLocations.packet.path : movedLocations.packet.path,
      );
      return structuredClone(BASE_SOURCES);
    },
  };

  const result = await loadCoherentSessionSnapshot({ requestedCwd: "/worktree", io });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.attempts, 2);
  assert.equal(resolves, 4, "locations are resolved independently for A and B on every attempt");
  assert.equal(sourceReads, 2, "source capture stays bound to the A locations");
});

test("a new private-store conflict at vector B fails closed", async () => {
  let resolves = 0;
  const locations = snapshotLocations("/git");
  const io: CoherentSnapshotIo = {
    async captureRoutingConfig() {
      return structuredClone(BASE_SOURCES.config);
    },
    async resolveLocations() {
      resolves += 1;
      if (resolves === 2) {
        throw new Error(
          "Conflicting last-run packet state exists in both Git-private and worktree storage.",
        );
      }
      return structuredClone(locations);
    },
    async readVersionVector() {
      return structuredClone(BASE_VECTOR);
    },
    async captureSources() {
      return structuredClone(BASE_SOURCES);
    },
  };

  const result = await loadCoherentSessionSnapshot({ requestedCwd: "/worktree", io });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.attempts, 1);
  assert.equal(result.diagnostic.code, "coherent-snapshot-source-invalid");
  assert.match(result.diagnostic.message, /conflicting last-run packet state/i);
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

test("coherent snapshot never carries accepted authority across a segment boundary", async () => {
  const records = [
    { type: "config", name: "old", metricName: "seconds" },
    {
      type: "experiment-contract-accepted",
      segment: 0,
      eventId: "old-epoch",
      contract: {
        contractDigest: "old-contract",
        evaluator: { id: "old-evaluator", execution: { executionDigest: "old-execution" } },
        checks: [{ id: "old-check", execution: { executionDigest: "old-check-execution" } }],
      },
    },
    { run: 1, segment: 0, status: "discard" },
    { run: 2, segment: 0, status: "discard" },
    { type: "config", name: "new", metricName: "seconds" },
  ];
  const sources = {
    ...BASE_SOURCES,
    ledger: Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`),
  };
  const result = await loadCoherentSessionSnapshot({
    requestedCwd: "/worktree",
    io: sequenceIo([BASE_VECTOR, BASE_VECTOR], [sources]),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.snapshot.semanticFacts.contractDigest, "");
  assert.equal(result.snapshot.semanticFacts.evaluatorIdentity, "");
  assert.deepEqual(result.snapshot.semanticFacts.acceptedCheckIdentities, []);
  assert.equal(result.snapshot.semanticFacts.preconditionEpoch, "");
});

test("derived fact collection runs inside each A/load/B attempt and retains the accepted attempt", async () => {
  const changed = structuredClone(BASE_VECTOR);
  changed.config.hash = "config-b";
  const first = { ...BASE_SOURCES, config: Buffer.from('{"name":"raced"}\n') };
  const accepted = { ...BASE_SOURCES, config: Buffer.from('{"name":"accepted"}\n') };
  const io = sequenceIo(
    [BASE_VECTOR, changed, changed, changed],
    [first, accepted],
    [first.config, accepted.config],
  );
  const inspectedNames: string[] = [];

  const result = await loadCoherentSessionSnapshot({
    requestedCwd: "/worktree",
    io,
    inspectCapturedSnapshot: async (snapshot) => {
      inspectedNames.push(String(snapshot.config.name || ""));
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(inspectedNames, ["raced", "accepted"]);
  if (result.ok) assert.equal(result.snapshot.config.name, "accepted");
});

test("derived fact stability is verified without entering the raw generation vector", async () => {
  const io = sequenceIo([BASE_VECTOR, BASE_VECTOR], [BASE_SOURCES]);
  let inspections = 0;

  const result = await loadCoherentSessionSnapshot({
    requestedCwd: "/worktree",
    io,
    inspectCapturedSnapshot: async () => {
      inspections += 1;
      return "stable-derived-fact-version";
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(inspections, 2, "derived facts are checked on both sides of the accepted attempt");
  assert.equal(result.snapshot.generationId, generationIdForVersionVector(BASE_VECTOR));
  assert.equal(Object.hasOwn(result.snapshot.vector, "decisionFacts"), false);
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
  assert.deepEqual(io.resolvedWorkDirs(), [
    "/session/wrong",
    "/session/wrong",
    "/session/right",
    "/session/right",
  ]);
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

test("Git version capture accepts only a proven unborn symbolic branch", async () => {
  const calls: string[] = [];
  const resultFor = (code: number, stdout = "", stderr = ""): ProcessRunResult => ({
    code,
    signal: null,
    stdout,
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 1,
  });
  const result = await captureGitVersion("/worktree", {
    insideGitRepo: async () => true,
    runGit: async (args) => {
      calls.push(args.join(" "));
      if (args[0] === "rev-parse") return resultFor(128, "", "fatal: Needed a single revision");
      if (args[0] === "symbolic-ref") return resultFor(0, "refs/heads/main\n");
      if (args[0] === "show-ref") return resultFor(1);
      if (args[0] === "write-tree") return resultFor(0, "tree\n");
      return resultFor(0);
    },
  });

  assert.equal(result.head, "unborn");
  assert.ok(calls.includes("symbolic-ref -q HEAD"));
  assert.ok(calls.includes("show-ref --verify --quiet refs/heads/main"));
});

test("Git HEAD integrity failures cannot be mislabeled as unborn", async () => {
  const resultFor = (code: number, stdout = "", stderr = ""): ProcessRunResult => ({
    code,
    signal: null,
    stdout,
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 1,
  });
  await assert.rejects(
    captureGitVersion("/worktree", {
      insideGitRepo: async () => true,
      runGit: async (args) => {
        if (args[0] === "rev-parse") return resultFor(128, "", "fatal: bad object HEAD");
        if (args[0] === "symbolic-ref") return resultFor(0, "refs/heads/main\n");
        if (args[0] === "show-ref") return resultFor(128, "", "fatal: bad ref");
        if (args[0] === "write-tree") return resultFor(0, "tree\n");
        return resultFor(0);
      },
    }),
    /Git HEAD could not be captured.*bad object HEAD/i,
  );
});

test("a missing non-branch symbolic ref is not an unborn branch", async () => {
  const resultFor = (code: number, stdout = "", stderr = ""): ProcessRunResult => ({
    code,
    signal: null,
    stdout,
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 1,
  });
  await assert.rejects(
    captureGitVersion("/worktree", {
      insideGitRepo: async () => true,
      runGit: async (args) => {
        if (args[0] === "rev-parse") return resultFor(128, "", "fatal: bad object HEAD");
        if (args[0] === "symbolic-ref") return resultFor(0, "refs/tags/missing\n");
        if (args[0] === "write-tree") return resultFor(0, "tree\n");
        return resultFor(0);
      },
    }),
    /Git HEAD could not be captured.*bad object HEAD/i,
  );
});

test("source capture failures return a typed coherent snapshot diagnostic", async () => {
  const base = sequenceIo([BASE_VECTOR], [BASE_SOURCES]);
  const io: CoherentSnapshotIo = {
    ...base,
    readVersionVector: async () => {
      throw new Error("Git HEAD could not be captured: fatal: bad object HEAD");
    },
  };

  const result = await loadCoherentSessionSnapshot({ requestedCwd: "/worktree", io });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.attempts, 1);
  assert.equal(result.diagnostic.code, "coherent-snapshot-source-invalid");
  assert.match(result.diagnostic.message, /bad object HEAD/);
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

function snapshotLocations(privateRoot: string) {
  return {
    ledgerPath: "/session/autoresearch.jsonl",
    configPath: "/session/autoresearch.config.json",
    packet: { path: `${privateRoot}/last-run.json`, storage: "git-private" as const },
    receipt: {
      path: `${privateRoot}/pending-log-transaction.json`,
      storage: "git-private" as const,
    },
    process: { path: `${privateRoot}/progress.json`, storage: "git-private" as const },
  };
}
