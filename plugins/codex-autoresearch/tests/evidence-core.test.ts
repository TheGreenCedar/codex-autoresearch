import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  appendJsonl,
  buildDecisionEnvelope,
  buildLastRunFreshnessSnapshot,
  createSessionReadCache,
  currentState,
  finiteMetric,
  lastRunPacketFreshness,
  loadSessionRecords,
  loadSessionState,
  normalizeScopedFileFingerprints,
  readJsonlTail,
  streamJsonl,
  statusHash,
} from "../lib/session-core.js";
import { buildCheapFinalizationPressure } from "../lib/session-read-model.js";
import {
  parseMetricLines,
  runProcess,
  runShell,
  terminateAfterTimeout,
  terminateProcessTree,
} from "../lib/runner.js";
import { buildLoopContractStatus } from "../lib/loop-governance.js";
import { isPublicCatalogAddress } from "../lib/recipes.js";
import {
  isMetricEligibleStatus,
  isPromotionalStatus,
  isRejectedRunStatus,
} from "../lib/run-status.js";
import {
  redactCommandDisplay,
  redactEvidenceObject,
  redactEvidenceText,
  redactPathDisplay,
} from "../lib/evidence-redaction.js";
import {
  DEFAULT_DECISION_THRESHOLDS,
  resolveDecisionThresholds,
} from "../lib/decision-thresholds.js";
import { analyzeExperimentEconomics } from "../lib/experiment-economics.js";
import {
  compactEvidenceSummaries,
  evidenceClaim,
  mergeEvidenceClaims,
  readEvidenceIndex,
  validateClaimReferences,
} from "../lib/evidence-index.js";
import { artifactEvidenceList, buildEvidenceRegistry } from "../lib/evidence-registry.js";
import {
  buildPartialResultEvidenceClaim,
  discoverPartialResultCandidates,
} from "../lib/partial-results.js";
import { buildResearchIntegrity } from "../lib/truth-signals.js";
import {
  commandClassFor,
  createProgressSnapshot,
  progressSnapshotFromRun,
  staleProgressReason,
} from "../lib/runner-progress.js";
import { assertSafeWriteTarget, checkedAtomicWriteFile } from "../lib/checked-write.js";
import {
  sessionMutationLockLocation,
  sessionRecoveryLockPath,
  withSessionMutationLock,
} from "../lib/session-mutation-lock.js";
import { clearFilesWithWarnings } from "../lib/commands/log.js";
import {
  assertInsideResearchRoot,
  resolveSafeResearchPath,
  validateResearchSlug,
} from "../lib/research-path-guard.js";
import { isPathInside } from "../lib/path-containment.js";
import { parseSessionForensics } from "../lib/session-forensics.js";
import { analyzeWorkflowFriction } from "../lib/workflow-friction.js";
import {
  benchmarkContractFixtureEntries,
  benchmarkOverfitFixtureEntries,
  fixtureJsonl,
  outputBudgetFixtureEntries,
  searchLatencyFixtureEntries,
} from "./helpers/session-forensics-fixtures.js";
import { quoteForShell, withTempDir as withNamedTempDir } from "./helpers/process.js";

const withTempDir = (name, fn) => withNamedTempDir("autoresearch-e1", name, fn);

test("runner parses early metrics from full output while retaining only bounded tails", async () => {
  await withTempDir("full-output-metric", async (dir) => {
    const script = path.join(dir, "noisy-metric.mjs");
    await writeFile(
      script,
      [
        "process.stdout.write('METRIC seconds=7\\n');",
        "process.stdout.write('noise-line\\n'.repeat(30000));",
      ].join("\n"),
    );

    const result = await runShell(
      `${quoteForShell(process.execPath)} ${quoteForShell(script)}`,
      dir,
      10,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputTruncated, true);
    assert.equal(result.parsedMetrics.seconds, 7);
    assert.equal(parseMetricLines(result.output).seconds, undefined);

    const processResult = await runProcess(process.execPath, [script], {
      cwd: dir,
      timeoutSeconds: 10,
    });
    assert.equal(processResult.exitCode, 0);
    assert.equal(processResult.outputTruncated, true);
    assert.equal(processResult.parsedMetrics.seconds, 7);
    assert.equal(parseMetricLines(processResult.combinedOutput).seconds, undefined);
  });
});

test("runner minimal env mode keeps explicit env without inheriting unrelated parent keys", async () => {
  await withTempDir("minimal-env-mode", async (dir) => {
    const parentKey = `AR_PARENT_SECRET_${Date.now()}`;
    process.env[parentKey] = "should-not-leak";
    try {
      const script = [
        `console.log("PARENT=" + (process.env[${JSON.stringify(parentKey)}] || ""));`,
        'console.log("EXPLICIT=" + (process.env.AR_EXPLICIT_PACKET || ""));',
        'console.log("METRIC seconds=1");',
      ].join("");
      const result = await runShell(
        `${quoteForShell(process.execPath)} -e ${quoteForShell(script)}`,
        dir,
        5,
        {
          envMode: "minimal",
          env: { AR_EXPLICIT_PACKET: "visible" },
        },
      );

      assert.equal(result.exitCode, 0);
      assert.match(result.output, /PARENT=\s/);
      assert.match(result.output, /EXPLICIT=visible/);
      assert.equal(result.parsedMetrics.seconds, 1);
    } finally {
      delete process.env[parentKey];
    }
  });
});

test("runner proves a stubborn child and grandchild are gone before timeout resolves", async () => {
  await withTempDir("stubborn-process-tree", async (dir) => {
    const fixture = path.join(process.cwd(), "tests", "fixtures", "stubborn-process-tree.mjs");
    const marker = path.join(dir, "heartbeat.txt");
    const command = `${quoteForShell(process.execPath)} ${quoteForShell(fixture)} root ${quoteForShell(marker)}`;
    let result: Awaited<ReturnType<typeof runShell>> | null = null;
    let fixturePids: number[] = [];
    try {
      result = await runShell(command, dir, 1);
      fixturePids = processTreeFixturePids(result.fullOutput);

      assert.equal(result.timedOut, true);
      assert.equal(result.terminationFailed, false, JSON.stringify(result.termination));
      assert.equal(result.termination?.proven, true);
      assert.equal(result.termination?.escalated, true);
      assert.match(result.output, /partial-output-before-timeout/);
      assert.match(result.fullOutput, /ARTIFACT heartbeat=/);
      assert.equal(fixturePids.length, 3, result.fullOutput);
      for (const pid of fixturePids) assert.equal(processIsAlive(pid), false, `PID ${pid}`);
      for (const pid of fixturePids) {
        assert.equal(result.termination?.trackedPids.includes(pid), true, `untracked PID ${pid}`);
      }

      const before = await readFile(marker, "utf8");
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(await readFile(marker, "utf8"), before);
    } finally {
      await forceCleanupPids(
        result?.termination?.pid ?? null,
        [
          ...fixturePids,
          ...(result?.termination?.trackedPids || []),
          ...(result?.termination?.remainingPids || []),
        ],
        true,
      );
    }
  });
});

test("a non-resolving terminator is bounded and remains an explicit loop-contract blocker", async () => {
  let result: Awaited<ReturnType<typeof runProcess>> | null = null;
  try {
    result = await runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: process.cwd(),
      timeoutSeconds: 1,
      terminationTimeoutMs: 50,
      terminateProcessTree: async () => await new Promise(() => {}),
    });

    assert.equal(result.terminationFailed, true);
    assert.equal(result.termination?.reason, "termination_handler_timeout");
    const progress = progressSnapshotFromRun({ run: result });
    assert.equal(progress.exitState, "termination_failed");
    const contract = buildLoopContractStatus({ experimentEconomics: { progress } });
    assert.equal(contract.canRunNextPacket, false);
    assert.equal(contract.blockers[0]?.kind, "termination-failed");
    assert.match(contract.blockers[0]?.reason || "", new RegExp(String(result.termination?.pid)));
  } finally {
    await forceCleanupPids(
      result?.termination?.pid ?? null,
      result?.termination?.trackedPids || [],
    );
  }
});

test("termination wrapper rejects an invalid hook result", async () => {
  const result = await terminateAfterTimeout(4242, async () => null as never, 50);
  assert.equal(result.proven, false);
  assert.equal(result.reason, "termination_handler_invalid");
  assert.deepEqual(result.remainingPids, [4242]);
});

test("remote catalog address validation accepts only globally routable IPs", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "::1",
    "::ffff:7f00:1",
    "2001:db8::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
  ]) {
    assert.equal(isPublicCatalogAddress(address), false, address);
  }
  assert.equal(isPublicCatalogAddress("8.8.8.8"), true);
  assert.equal(isPublicCatalogAddress("2606:4700:4700::1111"), true);
});

test("progress command classes never persist executable paths or arguments", () => {
  assert.equal(
    commandClassFor("C:\\Users\\secret\\node.exe C:\\private\\bench.mjs --token raw"),
    "node script",
  );
  assert.equal(commandClassFor("TOKEN=raw npm run private-task -- --secret raw"), "npm run");
});

test("checked writes allow canonicalized ancestors but reject linked parents inside the root", async (t) => {
  await withTempDir("checked-write-linked-root", async (dir) => {
    const outside = path.join(dir, "outside");
    const link = path.join(dir, "linked");
    await mkdir(path.join(outside, "session"), { recursive: true });
    try {
      await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      t.skip(`directory links are unavailable: ${String(error)}`);
      return;
    }
    const aliasedRoot = path.join(link, "session");
    const configPath = path.join(aliasedRoot, "autoresearch.config.json");
    const boundTarget = await assertSafeWriteTarget(aliasedRoot, configPath);
    assert.equal(isPathInside(await realpath(aliasedRoot), boundTarget), true);
    await checkedAtomicWriteFile(aliasedRoot, configPath, "{}\n");
    assert.equal(await readFile(configPath, "utf8"), "{}\n");
    const canonicalLock = path.join(await realpath(aliasedRoot), ".autoresearch-mutation.lock");
    await withSessionMutationLock(aliasedRoot, "canonical-lock", async () => {
      await access(canonicalLock);
    });
    await assert.rejects(access(canonicalLock));
    await writeFile(
      canonicalLock,
      `${JSON.stringify({ pid: 2_147_483_647, command: "stale", timestamp: new Date(0).toISOString(), token: "dead" })}\n`,
    );
    let recoveredCanonicalLock = false;
    await withSessionMutationLock(aliasedRoot, "recover-canonical-lock", async () => {
      recoveredCanonicalLock = true;
    });
    assert.equal(recoveredCanonicalLock, true);
    await assert.rejects(access(canonicalLock));

    const escaped = path.join(dir, "escaped");
    const linkedParent = path.join(aliasedRoot, "linked-parent");
    await mkdir(escaped, { recursive: true });
    await symlink(escaped, linkedParent, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      checkedAtomicWriteFile(
        aliasedRoot,
        path.join(linkedParent, "autoresearch.config.json"),
        '{"unsafe":true}\n',
      ),
      /symlink, junction, or file/,
    );
  });
});

test("checked atomic writes remove temporary files after write failure", async () => {
  await withTempDir("checked-write-failure-cleanup", async (dir) => {
    const bytes = new Uint8Array(8);
    structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
    await assert.rejects(
      checkedAtomicWriteFile(dir, path.join(dir, "autoresearch.config.json"), bytes),
    );
    assert.deepEqual(
      (await readdir(dir)).filter((entry) => entry.endsWith(".tmp")),
      [],
    );
  });
});

test("session mutation locks block live owners and reclaim dead owners", async () => {
  await withTempDir("session-mutation-lock", async (dir) => {
    const lockPath = path.join(dir, ".autoresearch-mutation.lock");
    const beforeGit = await sessionMutationLockLocation(dir);
    if (typeof process.getuid === "function") {
      assert.match(path.basename(beforeGit.root), new RegExp(`uid-${process.getuid()}$`));
      const rootStat = await stat(beforeGit.root);
      assert.equal(rootStat.uid, process.getuid());
      assert.equal(rootStat.mode & 0o077, 0);
    } else {
      assert.match(path.basename(beforeGit.root), /user-[a-f0-9]{16}$/);
    }
    await mkdir(path.join(dir, ".git"));
    const afterGit = await sessionMutationLockLocation(dir);
    assert.equal(afterGit.path, beforeGit.path, "git init must not move the lock");
    assert.equal(isPathInside(dir, beforeGit.path), false, "locks must stay outside the worktree");
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: 2_147_483_647, command: "stale", timestamp: new Date(0).toISOString(), token: "dead" })}\n`,
    );
    let recovered = false;
    await withSessionMutationLock(dir, "recover", async () => {
      recovered = true;
    });
    assert.equal(recovered, true);
    await assert.rejects(access(lockPath));

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withSessionMutationLock(dir, "first", async () => await gate);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(
      withSessionMutationLock(dir, "second", async () => {}),
      /already running/,
    );
    release();
    await first;
  });
});

test("parallel dead-owner recovery admits exactly one session mutation", async () => {
  await withTempDir("session-mutation-lock-race", async (dir) => {
    const lockPath = path.join(dir, ".autoresearch-mutation.lock");
    const recoveryPath = sessionRecoveryLockPath(lockPath, "dead");
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: 2_147_483_647, command: "stale", timestamp: new Date(0).toISOString(), token: "dead" })}\n`,
    );
    await writeFile(
      recoveryPath,
      `${JSON.stringify({ pid: 2_147_483_647, command: "stale-recovery", timestamp: new Date(0).toISOString(), token: "dead-recovery" })}\n`,
    );
    let actions = 0;
    const contenders = await Promise.allSettled(
      ["first", "second"].map((command) =>
        withSessionMutationLock(dir, command, async () => {
          actions += 1;
          await new Promise((resolve) => setTimeout(resolve, 30));
        }),
      ),
    );
    assert.equal(actions, 1);
    assert.equal(contenders.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(contenders.filter((result) => result.status === "rejected").length, 1);
    await assert.rejects(access(lockPath));
    await assert.rejects(access(recoveryPath));
  });
});

test("last-run cleanup keeps non-missing failures as structured warnings", async () => {
  const warnings = await clearFilesWithWarnings(
    ["C:\\private\\autoresearch\\last-run.json"],
    async () => {
      const error = new Error("EACCES C:\\private\\autoresearch\\last-run.json");
      (error as Error & { code: string }).code = "EACCES";
      throw error;
    },
    { workDir: "C:\\private" },
  );
  assert.equal(warnings[0].code, "last_run_cleanup_failed");
  assert.doesNotMatch(warnings[0].message, /C:\\private/i);
});

test("metricless crash and checks_failed entries remain metricless in current state", async () => {
  await withTempDir("metricless-failures", async (dir) => {
    appendJsonl(dir, { type: "config", name: "evidence", metricName: "seconds" });
    appendJsonl(dir, { run: 1, status: "crash", description: "Command failed before metric." });
    appendJsonl(dir, {
      run: 2,
      metric: null,
      status: "checks_failed",
      description: "Checks failed without a metric.",
    });

    const state = currentState(dir);
    assert.equal(Object.hasOwn(state.current[0], "metric"), false);
    assert.equal(state.current[1].metric, null);
    assert.equal(state.baseline, null);
    assert.equal(state.best, null);
    assert.equal(state.confidence, null);
  });
});

test("core metric helpers do not coerce invalid values to numeric zero", async () => {
  assert.equal(finiteMetric(0), 0);
  assert.equal(finiteMetric("0"), 0);
  assert.equal(finiteMetric(" 0 "), 0);
  assert.equal(finiteMetric("-1.5e+2"), -150);
  assert.equal(finiteMetric(null), null);
  assert.equal(finiteMetric(undefined), null);
  assert.equal(finiteMetric(""), null);
  assert.equal(finiteMetric("   "), null);
  assert.equal(finiteMetric(false), null);
  assert.equal(finiteMetric([]), null);
  assert.equal(finiteMetric({ value: 0 }), null);
  assert.equal(finiteMetric("Infinity"), null);
  assert.equal(finiteMetric("not-a-number"), null);

  await withTempDir("invalid-metrics", async (dir) => {
    appendJsonl(dir, { type: "config", name: "evidence", metricName: "seconds" });
    appendJsonl(dir, { run: 1, metric: false, status: "keep", description: "Invalid boolean." });
    appendJsonl(dir, {
      run: 2,
      metric: "not-a-number",
      status: "discard",
      description: "Invalid string.",
    });
    appendJsonl(dir, { run: 3, metric: "0", status: "keep", description: "Real zero metric." });

    const state = currentState(dir);
    assert.equal(state.current[0].metric, null);
    assert.equal(state.current[1].metric, null);
    assert.equal(state.current[2].metric, 0);
    assert.equal(state.baseline, 0);
    assert.equal(state.best, 0);
  });
});

test("session JSONL helpers can stream and return bounded tails", async () => {
  await withTempDir("jsonl-tail", async (dir) => {
    appendJsonl(dir, { type: "config", name: "evidence", metricName: "seconds" });
    appendJsonl(dir, { run: 1, metric: 3, status: "keep", description: "Baseline." });
    appendJsonl(dir, { run: 2, metric: 2, status: "discard", description: "Probe." });

    const streamed = [];
    for await (const entry of streamJsonl(dir)) streamed.push(entry);
    assert.equal(streamed.length, 3);
    assert.equal(streamed[0].type, "config");

    const tail = await readJsonlTail(dir, 2);
    assert.deepEqual(
      tail.map((entry) => entry.run),
      [1, 2],
    );
  });
});

test("session read cache reuses parsed records and derives state from them", async () => {
  await withTempDir("session-read-cache", async (dir) => {
    appendJsonl(dir, { type: "config", name: "cached", metricName: "seconds" });
    appendJsonl(dir, { run: 1, metric: 3, status: "measure", description: "Baseline." });

    const cache = createSessionReadCache();
    const records = loadSessionRecords(dir, cache);
    const state = loadSessionState(dir, cache);
    appendJsonl(dir, { run: 2, metric: 2, status: "keep", description: "Later run." });

    assert.equal(loadSessionRecords(dir, cache), records);
    assert.equal(loadSessionState(dir, cache), state);
    assert.equal(state.results.length, 1);
    assert.equal(currentState(dir).results.length, 2);
  });
});

test("stamp-aware session read cache refreshes when the ledger changes", async () => {
  await withTempDir("session-read-cache-refresh", async (dir) => {
    appendJsonl(dir, { type: "config", name: "cached", metricName: "seconds" });
    appendJsonl(dir, { run: 1, metric: 3, status: "measure", description: "Baseline." });

    const cache = createSessionReadCache({ invalidateOnLedgerChange: true });
    const records = loadSessionRecords(dir, cache);
    const state = loadSessionState(dir, cache);
    appendJsonl(dir, { run: 2, metric: 2, status: "keep", description: "Later run." });

    const refreshedRecords = loadSessionRecords(dir, cache);
    const refreshedState = loadSessionState(dir, cache);
    assert.notEqual(refreshedRecords, records);
    assert.notEqual(refreshedState, state);
    assert.equal(refreshedRecords.length, 3);
    assert.equal(refreshedState.results.length, 2);
  });
});

test("stamp-aware session read cache refreshes state before records after ledger changes", async () => {
  await withTempDir("session-read-cache-state-first", async (dir) => {
    appendJsonl(dir, { type: "config", name: "cached", metricName: "seconds" });
    appendJsonl(dir, { run: 1, metric: 3, status: "measure", description: "Baseline." });

    const cache = createSessionReadCache({ invalidateOnLedgerChange: true });
    const state = loadSessionState(dir, cache);
    const records = loadSessionRecords(dir, cache);
    appendJsonl(dir, { run: 2, metric: 2, status: "keep", description: "Later run." });

    const refreshedState = loadSessionState(dir, cache);
    const refreshedRecords = loadSessionRecords(dir, cache);
    assert.notEqual(refreshedState, state);
    assert.notEqual(refreshedRecords, records);
    assert.equal(refreshedState.results.length, 2);
    assert.equal(refreshedRecords.length, 3);
  });
});

test("core last-run freshness can validate command, git, and scoped file context", async () => {
  await withTempDir("last-run-freshness", async (dir) => {
    appendJsonl(dir, { type: "config", name: "evidence", metricName: "seconds" });
    const context = {
      command: "npm test -- --runInBand",
      cwd: dir,
      workingDir: dir,
      gitHead: "abc1234",
      dirtyStatusHash: statusHash(" M src/example.js\n"),
      scopedFileFingerprints: {
        "src\\b.js": "sha-b",
        "src/a.js": "sha-a",
      },
    };
    const packet = {
      history: buildLastRunFreshnessSnapshot(dir, context),
    };

    assert.deepEqual(packet.history.scopedFileFingerprints, {
      "src/a.js": "sha-a",
      "src/b.js": "sha-b",
    });
    assert.deepEqual(normalizeScopedFileFingerprints({ "z\\file.js": 123 }), {
      "z/file.js": "123",
    });

    const fresh = lastRunPacketFreshness(dir, packet, context);
    assert.equal(fresh.fresh, true);
    assert.equal(fresh.expectedNextRun, 1);

    const commandChanged = lastRunPacketFreshness(dir, packet, {
      ...context,
      command: "npm run check",
    });
    assert.equal(commandChanged.fresh, false);
    assert.match(commandChanged.reason, /command changed/);

    appendJsonl(dir, { run: 1, metric: 0, status: "keep", description: "Baseline." });
    const historyAdvanced = lastRunPacketFreshness(dir, packet, context);
    assert.equal(historyAdvanced.fresh, false);
    assert.match(historyAdvanced.reason, /expected next log run #1/);
  });
});

test("evidence redactor hides secrets, credentials, home paths, and env files", () => {
  const text = [
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    "api_key=sk-test-1234567890abcdef",
    "family key api key abcdefghijklmnop",
    "node scripts/private-check.mjs --api-key flagsecretvalue123",
    'node scripts/private-check.mjs --client-secret "flag secret value 456"',
    "node scripts/private-check.mjs --api-key=flag:secret:value789",
    "node scripts/private-check.mjs --tokenize publicidentifier123",
    "https://user:pass@example.test/path",
    "C:\\Users\\albert\\project\\.env.local",
    "/home/albert/project/.env",
    "--packet-env-file=.env.production",
    `/${"!/".repeat(200)}not-env`,
    "/Users/albert/project/file.txt",
  ].join("\n");
  const redacted = redactCommandDisplay(text);
  assert.doesNotMatch(redacted, /abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(redacted, /abcdefghijklmnop/);
  assert.doesNotMatch(redacted, /flagsecretvalue123/);
  assert.doesNotMatch(redacted, /flag secret value 456/);
  assert.doesNotMatch(redacted, /flag:secret:value789/);
  assert.doesNotMatch(redacted, /sk-test/);
  assert.doesNotMatch(redacted, /user:pass/);
  assert.doesNotMatch(redacted, /albert/);
  assert.doesNotMatch(redacted, /\.env\.production/);
  assert.match(redacted, /--api-key <redacted>/);
  assert.match(redacted, /--client-secret <redacted>/);
  assert.match(redacted, /--api-key=<redacted>/);
  assert.match(redacted, /--tokenize publicidentifier123/);
  assert.match(redacted, /<redacted>|<credentials>|<env-file>|<user>/);

  const object = redactEvidenceObject({
    command: text,
    nested: {
      token: "123456789abcdef",
      accessToken: "zyxwvutsrqponmlkjihg",
      client_secret: "sk-test-structured-secret",
      tokenCount: 123456789,
    },
  });
  assert.doesNotMatch(JSON.stringify(object), /123456789abcdef/);
  assert.doesNotMatch(JSON.stringify(object), /zyxwvutsrqponmlkjihg/);
  assert.doesNotMatch(JSON.stringify(object), /sk-test-structured-secret/);
  assert.equal(object.nested.token, "<redacted>");
  assert.equal(object.nested.accessToken, "<redacted>");
  assert.equal(object.nested.client_secret, "<redacted>");
  assert.equal(object.nested.tokenCount, 123456789);
  assert.equal(redactPathDisplay("out/report.json", "/tmp/project"), "out/report.json");
  assert.equal(
    redactPathDisplay("/tmp/elsewhere/report.json", "/tmp/project"),
    "<outside-workdir>",
  );
});

test("evidence redactor removes stack frames before dashboard or packet storage", () => {
  const stack = [
    "Error: failed while loading token=abcdefghijklmnop",
    "    at loadSecret (C:\\Users\\Alice\\repo\\src\\secret.ts:12:34)",
    "    at file:///home/alice/repo/src/index.mjs:5:1",
    '  File "/Users/alice/repo/secret.py", line 9, in main',
  ].join("\n");

  const redacted = redactEvidenceText(stack, { workDir: "C:\\Users\\Alice\\repo" });
  assert.match(redacted, /Error: failed while loading token=<redacted>/);
  assert.equal((redacted.match(/<stack-frame>/g) || []).length, 3);
  assert.doesNotMatch(redacted, /abcdefghijklmnop/);
  assert.doesNotMatch(redacted, /Alice|alice/);
  assert.doesNotMatch(redacted, /secret\.ts|index\.mjs|secret\.py/);
});

test("decision thresholds use conservative defaults with safe overrides", () => {
  assert.equal(DEFAULT_DECISION_THRESHOLDS.compactions, 3);
  assert.equal(DEFAULT_DECISION_THRESHOLDS.outputCommandTokenBudget, 20_000);
  const resolved = resolveDecisionThresholds({
    decisionThresholds: {
      compactions: 5,
      outputCommandTokenBudget: 10_000,
      repeatedCommandHeadCount: -1,
    },
  });
  assert.equal(resolved.compactions, 5);
  assert.equal(resolved.outputCommandTokenBudget, 10_000);
  assert.equal(
    resolved.repeatedCommandHeadCount,
    DEFAULT_DECISION_THRESHOLDS.repeatedCommandHeadCount,
  );
});

test("research path guard rejects unsafe slugs and out-of-root paths", async () => {
  await withTempDir("research-path-guard", async (dir) => {
    assert.equal(validateResearchSlug("session-019e"), "session-019e");
    for (const slug of ["../x", "x/y", "x\\y", "CON", ".hidden", ""]) {
      assert.throws(() => validateResearchSlug(slug));
    }

    const safe = await resolveSafeResearchPath(dir, "session-019e");
    assert.equal(path.basename(safe.outputDir), "session-019e");
    await assertInsideResearchRoot(safe.root, path.join(safe.outputDir, "session-digest.md"));
    await assert.rejects(
      () => assertInsideResearchRoot(safe.root, path.join(dir, "outside.md")),
      /escapes/,
    );
  });
});

test("path containment treats dot-prefixed child names as inside", async () => {
  await withTempDir("path-containment", async (dir) => {
    assert.equal(isPathInside(dir, path.join(dir, "..artifact", "evidence.json")), true);
    assert.equal(isPathInside(dir, path.join(dir, "..", "outside.json")), false);
  });
});

test("evidence index uses deterministic ids, merges claims, and validates references", async () => {
  await withTempDir("evidence-index", async (dir) => {
    const claim = evidenceClaim({
      claim: "Session import observed repeated polling.",
      source: "rollout.jsonl",
      evidenceType: "session",
      freshness: "current",
      confidence: "medium",
      promotionRelevance: "diagnostic",
    });
    const index = await mergeEvidenceClaims(dir, "session-019e", [claim]);
    assert.equal(index.schemaVersion, 1);
    assert.equal(index.claims.length, 1);
    assert.equal(index.claims[0].id, claim.id);

    const reread = await readEvidenceIndex(dir, "session-019e");
    assert.deepEqual(reread, index);
    assert.deepEqual(validateClaimReferences(`[evidence:${claim.id}]`, index), []);
    assert.deepEqual(validateClaimReferences("[evidence:ev-aaaaaaaaaaaa]", index), [
      "ev-aaaaaaaaaaaa",
    ]);
    assert.deepEqual(compactEvidenceSummaries(index), [
      {
        id: claim.id,
        claim: claim.claim,
        evidenceType: "session",
        confidence: "medium",
        promotionRelevance: "diagnostic",
      },
    ]);
  });
});

test("evidence registry keeps rejected and provisional runs out of accepted current evidence", async () => {
  await withTempDir("evidence-registry-runs", async (dir) => {
    appendJsonl(dir, { type: "config", name: "registry", metricName: "score" });
    appendJsonl(dir, {
      run: 1,
      metric: 10,
      status: "keep",
      evidenceStatus: "rejected",
      description: "Rejected keep must remain audit only.",
    });
    appendJsonl(dir, {
      run: 2,
      metric: 8,
      status: "measure",
      description: "Provisional diagnostic measurement.",
    });
    appendJsonl(dir, {
      run: 3,
      metric: 6,
      status: "keep",
      evidenceStatus: "accepted",
      description: "Accepted current result.",
    });
    appendJsonl(dir, {
      run: 4,
      metric: 1,
      status: "keep",
      evidenceStatus: "superseded",
      description: "Superseded keep must remain audit only.",
    });

    const state = currentState(dir);
    assert.equal(state.best, 6);
    assert.equal(state.development.best, 6);
    assert.equal(state.evidenceRegistry.counts.accepted, 1);
    assert.equal(state.evidenceRegistry.counts.provisional, 1);
    assert.equal(state.evidenceRegistry.counts.rejected, 1);
    assert.equal(state.evidenceRegistry.counts.superseded, 1);
    assert.deepEqual(
      state.evidenceRegistry.currentRuns.map((run) => run.run),
      [3],
    );
    assert.deepEqual(
      state.evidenceRegistry.acceptedCurrent.map((entry) => entry.id),
      ["run-3"],
    );
    assert.deepEqual(
      state.evidenceRegistry.audit.map((entry) => entry.id),
      ["run-1", "run-2", "run-3", "run-4"],
    );
  });
});

test("review-required kept evidence stays provisional until ASI acknowledgement", () => {
  const run = {
    run: 1,
    metric: 0,
    status: "keep",
    description: "Review-gated packet.",
    metrics: { quality_gap: 0, review_required: 1 },
  };
  const registry = buildEvidenceRegistry({ runs: [run] });
  const signals = analyzeWorkflowFriction({
    state: {
      current: [run],
      results: [run],
    },
  });
  const signal = signals.find((item) => item.kind === "review_required_packet");

  assert.equal(signal?.severity, "warning");
  assert.match(signal?.reason || "", /review_required=1/);
  assert.match(signal?.suggestedAction.reason || "", /ASI acknowledgement/i);
  assert.equal(registry.entries[0].evidenceStatus, "provisional");
  assert.equal(registry.entries[0].current, false);
  assert.equal(registry.currentRuns.length, 0);
});

test("review-required no-issue string metrics stay accepted without workflow warning", () => {
  const run = {
    run: 1,
    metric: 0,
    status: "keep",
    evidenceStatus: "accepted",
    description: "Clean packet.",
    metrics: { quality_gap: 0, overfit_signal: "passed" },
  };
  const registry = buildEvidenceRegistry({ runs: [run] });
  const signals = analyzeWorkflowFriction({
    state: {
      current: [run],
      results: [run],
    },
  });

  assert.equal(registry.entries[0].evidenceStatus, "accepted");
  assert.equal(registry.entries[0].current, true);
  assert.equal(
    signals.some((item) => item.kind === "review_required_packet"),
    false,
  );
});

test("review-required positive string metrics stay provisional with workflow warning", () => {
  const run = {
    run: 1,
    metric: 0,
    status: "keep",
    evidenceStatus: "accepted",
    description: "Detected review signal.",
    metrics: { quality_gap: 0, overfit_signal: "detected" },
  };
  const registry = buildEvidenceRegistry({ runs: [run] });
  const signals = analyzeWorkflowFriction({
    state: {
      current: [run],
      results: [run],
    },
  });
  const signal = signals.find((item) => item.kind === "review_required_packet");

  assert.equal(registry.entries[0].evidenceStatus, "provisional");
  assert.equal(registry.entries[0].current, false);
  assert.equal(signal?.severity, "warning");
  assert.match(signal?.reason || "", /overfit_signal=detected/);
});

test("review-required provisional evidence is not accepted read-model finalization proof", () => {
  const pressure = buildCheapFinalizationPressure({
    state: {
      productClaimCoverage: { productGradeReady: true },
      current: [
        {
          run: 1,
          metric: 0,
          status: "keep",
          metrics: { quality_gap: 0, review_required: 1 },
        },
      ],
    },
  });

  assert.equal(pressure.ready, false);
  assert.match(pressure.nextAction, /Git-backed autoresearch branch/i);
});

test("review-required acknowledged kept evidence remains accepted and current", () => {
  const registry = buildEvidenceRegistry({
    runs: [
      {
        run: 1,
        metric: 0,
        status: "keep",
        description: "Human-reviewed packet.",
        metrics: { quality_gap: 0, review_required: 1 },
        asi: { review_acknowledged: true },
      },
    ],
  });

  assert.equal(registry.entries[0].evidenceStatus, "accepted");
  assert.equal(registry.entries[0].current, true);
  assert.deepEqual(
    registry.currentRuns.map((run) => run.run),
    [1],
  );
});

test("run status taxonomy separates rejected evidence from metric-eligible records", () => {
  assert.equal(isRejectedRunStatus("discard"), true);
  assert.equal(isMetricEligibleStatus("discard"), true);
  assert.equal(isPromotionalStatus("discard"), true);
  assert.equal(isRejectedRunStatus("measure"), false);
  assert.equal(isMetricEligibleStatus("measure"), false);
  assert.equal(isMetricEligibleStatus("crash"), false);
  assert.equal(isMetricEligibleStatus("checks_failed"), false);
  assert.equal(isRejectedRunStatus("keep"), false);
  assert.equal(isMetricEligibleStatus("keep"), true);
});

test("truth signals ignore rejected and superseded keeps as current best evidence", () => {
  const integrity = buildResearchIntegrity({
    state: {
      config: { metricName: "quality_gap", bestDirection: "lower" },
      current: [
        {
          run: 1,
          metric: 0,
          status: "keep",
          evidenceStatus: "rejected",
          description: "Rejected perfect-looking run.",
          metrics: { quality_gap: 0 },
        },
        {
          run: 2,
          metric: 0,
          status: "keep",
          evidenceStatus: "superseded",
          description: "Superseded perfect-looking run.",
          metrics: { quality_gap: 0 },
        },
      ],
      results: [
        {
          run: 1,
          metric: 0,
          status: "keep",
          evidenceStatus: "rejected",
          description: "Rejected perfect-looking run.",
          metrics: { quality_gap: 0 },
        },
        {
          run: 2,
          metric: 0,
          status: "keep",
          evidenceStatus: "superseded",
          description: "Superseded perfect-looking run.",
          metrics: { quality_gap: 0 },
        },
      ],
    },
  });

  assert.equal(integrity.evidenceLabels.includes("dev_best"), false);
  assert.equal(integrity.evidenceLabels.includes("promotion_eligible"), false);
  assert.doesNotMatch(integrity.warnings.join("\n"), /Current best is development-only/);

  const stalePrecomputed = buildResearchIntegrity({
    state: {
      config: { metricName: "quality_gap", bestDirection: "lower" },
      current: [],
      development: {
        bestRun: {
          run: 9,
          metric: 0,
          status: "keep",
          evidenceStatus: "superseded",
          description: "Stale precomputed best.",
          metrics: { quality_gap: 0 },
        },
      },
    },
  });

  assert.equal(stalePrecomputed.evidenceLabels.includes("dev_best"), false);
  assert.doesNotMatch(stalePrecomputed.warnings.join("\n"), /Current best is development-only/);
});

test("decision envelope omits rejected and superseded keeps from best evidence", () => {
  const envelope = buildDecisionEnvelope({
    state: {
      config: { bestDirection: "lower" },
      current: [
        {
          run: 1,
          metric: 1,
          status: "keep",
          evidenceStatus: "rejected",
          description: "Rejected perfect-looking run.",
          metrics: { promotionGrade: true },
        },
        {
          run: 2,
          metric: 2,
          status: "keep",
          evidenceStatus: "superseded",
          description: "Superseded run.",
          metrics: { promotionGrade: true },
        },
        {
          run: 3,
          metric: 3,
          status: "keep",
          description: "Legacy accepted keep.",
          metrics: { promotionGrade: true },
        },
      ],
      results: [
        {
          run: 1,
          metric: 1,
          status: "keep",
          evidenceStatus: "rejected",
          description: "Rejected perfect-looking run.",
          metrics: { promotionGrade: true },
        },
        {
          run: 2,
          metric: 2,
          status: "keep",
          evidenceStatus: "superseded",
          description: "Superseded run.",
          metrics: { promotionGrade: true },
        },
        {
          run: 3,
          metric: 3,
          status: "keep",
          description: "Legacy accepted keep.",
          metrics: { promotionGrade: true },
        },
      ],
    },
    nextAction: "Continue.",
  });

  assert.equal(envelope.historicalBest.run, 3);
  assert.equal(envelope.promotionGradeBest.run, 3);
});

test("evidence registry rejects quarantined artifacts and accepts current artifact evidence", async () => {
  await withTempDir("evidence-registry-artifacts", async (dir) => {
    await mkdir(path.join(dir, "out"), { recursive: true });
    await writeFile(path.join(dir, "out", "accepted.json"), "{}\n", "utf8");

    const accepted = artifactEvidenceList({ manifest: "out/accepted.json" }, dir, "accepted");
    const quarantined = artifactEvidenceList({ outside: "<outside-workdir>" }, dir, "accepted");
    const registry = buildEvidenceRegistry({
      runs: [
        {
          run: 1,
          status: "keep",
          evidenceStatus: "accepted",
          artifactEvidence: [...accepted, ...quarantined],
        },
      ],
    });

    assert.equal(registry.currentArtifacts.length, 1);
    assert.equal(registry.currentArtifacts[0].name, "manifest");
    assert.equal(registry.currentArtifacts[0].evidenceStatus, "accepted");
    assert.equal(registry.currentArtifacts[0].current, true);
    const outside = registry.audit.find((entry) => entry.name === "outside");
    assert.equal(outside?.evidenceStatus, "rejected");
    assert.equal(outside?.current, false);
    assert.equal(outside?.quarantined, true);
  });
});

test("evidence registry rejects artifacts that resolve outside the workdir through links", async (t) => {
  await withTempDir("evidence-registry-linked-artifacts", async (dir) => {
    const outsideDir = path.join(path.dirname(dir), `${path.basename(dir)}-outside`);
    await mkdir(outsideDir, { recursive: true });
    try {
      await writeFile(path.join(outsideDir, "accepted.json"), "{}\n", "utf8");
      const linkPath = path.join(dir, "linked-out");
      try {
        await symlink(outsideDir, linkPath, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        t.skip(
          `directory symlink creation unavailable: ${error instanceof Error ? error.message : error}`,
        );
        return;
      }

      const linked = artifactEvidenceList(
        { manifest: "linked-out/accepted.json" },
        dir,
        "accepted",
      );
      assert.equal(linked[0].quarantined, true);
      assert.equal(linked[0].exists, false);
      assert.equal(linked[0].evidenceStatus, "rejected");
      assert.equal(linked[0].path, "<outside-workdir>");

      const registry = buildEvidenceRegistry({
        runs: [
          {
            run: 1,
            status: "keep",
            evidenceStatus: "accepted",
            artifactEvidence: linked,
          },
        ],
      });

      assert.equal(registry.currentArtifacts.length, 0);
      assert.equal(registry.counts.rejected, 1);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

test("partial result salvager scores complete artifact rows as diagnostic candidates", async () => {
  await withTempDir("partial-result-scored", async (dir) => {
    await mkdir(path.join(dir, "out"), { recursive: true });
    await writeFile(
      path.join(dir, "out", "results.json"),
      JSON.stringify(
        {
          rows: [{ label: "candidate-a", seconds: 1.25, rawBody: "do-not-copy-this-body" }],
          schemaVersion: 1,
          metricName: "seconds",
          formulaVersion: "v1",
        },
        null,
        2,
      ),
      "utf8",
    );

    const discovery = await discoverPartialResultCandidates({
      workDir: dir,
      lastRunPacket: {
        packetEvidence: {
          commandIdentity: { commandHash: "hash-123" },
          artifacts: [
            {
              name: "results",
              path: "out/results.json",
              exists: true,
              quarantined: false,
            },
          ],
        },
      },
    });

    assert.equal(discovery.skippedArtifacts.length, 0);
    assert.equal(discovery.candidates.length, 1);
    assert.match(discovery.candidates[0].id, /^partial-[a-f0-9]{12}$/);
    assert.equal(discovery.candidates[0].artifactName, "results");
    assert.equal(discovery.candidates[0].artifactPath, "out/results.json");
    assert.equal(discovery.candidates[0].rowIndex, 0);
    assert.equal(discovery.candidates[0].status, "scored");
    assert.equal(discovery.candidates[0].metricName, "seconds");
    assert.equal(discovery.candidates[0].metricValue, 1.25);
    assert.equal(discovery.candidates[0].provenance.diagnosticOnly, true);
    assert.equal(JSON.stringify(discovery.candidates[0]).includes("do-not-copy-this-body"), false);

    const claim = buildPartialResultEvidenceClaim(discovery.candidates[0]);
    assert.equal(claim.evidenceType, "benchmark-artifact");
    assert.equal(claim.promotionRelevance, "diagnostic");
    assert.match(claim.source, /^out\/results\.json#row-0$/);
  });
});

test("partial result salvager sends incomplete rows to manual review", async () => {
  await withTempDir("partial-result-manual", async (dir) => {
    await mkdir(path.join(dir, "out"), { recursive: true });
    await writeFile(path.join(dir, "out", "array-results.json"), '[{"seconds":2.5}]\n', "utf8");
    await writeFile(
      path.join(dir, "out", "missing-metric.json"),
      JSON.stringify({
        rows: [{ label: "candidate-b" }],
        schemaVersion: 1,
        metricName: "seconds",
        formulaVersion: "v1",
      }),
      "utf8",
    );

    const discovery = await discoverPartialResultCandidates({
      workDir: dir,
      primaryMetricName: "seconds",
      lastRunPacket: {
        packetEvidence: {
          commandIdentity: { commandHash: "hash-123" },
          artifacts: [
            {
              name: "array-results",
              path: "out/array-results.json",
              exists: true,
              quarantined: false,
            },
            {
              name: "missing-metric",
              path: "out/missing-metric.json",
              exists: true,
              quarantined: false,
            },
          ],
        },
      },
    });

    assert.equal(discovery.candidates.length, 2);
    const byName = new Map(
      discovery.candidates.map((candidate) => [candidate.artifactName, candidate]),
    );
    const missingVersions = byName.get("array-results");
    const missingMetric = byName.get("missing-metric");

    assert.equal(missingVersions?.status, "manual_review");
    assert.equal(missingVersions?.metricValue, 2.5);
    assert.match(missingVersions?.reason || "", /schema version missing/);
    assert.match(missingVersions?.reason || "", /formula version missing/);

    assert.equal(missingMetric?.status, "manual_review");
    assert.equal(missingMetric?.metricValue, null);
    assert.match(missingMetric?.reason || "", /finite primary metric missing/);
  });
});

test("partial result salvager rejects path escapes and does not persist raw artifact bodies", async () => {
  await withTempDir("partial-result-path-escape", async (dir) => {
    const outsidePath = path.join(path.dirname(dir), `${path.basename(dir)}-outside-results.json`);
    await writeFile(
      outsidePath,
      JSON.stringify({
        rows: [{ seconds: 9, rawBody: "outside-raw-body-must-not-leak" }],
        schemaVersion: 1,
        metricName: "seconds",
        formulaVersion: "v1",
      }),
      "utf8",
    );
    try {
      const discovery = await discoverPartialResultCandidates({
        workDir: dir,
        lastRunPacket: {
          packetEvidence: {
            commandIdentity: { commandHash: "hash-123" },
            artifacts: [
              {
                name: "outside-results",
                path: outsidePath,
                exists: true,
                quarantined: false,
              },
            ],
          },
        },
      });

      assert.equal(discovery.candidates.length, 0);
      assert.equal(discovery.skippedArtifacts.length, 1);
      assert.equal(discovery.skippedArtifacts[0].artifactName, "outside-results");
      assert.equal(discovery.skippedArtifacts[0].artifactPath, "<outside-workdir>");
      assert.equal(discovery.skippedArtifacts[0].reason, "artifact_path_outside_workdir");
      assert.equal(JSON.stringify(discovery).includes("outside-raw-body-must-not-leak"), false);
    } finally {
      await rm(outsidePath, { force: true });
    }
  });
});

test("runner progress and experiment economics expose timeout and stale-progress costs", () => {
  const progress = progressSnapshotFromRun({
    packetId: "packet-1",
    run: {
      command: "npm test -- --runInBand",
      workDir: "project",
      startedAt: "2026-05-25T10:00:00.000Z",
      lastOutputAt: "2026-05-25T10:05:00.000Z",
      finishedAt: "2026-05-25T10:10:00.000Z",
      timeoutSeconds: 30,
      timedOut: true,
      exitCode: null,
    },
    artifacts: [{ name: "rows", path: "out/rows.json" }],
  });

  assert.equal(progress.packetId, "packet-1");
  assert.equal(progress.commandClass, "npm test");
  assert.equal(progress.timeoutPhase, "benchmark");
  assert.equal(progress.exitState, "timed_out");
  assert.equal(progress.latestArtifactRow, "rows=out/rows.json");

  const running = createProgressSnapshot({
    packetId: "packet-2",
    command: "node bench.mjs --timeout 120",
    startedAt: "2026-05-25T10:00:00.000Z",
    timeoutSeconds: 60,
  });
  assert.match(
    staleProgressReason(running, {
      now: "2026-05-25T10:10:00.000Z",
      staleAfterSeconds: 300,
    }),
    /No packet output/,
  );

  const economics = analyzeExperimentEconomics({
    state: {
      baseline: 10,
      config: { bestDirection: "lower" },
      current: [
        { run: 1, status: "discard", durationSeconds: 900 },
        { run: 2, status: "crash", durationSeconds: 950 },
        { run: 3, status: "checks_failed", durationSeconds: 925 },
        { run: 4, status: "discard", durationSeconds: 940 },
      ],
    },
    lastRun: {
      run: { durationSeconds: 900 },
      packetEvidence: {
        timeoutSeconds: 60,
        commandIdentity: { command: "node bench.mjs --timeout-seconds 120" },
      },
    },
    progress: {
      ...running,
      staleProgressReason: "No packet output or artifact progress for 600s.",
    },
  });

  const warningCodes = economics.warnings.map((warning) => warning.code);
  assert.equal(economics.runtimeClass, "long");
  assert.equal(warningCodes.includes("outer_timeout_shorter_than_inner"), true);
  assert.equal(warningCodes.includes("repeated_small_probe"), true);
  assert.equal(warningCodes.includes("stale_progress"), true);
  assert.equal(economics.freshRunRequired, true);

  assert.equal(
    buildDecisionEnvelope({
      state: { current: [] },
      experimentEconomics: economics,
    }).canonicalNextAction.kind,
    "benchmark-mismatch",
  );

  const smallProbeEconomics = analyzeExperimentEconomics({
    state: {
      baseline: 10,
      config: { bestDirection: "lower" },
      current: [
        { run: 1, status: "discard", durationSeconds: 900 },
        { run: 2, status: "crash", durationSeconds: 950 },
        { run: 3, status: "checks_failed", durationSeconds: 925 },
        { run: 4, status: "discard", durationSeconds: 940 },
      ],
    },
    lastRun: { run: { durationSeconds: 900 }, packetEvidence: { timeoutSeconds: 1200 } },
  });
  assert.equal(
    buildDecisionEnvelope({
      state: { current: [] },
      experimentEconomics: smallProbeEconomics,
    }).canonicalNextAction.kind,
    "workflow-friction",
  );
});

test("workflow friction uses forensics, churn, dirty tree, recipes, and quality_gap wording", () => {
  const signals = analyzeWorkflowFriction({
    state: {
      config: {
        metricName: "quality_gap",
        recipeId: "missing-recipe",
        commitPaths: ["src/a.ts"],
      },
      qualityGap: { open: 2 },
      current: [
        { run: 1, command: "npm test -- --runInBand" },
        { run: 2, command: "npm test -- --runInBand" },
        { run: 3, command: "npm test -- --runInBand" },
      ],
    },
    forensics: {
      productSignals: [
        {
          kind: "benchmark_overfit_steering",
          message: "Benchmark-specific row wins were treated as product proof.",
        },
      ],
      workflowWaste: [
        {
          kind: "output_budget_exceeded",
          message: "Large command output.",
          size: { tokens: 25000, lines: 900 },
        },
      ],
    },
    warningDetails: [{ code: "git_dirty", message: "Git worktree is dirty." }],
    recipes: [{ id: "known-recipe" }],
    thresholds: { repeatedCommandHeadCount: 3 },
  });
  const byKind = new Map(signals.map((signal) => [signal.kind, signal]));

  assert.equal(byKind.get("benchmark_overfit_steering")?.severity, "blocker");
  assert.match(
    byKind.get("benchmark_overfit_steering")?.suggestedAction.reason || "",
    /blind holdout|breadth gate/i,
  );
  assert.equal(byKind.get("output_budget_exceeded")?.severity, "warning");
  assert.equal(byKind.get("verification_churn")?.count, 3);
  assert.equal(byKind.get("dirty_tree_recovery")?.severity, "blocker");
  assert.deepEqual(byKind.get("dirty_tree_recovery")?.affectedFiles, ["src/a.ts"]);
  assert.match(byKind.get("unknown_recipe")?.reason || "", /missing-recipe/);
  assert.match(byKind.get("quality_gap_wording")?.reason || "", /accepted quality-gap/);

  const quietSignals = analyzeWorkflowFriction({
    lastRun: {
      packetEvidence: {
        stdoutTail: "x".repeat(700),
        commandIdentity: { command: "node bench.mjs" },
      },
    },
  });
  assert.equal(
    quietSignals.some((signal) => signal.kind === "output_budget_exceeded"),
    false,
  );
});

test("metric saturation becomes a review checkpoint before another same-metric packet", () => {
  const saturatedState = {
    best: 0,
    config: { metricName: "agent_value_gap", bestDirection: "lower" },
    current: [{ run: 1, status: "keep", metric: 0 }],
    development: { best: 0 },
    promotion: { kept: 0 },
    researchIntegrity: {
      evidenceLabels: ["dev_best"],
      notPromotableBecause: [
        "Current best is development-only; it is not promotable without promotion-grade metadata.",
      ],
    },
  };
  const signals = analyzeWorkflowFriction({ state: saturatedState });
  const saturation = signals.find((signal) => signal.kind === "metric_saturated_not_promotable");

  assert.equal(saturation?.severity, "warning");
  assert.match(saturation?.suggestedAction.reason || "", /review\/rescope checkpoint/);
  const envelope = buildDecisionEnvelope({
    state: saturatedState,
    workflowFriction: signals,
    nextAction: "Run the next measured packet.",
  });
  assert.equal(envelope.canonicalNextAction.kind, "metric-saturation");
});

test("finalization coverage gaps prefer current-tree finalization", () => {
  const envelope = buildDecisionEnvelope({
    state: { current: [{ run: 1, status: "keep", metric: 0 }] },
    finalization: {
      ready: false,
      actionCode: "current-tree-finalization",
      nextAction: "Resolve the structured current-tree review unit blocker.",
      warnings: ["Current branch tree is not covered by selected kept groups."],
    },
    nextAction: "Run the next measured packet.",
  });

  assert.equal(envelope.canonicalNextAction.kind, "current-tree-finalization");
});

test("loop contract blockers drive canonical next action ahead of legacy actions", () => {
  const envelope = buildDecisionEnvelope({
    state: {
      current: [],
      runtimeProvenance: {
        drifted: true,
        reason: "Source and installed runtime drift needs inspection.",
      },
    },
    nextAction: "Run the next measured packet.",
    finalization: { ready: true, nextAction: "Finalize reviewable kept work." },
  });

  assert.equal(envelope.loopContract.blockers[0].kind, "runtime-provenance");
  assert.equal(envelope.canonicalNextAction.kind, "runtime-provenance");
});

test("loop contract warnings prevent next-packet canonical drift", () => {
  const envelope = buildDecisionEnvelope({
    state: {
      current: [],
    },
    nextAction: "Run the next measured packet.",
    finalization: { ready: true, nextAction: "Finalize reviewable kept work." },
  });

  assert.equal(envelope.loopContract.blockers.length, 0);
  assert.equal(envelope.loopContract.warnings[0].kind, "finalization");
  assert.equal(envelope.loopContract.canRunNextPacket, false);
  assert.equal(envelope.canonicalNextAction.kind, "finalization");
});

test("loop contract warnings also prevent plateau packet drift", () => {
  const envelope = buildDecisionEnvelope({
    state: {
      current: [{ run: 1, status: "keep", metric: 5 }],
      sessionDecisionCapsule: {
        enforcement: {
          mode: "bounded-next",
          canRunNextPacket: false,
          commandHint: "node scripts/autoresearch.mjs benchmark-lint --cwd .",
        },
        nextExperiment: "Run a bounded benchmark-lint handoff before more packet work.",
      },
    },
    experimentMemory: {
      plateau: {
        detected: true,
        recommendation: "Scout a distant lane before repeating the plateau.",
      },
    },
    nextAction: "Run the next measured packet.",
  });

  assert.equal(envelope.loopContract.blockers.length, 0);
  assert.equal(envelope.loopContract.warnings[0].kind, "decision-capsule");
  assert.equal(envelope.loopContract.canRunNextPacket, false);
  assert.equal(envelope.canonicalNextAction.kind, "decision-capsule");
});

test("session forensics parses bounded signals without raw body persistence", async () => {
  await withTempDir("session-forensics", async (dir) => {
    const sessionPath = path.join(dir, "rollout.jsonl");
    const noisyOutput = [
      "Chunk ID: abc",
      "Wall time: 0.1 seconds",
      "Process exited with code 1",
      "Original token count: 25000",
      "Output:",
      "api_key=sk-test-1234567890abcdef",
      "Total output lines: 600",
    ].join("\n");
    const entries = [
      { timestamp: "2026-05-25T00:00:00.000Z", type: "session_meta", payload: { id: "s1" } },
      {
        timestamp: "2026-05-25T00:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Actually the metric details tell me nothing." }],
        },
      },
      {
        timestamp: "2026-05-25T00:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "git status --short" }),
        },
      },
      {
        timestamp: "2026-05-25T00:00:03.000Z",
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call1", output: noisyOutput },
      },
      { timestamp: "2026-05-25T00:00:04.000Z", type: "compacted", payload: {} },
    ];
    await writeFile(sessionPath, entries.map((entry) => JSON.stringify(entry)).join("\n"));

    const result = await parseSessionForensics({
      sessionJsonl: sessionPath,
      allowSnippets: true,
      maxSnippets: 3,
      thresholds: { compactions: 1, repeatedCommandHeadCount: 1 },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.compactions, 1);
    assert.equal(result.toolCounts.exec_command, 1);
    assert.equal(result.commandClasses["git status --short"], 1);
    assert.equal(
      result.productSignals.some((signal) => signal.kind === "dashboard_ux_feedback"),
      true,
    );
    assert.equal(
      result.productSignals.some((signal) => signal.kind === "context_distillation_required"),
      true,
    );
    assert.equal(
      result.workflowWaste.some((signal) => signal.kind === "output_budget_exceeded"),
      true,
    );
    assert.equal(
      result.workflowWaste.some((signal) => signal.kind === "verification_churn"),
      true,
    );
    assert.equal(result.decisionCapsule.kind, "session-decision-capsule");
    assert.match(result.decisionCapsule.nextExperiment, /context capsule/i);
    assert.equal(JSON.stringify(result).includes("sk-test"), false);
  });
});

test("parseSessionForensics returns unreadable_file when the read stream fails", async () => {
  await withTempDir("session-forensics-stream-error", async (dir) => {
    const sessionPath = path.join(dir, "rollout.jsonl");
    await writeFile(sessionPath, '{"type":"session_meta"}\n', "utf8");
    const { PassThrough } = await import("node:stream");
    const result = await parseSessionForensics({
      sessionJsonl: sessionPath,
      createReadStream: () => {
        const stream = new PassThrough();
        queueMicrotask(() => stream.destroy(new Error("stream broke")));
        return stream as ReturnType<typeof import("node:fs").createReadStream>;
      },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "unreadable_file");
    assert.match(result.message, /stream broke/i);
    assert.equal(result.path, sessionPath);
  });
});

test("session forensics prioritizes broken benchmark contracts over more packets", async () => {
  await withTempDir("session-forensics-benchmark-contract", async (dir) => {
    const sessionPath = path.join(dir, "rollout.jsonl");
    await writeFile(sessionPath, fixtureJsonl(benchmarkContractFixtureEntries()));

    const result = await parseSessionForensics({ sessionJsonl: sessionPath });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(
      result.productSignals.some((signal) => signal.kind === "benchmark_contract_broken"),
      true,
    );
    assert.match(result.decisionCapsule.bottleneck, /benchmark wrapper/i);
    assert.equal(result.decisionCapsule.enforcement.mode, "hard-block");
    assert.equal(result.decisionCapsule.enforcement.canRunNextPacket, false);
    assert.equal(result.decisionCapsule.enforcement.blocksFinalization, true);
    assert.match(result.decisionCapsule.evidence.join("\n"), /benchmark lint contract broken/i);
    assert.match(result.decisionCapsule.nextExperiment, /benchmark-lint emits the primary METRIC/i);
    assert.equal(
      result.decisionCapsule.wrongNextActions.some((action) =>
        /run next or finalize/i.test(action),
      ),
      true,
    );
  });
});

test("session forensics hard-blocks benchmark overfit steering before promotion", async () => {
  await withTempDir("session-forensics-benchmark-overfit", async (dir) => {
    const sessionPath = path.join(dir, "rollout.jsonl");
    await writeFile(sessionPath, fixtureJsonl(benchmarkOverfitFixtureEntries()));

    const result = await parseSessionForensics({ sessionJsonl: sessionPath });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(
      result.productSignals.some((signal) => signal.kind === "benchmark_overfit_steering"),
      true,
    );
    assert.equal(result.decisionCapsule.enforcement.mode, "hard-block");
    assert.equal(result.decisionCapsule.enforcement.canRunNextPacket, false);
    assert.equal(result.decisionCapsule.enforcement.blocksFinalization, true);
    assert.match(result.decisionCapsule.bottleneck, /epistemic trust/i);
    assert.match(result.decisionCapsule.nextExperiment, /blind holdout|breadth gate/i);
    assert.equal(
      result.decisionCapsule.wrongNextActions.some((action) =>
        /task-family detectors|holdout evidence/i.test(action),
      ),
      true,
    );
  });
});

test("session forensics does not hard-block generic unsafe-next wording as benchmark repair", async () => {
  await withTempDir("session-forensics-generic-unsafe-next", async (dir) => {
    const sessionPath = path.join(dir, "rollout.jsonl");
    await writeFile(
      sessionPath,
      fixtureJsonl([
        { timestamp: "2026-06-01T13:02:13.000Z", type: "session_meta", payload: { id: "s3" } },
        {
          timestamp: "2026-06-01T13:10:26.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "Run next packet is unsafe until stale context is refreshed and dirty source drift is inspected.",
              },
            ],
          },
        },
      ]),
    );

    const result = await parseSessionForensics({ sessionJsonl: sessionPath });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(
      result.productSignals.some((signal) => signal.kind === "benchmark_contract_broken"),
      false,
    );
    assert.notEqual(result.decisionCapsule.enforcement.mode, "hard-block");
    assert.doesNotMatch(result.decisionCapsule.bottleneck, /benchmark wrapper/i);
  });
});

test("session forensics turns 019e5d3a search latency into bounded-next governance", async () => {
  await withTempDir("session-forensics-search-latency", async (dir) => {
    const sessionPath = path.join(dir, "rollout.jsonl");
    await writeFile(sessionPath, fixtureJsonl(searchLatencyFixtureEntries()));

    const result = await parseSessionForensics({ sessionJsonl: sessionPath });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.decisionCapsule.schemaVersion, 1);
    assert.equal(result.decisionCapsule.enforcement.mode, "bounded-next");
    assert.equal(result.decisionCapsule.enforcement.canRunNextPacket, false);
    assert.equal(result.decisionCapsule.enforcement.allowBoundedNext, true);
    assert.match(result.decisionCapsule.bottleneck, /retrieval\/search latency/i);
    assert.match(result.decisionCapsule.nextExperiment, /initial retrieval\/search phase/i);
    assert.equal(
      result.decisionCapsule.wrongNextActions.some((action) => /generic packet/i.test(action)),
      true,
    );
  });
});

test("session forensics converts repeated command output into budget warnings without raw leaks", async () => {
  await withTempDir("session-forensics-output-budget", async (dir) => {
    const sessionPath = path.join(dir, "rollout.jsonl");
    await writeFile(sessionPath, fixtureJsonl(outputBudgetFixtureEntries()));

    const result = await parseSessionForensics({
      sessionJsonl: sessionPath,
      thresholds: { repeatedCommandHeadCount: 3 },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.decisionCapsule.enforcement.mode, "bounded-next");
    assert.match(result.decisionCapsule.bottleneck, /command-output cost/i);
    assert.match(result.decisionCapsule.commandBudgetWarnings.join("\n"), /Largest reported/);
    assert.match(result.decisionCapsule.doNotRepeat.join("\n"), /rg -n important/);
    assert.equal(JSON.stringify(result).includes("<bounded fixture output omitted>"), false);
  });
});

test("currentState reads the latest active decision capsule and clears it from later ledger events", async () => {
  await withTempDir("active-decision-capsule-reader", async (dir) => {
    const invalidDir = path.join(dir, "autoresearch.research", "invalid");
    const activeDir = path.join(dir, "autoresearch.research", "active");
    await mkdir(invalidDir, { recursive: true });
    await mkdir(activeDir, { recursive: true });
    await writeFile(path.join(invalidDir, "decision-capsule.json"), "{not json");
    await writeFile(
      path.join(activeDir, "decision-capsule.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "session-decision-capsule",
        status: "active",
        enforcement: {
          mode: "hard-block",
          canRunNextPacket: false,
          allowBoundedNext: false,
          blocksFinalization: true,
          clearingCondition: "Repair benchmark-lint.",
          commandHint: "node scripts/autoresearch.mjs benchmark-lint --cwd <project>",
          triggeredBy: ["sessionDecisionCapsule"],
        },
        bottleneck: "Benchmark wrapper is broken.",
        evidence: ["benchmark-lint parsed no primary METRIC."],
        nextExperiment: "Repair benchmark-lint.",
        wrongNextActions: ["Do not run next."],
        doNotRepeat: [],
        commandBudgetWarnings: [],
        generatedFrom: {
          compactions: 0,
          first: "2026-06-01T13:00:00.000Z",
          last: "2026-06-01T13:10:00.000Z",
          toolCounts: {},
          topCommandHeads: [],
        },
        importedAt: "2026-06-01T13:10:00.000Z",
      }),
    );

    assert.equal(currentState(dir).sessionDecisionCapsule?.researchSlug, "active");
    appendJsonl(dir, {
      type: "session_decision_capsule_ack",
      timestamp: "2026-06-01T13:15:00.000Z",
    });
    assert.equal(currentState(dir).sessionDecisionCapsule, null);
  });
});

test("analyzeExperimentEconomics converts dashed test-timeout millisecond values", () => {
  for (const command of [
    "node bench.mjs --test-timeout 5000",
    "node bench.mjs --test-timeout=5000",
  ]) {
    const economics = analyzeExperimentEconomics({
      state: { baseline: 10, config: { bestDirection: "lower" }, current: [] },
      lastRun: {
        run: { durationSeconds: 30 },
        packetEvidence: {
          timeoutSeconds: 3,
          commandIdentity: { command },
        },
      },
    });
    const warning = economics.warnings.find(
      (entry) => entry.code === "outer_timeout_shorter_than_inner",
    );
    assert.equal(warning?.details?.innerTimeout, 5, command);
  }

  const secondsEconomics = analyzeExperimentEconomics({
    state: { baseline: 10, config: { bestDirection: "lower" }, current: [] },
    lastRun: {
      run: { durationSeconds: 30 },
      packetEvidence: {
        timeoutSeconds: 3,
        commandIdentity: { command: "node bench.mjs --test-timeout-seconds 5" },
      },
    },
  });
  const secondsWarning = secondsEconomics.warnings.find(
    (entry) => entry.code === "outer_timeout_shorter_than_inner",
  );
  assert.equal(secondsWarning?.details?.innerTimeout, 5);
});

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error &&
      typeof error === "object" &&
      "code" in error &&
      String(error.code) === "ESRCH"
    );
  }
}

function processTreeFixturePids(output: string): number[] {
  return ["ROOT_PID", "SPAWNED_CHILD_PID", "CHILD_PID", "SPAWNED_GRANDCHILD_PID", "GRANDCHILD_PID"]
    .map((name) => Number(output.match(new RegExp(`(?:^|\\n)${name}=(\\d+)`))?.[1]))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
    .filter((pid, index, values) => values.indexOf(pid) === index);
}

async function forceCleanupPids(
  rootPid: number | null,
  pids: number[],
  fixtureOnly = false,
): Promise<void> {
  if (rootPid) await terminateProcessTree(rootPid).catch(() => null);
  for (const pid of [...new Set(pids)].reverse()) {
    if (!processIsAlive(pid)) continue;
    if (fixtureOnly && !isStubbornFixtureProcess(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  if (fixtureOnly) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const pid of new Set(pids)) {
      assert.equal(isStubbornFixtureProcess(pid), false, `fixture PID ${pid} survived cleanup`);
    }
  }
}

function isStubbornFixtureProcess(pid: number): boolean {
  if (!processIsAlive(pid)) return false;
  try {
    const command =
      process.platform === "win32"
        ? execFileSync(
            "powershell.exe",
            [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`,
            ],
            { encoding: "utf8", timeout: 2000, windowsHide: true },
          )
        : execFileSync("ps", ["-p", String(pid), "-o", "command="], {
            encoding: "utf8",
            timeout: 2000,
          });
    return command.includes("stubborn-process-tree.mjs");
  } catch {
    return false;
  }
}
