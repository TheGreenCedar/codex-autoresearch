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

const createDashboardElement = (id) => ({ id, textContent: "", innerHTML: "", className: "", onchange: null });

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
    assert.match(dashboard, /Ready to finalize/);
    assert.match(dashboard, /renderSegmentSelector/);
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
  const child = spawn(process.execPath, [cli, "--mcp"], {
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

test("mcp server rejects oversized frames before parsing", async () => {
  const child = spawn(process.execPath, [cli, "--mcp"], {
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
    assert.deepEqual(payload.decision.allowedStatuses, ["keep", "discard"]);
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
      "--asi", JSON.stringify({ hypothesis: "baseline", next_action_hint: "try caching" }),
    ]);
    await runCli([
      "log",
      "--cwd", dir,
      "--metric", "7",
      "--status", "keep",
      "--description", "Cache package metadata",
      "--asi", JSON.stringify({
        hypothesis: "metadata cache removes repeated filesystem scans",
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
        rollback_reason: "slower and harder to read",
        next_action_hint: "avoid parser inlining",
      }),
    ]);

    const exportResult = await runCli(["export", "--cwd", dir]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const dashboard = await readFile(path.join(dir, "autoresearch-dashboard.html"), "utf8");

    assert.match(dashboard, /Operator readout/);
    assert.match(dashboard, /Best kept change/);
    assert.match(dashboard, /Recent failures/);
    assert.match(dashboard, /Next action/);
    assert.match(dashboard, /lower is better/);
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
    assert.match(payload.issues.join("\n"), /primary metric/);
    assert.match(payload.nextAction, /benchmark/i);
  });
});

test("runShell configures a POSIX process group for timeout cleanup", async () => {
  const source = await readFile(cli, "utf8");
  assert.match(source, /detached:\s*process\.platform !== "win32"/);
});
