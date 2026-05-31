import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendJsonl,
  buildDecisionEnvelope,
  buildLastRunFreshnessSnapshot,
  currentState,
  finiteMetric,
  lastRunPacketFreshness,
  normalizeScopedFileFingerprints,
  readJsonlTail,
  streamJsonl,
  statusHash,
} from "../lib/session-core.js";
import { parseMetricLines, runProcess, runShell } from "../lib/runner.js";
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
  createProgressSnapshot,
  progressSnapshotFromRun,
  staleProgressReason,
} from "../lib/runner-progress.js";
import {
  assertInsideResearchRoot,
  resolveSafeResearchPath,
  validateResearchSlug,
} from "../lib/research-path-guard.js";
import { parseSessionForensics } from "../lib/session-forensics.js";
import { analyzeWorkflowFriction } from "../lib/workflow-friction.js";
import { quoteForShell } from "./helpers/process.js";

const withTempDir = async (name, fn) => {
  const dir = await mkdtemp(path.join(tmpdir(), `autoresearch-e1-${name}-`));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

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
  assert.doesNotMatch(redacted, /sk-test/);
  assert.doesNotMatch(redacted, /user:pass/);
  assert.doesNotMatch(redacted, /albert/);
  assert.doesNotMatch(redacted, /\.env\.production/);
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
  assert.equal(progress.commandClass, "npm test --");
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
