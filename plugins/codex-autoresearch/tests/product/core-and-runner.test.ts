import assert from "node:assert/strict";
import test from "node:test";
import {
  appendJsonl,
  currentState,
  iterationLimitInfo,
  parseQualityGaps,
  shellQuote as sessionShellQuote,
} from "../../lib/session-core.js";
import {
  parseMetricLines,
  runExecutableCommand,
  runProcess,
  runShell,
  tailText,
} from "../../lib/runner.js";
import { quoteForAcceptedShell, quoteForRunShell } from "../helpers/process.js";
import { pluginRoot, runCli, withTempDir } from "./helpers.js";

test("session core handles finite metrics, segments, limits, and quality gaps", async () => {
  await withTempDir("session-core", async (dir) => {
    appendJsonl(dir, { type: "config", name: "core", metricName: "delta", bestDirection: "lower" });
    appendJsonl(dir, { run: 1, metric: 0, status: "keep", description: "Zero baseline" });
    appendJsonl(dir, { run: 2, metric: -2, status: "keep", description: "Negative improvement" });

    let state = currentState(dir);
    assert.equal(state.baseline, 0);
    assert.equal(state.best, -2);
    assert.equal(iterationLimitInfo(state, { maxIterations: 3 }).remainingIterations, 1);

    appendJsonl(dir, {
      type: "config",
      name: "second",
      metricName: "seconds",
      bestDirection: "higher",
    });
    appendJsonl(dir, { run: 3, metric: 5, status: "discard", description: "Segment reset" });
    state = currentState(dir);
    assert.equal(state.segment, 1);
    assert.equal(state.current.length, 1);
    assert.equal(iterationLimitInfo(state, { maxIterations: 1 }).limitReached, true);

    assert.deepEqual(parseQualityGaps("- [ ] Open\n- [x] Closed\n- [X] Rejected\n"), {
      open: 1,
      closed: 2,
      total: 3,
    });
  });
});

test("displayed command quoting preserves backslashes before quotes", async () => {
  const trickyArg = String.raw`C:\tmp"name`;
  const expectedDisplay = String.raw`"C:\\tmp\"name"`;

  assert.equal(sessionShellQuote(trickyArg), expectedDisplay);

  const result = await runProcess(process.execPath, ["-e", "", trickyArg], {
    cwd: pluginRoot,
    timeoutSeconds: 10,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(result.commandDisplay.includes(expectedDisplay), result.commandDisplay);
});

test("runner parses metrics, truncates tails, and reports timeouts", async () => {
  const metrics = parseMetricLines(
    ["metric seconds=1.25", "METRIC delta=-2", "METRIC scaled=1.5e+2", "METRIC __proto__=99"].join(
      "\n",
    ),
  );
  assert.equal(metrics.seconds, 1.25);
  assert.equal(metrics.delta, -2);
  assert.equal(metrics.scaled, 150);
  assert.equal(Object.hasOwn(metrics, "__proto__"), false);

  const tail = tailText(
    Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n"),
    5,
    2000,
  );
  assert.equal(tail.split(/\r?\n/).length, 5);
  assert.match(tail, /line 39/);

  const command = `${quoteForRunShell(process.execPath)} -e "setTimeout(()=>{}, 2000)"`;
  const result = await runShell(command, pluginRoot, 1);
  assert.equal(result.timedOut, true);
});

test("raw and accepted shell commands use their explicit Windows execution boundary", async () => {
  const raw = await runShell(
    `${quoteForRunShell(process.execPath)} -e "console.log('run-shell-ok')"`,
    pluginRoot,
    10,
  );
  assert.equal(raw.exitCode, 0, raw.output);
  assert.match(raw.output, /run-shell-ok/);

  const acceptedScript = `${quoteForAcceptedShell(process.execPath)} -e ${quoteForAcceptedShell(
    "console.log('accepted-shell-ok')",
  )}`;
  const accepted = await runExecutableCommand(
    {
      kind: "shell",
      shell: process.platform === "win32" ? "powershell" : "bash",
      script: acceptedScript,
    },
    pluginRoot,
    10,
  );
  assert.equal(accepted.exitCode, 0, accepted.output);
  assert.match(accepted.output, /accepted-shell-ok/);
});

test("direct CLI command execution stays intentionally ungated", async () => {
  await withTempDir("cli-direct-command-boundary", async (dir) => {
    const command = `${quoteForRunShell(process.execPath)} -e "console.log('METRIC seconds=1')"`;
    const lint = await runCli([
      "benchmark-lint",
      "--cwd",
      dir,
      "--metric-name",
      "seconds",
      "--command",
      command,
    ]);

    assert.equal(lint.code, 0, lint.stderr);
    const payload = JSON.parse(lint.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.parsedMetrics.seconds, 1);
  });
});
