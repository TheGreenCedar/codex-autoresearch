import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";
import { resolvePackageRoot } from "../lib/runtime-paths.js";

const pluginRoot = resolvePackageRoot(import.meta.url);
const cli = path.join(pluginRoot, "scripts", "autoresearch.mjs");
const mcpServer = path.join(pluginRoot, "scripts", "autoresearch-mcp.mjs");

const quoteForShell = (value) => {
  return `"${String(value).replace(/"/g, '\\"')}"`;
};

const processResult = (code, stdout, stderr) => ({ code, stdout, stderr });

const runProcess = (command, args, cwd) => {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => resolve(processResult(code, stdout, stderr)));
  });
};

const runCli = (args, options = {}) => {
  return runProcess(process.execPath, [cli, ...args], options.cwd || pluginRoot);
};

const withTempDir = async (name, fn) => {
  const dir = await mkdtemp(path.join(tmpdir(), `autoresearch-${name}-`));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const git = async (cwd, args) => {
  const result = await runProcess("git", args, cwd);
  assert.equal(result.code, 0, `git ${args.join(" ")} failed\n${result.stderr}${result.stdout}`);
  return result.stdout.trim();
};

function mcpFrame(message) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function parseMcpFrames(stdout) {
  const frames = [];
  let remaining = Buffer.from(stdout, "utf8");
  for (;;) {
    const headerEnd = remaining.indexOf("\r\n\r\n");
    if (headerEnd < 0) return frames;
    const header = remaining.subarray(0, headerEnd).toString("utf8");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) return frames;
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (remaining.length < bodyStart + length) return frames;
    frames.push(JSON.parse(remaining.subarray(bodyStart, bodyStart + length).toString("utf8")));
    remaining = remaining.subarray(bodyStart + length);
  }
}

async function waitForMcpResponseById(stdoutFn, stderrFn, id) {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const found = parseMcpFrames(stdoutFn()).find((message) => message.id === id);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`No MCP response for ${id}\nstdout=${stdoutFn()}\nstderr=${stderrFn()}`);
}

async function callMcpTool(name, args) {
  const child = spawn(process.execPath, [mcpServer], {
    cwd: pluginRoot,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const send = (message) => {
    child.stdin.write(mcpFrame(message));
  };

  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {} },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
    return await waitForMcpResponseById(
      () => stdout,
      () => stderr,
      2,
    );
  } finally {
    child.kill();
  }
}

async function renderExportedDashboard(html) {
  const dom = new JSDOM(html, {
    pretendToBeVisual: true,
    runScripts: "dangerously",
    url: "file:///autoresearch-dashboard.html",
  });
  const started = Date.now();
  while (!dom.window.__AUTORESEARCH_DASHBOARD_READY__) {
    if (Date.now() - started > 2000)
      throw new Error("Dashboard React app did not finish rendering.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return dom;
}

test("run reports missing primary metric as a failed experiment", async () => {
  await withTempDir("missing-metric", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "missing metric", "--metric-name", "seconds"]);

    const command = `${quoteForShell(process.execPath)} -e "console.log('no metric here')"`;
    const result = await runCli(["run", "--cwd", dir, "--command", command]);
    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.parsedPrimary, null);
    assert.match(payload.metricError, /seconds/);
    assert.equal(payload.logHint.status, "crash");
    assert.deepEqual(payload.logHint.allowedStatuses, ["crash"]);
  });
});

test("research-setup creates a quality_gap scratchpad and benchmark", async () => {
  await withTempDir("research-setup", async (dir) => {
    const result = await runCli([
      "research-setup",
      "--cwd",
      dir,
      "--slug",
      "Project Study",
      "--goal",
      "Study the project before improving it",
      "--max-iterations",
      "7",
    ]);
    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.slug, "project-study");
    assert.equal(payload.init.config.metricName, "quality_gap");
    assert.equal(payload.init.config.bestDirection, "lower");
    assert.equal(payload.qualityGap.open, 6);

    const researchRoot = path.join(dir, "autoresearch.research", "project-study");
    assert.match(await readFile(path.join(researchRoot, "brief.md"), "utf8"), /Study the project/);
    assert.match(await readFile(path.join(researchRoot, "sources.md"), "utf8"), /Claim Supported/);
    assert.match(
      await readFile(path.join(researchRoot, "synthesis.md"), "utf8"),
      /Quality-Gap Translation/,
    );
    assert.match(await readFile(path.join(researchRoot, "quality-gaps.md"), "utf8"), /- \[ \]/);

    const scriptName = process.platform === "win32" ? "autoresearch.ps1" : "autoresearch.sh";
    const benchmark = await readFile(path.join(dir, scriptName), "utf8");
    assert.match(benchmark, /quality-gap/);
    assert.match(benchmark, /project-study/);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    assert.equal(JSON.parse(state.stdout).config.metricName, "quality_gap");

    const exportResult = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const exportPayload = JSON.parse(exportResult.stdout);
    assert.match(exportPayload.modeGuidance.difference, /read-only fallback snapshot/);
    const dashboard = await readFile(path.join(dir, "autoresearch-dashboard.html"), "utf8");
    assert.match(dashboard, /"deliveryMode":"static-export"/);
    assert.match(dashboard, /Read-only snapshot/);
    assert.doesNotMatch(dashboard, /Serve dashboard/);
    assert.doesNotMatch(dashboard, /--research-slug \\"project-study\\"/);
    assert.match(dashboard, /activeResearchSlug/);
  });
});

test("quality-gap counts checked and unchecked research gaps", async () => {
  await withTempDir("quality-gap", async (dir) => {
    await runCli([
      "research-setup",
      "--cwd",
      dir,
      "--slug",
      "study",
      "--goal",
      "Study quality gaps",
    ]);
    await writeFile(
      path.join(dir, "autoresearch.research", "study", "quality-gaps.md"),
      [
        "# Quality Gaps",
        "",
        "- [ ] Open gap",
        "- [x] Closed gap",
        "- [X] Rejected with evidence",
        "- [ ] Another open gap",
        "- plain note",
        "",
      ].join("\n"),
    );

    const result = await runCli(["quality-gap", "--cwd", dir, "--research-slug", "study"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /METRIC quality_gap=2/);
    assert.match(result.stdout, /METRIC quality_total=4/);
    assert.match(result.stdout, /METRIC quality_closed=2/);

    const listed = await runCli([
      "quality-gap",
      "--cwd",
      dir,
      "--research-slug",
      "study",
      "--list",
    ]);
    assert.equal(listed.code, 0, listed.stderr);
    const listedPayload = JSON.parse(listed.stdout);
    assert.deepEqual(listedPayload.openItems, ["Open gap", "Another open gap"]);
    assert.deepEqual(listedPayload.closedItems, ["Closed gap", "Rejected with evidence"]);
  });
});

test("run returns explicit keep/discard decision options instead of a fake status", async () => {
  await withTempDir("decision-hint", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "decision hint", "--metric-name", "seconds"]);

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1.25')"`;
    const result = await runCli(["run", "--cwd", dir, "--command", command]);
    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.logHint.status, null);
    assert.equal(payload.logHint.needsDecision, true);
    assert.deepEqual(payload.logHint.allowedStatuses, ["keep", "discard"]);
  });
});

test("state and dashboard math keep zero-valued metrics visible", async () => {
  await withTempDir("zero-metric", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "zero metric", "--metric-name", "failures"]);
    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "0",
      "--status",
      "keep",
      "--description",
      "Reach zero failures",
    ]);
    assert.equal(log.code, 0, log.stderr);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.equal(payload.baseline, 0);
    assert.equal(payload.best, 0);

    const exportResult = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const dashboard = await readFile(path.join(dir, "autoresearch-dashboard.html"), "utf8");
    assert.match(dashboard, /Reach zero failures/);
  });
});

test("state supports negative metrics when lower is better", async () => {
  await withTempDir("negative-metric", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "negative metric",
      "--metric-name",
      "delta",
      "--direction",
      "lower",
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Baseline positive delta",
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "-2",
      "--status",
      "keep",
      "--description",
      "Beat baseline below zero",
    ]);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.equal(payload.baseline, 1);
    assert.equal(payload.best, -2);

    const exportResult = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const dashboard = await readFile(path.join(dir, "autoresearch-dashboard.html"), "utf8");
    const dom = await renderExportedDashboard(dashboard);
    const chart = dom.window.document.getElementById("trend-chart").innerHTML;
    assert.match(chart, /#1 1 keep/);
    assert.match(chart, /#2 -2 keep/);
    assert.doesNotMatch(chart, /Infinity|NaN/);
    assert.equal(dom.window.document.getElementById("improvement-value").textContent, "+300.0%");
    dom.window.close();
  });
});

test("state reports corrupt JSONL with the ledger path", async () => {
  await withTempDir("state-corrupt-jsonl", async (dir) => {
    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      [
        JSON.stringify({ type: "config", name: "corrupt state", metricName: "seconds" }),
        "{ not valid json",
      ].join("\n") + "\n",
      "utf8",
    );

    const state = await runCli(["state", "--cwd", dir]);
    assert.notEqual(state.code, 0);
    assert.match(state.stderr, /autoresearch\.jsonl/);
    assert.match(state.stderr, /line 2/);
  });
});

test("discarded metrics do not become best or suppress on-improvement checks", async () => {
  await withTempDir("discarded-best", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "discarded best",
      "--metric-name",
      "seconds",
      "--direction",
      "lower",
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "10",
      "--status",
      "keep",
      "--description",
      "Baseline",
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "5",
      "--status",
      "discard",
      "--description",
      "Faster but rejected",
    ]);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    assert.equal(JSON.parse(state.stdout).best, 10);

    const checksFile =
      process.platform === "win32" ? "autoresearch.checks.ps1" : "autoresearch.checks.sh";
    const checksBody = process.platform === "win32" ? "exit 1\n" : "#!/bin/sh\nexit 1\n";
    await writeFile(path.join(dir, checksFile), checksBody, "utf8");

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=7')"`;
    const result = await runCli([
      "run",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "on-improvement",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.improvesPrimary, true);
    assert.equal(payload.checks?.passed, false);
    assert.equal(payload.ok, false);
    assert.deepEqual(payload.logHint.allowedStatuses, ["checks_failed"]);
  });
});

test("dashboard includes segment controls and visual-aid layout", async () => {
  await withTempDir("dashboard-cockpit", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "first segment", "--metric-name", "seconds"]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "4",
      "--status",
      "keep",
      "--description",
      "Baseline",
    ]);
    await runCli(["init", "--cwd", dir, "--name", "second segment", "--metric-name", "seconds"]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "3",
      "--status",
      "keep",
      "--description",
      "Second baseline",
    ]);

    const exportResult = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const dashboard = await readFile(path.join(dir, "autoresearch-dashboard.html"), "utf8");
    const dom = await renderExportedDashboard(dashboard);
    const doc = dom.window.document;
    const rendered = doc.body.innerHTML;

    assert.ok(doc.getElementById("segment-select"));
    assert.ok(doc.getElementById("live-toggle"));
    assert.doesNotMatch(dashboard, /id="command-grid"/);
    assert.match(doc.body.textContent, /Run log/);
    assert.ok(doc.getElementById("ledger-scroll"));
    assert.match(doc.body.textContent, /Codex brief/);
    assert.ok(doc.getElementById("ai-summary-title"));
    assert.equal(doc.getElementById("mission-control-grid"), null);
    assert.equal(doc.getElementById("run-log-decision"), null);
    assert.equal(doc.getElementById("trust-strip"), null);
    assert.match(dashboard, /__AUTORESEARCH_META__/);
    assert.doesNotMatch(dashboard, /clipboard\?\.writeText/);
    assert.doesNotMatch(dashboard, /autoresearch\.mjs/);
    assert.match(doc.body.textContent, /Finalize/);
    assert.ok(rendered.indexOf('id="trend-panel"') < rendered.indexOf('id="codex-brief"'));
    assert.ok(rendered.indexOf('id="codex-brief"') < rendered.indexOf('id="strategy-memory"'));
    assert.ok(rendered.indexOf('id="strategy-memory"') < rendered.indexOf('id="decision-rail"'));
    assert.ok(rendered.indexOf('id="decision-rail"') < rendered.indexOf('id="ledger"'));
    assert.ok(rendered.indexOf('id="trend-panel"') < rendered.indexOf('id="ledger"'));
    assert.ok(rendered.indexOf('id="ledger"') < rendered.indexOf('id="research-truth-meter"'));
    dom.window.close();
  });
});

test("config persists operator settings and extends iteration limits", async () => {
  await withTempDir("operator-config", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "operator config", "--metric-name", "seconds"]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "5",
      "--status",
      "keep",
      "--description",
      "Baseline",
    ]);

    const result = await runCli([
      "config",
      "--cwd",
      dir,
      "--autonomy-mode",
      "owner-autonomous",
      "--checks-policy",
      "on-improvement",
      "--keep-policy",
      "primary-or-risk-reduction",
      "--dashboard-refresh-seconds",
      "2",
      "--extend",
      "4",
      "--commit-paths",
      "src,tests",
    ]);
    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.config.autonomyMode, "owner-autonomous");
    assert.equal(payload.config.checksPolicy, "on-improvement");
    assert.equal(payload.config.keepPolicy, "primary-or-risk-reduction");
    assert.equal(payload.config.dashboardRefreshSeconds, 2);
    assert.equal(payload.config.maxIterations, 5);
    assert.deepEqual(payload.config.commitPaths, ["src", "tests"]);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.settings.autonomyMode, "owner-autonomous");
    assert.equal(statePayload.limit.remainingIterations, 4);
    assert.match(statePayload.commands[0].command, /autoresearch\.mjs/);
    assert.match(statePayload.commands[0].command, /--cwd/);
  });
});

test("next writes a reusable last-run packet and log can consume it", async () => {
  await withTempDir("last-run", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "last run", "--metric-name", "seconds"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3'); console.log('METRIC cache_hits=8')"`;

    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.decision.metric, 3);
    assert.equal(packet.decision.metrics.cache_hits, 8);
    assert.equal(packet.decision.safeSuggestedStatus, "keep");
    assert.match(packet.decision.statusGuidance, /Safe to consider keep/);
    assert.ok(packet.decision.diversityGuidance);
    assert.equal(packet.decision.asiTemplate.lane, packet.decision.diversityGuidance.id);

    const lastRun = JSON.parse(await readFile(packet.lastRunPath, "utf8"));
    assert.equal(lastRun.decision.metric, 3);
    assert.equal(lastRun.history.nextRun, 1);
    assert.equal(lastRun.history.config.metricName, "seconds");

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "discard",
      "--description",
      "Discard cached packet",
    ]);
    assert.equal(log.code, 0, log.stderr);
    const payload = JSON.parse(log.stdout);
    assert.equal(payload.experiment.metric, 3);
    assert.equal(payload.experiment.metrics.cache_hits, 8);
    assert.equal(payload.lastRunCleared, true);
    await assert.rejects(access(packet.lastRunPath));

    const duplicate = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "discard",
      "--description",
      "Duplicate cached packet",
    ]);
    assert.notEqual(duplicate.code, 0);
    assert.match(duplicate.stderr, /No last-run packet/);
  });
});

test("next parses metrics from the full benchmark output before display truncation", async () => {
  await withTempDir("full-output-metric", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "full output", "--metric-name", "seconds"]);
    const script = path.join(dir, "noisy-benchmark.mjs");
    await writeFile(
      script,
      [
        "console.log('METRIC seconds=7');",
        "for (let i = 0; i < 3000; i += 1) console.log(`noise ${i} ${'x'.repeat(80)}`);",
        "",
      ].join("\n"),
      "utf8",
    );

    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      `${quoteForShell(process.execPath)} ${quoteForShell(script)}`,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.decision.metric, 7);
    assert.equal(packet.run.parsedPrimary, 7);
    assert.equal(packet.run.outputTruncated, true);
  });
});

test("successful last-run packets require explicit status and suggest discard for regressions", async () => {
  await withTempDir("last-run-suggest-discard", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "suggest discard",
      "--metric-name",
      "seconds",
      "--direction",
      "lower",
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "3",
      "--status",
      "keep",
      "--description",
      "Baseline",
    ]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=4')"`;

    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.decision.suggestedStatus, "discard");
    assert.deepEqual(packet.decision.allowedStatuses, ["keep", "discard"]);

    const missingStatus = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--description",
      "No status",
    ]);
    assert.notEqual(missingStatus.code, 0);
    assert.match(missingStatus.stderr, /status is required/);

    const discard = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "discard",
      "--description",
      "Discard slower run",
    ]);
    assert.equal(discard.code, 0, discard.stderr);
    assert.equal(JSON.parse(discard.stdout).experiment.status, "discard");
  });
});

test("stale last-run packets are rejected when history advances", async () => {
  await withTempDir("stale-last-run", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "stale packet", "--metric-name", "seconds"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);

    const directLog = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "2",
      "--status",
      "keep",
      "--description",
      "Manual run",
    ]);
    assert.equal(directLog.code, 0, directLog.stderr);

    const stale = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Old packet",
    ]);
    assert.notEqual(stale.code, 0);
    assert.match(stale.stderr, /Last-run packet is stale/);
  });
});

test("stale last-run packets are rejected when scoped git evidence changes", async () => {
  await withTempDir("stale-last-run-git-evidence", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "git stale packet", "--metric-name", "seconds"]);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);

    await writeFile(path.join(dir, "tracked.txt"), "changed after next\n", "utf8");
    const stale = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "discard",
      "--description",
      "Old packet after file edit",
    ]);
    assert.notEqual(stale.code, 0);
    assert.match(stale.stderr, /Git dirty state changed|scoped file fingerprints changed/);
  });
});

test("stale last-run packets are rejected when dirty file contents change without status shape changes", async () => {
  await withTempDir("stale-last-run-dirty-content", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "dirty content packet",
      "--metric-name",
      "seconds",
    ]);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await writeFile(path.join(dir, "tracked.txt"), "dirty before packet\n", "utf8");

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);

    await writeFile(path.join(dir, "tracked.txt"), "dirty after packet\n", "utf8");
    const stale = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Old packet after dirty content edit",
      "--allow-add-all",
    ]);
    assert.notEqual(stale.code, 0);
    assert.match(stale.stderr, /dirty file contents changed/);
  });
});

test("stale last-run packets are rejected when untracked directory contents change", async () => {
  await withTempDir("stale-last-run-untracked-dir", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "untracked dir packet",
      "--metric-name",
      "seconds",
    ]);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await mkdir(path.join(dir, "scratch"), { recursive: true });
    await writeFile(path.join(dir, "scratch", "thing.txt"), "before packet\n", "utf8");

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);

    await writeFile(path.join(dir, "scratch", "thing.txt"), "after packet\n", "utf8");
    const stale = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Old packet after untracked dir edit",
      "--allow-add-all",
    ]);
    assert.notEqual(stale.code, 0);
    assert.match(stale.stderr, /dirty file contents changed|Git dirty state changed/);
  });
});

test("last-run packets are rejected when config changes before logging", async () => {
  await withTempDir("config-stale-last-run", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "first config", "--metric-name", "seconds"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);

    const secondConfig = await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "second config",
      "--metric-name",
      "points",
      "--direction",
      "higher",
    ]);
    assert.equal(secondConfig.code, 0, secondConfig.stderr);

    const stale = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Old metric packet",
    ]);
    assert.notEqual(stale.code, 0);
    assert.match(stale.stderr, /session config changed/);
  });
});

test("owner-autonomous runs return continuation instead of handing control back", async () => {
  await withTempDir("continuation", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "continuation", "--metric-name", "seconds"]);
    await runCli([
      "config",
      "--cwd",
      dir,
      "--autonomy-mode",
      "owner-autonomous",
      "--checks-policy",
      "manual",
    ]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;

    const next = await runCli(["next", "--cwd", dir, "--command", command]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.continuation.stage, "needs-log-decision");
    assert.equal(packet.continuation.requiresLogDecision, true);
    assert.equal(packet.continuation.shouldAskUser, false);
    assert.equal(packet.continuation.forbidFinalAnswer, true);

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Keep baseline",
    ]);
    assert.equal(log.code, 0, log.stderr);
    const payload = JSON.parse(log.stdout);
    assert.equal(payload.continuation.stage, "logged");
    assert.equal(payload.continuation.shouldContinue, true);
    assert.equal(payload.continuation.shouldAskUser, false);
    assert.equal(payload.continuation.forbidFinalAnswer, true);
    assert.match(payload.continuation.nextAction, /without asking the user/);
    assert.match(payload.continuation.commands.next, / next /);
  });
});

test("guarded sessions with active budgets keep continuation non-final", async () => {
  await withTempDir("guarded-active-budget", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "budget", "--metric-name", "seconds"]);
    await runCli(["config", "--cwd", dir, "--checks-policy", "manual", "--max-iterations", "3"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;

    const next = await runCli(["next", "--cwd", dir, "--command", command, "--compact"]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.continuation.stage, "needs-log-decision");
    assert.equal(packet.continuation.activeBudget, true);
    assert.equal(packet.continuation.shouldContinue, true);
    assert.equal(packet.continuation.forbidFinalAnswer, true);
    assert.match(packet.report.tried, /seconds=3/);
    assert.equal(packet.doctor, undefined);
    assert.match(packet.fullPacket, /lastRunPath/);

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Keep baseline",
    ]);
    assert.equal(log.code, 0, log.stderr);
    const payload = JSON.parse(log.stdout);
    assert.equal(payload.continuation.stage, "logged");
    assert.equal(payload.continuation.activeBudget, true);
    assert.equal(payload.continuation.shouldContinue, true);
    assert.equal(payload.continuation.forbidFinalAnswer, true);
    assert.match(payload.continuation.finalAnswerPolicy, /Do not stop/);

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.activeBudget, true);
    assert.equal(statePayload.forbidFinalAnswer, true);
    assert.match(statePayload.commands.next, /--compact/);
    assert.match(statePayload.report.next, /Keep going/);
  });
});

test("continuation stops cleanly at the configured iteration limit", async () => {
  await withTempDir("continuation-limit", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "continuation limit",
      "--metric-name",
      "seconds",
    ]);
    await runCli([
      "config",
      "--cwd",
      dir,
      "--autonomy-mode",
      "owner-autonomous",
      "--checks-policy",
      "manual",
      "--max-iterations",
      "1",
    ]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;

    const next = await runCli(["next", "--cwd", dir, "--command", command]);
    assert.equal(next.code, 0, next.stderr);
    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Limit baseline",
    ]);
    assert.equal(log.code, 0, log.stderr);
    const payload = JSON.parse(log.stdout);
    assert.equal(payload.limit.limitReached, true);
    assert.equal(payload.continuation.shouldContinue, false);
    assert.match(payload.continuation.stopReason, /maxIterations reached/);
    assert.match(payload.continuation.commands.extendLimit, /--extend 10/);
  });
});

test("log from last packet rejects keep after failed checks", async () => {
  await withTempDir("last-run-check-failure", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "last run checks", "--metric-name", "seconds"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const checks = `${quoteForShell(process.execPath)} -e "process.exit(1)"`;

    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-command",
      checks,
    ]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.deepEqual(packet.decision.allowedStatuses, ["checks_failed"]);

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Should not keep failed checks",
    ]);
    assert.notEqual(log.code, 0);
    assert.match(log.stderr, /Cannot log status 'keep'/);

    const jsonl = await readFile(path.join(dir, "autoresearch.jsonl"), "utf8");
    assert.doesNotMatch(jsonl, /Should not keep failed checks/);
  });
});

test("metricless failure logs do not become baseline or best", async () => {
  await withTempDir("metricless-failures", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "metricless failures",
      "--metric-name",
      "seconds",
    ]);

    const crash = await runCli([
      "log",
      "--cwd",
      dir,
      "--status",
      "crash",
      "--description",
      "Benchmark crashed before metric",
    ]);
    assert.equal(crash.code, 0, crash.stderr);
    assert.equal(JSON.parse(crash.stdout).experiment.metric, null);

    const checksFailed = await runCli([
      "log",
      "--cwd",
      dir,
      "--status",
      "checks_failed",
      "--description",
      "Checks failed before metric",
    ]);
    assert.equal(checksFailed.code, 0, checksFailed.stderr);
    assert.equal(JSON.parse(checksFailed.stdout).experiment.metric, null);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.equal(payload.baseline, null);
    assert.equal(payload.best, null);
    assert.equal(payload.crashed, 1);
    assert.equal(payload.checksFailed, 1);
  });
});

test("legacy failed sentinel metrics do not suppress next-run baseline guidance", async () => {
  await withTempDir("legacy-sentinel-baseline", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "legacy sentinel", "--metric-name", "seconds"]);

    const legacyFailure = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "-999",
      "--status",
      "crash",
      "--description",
      "Legacy sentinel failure",
    ]);
    assert.equal(legacyFailure.code, 0, legacyFailure.stderr);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    assert.equal(JSON.parse(state.stdout).baseline, null);

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=5')"`;
    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);
    const payload = JSON.parse(next.stdout);
    assert.equal(payload.decision.rawSuggestedStatus, "keep");
    assert.equal(payload.decision.safeSuggestedStatus, "keep");
  });
});

test("metricless failed last-run packets log cleanly and preserve packet on invalid status", async () => {
  await withTempDir("metricless-last-run", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "metricless last run",
      "--metric-name",
      "seconds",
    ]);
    const command = `${quoteForShell(process.execPath)} -e "process.exit(1)"`;

    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.decision.metric, null);
    assert.deepEqual(packet.decision.allowedStatuses, ["crash"]);

    const invalid = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Wrong failed status",
    ]);
    assert.notEqual(invalid.code, 0);
    assert.match(invalid.stderr, /Cannot log status 'keep'/);
    await access(path.join(dir, "autoresearch.last-run.json"));

    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "crash",
      "--description",
      "Log failed packet",
    ]);
    assert.equal(logged.code, 0, logged.stderr);
    const payload = JSON.parse(logged.stdout);
    assert.equal(payload.experiment.metric, null);
    assert.equal(payload.lastRunCleared, true);
    await assert.rejects(access(path.join(dir, "autoresearch.last-run.json")));
  });
});

test("keep and discard still require finite metrics", async () => {
  await withTempDir("metric-required", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "metric required", "--metric-name", "seconds"]);

    for (const status of ["keep", "discard"]) {
      const result = await runCli([
        "log",
        "--cwd",
        dir,
        "--status",
        status,
        "--description",
        `${status} without metric`,
      ]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /metric is required/);
    }
  });
});

test("state normalizes invalid metrics before experiment memory ranking", async () => {
  await withTempDir("state-invalid-metric-memory", async (dir) => {
    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "invalid metric memory",
          metricName: "seconds",
          bestDirection: "lower",
        }),
        JSON.stringify({
          run: 1,
          metric: false,
          status: "keep",
          description: "Invalid metric",
          asi: { family: "same" },
        }),
        JSON.stringify({
          run: 2,
          metric: "not-a-number",
          status: "discard",
          description: "Invalid string",
          asi: { family: "same" },
        }),
        JSON.stringify({
          run: 3,
          metric: 5,
          status: "keep",
          description: "Real metric",
          asi: { family: "same" },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    const family = payload.memory.families.find((item) => item.label === "same");

    assert.equal(payload.baseline, 5);
    assert.equal(payload.best, 5);
    assert.deepEqual(
      payload.memory.kept.map((item) => item.metric),
      [null, 5],
    );
    assert.equal(family.bestRun.run, 3);
    assert.equal(family.bestRun.metric, 5);
    assert.equal(family.bestKeptRun.run, 3);
    assert.equal(family.bestKeptRun.metric, 5);
  });
});

test("last-run packet does not dirty git worktrees before discard logging", async () => {
  await withTempDir("git-last-run", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "git last run", "--metric-name", "seconds"]);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.doesNotMatch(packet.lastRunPath, /autoresearch\.last-run\.json$/);

    const statusBeforeLog = await git(dir, ["status", "--short"]);
    assert.equal(statusBeforeLog, "");

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "discard",
      "--description",
      "Discard clean packet",
    ]);
    assert.equal(log.code, 0, log.stderr);
    const payload = JSON.parse(log.stdout);
    assert.equal(payload.experiment.metric, 3);
  });
});

test("no-change keep records no fake kept commit", async () => {
  await withTempDir("no-change-keep", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "no change keep", "--metric-name", "seconds"]);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1')"`;
    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Keep evidence without file changes",
      "--commit-paths",
      "tracked.txt",
    ]);
    assert.equal(log.code, 0, log.stderr);
    const payload = JSON.parse(log.stdout);
    assert.equal(payload.experiment.commit, "");
    assert.match(payload.git, /nothing to commit/);
  });
});

test("config extend is based on the active segment run count", async () => {
  await withTempDir("segment-extend", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "first segment", "--metric-name", "seconds"]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "5",
      "--status",
      "keep",
      "--description",
      "Baseline",
    ]);
    await runCli(["init", "--cwd", dir, "--name", "second segment", "--metric-name", "seconds"]);

    const result = await runCli(["config", "--cwd", dir, "--extend", "4"]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.config.maxIterations, 4);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.limit.maxIterations, 4);
    assert.equal(statePayload.limit.remainingIterations, 4);
  });
});

test("dashboard script renders zero and negative metric points", async () => {
  await withTempDir("dashboard-runtime", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "runtime dashboard",
      "--metric-name",
      "delta",
      "--direction",
      "lower",
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "0",
      "--status",
      "keep",
      "--description",
      "Zero baseline",
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "-2",
      "--status",
      "keep",
      "--description",
      "Negative improvement",
    ]);

    const exportResult = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const dashboard = await readFile(path.join(dir, "autoresearch-dashboard.html"), "utf8");
    const dom = await renderExportedDashboard(dashboard);
    const chart = dom.window.document.getElementById("trend-chart").innerHTML;
    assert.match(chart, /#1 0 keep/);
    assert.match(chart, /#2 -2 keep/);
    dom.window.close();
  });
});

test("keep commits can be scoped to experiment paths", async () => {
  await withTempDir("scoped-commit", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "scoped commit", "--metric-name", "seconds"]);
    await writeFile(path.join(dir, "tracked.txt"), "after\n", "utf8");
    await writeFile(path.join(dir, "scratch.txt"), "do not commit\n", "utf8");

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Scope the keep commit",
      "--commit-paths",
      "tracked.txt",
    ]);
    assert.equal(result.code, 0, result.stderr);

    const committed = await git(dir, ["show", "--name-only", "--format=", "HEAD"]);
    assert.match(committed, /tracked\.txt/);
    assert.doesNotMatch(committed, /scratch\.txt/);

    const status = await git(dir, ["status", "--short"]);
    assert.match(status, /\?\? scratch\.txt/);
  });
});

test("keep logs require scoped commit paths or explicit add-all in git repos", async () => {
  await withTempDir("keep-add-all-gate", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "add all gate", "--metric-name", "seconds"]);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await writeFile(path.join(dir, "tracked.txt"), "after\n", "utf8");

    const blocked = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Blocked keep",
    ]);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /commitPaths is empty/);
    assert.match(await git(dir, ["status", "--short"]), /M tracked\.txt/);

    const allowed = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Allow broad keep",
      "--allow-add-all",
    ]);
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.match(JSON.parse(allowed.stdout).git, /explicit add-all/);
  });
});

test("keep logs can record an existing commit without staging dirty work", async () => {
  await withTempDir("keep-existing-commit", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "existing commit", "--metric-name", "seconds"]);
    await writeFile(path.join(dir, "tracked.txt"), "after\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "manual experiment"]);
    const manualCommit = await git(dir, ["rev-parse", "HEAD"]);
    await writeFile(path.join(dir, "scratch.txt"), "leave dirty\n", "utf8");

    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Record existing commit",
      "--commit",
      manualCommit,
    ]);
    assert.equal(logged.code, 0, logged.stderr);
    const payload = JSON.parse(logged.stdout);
    assert.equal(payload.experiment.commit, manualCommit.slice(0, 12));
    assert.match(payload.git, /recorded existing commit/);
    assert.match(await git(dir, ["status", "--short"]), /\?\? autoresearch\.jsonl/);
    assert.match(await git(dir, ["status", "--short"]), /\?\? scratch\.txt/);
  });
});

test("doctor and dashboard stay quiet about empty commit paths until keep logging needs them", async () => {
  await withTempDir("empty-commit-path-warning", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "warning", "--metric-name", "seconds"]);
    const doctor = await runCli(["doctor", "--cwd", dir]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctorPayload = JSON.parse(doctor.stdout);
    assert.ok(
      !doctorPayload.warningDetails.some(
        (warning) => warning.code === "empty_commit_paths_in_git_repo",
      ),
    );

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.ok(
      !statePayload.warningDetails.some(
        (warning) => warning.code === "empty_commit_paths_in_git_repo",
      ),
    );

    const exported = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exported.code, 0, exported.stderr);
    const exportPayload = JSON.parse(exported.stdout);
    assert.ok(
      !exportPayload.viewModel.warnings.some(
        (warning) => warning.code === "empty_commit_paths_in_git_repo",
      ),
    );
  });
});

test("export treats missing keep commits as finalization backlog instead of trust warnings", async () => {
  await withTempDir("missing-keep-commit-preview", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "preview quiet", "--metric-name", "seconds"]);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await git(dir, ["branch", "-M", "main"]);
    await git(dir, ["checkout", "-b", "experiment"]);

    const sessionLog = [
      JSON.stringify({
        type: "config",
        name: "preview quiet",
        metricName: "seconds",
        metricUnit: "s",
        bestDirection: "lower",
      }),
      JSON.stringify({
        run: 1,
        metric: 10,
        status: "keep",
        description: "Keep baseline without commit metadata",
        timestamp: Date.now(),
        segment: 0,
        confidence: 1,
        asi: {
          evidence: "seconds=10",
          next_action_hint: "Confirm correctness before review packaging.",
        },
      }),
      "",
    ].join("\n");
    await writeFile(path.join(dir, "autoresearch.jsonl"), sessionLog, "utf8");
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "keep without commit metadata"]);

    const exported = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exported.code, 0, exported.stderr);
    const exportPayload = JSON.parse(exported.stdout);
    const trustReasons = exportPayload.viewModel.trustState.reasons.join("\n");
    assert.doesNotMatch(trustReasons, /has no commit/i);
    const previewPacket = exportPayload.viewModel.finalizationChecklist.find(
      (item) => item.label === "Preview packet",
    );
    assert.equal(previewPacket.state, "idle");
    assert.match(previewPacket.detail, /commit-backed keep logs/i);
  });
});

test("keep logs fail instead of recording success when git add fails", async () => {
  await withTempDir("keep-add-failure", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "git add failure", "--metric-name", "seconds"]);
    await writeFile(path.join(dir, "tracked.txt"), "after\n", "utf8");

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Should not be logged",
      "--commit-paths",
      "missing.txt",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Git add failed/);

    const log = await readFile(path.join(dir, "autoresearch.jsonl"), "utf8");
    assert.doesNotMatch(log, /Should not be logged/);
  });
});

test("keep logs fail instead of recording success when git commit fails", async () => {
  await withTempDir("keep-commit-failure", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);
    await mkdir(path.join(dir, ".git", "hooks"), { recursive: true });
    await writeFile(path.join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", "utf8");

    await runCli(["init", "--cwd", dir, "--name", "commit failure", "--metric-name", "seconds"]);
    await writeFile(path.join(dir, "tracked.txt"), "after\n", "utf8");

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Should not commit",
      "--commit-paths",
      "tracked.txt",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Git commit failed/);

    const log = await readFile(path.join(dir, "autoresearch.jsonl"), "utf8");
    assert.doesNotMatch(log, /Should not commit/);
  });
});

test("discard reverts scoped experiment paths without deleting unrelated dirty work", async () => {
  await withTempDir("safe-discard", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "value.txt"), "base\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "safe discard", "--metric-name", "seconds"]);
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({ commitPaths: ["src"] }, null, 2),
    );
    await git(dir, ["add", "autoresearch.jsonl", "autoresearch.config.json"]);
    await git(dir, ["commit", "-m", "session"]);

    await writeFile(path.join(dir, "src", "value.txt"), "experiment\n", "utf8");
    await writeFile(path.join(dir, "notes.txt"), "unrelated dirty work\n", "utf8");

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "2",
      "--status",
      "discard",
      "--description",
      "Discard scoped experiment",
    ]);
    assert.equal(result.code, 0, result.stderr);

    assert.equal(await readFile(path.join(dir, "src", "value.txt"), "utf8"), "base\n");
    assert.equal(await readFile(path.join(dir, "notes.txt"), "utf8"), "unrelated dirty work\n");
  });
});

test("discard without scoped paths refuses to clean a dirty git tree", async () => {
  await withTempDir("unsafe-discard", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "unsafe discard", "--metric-name", "seconds"]);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await writeFile(path.join(dir, "scratch.txt"), "unrelated\n", "utf8");

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "2",
      "--status",
      "discard",
      "--description",
      "Unsafe discard",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Refusing broad discard cleanup/);
    assert.equal(await readFile(path.join(dir, "scratch.txt"), "utf8"), "unrelated\n");
  });
});

test("clear removes deep research scratchpads", async () => {
  await withTempDir("clear-research", async (dir) => {
    await runCli([
      "research-setup",
      "--cwd",
      dir,
      "--slug",
      "cleanup",
      "--goal",
      "Cleanup research",
    ]);
    const researchRoot = path.join(dir, "autoresearch.research");
    await access(researchRoot);

    const result = await runCli(["clear", "--cwd", dir, "--yes"]);
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(access(researchRoot));
  });
});

test("clear dry-run previews deletion targets without removing files", async () => {
  await withTempDir("clear-dry-run", async (dir) => {
    await runCli([
      "research-setup",
      "--cwd",
      dir,
      "--slug",
      "preview",
      "--goal",
      "Preview cleanup",
    ]);
    const researchRoot = path.join(dir, "autoresearch.research");
    await access(researchRoot);

    const result = await runCli(["clear", "--cwd", dir, "--dry-run"]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.deleted.length, 0);
    assert.ok(payload.targets.includes(researchRoot));
    assert.ok(payload.wouldDelete.includes(researchRoot));
    await access(researchRoot);
  });
});

test("mcp clear_session dry-run previews deletion targets without confirmation", async () => {
  await withTempDir("mcp-clear-dry-run", async (dir) => {
    await runCli([
      "research-setup",
      "--cwd",
      dir,
      "--slug",
      "preview",
      "--goal",
      "Preview cleanup",
    ]);
    const researchRoot = path.join(dir, "autoresearch.research");
    await access(researchRoot);

    const response = await callMcpTool("clear_session", {
      working_dir: dir,
      dry_run: true,
    });
    assert.equal(response.result?.isError, undefined, response.result?.content?.[0]?.text);
    const payload = JSON.parse(response.result.content[0].text);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.deleted.length, 0);
    assert.ok(payload.wouldDelete.includes(researchRoot));
    await access(researchRoot);
  });
});

test("setup-plan preserves explicit command and state inputs", async () => {
  await withTempDir("setup-plan-inputs", async (dir) => {
    const benchmark = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1')"`;
    const checks = `${quoteForShell(process.execPath)} -e "process.exit(0)"`;
    const result = await runCli([
      "setup-plan",
      "--cwd",
      dir,
      "--name",
      "explicit setup",
      "--metric-name",
      "seconds",
      "--benchmark-command",
      benchmark,
      "--checks-command",
      checks,
      "--commit-paths",
      "src,tests",
      "--max-iterations",
      "7",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.match(payload.nextCommand, /--benchmark-command/);
    assert.match(payload.nextCommand, /METRIC seconds=1/);
    assert.match(payload.nextCommand, /--checks-command/);
    assert.match(payload.nextCommand, /process\.exit\(0\)/);
    assert.match(payload.nextCommand, /--commit-paths "src,tests"/);
    assert.match(payload.nextCommand, /--max-iterations "7"/);
    assert.equal(payload.benchmarkMode.printsMetric, true);
    assert.match(payload.benchmarkLintCommand, /benchmark-lint/);
    assert.deepEqual(
      payload.firstRunChecklist.map((step) => step.step),
      ["setup", "benchmark-lint", "doctor", "checkpoint", "baseline", "log"],
    );
  });
});

test("setup-plan warns when files in scope and commit paths diverge", async () => {
  await withTempDir("setup-plan-scope-warning", async (dir) => {
    const result = await runCli([
      "setup-plan",
      "--cwd",
      dir,
      "--name",
      "scope warning",
      "--metric-name",
      "seconds",
      "--benchmark-command",
      `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1')"`,
      "--files-in-scope",
      "src",
      "--commit-paths",
      "src,tests",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.match(payload.scopeWarnings.join("\n"), /tests/);
    assert.match(payload.notes.join("\n"), /Scope warning/);
  });
});

test("setup does not append elapsed metrics to explicit metric-emitting benchmarks", async () => {
  await withTempDir("setup-explicit-metric", async (dir) => {
    const benchmark = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=42')"`;
    const result = await runCli([
      "setup",
      "--cwd",
      dir,
      "--name",
      "explicit metric setup",
      "--metric-name",
      "seconds",
      "--benchmark-command",
      benchmark,
      "--commit-paths",
      "src,tests",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.ok(payload.checkpoint.paths.includes("autoresearch.md"));
    assert.ok(payload.checkpoint.paths.includes("autoresearch.config.json"));
    assert.ok(payload.checkpoint.paths.includes(".gitattributes"));
    assert.match(payload.checkpoint.commands.join("\n"), /git add --/);
    assert.equal(payload.benchmarkMode.printsMetric, true);
    assert.match(payload.benchmarkLintCommand, /benchmark-lint/);
    assert.deepEqual(
      payload.firstRunChecklist.map((step) => step.step),
      ["setup", "benchmark-lint", "doctor", "checkpoint", "baseline", "log"],
    );

    const scriptName = process.platform === "win32" ? "autoresearch.ps1" : "autoresearch.sh";
    const script = await readFile(path.join(dir, scriptName), "utf8");
    assert.match(script, /METRIC seconds=42/);
    assert.doesNotMatch(script, /Elapsed\.TotalSeconds|elapsed_seconds/);
    assert.doesNotMatch(script, /METRIC seconds=\{0\}|printf 'METRIC seconds/);

    const sessionDoc = await readFile(path.join(dir, "autoresearch.md"), "utf8");
    assert.match(sessionDoc, /`src`: in configured commit scope/);
    assert.match(sessionDoc, /`tests`: in configured commit scope/);
    assert.doesNotMatch(sessionDoc, /TBD: add files after initial inspection/);

    const attributes = await readFile(path.join(dir, ".gitattributes"), "utf8");
    assert.match(attributes, /autoresearch\.jsonl text eol=lf/);
    assert.match(attributes, /autoresearch\.md text eol=lf/);
    assert.match(attributes, /autoresearch\.ideas\.md text eol=lf/);
  });
});

test("ledger appends use LF on Windows-facing sessions", async () => {
  await withTempDir("ledger-lf", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "lf", "--metric-name", "seconds"]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Baseline",
    ]);
    const ledger = await readFile(path.join(dir, "autoresearch.jsonl"), "utf8");
    assert.doesNotMatch(ledger, /\r\n/);
    assert.match(ledger, /\n/);
  });
});

test("benchmark-inspect warns before suspicious full benchmark probes", async () => {
  await withTempDir("benchmark-inspect", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "inspect", "--metric-name", "score"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('case-a')"`;
    const result = await runCli(["benchmark-inspect", "--cwd", dir, "--command", command]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ranCommand, true);
    assert.match(payload.outputPreview, /case-a/);
    assert.match(payload.hints.join("\n"), /METRIC score=<number>/);

    const suspicious = await runCli([
      "benchmark-inspect",
      "--cwd",
      dir,
      "--command",
      "CODESTORY_PIPELINE_LIST_CASES=1 node scripts/autoresearch-indexer-embedder-pipeline.mjs",
    ]);
    assert.equal(suspicious.code, 0, suspicious.stderr);
    const suspiciousPayload = JSON.parse(suspicious.stdout);
    assert.match(suspiciousPayload.warnings.join("\n"), /CODESTORY_EMBED_RESEARCH_LIST=1/);
  });
});

test("checks-inspect catches malformed cargo checks and broad failures", async () => {
  await withTempDir("checks-inspect", async (dir) => {
    const cargoShape = `${quoteForShell(process.execPath)} -e "console.error(\\"error: unexpected argument 'build_search_state' found\\\\n\\\\nUsage: cargo.exe test [OPTIONS] [TESTNAME] [-- [ARGS]...]\\"); process.exit(1)"`;
    const shapeResult = await runCli(["checks-inspect", "--cwd", dir, "--command", cargoShape]);
    assert.equal(shapeResult.code, 0, shapeResult.stderr);
    const shapePayload = JSON.parse(shapeResult.stdout);
    assert.equal(shapePayload.ok, false);
    assert.match(shapePayload.warnings.join("\n"), /Cargo rejected/);
    assert.match(shapePayload.nextAction, /Fix command-shape/);

    const broadFailure = `${quoteForShell(process.execPath)} -e "console.error(\\"test runtime::one ... FAILED\\\\ntest semantic::two ... FAILED\\"); process.exit(1)"`;
    const broadResult = await runCli(["checks-inspect", "--cwd", dir, "--command", broadFailure]);
    assert.equal(broadResult.code, 0, broadResult.stderr);
    const broadPayload = JSON.parse(broadResult.stdout);
    assert.deepEqual(broadPayload.failedTests, ["runtime::one", "semantic::two"]);
    assert.match(broadPayload.warnings.join("\n"), /2 tests failed/);
  });
});

test("promote-gate dry-runs and appends measurement gate metadata", async () => {
  await withTempDir("promote-gate", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "gate", "--metric-name", "score"]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Baseline",
    ]);
    const dryRun = await runCli([
      "promote-gate",
      "--cwd",
      dir,
      "--reason",
      "move to 150 queries",
      "--query-count",
      "150",
      "--dry-run",
    ]);
    assert.equal(dryRun.code, 0, dryRun.stderr);
    const dryPayload = JSON.parse(dryRun.stdout);
    assert.equal(dryPayload.dryRun, true);
    assert.equal(dryPayload.entry.measurementGate.queryCount, 150);

    const confirmed = await runCli([
      "promote-gate",
      "--cwd",
      dir,
      "--reason",
      "move to 150 queries",
      "--gate-name",
      "150-query gate",
      "--query-count",
      "150",
      "--yes",
    ]);
    assert.equal(confirmed.code, 0, confirmed.stderr);
    const payload = JSON.parse(confirmed.stdout);
    assert.equal(payload.nextSegment, 1);
    assert.equal(payload.entry.measurementGate.name, "150-query gate");

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(JSON.parse(state.stdout).segment, 1);
  });
});

test("invalid iteration limits and negative extensions fail loudly", async () => {
  await withTempDir("invalid-iteration-limits", async (dir) => {
    const setup = await runCli([
      "setup",
      "--cwd",
      dir,
      "--name",
      "bad limit",
      "--metric-name",
      "seconds",
      "--max-iterations",
      "0",
    ]);
    assert.notEqual(setup.code, 0);
    assert.match(setup.stderr, /maxIterations must be a positive integer/);

    const fractionalSetup = await runCli([
      "setup",
      "--cwd",
      dir,
      "--name",
      "fractional limit",
      "--metric-name",
      "seconds",
      "--max-iterations",
      "1.5",
    ]);
    assert.notEqual(fractionalSetup.code, 0);
    assert.match(fractionalSetup.stderr, /maxIterations must be a positive integer/);

    await runCli(["init", "--cwd", dir, "--name", "config limit", "--metric-name", "seconds"]);
    const config = await runCli(["config", "--cwd", dir, "--extend", "-1"]);
    assert.notEqual(config.code, 0);
    assert.match(config.stderr, /extend must be a non-negative integer/);

    const fractionalExtend = await runCli(["config", "--cwd", dir, "--extend", "1.5"]);
    assert.notEqual(fractionalExtend.code, 0);
    assert.match(fractionalExtend.stderr, /extend must be a non-negative integer/);
  });
});

test("log accepts ASI from a JSON file", async () => {
  await withTempDir("asi-file", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "asi file", "--metric-name", "seconds"]);
    await writeFile(
      path.join(dir, "asi.json"),
      JSON.stringify({
        hypothesis: "avoid shell quoting",
        evidence: "file parsed",
        next_action_hint: "continue",
      }),
      "utf8",
    );

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "3",
      "--status",
      "keep",
      "--description",
      "Baseline",
      "--asi-file",
      "asi.json",
    ]);
    assert.equal(result.code, 0, result.stderr);

    const ledger = (await readFile(path.join(dir, "autoresearch.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const run = ledger.find((entry) => entry.run === 1);
    assert.equal(run.asi.hypothesis, "avoid shell quoting");
    assert.equal(run.asi.evidence, "file parsed");
  });
});

test("broad discard cleanup preserves deep research scratchpads", async () => {
  await withTempDir("preserve-research", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli([
      "research-setup",
      "--cwd",
      dir,
      "--slug",
      "study",
      "--goal",
      "Preserve research",
    ]);
    await writeFile(path.join(dir, "tracked.txt"), "experiment\n", "utf8");
    const gapsPath = path.join(dir, "autoresearch.research", "study", "quality-gaps.md");
    await writeFile(gapsPath, "- [ ] Preserve this scratchpad\n", "utf8");

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "discard",
      "--description",
      "Discard broad change",
      "--allow-dirty-revert",
    ]);
    assert.equal(result.code, 0, result.stderr);

    assert.equal(await readFile(path.join(dir, "tracked.txt"), "utf8"), "base\n");
    assert.equal(await readFile(gapsPath, "utf8"), "- [ ] Preserve this scratchpad\n");
  });
});

test("mcp server returns a JSON-RPC parse error for malformed JSON", async () => {
  const child = spawn(process.execPath, [mcpServer], {
    cwd: pluginRoot,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const body = "{bad json";
  child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);

  await new Promise((resolve) => setTimeout(resolve, 250));
  child.kill();

  assert.match(stdout, /Content-Length:/);
  assert.match(stdout, /"code":-32700/);
  assert.equal(stderr, "");
});

test("mcp-smoke reports direct stdio server readiness", async () => {
  const result = await runCli(["mcp-smoke"]);
  assert.equal(result.code, 0, result.stderr);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.initialize.serverInfo.name, "codex-autoresearch");
  assert.ok(payload.toolCount >= 6);
  assert.equal(payload.missingRequiredTools.length, 0);
  assert.match(payload.toolNames.join("\n"), /setup_session/);
  assert.match(payload.toolNames.join("\n"), /next_experiment/);
  assert.match(payload.toolNames.join("\n"), /checks_inspect/);
});

test("CLI parser accepts equals-form options", async () => {
  await withTempDir("equals-options", async (dir) => {
    const init = await runCli([
      "init",
      `--cwd=${dir}`,
      "--name=equals options",
      "--metric-name=seconds",
    ]);
    assert.equal(init.code, 0, init.stderr);
    const state = await runCli(["state", `--cwd=${dir}`]);
    assert.equal(state.code, 0, state.stderr);
    assert.equal(JSON.parse(state.stdout).config.metricName, "seconds");
  });
});

test("mcp tools/list uses conservative 2024-compatible tool metadata", async () => {
  const child = spawn(process.execPath, [mcpServer], {
    cwd: pluginRoot,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  child.stdin.write(
    mcpFrame({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {} },
    }),
  );
  child.stdin.write(mcpFrame({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }));
  child.stdin.write(mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));

  const response = await waitForMcpResponseById(
    () => stdout,
    () => stderr,
    2,
  );
  child.kill();

  const tools = response.result.tools;
  assert.ok(tools.length >= 6);
  for (const tool of tools) {
    assert.deepEqual(Object.keys(tool).sort(), ["description", "inputSchema", "name"]);
  }
  assert.equal(stderr, "");
});

test("mcp tools expose guidance and output contracts", async () => {
  const [
    { mcpToolSchemasWithContracts, toolSchemas },
    { validateToolContracts },
    { cliCommandForTool, toolMutates, validateToolRegistry },
  ] = await Promise.all([
    import("../lib/mcp-interface.js"),
    import("../lib/tool-contracts.js"),
    import("../lib/tool-registry.js"),
  ]);
  const contractCheck = validateToolContracts(toolSchemas);
  assert.equal(contractCheck.ok, true, contractCheck.issues.join("\n"));
  const registryCheck = validateToolRegistry(toolSchemas);
  assert.equal(registryCheck.ok, true, JSON.stringify(registryCheck));

  const guided = toolSchemas.find((tool) => tool.name === "guided_setup");
  const next = toolSchemas.find((tool) => tool.name === "next_experiment");
  const doctor = toolSchemas.find((tool) => tool.name === "doctor_session");
  const checksInspect = toolSchemas.find((tool) => tool.name === "checks_inspect");
  const serve = toolSchemas.find((tool) => tool.name === "serve_dashboard");

  assert.ok(guided);
  assert.ok(checksInspect);
  assert.ok(serve);
  assert.match(guided.description, /first-run or resume action packet/);
  assert.equal(guided.outputSchema.type, "object");
  assert.equal(next.outputSchema.type, "object");
  assert.match(next.description, /normal measured loop iteration/);
  assert.match(serve.description, /live local dashboard/);
  assert.equal(
    doctor.annotations.safety,
    "Read-only unless benchmark check runs configured commands.",
  );

  const richDoctor = mcpToolSchemasWithContracts.find((tool) => tool.name === "doctor_session");
  assert.equal(richDoctor.outputSchema.type, "object");
  assert.equal(
    richDoctor.annotations.safety,
    "Read-only unless benchmark check runs configured commands.",
  );
  assert.equal(cliCommandForTool("next_experiment"), "next");
  assert.equal(cliCommandForTool("checks_inspect"), "checks-inspect");
  assert.equal(toolMutates("next_experiment"), true);
  assert.equal(toolMutates("read_state"), false);
});

test("plugin MCP registration uses the lightweight startup entrypoint", async () => {
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, ".mcp.json"), "utf8"));
  const registration = manifest.mcpServers["codex-autoresearch"];

  assert.deepEqual(registration.args, ["./scripts/autoresearch-mcp.mjs"]);
  assert.equal(registration.startup_timeout_sec, 60);
});

test("mcp server dispatches tool calls through the CLI wrapper", async () => {
  const child = spawn(process.execPath, [mcpServer], {
    cwd: pluginRoot,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const send = (message) => {
    const body = JSON.stringify(message);
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  };
  const responseWithId = async (id) => {
    const started = Date.now();
    while (Date.now() - started < 5000) {
      const parsed = [];
      let remaining = Buffer.from(stdout, "utf8");
      for (;;) {
        const headerEnd = remaining.indexOf("\r\n\r\n");
        if (headerEnd < 0) break;
        const header = remaining.subarray(0, headerEnd).toString("utf8");
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) break;
        const length = Number(match[1]);
        const bodyStart = headerEnd + 4;
        if (remaining.length < bodyStart + length) break;
        parsed.push(JSON.parse(remaining.subarray(bodyStart, bodyStart + length).toString("utf8")));
        remaining = remaining.subarray(bodyStart + length);
      }
      const found = parsed.find((message) => message.id === id);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`No MCP response for ${id}\nstdout=${stdout}\nstderr=${stderr}`);
  };

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {} },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "setup_plan", arguments: { working_dir: pluginRoot } },
  });

  const init = await responseWithId(1);
  const tool = await responseWithId(2);
  child.kill();

  assert.equal(init.result.serverInfo.name, "codex-autoresearch");
  const payload = JSON.parse(tool.result.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.tool, "setup_plan");
  assert.equal(payload.workDir, pluginRoot);
  assert.equal(payload.result.workDir, pluginRoot);
  assert.equal(stderr, "");
});

test("mcp server dispatches guided setup through the CLI wrapper", async () => {
  await withTempDir("mcp-guided-setup", async (dir) => {
    const response = await callMcpTool("guided_setup", { working_dir: dir });
    assert.equal(response.result?.isError, undefined);

    const payload = JSON.parse(response.result.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(payload.workDir, dir);
    assert.equal(payload.setup.ok, true);
  });
});

test("mcp server rejects unknown arguments and gated command materialization", async () => {
  await withTempDir("mcp-contract-rejections", async (dir) => {
    const unknown = await callMcpTool("setup_plan", { working_dir: dir, typo_argument: true });
    assert.equal(unknown.result.isError, true);
    assert.match(unknown.result.content[0].text, /Unknown argument/);
    assert.doesNotMatch(unknown.result.content[0].text, /\n\s+at\s/);

    const gatedPlan = await callMcpTool("setup_plan", {
      working_dir: dir,
      benchmark_command: "node -e \"console.log('METRIC seconds=1')\"",
    });
    assert.equal(gatedPlan.result.isError, true);
    assert.match(gatedPlan.result.content[0].text, /allow_unsafe_command=true/);

    const readOnlyPlan = await callMcpTool("setup_plan", {
      working_dir: dir,
      name: "read only command plan",
      metric_name: "seconds",
      benchmark_command: "node -e \"console.log('METRIC seconds=1')\"",
      checks_command: 'node -e "process.exit(0)"',
      commit_paths: ["src", "tests"],
      max_iterations: 7,
      allow_unsafe_command: true,
    });
    assert.equal(readOnlyPlan.result?.isError, undefined, readOnlyPlan.result?.content?.[0]?.text);
    const readOnlyPayload = JSON.parse(readOnlyPlan.result.content[0].text);
    assert.match(readOnlyPayload.nextCommand, /--checks-command/);
    assert.match(readOnlyPayload.nextCommand, /--commit-paths "src,tests"/);
    assert.match(readOnlyPayload.nextCommand, /--max-iterations "7"/);

    const fractionalPlan = await callMcpTool("setup_plan", {
      working_dir: dir,
      max_iterations: 1.5,
    });
    assert.equal(fractionalPlan.result.isError, true);
    assert.match(fractionalPlan.result.content[0].text, /max_iterations must be an integer/);

    const gatedGuide = await callMcpTool("guided_setup", {
      working_dir: dir,
      checks_command: 'node -e "process.exit(0)"',
    });
    assert.equal(gatedGuide.result.isError, true);
    assert.match(gatedGuide.result.content[0].text, /allow_unsafe_command=true/);

    const catalog = path.join(dir, "recipes.json");
    await writeFile(
      catalog,
      JSON.stringify({
        recipes: [
          {
            id: "external-runtime",
            title: "External Runtime",
            metricName: "seconds",
            metricUnit: "s",
            direction: "lower",
            benchmarkCommand: "node -e \"console.log('METRIC seconds=1')\"",
            checksCommand: 'node -e "process.exit(0)"',
          },
        ],
      }),
      "utf8",
    );
    const gatedCatalog = await callMcpTool("setup_plan", {
      working_dir: dir,
      recipe_id: "external-runtime",
      catalog,
    });
    assert.equal(gatedCatalog.result.isError, true);
    assert.match(gatedCatalog.result.content[0].text, /allow_unsafe_command=true/);

    const readOnlyGuide = await callMcpTool("guided_setup", {
      working_dir: dir,
      name: "read only guide",
      metric_name: "seconds",
      benchmark_command: "node -e \"console.log('METRIC seconds=1')\"",
      checks_command: 'node -e "process.exit(0)"',
      commit_paths: ["src"],
      max_iterations: 3,
      allow_unsafe_command: true,
    });
    assert.equal(
      readOnlyGuide.result?.isError,
      undefined,
      readOnlyGuide.result?.content?.[0]?.text,
    );
    const guidePayload = JSON.parse(readOnlyGuide.result.content[0].text);
    assert.match(guidePayload.setup.nextCommand, /--checks-command/);
    assert.match(guidePayload.setup.nextCommand, /--commit-paths "src"/);
    assert.match(guidePayload.setup.nextCommand, /--max-iterations "3"/);

    const allowedCatalog = await callMcpTool("setup_plan", {
      working_dir: dir,
      recipe_id: "external-runtime",
      catalog,
      allow_unsafe_command: true,
    });
    assert.equal(
      allowedCatalog.result?.isError,
      undefined,
      allowedCatalog.result?.content?.[0]?.text,
    );
    const catalogPayload = JSON.parse(allowedCatalog.result.content[0].text);
    assert.match(catalogPayload.nextCommand, /--benchmark-command/);
    assert.match(catalogPayload.nextCommand, /--checks-command/);

    const fractionalExtend = await callMcpTool("configure_session", {
      working_dir: dir,
      extend: 1.5,
    });
    assert.equal(fractionalExtend.result.isError, true);
    assert.match(fractionalExtend.result.content[0].text, /extend must be an integer/);

    const gated = await callMcpTool("setup_session", {
      working_dir: dir,
      name: "unsafe setup",
      metric_name: "seconds",
      benchmark_command: "node -e \"console.log('METRIC seconds=1')\"",
    });
    assert.equal(gated.result.isError, true);
    assert.match(gated.result.content[0].text, /allow_unsafe_command=true/);
    assert.doesNotMatch(gated.result.content[0].text, /\n\s+at\s/);
  });
});

test("mcp quality-gap tools infer active research slug deterministically", async () => {
  await withTempDir("mcp-quality-gap-slug", async (dir) => {
    const alphaDir = path.join(dir, "autoresearch.research", "alpha-study");
    await mkdir(alphaDir, { recursive: true });
    await writeFile(
      path.join(alphaDir, "quality-gaps.md"),
      "- [ ] Alpha open gap\n- [x] Alpha closed gap\n",
      "utf8",
    );
    await writeFile(
      path.join(alphaDir, "synthesis.md"),
      [
        "# Research Synthesis",
        "",
        "## High-Impact Findings",
        "- Add alpha evidence guidance.",
        "",
      ].join("\n"),
      "utf8",
    );

    const measured = await callMcpTool("measure_quality_gap", { working_dir: dir });
    assert.equal(measured.result?.isError, undefined, measured.result?.content?.[0]?.text);
    const measuredPayload = JSON.parse(measured.result.content[0].text);
    assert.equal(measuredPayload.slug, "alpha-study");
    assert.equal(measuredPayload.open, 1);
    assert.deepEqual(measuredPayload.openItems, ["Alpha open gap"]);

    const candidates = await callMcpTool("gap_candidates", { working_dir: dir });
    assert.equal(candidates.result?.isError, undefined, candidates.result?.content?.[0]?.text);
    const candidatesPayload = JSON.parse(candidates.result.content[0].text);
    assert.equal(candidatesPayload.slug, "alpha-study");
    assert.equal(candidatesPayload.candidates.length, 1);

    const betaDir = path.join(dir, "autoresearch.research", "beta-study");
    await mkdir(betaDir, { recursive: true });
    await writeFile(path.join(betaDir, "quality-gaps.md"), "- [ ] Beta open gap\n", "utf8");

    const ambiguous = await callMcpTool("measure_quality_gap", { working_dir: dir });
    assert.equal(ambiguous.result?.isError, true);
    assert.match(ambiguous.result.content[0].text, /research_slug explicitly/);
    assert.match(ambiguous.result.content[0].text, /alpha-study/);
    assert.match(ambiguous.result.content[0].text, /beta-study/);

    const explicit = await callMcpTool("measure_quality_gap", {
      working_dir: dir,
      research_slug: "beta-study",
    });
    assert.equal(explicit.result?.isError, undefined, explicit.result?.content?.[0]?.text);
    const explicitPayload = JSON.parse(explicit.result.content[0].text);
    assert.equal(explicitPayload.slug, "beta-study");
    assert.equal(explicitPayload.open, 1);
  });
});

test("mcp CLI adapter forwards schema-supported options that need CLI flags", async () => {
  const { buildCliInvocationForTool, createCliToolCaller } =
    await import("../lib/mcp-cli-adapter.js");
  await withTempDir("mcp-cli-adapter", async (dir) => {
    const fakeCli = path.join(dir, "fake-cli.mjs");
    await writeFile(
      fakeCli,
      "console.log(JSON.stringify({ args: process.argv.slice(2) }));\n",
      "utf8",
    );
    const callTool = createCliToolCaller({
      cliScript: fakeCli,
      pluginRoot: dir,
      toolTimeoutSeconds: 5,
    });

    const guided = await callTool("guided_setup", {
      working_dir: dir,
      recipe_id: "node-test-runtime",
      metric_name: "seconds",
      checks_command: "npm test",
      commit_paths: ["src"],
      max_iterations: 3,
    });
    assert.deepEqual(guided.args.slice(0, 3), ["guide", "--cwd", dir]);
    assert.ok(guided.args.includes("--recipe"));
    assert.ok(guided.args.includes("--metric-name"));
    assert.ok(guided.args.includes("--checks-command"));
    assert.ok(guided.args.includes("--commit-paths"));
    assert.ok(guided.args.includes("--max-iterations"));

    const setupPlan = await callTool("setup_plan", {
      working_dir: dir,
      metric_name: "seconds",
      checks_command: "npm test",
      commit_paths: ["src", "tests"],
      max_iterations: 7,
    });
    assert.deepEqual(setupPlan.args.slice(0, 3), ["setup-plan", "--cwd", dir]);
    assert.ok(setupPlan.args.includes("--checks-command"));
    assert.ok(setupPlan.args.includes("src,tests"));
    assert.ok(setupPlan.args.includes("--max-iterations"));

    const clear = buildCliInvocationForTool("clear_session", {
      working_dir: dir,
      dry_run: true,
    });
    assert.deepEqual(clear.args.slice(0, 3), ["clear", "--cwd", dir]);
    assert.ok(clear.args.includes("--dry-run"));
    assert.equal(clear.args.includes("--yes"), false);

    const log = await callTool("log_experiment", {
      working_dir: dir,
      metric: 1,
      status: "keep",
      description: "Keep broad change",
      allow_add_all: true,
    });
    assert.ok(log.args.includes("--allow-add-all"));

    const exported = await callTool("export_dashboard", { working_dir: dir, full: true });
    assert.ok(exported.args.includes("--json-full"));

    const doctor = await callTool("doctor_session", {
      working_dir: dir,
      check_benchmark: true,
      check_installed: true,
    });
    assert.ok(doctor.args.includes("--check-benchmark"));
    assert.ok(doctor.args.includes("--check-installed"));

    const invocation = buildCliInvocationForTool(
      "gap_candidates",
      {
        working_dir: dir,
        model_command: "node model.js",
        model_timeout_seconds: 3,
      },
      { cliScript: fakeCli, cwd: dir, timeoutSeconds: 5 },
    );
    assert.equal(invocation.command, process.execPath);
    assert.deepEqual(invocation.args.slice(0, 3), [fakeCli, "gap-candidates", "--cwd"]);
    assert.ok(invocation.args.includes("--model-timeout-seconds"));
    assert.deepEqual(invocation.unsafeFields, ["model_command"]);
    assert.equal(invocation.actionPolicy, "preview");
    assert.equal(invocation.mutates, false);
    assert.equal(invocation.timeoutSeconds, 5);

    const appliedInvocation = buildCliInvocationForTool(
      "gap_candidates",
      {
        working_dir: dir,
        apply: true,
      },
      { cliScript: fakeCli, cwd: dir, timeoutSeconds: 5 },
    );
    assert.equal(appliedInvocation.actionPolicy, "state_mutation");
    assert.equal(appliedInvocation.mutates, true);
  });
});

test("mcp server rejects oversized frames before parsing", async () => {
  const child = spawn(process.execPath, [mcpServer], {
    cwd: pluginRoot,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });

  const body = "x".repeat(1024 * 1024 + 1);
  child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);

  await new Promise((resolve) => setTimeout(resolve, 250));
  child.kill();

  assert.match(stdout, /"code":-32000/);
  assert.match(stdout, /Request too large/);
});

test("metric names must match the METRIC parser grammar", async () => {
  await withTempDir("bad-metric-name", async (dir) => {
    const result = await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "bad metric",
      "--metric-name",
      "bad metric",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Metric name/);
  });
});

test("export refuses to write outside the working directory", async () => {
  await withTempDir("contained-export", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "contained export", "--metric-name", "seconds"]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Baseline",
    ]);

    const result = await runCli(["export", "--cwd", dir, "--output", "../escape.html"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /outside the working directory/);
  });
});

test("export is compact by default and full with json-full", async () => {
  await withTempDir("compact-export", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "compact export", "--metric-name", "seconds"]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Baseline",
    ]);

    const compact = await runCli(["export", "--cwd", dir]);
    assert.equal(compact.code, 0, compact.stderr);
    const compactPayload = JSON.parse(compact.stdout);
    assert.equal(compactPayload.ok, true);
    assert.equal(compactPayload.summary.runs, 1);
    assert.equal(compactPayload.best, 1);
    assert.equal(compactPayload.viewModel, undefined);
    assert.equal(compactPayload.progress.stages[0].stage, "export");

    const full = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(full.code, 0, full.stderr);
    const fullPayload = JSON.parse(full.stdout);
    assert.equal(fullPayload.viewModel.summary.runs, 1);
  });
});

test("large benchmark output is capped and marked truncated", async () => {
  await withTempDir("large-output", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "large output", "--metric-name", "seconds"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('x'.repeat(30000)); console.log('METRIC seconds=1')"`;
    const result = await runCli(["run", "--cwd", dir, "--command", command]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.outputTruncated, true);
    assert.ok(payload.tailOutput.length < 9000);
    assert.equal(payload.parsedPrimary, 1);
  });
});

test("large no-newline benchmark tails do not hide early metrics", async () => {
  await withTempDir("large-no-newline-output", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "large no newline", "--metric-name", "seconds"]);
    const command = `${quoteForShell(process.execPath)} -e "process.stdout.write('METRIC seconds=2\\n'); process.stdout.write('x'.repeat(300000))"`;
    const result = await runCli(["run", "--cwd", dir, "--command", command]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.outputTruncated, true);
    assert.ok(payload.tailOutput.length < 9000);
    assert.equal(payload.parsedPrimary, 2);
  });
});

test("large metric streams retain bounded metrics and primary evidence", async () => {
  await withTempDir("large-metric-stream", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "large metric stream",
      "--metric-name",
      "seconds",
    ]);
    const command = `${quoteForShell(process.execPath)} -e "for (let i = 0; i < 20000; i++) console.log('METRIC m' + i + '=' + i); console.log('METRIC seconds=1')"`;
    const result = await runCli(["run", "--cwd", dir, "--command", command]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.metricsTruncated, true);
    assert.equal(payload.parsedPrimary, 1);
    assert.equal(payload.parsedMetrics.seconds, 1);
    assert.ok(Object.keys(payload.parsedMetrics).length <= 513);
  });
});

test("large metric streams keep a primary metric outside retained output tails", async () => {
  await withTempDir("large-metric-primary-middle", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "large primary stream",
      "--metric-name",
      "seconds",
    ]);
    const emitter = path.join(dir, "emit-metrics.mjs");
    await writeFile(
      emitter,
      [
        "function writeMetrics(prefix, count) {",
        "  let chunk = '';",
        "  for (let i = 0; i < count; i += 1) {",
        "    chunk += `METRIC ${prefix}${i}=${i}\\n`;",
        "    if (chunk.length > 65536) { process.stdout.write(chunk); chunk = ''; }",
        "  }",
        "  if (chunk) process.stdout.write(chunk);",
        "}",
        "writeMetrics('pre', 12000);",
        "process.stdout.write('METRIC seconds=7\\n');",
        "writeMetrics('post', 90000);",
      ].join("\n"),
      "utf8",
    );
    const command = `${quoteForShell(process.execPath)} ${quoteForShell(emitter)}`;
    const result = await runCli(["run", "--cwd", dir, "--command", command]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.metricsTruncated, true);
    assert.equal(payload.parsedPrimary, 7);
    assert.equal(payload.parsedMetrics.seconds, 7);
    assert.ok(Object.keys(payload.parsedMetrics).length <= 513);
  });
});

test("next command runs preflight and benchmark as one decision packet", async () => {
  await withTempDir("next-command", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "next command", "--metric-name", "seconds"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=2')"`;
    const result = await runCli(["next", "--cwd", dir, "--command", command]);
    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.doctor.ok, true);
    assert.equal(payload.run.parsedPrimary, 2);
    assert.equal(payload.run.progress.mode, "synchronous");
    assert.equal(payload.run.progress.status, "completed");
    assert.equal(payload.run.progress.cancellable, false);
    assert.equal(payload.run.progress.cancelStatus, "not_requested");
    assert.equal(payload.run.progress.stages[0].stage, "benchmark");
    assert.equal(payload.run.progress.stages[0].status, "completed");
    assert.match(payload.run.progress.latestOutputTail, /METRIC seconds=2/);
    assert.deepEqual(payload.decision.allowedStatuses, ["keep", "discard"]);
    assert.equal(payload.decision.suggestedStatus, "keep");
    assert.equal(payload.decision.safeSuggestedStatus, "keep");
    assert.match(payload.decision.statusGuidance, /Safe to consider keep/);
    assert.ok(Array.isArray(payload.decision.lanePortfolio));
    assert.ok(payload.decision.diversityGuidance);
    assert.match(payload.nextAction, /Log this run/);
  });
});

test("dashboard renders an operator readout from ASI and failures", async () => {
  await withTempDir("dashboard-readout", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "dashboard readout",
      "--metric-name",
      "seconds",
      "--metric-unit",
      "s",
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "10",
      "--status",
      "keep",
      "--description",
      "Baseline",
      "--asi",
      JSON.stringify({
        hypothesis: "baseline",
        family: "baseline",
        lane: "incumbent-confirmation",
        next_action_hint: "try caching",
      }),
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "7",
      "--status",
      "keep",
      "--description",
      "Cache package metadata",
      "--asi",
      JSON.stringify({
        hypothesis: "metadata cache removes repeated filesystem scans",
        family: "metadata cache",
        lane: "near-neighbor",
        evidence: "seconds improved from 10 to 7",
        next_action_hint: "measure memory impact next",
      }),
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "12",
      "--status",
      "discard",
      "--description",
      "Inline all parsing",
      "--asi",
      JSON.stringify({
        family: "parser inlining",
        lane: "near-neighbor",
        rollback_reason: "slower and harder to read",
        next_action_hint: "avoid parser inlining",
      }),
    ]);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.ok(statePayload.memory.families.length >= 2);
    assert.equal(typeof statePayload.memory.plateau.detected, "boolean");
    assert.equal(typeof statePayload.memory.novelty.score, "number");
    assert.ok(statePayload.memory.lanePortfolio.some((lane) => lane.id === "measurement-quality"));
    assert.ok(statePayload.memory.diversityGuidance);

    const exportResult = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const payload = JSON.parse(exportResult.stdout);
    const dashboard = await readFile(path.join(dir, "autoresearch-dashboard.html"), "utf8");

    assert.match(dashboard, /Codex brief/);
    assert.match(dashboard, /Best kept change/);
    assert.match(dashboard, /Recent failures/);
    assert.match(dashboard, /Next action/);
    assert.match(dashboard, /Experiment portfolio/);
    assert.match(dashboard, /lower is better/);
    assert.ok(payload.viewModel.nextBestAction.detail);
    assert.ok(payload.viewModel.nextBestAction.explanation.why);
    assert.ok(payload.viewModel.nextBestAction.explanation.avoids);
    assert.ok(payload.viewModel.nextBestAction.explanation.proof);
    assert.ok(
      payload.viewModel.nextBestAction.command || payload.viewModel.nextBestAction.safeAction,
    );
    assert.match(payload.viewModel.aiSummary.happened.join(" "), /runs/);
    assert.match(
      payload.viewModel.aiSummary.plan.join(" "),
      /avoid parser inlining|comparison anchor/i,
    );
    assert.equal(payload.viewModel.experimentMemory.latestNextAction, "avoid parser inlining");
    assert.equal(payload.viewModel.portfolio.families.length > 0, true);
    assert.equal(
      payload.viewModel.portfolio.lanes.some((lane) => lane.id === "measurement-quality"),
      true,
    );
    assert.equal(typeof payload.viewModel.portfolio.plateau.detected, "boolean");
    assert.equal(payload.progress.mode, "synchronous");
    assert.equal(payload.progress.status, "completed");
    assert.equal(payload.progress.stages[0].stage, "export");
  });
});

test("dashboard does not recommend next when manual metrics have no benchmark command", async () => {
  await withTempDir("dashboard-manual-no-command", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "manual metrics", "--metric-name", "seconds"]);
    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "5",
      "--status",
      "keep",
      "--description",
      "Manual baseline",
    ]);
    assert.equal(log.code, 0, log.stderr);

    const exportResult = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const payload = JSON.parse(exportResult.stdout);

    assert.equal(payload.viewModel.guidedSetup.stage, "needs-benchmark-command");
    assert.equal(payload.viewModel.setup.defaultBenchmarkCommandReady, false);
    assert.equal(payload.viewModel.nextBestAction.kind, "benchmark-command");
    assert.match(payload.viewModel.nextBestAction.title, /benchmark command/i);
    assert.doesNotMatch(payload.viewModel.nextBestAction.title, /next measured/i);
  });
});

test("dashboard surfaces stale last-run packets before normal next guidance", async () => {
  await withTempDir("dashboard-stale-last-run", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "stale dashboard", "--metric-name", "seconds"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);
    const directLog = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "2",
      "--status",
      "keep",
      "--description",
      "Manual run",
    ]);
    assert.equal(directLog.code, 0, directLog.stderr);

    const exportResult = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const payload = JSON.parse(exportResult.stdout);

    assert.equal(payload.viewModel.guidedSetup.stage, "stale-last-run");
    assert.equal(payload.viewModel.lastRun.freshness.fresh, false);
    assert.equal(payload.viewModel.nextBestAction.kind, "stale-packet");
    assert.match(payload.viewModel.guidedSetup.commands.replaceLast, /--command/);
    assert.match(payload.viewModel.guidedSetup.commands.replaceLast, /METRIC seconds=3/);
    assert.match(payload.viewModel.guidedSetup.commands.replaceLast, /--checks-policy "manual"/);
    assert.equal(
      payload.viewModel.nextBestAction.command,
      payload.viewModel.guidedSetup.commands.replaceLast,
    );
    assert.match(payload.viewModel.nextBestAction.detail, /Last-run packet is stale/);
    assert.match(payload.viewModel.readout.nextAction, /Last-run packet is stale/);
  });
});

test("doctor summarizes readiness and detects missing benchmark metrics", async () => {
  await withTempDir("doctor", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "doctor", "--metric-name", "seconds"]);

    const command = `${quoteForShell(process.execPath)} -e "console.log('no metric')"`;
    const result = await runCli([
      "doctor",
      "--cwd",
      dir,
      "--command",
      command,
      "--check-benchmark",
    ]);
    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.benchmark.checked, true);
    assert.equal(payload.benchmark.emitsPrimary, false);
    assert.equal(payload.benchmark.progress.mode, "synchronous");
    assert.equal(payload.benchmark.progress.status, "failed");
    assert.equal(payload.benchmark.progress.cancellable, false);
    assert.equal(payload.benchmark.progress.stages[0].stage, "benchmark");
    assert.match(payload.issues.join("\n"), /primary metric/);
    assert.match(payload.nextAction, /benchmark/i);
  });
});

test("drift report warns when installed Codex MCP runtime lags source", async () => {
  const { buildDriftReport } = await import("../lib/drift-doctor.js");
  const report = await buildDriftReport({
    pluginRoot,
    includeInstalled: true,
    inspectInstalled: async () => ({
      ok: true,
      available: true,
      pluginName: "codex-autoresearch",
      path: "C:\\Users\\alber\\.codex\\plugins\\cache\\thegreencedar-autoresearch\\codex-autoresearch\\0.5.1\\.",
      version: "0.5.1",
    }),
  });

  assert.equal(report.ok, false);
  assert.equal(report.local.version, "1.1.0");
  assert.equal(report.installed.version, "0.5.1");
  assert.match(report.warnings.join("\n"), /Installed Codex MCP runtime is 0\.5\.1/);
  assert.match(report.warnings.join("\n"), /restart Codex/);
});

test("runShell configures a POSIX process group for timeout cleanup", async () => {
  const [shim, runner] = await Promise.all([
    readFile(cli, "utf8"),
    readFile(path.join(pluginRoot, "lib", "runner.ts"), "utf8"),
  ]);
  assert.match(shim, /await import\(new URL\("\.\.\/dist\/scripts\/autoresearch\.mjs"/);
  assert.match(runner, /detached:\s*process\.platform !== "win32"/);
});
