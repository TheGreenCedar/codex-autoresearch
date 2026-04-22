import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, "..");
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

const createDashboardElement = (id) => ({
  id,
  textContent: "",
  innerHTML: "",
  className: "",
  onchange: null,
  onclick: null,
  dataset: {},
  setAttribute(name, value) {
    this[name] = value;
  },
  querySelectorAll() {
    return [];
  },
});

const getDashboardElement = (elements, id) => {
  if (!elements.has(id)) {
    elements.set(id, createDashboardElement(id));
  }
  return elements.get(id);
};

const createDashboardDocument = (elements) => ({
  getElementById: (id) => getDashboardElement(elements, id),
});

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
      "--cwd", dir,
      "--slug", "Project Study",
      "--goal", "Study the project before improving it",
      "--max-iterations", "7",
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
    assert.match(await readFile(path.join(researchRoot, "synthesis.md"), "utf8"), /Quality-Gap Translation/);
    assert.match(await readFile(path.join(researchRoot, "quality-gaps.md"), "utf8"), /- \[ \]/);

    const scriptName = process.platform === "win32" ? "autoresearch.ps1" : "autoresearch.sh";
    const benchmark = await readFile(path.join(dir, scriptName), "utf8");
    assert.match(benchmark, /quality-gap/);
    assert.match(benchmark, /project-study/);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    assert.equal(JSON.parse(state.stdout).config.metricName, "quality_gap");

    const exportResult = await runCli(["export", "--cwd", dir]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const exportPayload = JSON.parse(exportResult.stdout);
    assert.match(exportPayload.modeGuidance.difference, /read-only snapshot/);
    const dashboard = await readFile(path.join(dir, "autoresearch-dashboard.html"), "utf8");
    assert.match(dashboard, /"deliveryMode":"static-export"/);
    assert.match(dashboard, /Read-only snapshot/);
    assert.match(dashboard, /Serve dashboard/);
    assert.match(dashboard, /--research-slug \\"project-study\\"/);
    assert.match(dashboard, /activeResearchSlug/);
  });
});

test("quality-gap counts checked and unchecked research gaps", async () => {
  await withTempDir("quality-gap", async (dir) => {
    await runCli(["research-setup", "--cwd", dir, "--slug", "study", "--goal", "Study quality gaps"]);
    await writeFile(path.join(dir, "autoresearch.research", "study", "quality-gaps.md"), [
      "# Quality Gaps",
      "",
      "- [ ] Open gap",
      "- [x] Closed gap",
      "- [X] Rejected with evidence",
      "- [ ] Another open gap",
      "- plain note",
      "",
    ].join("\n"));

    const result = await runCli(["quality-gap", "--cwd", dir, "--research-slug", "study"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /METRIC quality_gap=2/);
    assert.match(result.stdout, /METRIC quality_total=4/);
    assert.match(result.stdout, /METRIC quality_closed=2/);

    const listed = await runCli(["quality-gap", "--cwd", dir, "--research-slug", "study", "--list"]);
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
    const log = await runCli(["log", "--cwd", dir, "--metric", "0", "--status", "keep", "--description", "Reach zero failures"]);
    assert.equal(log.code, 0, log.stderr);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.equal(payload.baseline, 0);
    assert.equal(payload.best, 0);

    const exportResult = await runCli(["export", "--cwd", dir]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const dashboard = await readFile(path.join(dir, "autoresearch-dashboard.html"), "utf8");
    assert.match(dashboard, /Reach zero failures/);
  });
});

test("state supports negative metrics when lower is better", async () => {
  await withTempDir("negative-metric", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "negative metric", "--metric-name", "delta", "--direction", "lower"]);
    await runCli(["log", "--cwd", dir, "--metric", "1", "--status", "keep", "--description", "Baseline positive delta"]);
    await runCli(["log", "--cwd", dir, "--metric", "-2", "--status", "keep", "--description", "Beat baseline below zero"]);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.equal(payload.baseline, 1);
    assert.equal(payload.best, -2);

    const exportResult = await runCli(["export", "--cwd", dir]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const dashboard = await readFile(path.join(dir, "autoresearch-dashboard.html"), "utf8");
    assert.match(dashboard, /const low = min < 0/);
    assert.doesNotMatch(dashboard, /run\.metric <= 0/);
    assert.match(dashboard, /Math\.abs\(baseline\)/);
  });
});

test("discarded metrics do not become best or suppress on-improvement checks", async () => {
  await withTempDir("discarded-best", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "discarded best", "--metric-name", "seconds", "--direction", "lower"]);
    await runCli(["log", "--cwd", dir, "--metric", "10", "--status", "keep", "--description", "Baseline"]);
    await runCli(["log", "--cwd", dir, "--metric", "5", "--status", "discard", "--description", "Faster but rejected"]);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    assert.equal(JSON.parse(state.stdout).best, 10);

    const checksFile = process.platform === "win32" ? "autoresearch.checks.ps1" : "autoresearch.checks.sh";
    const checksBody = process.platform === "win32" ? "exit 1\n" : "#!/bin/sh\nexit 1\n";
    await writeFile(path.join(dir, checksFile), checksBody, "utf8");

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=7')"`;
    const result = await runCli(["run", "--cwd", dir, "--command", command, "--checks-policy", "on-improvement"]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.improvesPrimary, true);
    assert.equal(payload.checks?.passed, false);
    assert.equal(payload.ok, false);
    assert.deepEqual(payload.logHint.allowedStatuses, ["checks_failed"]);
  });
});

test("dashboard includes segment and finalize-readiness cockpit controls", async () => {
  await withTempDir("dashboard-cockpit", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "first segment", "--metric-name", "seconds"]);
    await runCli(["log", "--cwd", dir, "--metric", "4", "--status", "keep", "--description", "Baseline"]);
    await runCli(["init", "--cwd", dir, "--name", "second segment", "--metric-name", "seconds"]);
    await runCli(["log", "--cwd", dir, "--metric", "3", "--status", "keep", "--description", "Second baseline"]);

    const exportResult = await runCli(["export", "--cwd", dir]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const dashboard = await readFile(path.join(dir, "autoresearch-dashboard.html"), "utf8");

    assert.match(dashboard, /id="segment-select"/);
    assert.match(dashboard, /id="live-toggle"/);
    assert.match(dashboard, /id="command-grid"/);
    assert.match(dashboard, /Mission control/);
    assert.match(dashboard, /id="mission-control-grid"/);
    assert.match(dashboard, /id="run-log-decision"/);
    assert.match(dashboard, /const meta = \{/);
    assert.match(dashboard, /!clipboard\?\.writeText/);
    assert.match(dashboard, /Ready to finalize/);
    assert.match(dashboard, /renderSegmentSelector/);
  });
});

test("config persists operator settings and extends iteration limits", async () => {
  await withTempDir("operator-config", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "operator config", "--metric-name", "seconds"]);
    await runCli(["log", "--cwd", dir, "--metric", "5", "--status", "keep", "--description", "Baseline"]);

    const result = await runCli([
      "config",
      "--cwd", dir,
      "--autonomy-mode", "owner-autonomous",
      "--checks-policy", "on-improvement",
      "--keep-policy", "primary-or-risk-reduction",
      "--dashboard-refresh-seconds", "2",
      "--extend", "4",
      "--commit-paths", "src,tests",
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

    const next = await runCli(["next", "--cwd", dir, "--command", command, "--checks-policy", "manual"]);
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
      "--cwd", dir,
      "--from-last",
      "--status", "discard",
      "--description", "Discard cached packet",
    ]);
    assert.equal(log.code, 0, log.stderr);
    const payload = JSON.parse(log.stdout);
    assert.equal(payload.experiment.metric, 3);
    assert.equal(payload.experiment.metrics.cache_hits, 8);
    assert.equal(payload.lastRunCleared, true);
    await assert.rejects(access(packet.lastRunPath));

    const duplicate = await runCli([
      "log",
      "--cwd", dir,
      "--from-last",
      "--status", "discard",
      "--description", "Duplicate cached packet",
    ]);
    assert.notEqual(duplicate.code, 0);
    assert.match(duplicate.stderr, /No last-run packet/);
  });
});

test("successful last-run packets require explicit status and suggest discard for regressions", async () => {
  await withTempDir("last-run-suggest-discard", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "suggest discard", "--metric-name", "seconds", "--direction", "lower"]);
    await runCli(["log", "--cwd", dir, "--metric", "3", "--status", "keep", "--description", "Baseline"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=4')"`;

    const next = await runCli(["next", "--cwd", dir, "--command", command, "--checks-policy", "manual"]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.decision.suggestedStatus, "discard");
    assert.deepEqual(packet.decision.allowedStatuses, ["keep", "discard"]);

    const missingStatus = await runCli(["log", "--cwd", dir, "--from-last", "--description", "No status"]);
    assert.notEqual(missingStatus.code, 0);
    assert.match(missingStatus.stderr, /status is required/);

    const discard = await runCli([
      "log",
      "--cwd", dir,
      "--from-last",
      "--status", "discard",
      "--description", "Discard slower run",
    ]);
    assert.equal(discard.code, 0, discard.stderr);
    assert.equal(JSON.parse(discard.stdout).experiment.status, "discard");
  });
});

test("stale last-run packets are rejected when history advances", async () => {
  await withTempDir("stale-last-run", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "stale packet", "--metric-name", "seconds"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const next = await runCli(["next", "--cwd", dir, "--command", command, "--checks-policy", "manual"]);
    assert.equal(next.code, 0, next.stderr);

    const directLog = await runCli(["log", "--cwd", dir, "--metric", "2", "--status", "keep", "--description", "Manual run"]);
    assert.equal(directLog.code, 0, directLog.stderr);

    const stale = await runCli([
      "log",
      "--cwd", dir,
      "--from-last",
      "--status", "keep",
      "--description", "Old packet",
    ]);
    assert.notEqual(stale.code, 0);
    assert.match(stale.stderr, /Last-run packet is stale/);
  });
});

test("last-run packets are rejected when config changes before logging", async () => {
  await withTempDir("config-stale-last-run", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "first config", "--metric-name", "seconds"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const next = await runCli(["next", "--cwd", dir, "--command", command, "--checks-policy", "manual"]);
    assert.equal(next.code, 0, next.stderr);

    const secondConfig = await runCli(["init", "--cwd", dir, "--name", "second config", "--metric-name", "points", "--direction", "higher"]);
    assert.equal(secondConfig.code, 0, secondConfig.stderr);

    const stale = await runCli([
      "log",
      "--cwd", dir,
      "--from-last",
      "--status", "keep",
      "--description", "Old metric packet",
    ]);
    assert.notEqual(stale.code, 0);
    assert.match(stale.stderr, /session config changed/);
  });
});

test("owner-autonomous runs return continuation instead of handing control back", async () => {
  await withTempDir("continuation", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "continuation", "--metric-name", "seconds"]);
    await runCli(["config", "--cwd", dir, "--autonomy-mode", "owner-autonomous", "--checks-policy", "manual"]);
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
      "--cwd", dir,
      "--from-last",
      "--status", "keep",
      "--description", "Keep baseline",
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

test("continuation stops cleanly at the configured iteration limit", async () => {
  await withTempDir("continuation-limit", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "continuation limit", "--metric-name", "seconds"]);
    await runCli([
      "config",
      "--cwd", dir,
      "--autonomy-mode", "owner-autonomous",
      "--checks-policy", "manual",
      "--max-iterations", "1",
    ]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;

    const next = await runCli(["next", "--cwd", dir, "--command", command]);
    assert.equal(next.code, 0, next.stderr);
    const log = await runCli([
      "log",
      "--cwd", dir,
      "--from-last",
      "--status", "keep",
      "--description", "Limit baseline",
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

    const next = await runCli(["next", "--cwd", dir, "--command", command, "--checks-command", checks]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.deepEqual(packet.decision.allowedStatuses, ["checks_failed"]);

    const log = await runCli([
      "log",
      "--cwd", dir,
      "--from-last",
      "--status", "keep",
      "--description", "Should not keep failed checks",
    ]);
    assert.notEqual(log.code, 0);
    assert.match(log.stderr, /Cannot log status 'keep'/);

    const jsonl = await readFile(path.join(dir, "autoresearch.jsonl"), "utf8");
    assert.doesNotMatch(jsonl, /Should not keep failed checks/);
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
    const next = await runCli(["next", "--cwd", dir, "--command", command, "--checks-policy", "manual"]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.doesNotMatch(packet.lastRunPath, /autoresearch\.last-run\.json$/);

    const statusBeforeLog = await git(dir, ["status", "--short"]);
    assert.equal(statusBeforeLog, "");

    const log = await runCli([
      "log",
      "--cwd", dir,
      "--from-last",
      "--status", "discard",
      "--description", "Discard clean packet",
    ]);
    assert.equal(log.code, 0, log.stderr);
    const payload = JSON.parse(log.stdout);
    assert.equal(payload.experiment.metric, 3);
  });
});

test("config extend is based on the active segment run count", async () => {
  await withTempDir("segment-extend", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "first segment", "--metric-name", "seconds"]);
    await runCli(["log", "--cwd", dir, "--metric", "5", "--status", "keep", "--description", "Baseline"]);
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
    await runCli(["init", "--cwd", dir, "--name", "runtime dashboard", "--metric-name", "delta", "--direction", "lower"]);
    await runCli(["log", "--cwd", dir, "--metric", "0", "--status", "keep", "--description", "Zero baseline"]);
    await runCli(["log", "--cwd", dir, "--metric", "-2", "--status", "keep", "--description", "Negative improvement"]);

    const exportResult = await runCli(["export", "--cwd", dir]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const dashboard = await readFile(path.join(dir, "autoresearch-dashboard.html"), "utf8");
    const script = dashboard.match(/<script>([\s\S]*)<\/script>/)?.[1];
    assert.ok(script);

    const elements = new Map();
    const document = createDashboardDocument(elements);
    vm.runInNewContext(script, { document, console });

    const chart = elements.get("trend-chart").innerHTML;
    assert.match(chart, /#1 0 keep/);
    assert.match(chart, /#2 -2 keep/);
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
      "--cwd", dir,
      "--metric", "1",
      "--status", "keep",
      "--description", "Scope the keep commit",
      "--commit-paths", "tracked.txt",
    ]);
    assert.equal(result.code, 0, result.stderr);

    const committed = await git(dir, ["show", "--name-only", "--format=", "HEAD"]);
    assert.match(committed, /tracked\.txt/);
    assert.doesNotMatch(committed, /scratch\.txt/);

    const status = await git(dir, ["status", "--short"]);
    assert.match(status, /\?\? scratch\.txt/);
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
      "--cwd", dir,
      "--metric", "1",
      "--status", "keep",
      "--description", "Should not be logged",
      "--commit-paths", "missing.txt",
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
      "--cwd", dir,
      "--metric", "1",
      "--status", "keep",
      "--description", "Should not commit",
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
    await writeFile(path.join(dir, "autoresearch.config.json"), JSON.stringify({ commitPaths: ["src"] }, null, 2));
    await git(dir, ["add", "autoresearch.jsonl", "autoresearch.config.json"]);
    await git(dir, ["commit", "-m", "session"]);

    await writeFile(path.join(dir, "src", "value.txt"), "experiment\n", "utf8");
    await writeFile(path.join(dir, "notes.txt"), "unrelated dirty work\n", "utf8");

    const result = await runCli([
      "log",
      "--cwd", dir,
      "--metric", "2",
      "--status", "discard",
      "--description", "Discard scoped experiment",
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
      "--cwd", dir,
      "--metric", "2",
      "--status", "discard",
      "--description", "Unsafe discard",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Refusing broad discard cleanup/);
    assert.equal(await readFile(path.join(dir, "scratch.txt"), "utf8"), "unrelated\n");
  });
});

test("clear removes deep research scratchpads", async () => {
  await withTempDir("clear-research", async (dir) => {
    await runCli(["research-setup", "--cwd", dir, "--slug", "cleanup", "--goal", "Cleanup research"]);
    const researchRoot = path.join(dir, "autoresearch.research");
    await access(researchRoot);

    const result = await runCli(["clear", "--cwd", dir, "--yes"]);
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(access(researchRoot));
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

    await runCli(["research-setup", "--cwd", dir, "--slug", "study", "--goal", "Preserve research"]);
    await writeFile(path.join(dir, "tracked.txt"), "experiment\n", "utf8");
    const gapsPath = path.join(dir, "autoresearch.research", "study", "quality-gaps.md");
    await writeFile(gapsPath, "- [ ] Preserve this scratchpad\n", "utf8");

    const result = await runCli([
      "log",
      "--cwd", dir,
      "--metric", "1",
      "--status", "discard",
      "--description", "Discard broad change",
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

  child.stdin.write(mcpFrame({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {} },
  }));
  child.stdin.write(mcpFrame({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }));
  child.stdin.write(mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));

  const response = await waitForMcpResponseById(() => stdout, () => stderr, 2);
  child.kill();

  const tools = response.result.tools;
  assert.ok(tools.length >= 6);
  for (const tool of tools) {
    assert.deepEqual(Object.keys(tool).sort(), ["description", "inputSchema", "name"]);
  }
  assert.equal(stderr, "");
});

test("mcp tools expose guidance and output contracts", async () => {
  const [{ toolSchemas }, { validateToolContracts }] = await Promise.all([
    import("../lib/mcp-interface.mjs"),
    import("../lib/tool-contracts.mjs"),
  ]);
  const contractCheck = validateToolContracts(toolSchemas);
  assert.equal(contractCheck.ok, true, contractCheck.issues.join("\n"));

  const guided = toolSchemas.find((tool) => tool.name === "guided_setup");
  const next = toolSchemas.find((tool) => tool.name === "next_experiment");
  const doctor = toolSchemas.find((tool) => tool.name === "doctor_session");

  assert.ok(guided);
  assert.match(guided.description, /first-run or resume action packet/);
  assert.equal(guided.outputSchema.type, "object");
  assert.equal(next.outputSchema.type, "object");
  assert.match(next.description, /normal measured loop iteration/);
  assert.equal(doctor.annotations.safety, "Read-only unless benchmark check runs configured commands.");
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

  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "setup_plan", arguments: { working_dir: pluginRoot } } });

  const init = await responseWithId(1);
  const tool = await responseWithId(2);
  child.kill();

  assert.equal(init.result.serverInfo.name, "codex-autoresearch");
  const payload = JSON.parse(tool.result.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.workDir, pluginRoot);
  assert.equal(stderr, "");
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
    const result = await runCli(["init", "--cwd", dir, "--name", "bad metric", "--metric-name", "bad metric"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Metric name/);
  });
});

test("export refuses to write outside the working directory", async () => {
  await withTempDir("contained-export", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "contained export", "--metric-name", "seconds"]);
    await runCli(["log", "--cwd", dir, "--metric", "1", "--status", "keep", "--description", "Baseline"]);

    const result = await runCli(["export", "--cwd", dir, "--output", "../escape.html"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /outside the working directory/);
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
    await runCli(["init", "--cwd", dir, "--name", "dashboard readout", "--metric-name", "seconds", "--metric-unit", "s"]);
    await runCli([
      "log",
      "--cwd", dir,
      "--metric", "10",
      "--status", "keep",
      "--description", "Baseline",
      "--asi", JSON.stringify({ hypothesis: "baseline", family: "baseline", lane: "incumbent-confirmation", next_action_hint: "try caching" }),
    ]);
    await runCli([
      "log",
      "--cwd", dir,
      "--metric", "7",
      "--status", "keep",
      "--description", "Cache package metadata",
      "--asi", JSON.stringify({
        hypothesis: "metadata cache removes repeated filesystem scans",
        family: "metadata cache",
        lane: "near-neighbor",
        evidence: "seconds improved from 10 to 7",
        next_action_hint: "measure memory impact next",
      }),
    ]);
    await runCli([
      "log",
      "--cwd", dir,
      "--metric", "12",
      "--status", "discard",
      "--description", "Inline all parsing",
      "--asi", JSON.stringify({
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

    const exportResult = await runCli(["export", "--cwd", dir]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const payload = JSON.parse(exportResult.stdout);
    const dashboard = await readFile(path.join(dir, "autoresearch-dashboard.html"), "utf8");

    assert.match(dashboard, /Operator readout/);
    assert.match(dashboard, /Best kept change/);
    assert.match(dashboard, /Recent failures/);
    assert.match(dashboard, /Next action/);
    assert.match(dashboard, /Next best action/);
    assert.match(dashboard, /Decision explanation/);
    assert.match(dashboard, /Experiment portfolio/);
    assert.match(dashboard, /lower is better/);
    assert.ok(payload.viewModel.nextBestAction.detail);
    assert.ok(payload.viewModel.nextBestAction.explanation.why);
    assert.ok(payload.viewModel.nextBestAction.explanation.avoids);
    assert.ok(payload.viewModel.nextBestAction.explanation.proof);
    assert.ok(payload.viewModel.nextBestAction.command || payload.viewModel.nextBestAction.safeAction);
    assert.equal(payload.viewModel.experimentMemory.latestNextAction, "avoid parser inlining");
    assert.equal(payload.viewModel.portfolio.families.length > 0, true);
    assert.equal(payload.viewModel.portfolio.lanes.some((lane) => lane.id === "measurement-quality"), true);
    assert.equal(typeof payload.viewModel.portfolio.plateau.detected, "boolean");
    assert.equal(payload.progress.mode, "synchronous");
    assert.equal(payload.progress.status, "completed");
    assert.equal(payload.progress.stages[0].stage, "export");
  });
});

test("dashboard does not recommend next when manual metrics have no benchmark command", async () => {
  await withTempDir("dashboard-manual-no-command", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "manual metrics", "--metric-name", "seconds"]);
    const log = await runCli(["log", "--cwd", dir, "--metric", "5", "--status", "keep", "--description", "Manual baseline"]);
    assert.equal(log.code, 0, log.stderr);

    const exportResult = await runCli(["export", "--cwd", dir]);
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
    const next = await runCli(["next", "--cwd", dir, "--command", command, "--checks-policy", "manual"]);
    assert.equal(next.code, 0, next.stderr);
    const directLog = await runCli(["log", "--cwd", dir, "--metric", "2", "--status", "keep", "--description", "Manual run"]);
    assert.equal(directLog.code, 0, directLog.stderr);

    const exportResult = await runCli(["export", "--cwd", dir]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const payload = JSON.parse(exportResult.stdout);

    assert.equal(payload.viewModel.guidedSetup.stage, "stale-last-run");
    assert.equal(payload.viewModel.lastRun.freshness.fresh, false);
    assert.equal(payload.viewModel.nextBestAction.kind, "stale-packet");
    assert.match(payload.viewModel.guidedSetup.commands.replaceLast, /--command/);
    assert.match(payload.viewModel.guidedSetup.commands.replaceLast, /METRIC seconds=3/);
    assert.match(payload.viewModel.guidedSetup.commands.replaceLast, /--checks-policy "manual"/);
    assert.equal(payload.viewModel.nextBestAction.command, payload.viewModel.guidedSetup.commands.replaceLast);
    assert.match(payload.viewModel.nextBestAction.detail, /Last-run packet is stale/);
    assert.match(payload.viewModel.readout.nextAction, /Last-run packet is stale/);
  });
});

test("doctor summarizes readiness and detects missing benchmark metrics", async () => {
  await withTempDir("doctor", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "doctor", "--metric-name", "seconds"]);

    const command = `${quoteForShell(process.execPath)} -e "console.log('no metric')"`;
    const result = await runCli(["doctor", "--cwd", dir, "--command", command, "--check-benchmark"]);
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

test("runShell configures a POSIX process group for timeout cleanup", async () => {
  const source = await readFile(cli, "utf8");
  assert.match(source, /detached:\s*process\.platform !== "win32"/);
});
