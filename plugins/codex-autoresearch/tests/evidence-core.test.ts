import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendJsonl,
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
