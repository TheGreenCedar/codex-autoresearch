#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SESSION_FILES = [
  "autoresearch.jsonl",
  "autoresearch.md",
  "autoresearch.ideas.md",
  "autoresearch.sh",
  "autoresearch.ps1",
  "autoresearch.checks.sh",
  "autoresearch.checks.ps1",
  "autoresearch.config.json",
];

const STATUS_VALUES = new Set(["keep", "discard", "crash", "checks_failed"]);
const DEFAULT_TIMEOUT_SECONDS = 600;
const DEFAULT_CHECKS_TIMEOUT_SECONDS = 300;
const OUTPUT_MAX_LINES = 20;
const OUTPUT_MAX_BYTES = 8192;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "..");
const DASHBOARD_TEMPLATE_PATH = path.join(PLUGIN_ROOT, "assets", "template.html");
const DASHBOARD_DATA_PLACEHOLDER = "__AUTORESEARCH_DATA__";

function usage() {
  return `Codex Autoresearch

Usage:
  node scripts/autoresearch.mjs setup --cwd <project> --name <name> --metric-name <name> [--benchmark-command <cmd>] [--checks-command <cmd>] [--shell bash|powershell] [--max-iterations <n>]
  node scripts/autoresearch.mjs init --cwd <project> --name <name> --metric-name <name> [--metric-unit <unit>] [--direction lower|higher]
  node scripts/autoresearch.mjs run --cwd <project> [--command <cmd>] [--timeout-seconds <n>]
  node scripts/autoresearch.mjs log --cwd <project> --metric <n> --status keep|discard|crash|checks_failed --description <text> [--metrics <json>] [--asi <json>]
  node scripts/autoresearch.mjs state --cwd <project>
  node scripts/autoresearch.mjs export --cwd <project> [--output <html>]
  node scripts/autoresearch.mjs clear --cwd <project> --yes
  node scripts/autoresearch.mjs --mcp

Benchmark output format:
  METRIC name=value
`;
}

function parseCliArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function parseJsonOption(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON option: ${error.message}`);
  }
}

function numberOption(value, fallback) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected a number, got ${value}`);
  return parsed;
}

function boolOption(value, fallback = false) {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "y"].includes(String(value).toLowerCase());
}

function listOption(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value == null || value === "") return [];
  return String(value)
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function pathExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function readConfig(sessionCwd) {
  const configPath = path.join(sessionCwd, "autoresearch.config.json");
  if (!fs.existsSync(configPath)) return {};
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function resolveWorkDir(cwdArg) {
  const sessionCwd = path.resolve(cwdArg || process.env.CODEX_AUTORESEARCH_WORKDIR || process.cwd());
  const config = readConfig(sessionCwd);
  const workDir = config.workingDir
    ? path.resolve(sessionCwd, config.workingDir)
    : sessionCwd;
  if (!fs.existsSync(workDir) || !fs.statSync(workDir).isDirectory()) {
    throw new Error(`Working directory does not exist: ${workDir}`);
  }
  return { sessionCwd, workDir, config };
}

function jsonlPath(workDir) {
  return path.join(workDir, "autoresearch.jsonl");
}

function assetPath(fileName) {
  return path.join(PLUGIN_ROOT, "assets", fileName);
}

function readAssetTemplate(fileName) {
  return fs.readFileSync(assetPath(fileName), "utf8");
}

function replaceAllText(text, replacements) {
  let out = text;
  for (const [from, to] of Object.entries(replacements)) {
    out = out.split(from).join(String(to));
  }
  return out;
}

function shellKindFromArgs(args) {
  const requested = String(args.shell || args.script || "").toLowerCase();
  if (["bash", "sh", "posix"].includes(requested)) return "bash";
  if (["powershell", "pwsh", "ps1", "windows"].includes(requested)) return "powershell";
  return process.platform === "win32" ? "powershell" : "bash";
}

function markdownList(items, emptyText) {
  if (!items.length) return `- ${emptyText}`;
  return items.map((item) => `- ${item}`).join("\n");
}

function renderSessionDocument(args) {
  const scope = listOption(args.files_in_scope ?? args.filesInScope ?? args.scope);
  const offLimits = listOption(args.off_limits ?? args.offLimits);
  const constraints = listOption(args.constraints);
  const secondary = listOption(args.secondary_metrics ?? args.secondaryMetrics);
  const benchmarkCommand = args.benchmark_command || args.benchmarkCommand || "./autoresearch.sh";
  const metricUnit = args.metric_unit ?? args.metricUnit ?? "";
  const direction = args.direction === "higher" ? "higher" : "lower";
  return replaceAllText(readAssetTemplate("autoresearch.md.template"), {
    "<goal>": args.name,
    "<Specific description of what is being optimized and the workload.>": args.goal || args.name,
    "- Primary: <name> (<unit>, lower/higher is better)": `- Primary: ${args.metric_name || args.metricName} (${metricUnit || "unitless"}, ${direction} is better)`,
    "- Secondary: <name>, <name>": secondary.length ? `- Secondary: ${secondary.join(", ")}` : "- Secondary: none yet",
    "`<benchmark command>` prints `METRIC name=value` lines.": `\`${benchmarkCommand}\` prints \`METRIC name=value\` lines.`,
    "- `<path>`: <why it matters>": markdownList(scope, "TBD: add files after initial inspection"),
    "- `<path or behavior>`: <reason>": markdownList(offLimits, "TBD: add off-limits files or behaviors if needed"),
    "- <Correctness, compatibility, dependency, or budget constraints>": markdownList(constraints, "TBD: add correctness and compatibility constraints"),
    "- Baseline: <initial metric and notes>": "- Baseline: pending",
  });
}

function renderBenchmarkScript(args, shellKind) {
  const command = args.benchmark_command || args.benchmarkCommand || "# TODO: replace with the real workload";
  const metricName = args.metric_name || args.metricName || "elapsed_ms";
  const templateName = shellKind === "bash" ? "autoresearch.sh.template" : "autoresearch.ps1.template";
  return replaceAllText(readAssetTemplate(templateName), {
    "<benchmark command>": command,
    "<metric name>": metricName,
  });
}

function renderChecksScript(args, shellKind) {
  const command = args.checks_command || args.checksCommand || "# TODO: add correctness checks";
  const templateName = shellKind === "bash" ? "autoresearch.checks.sh.template" : "autoresearch.checks.ps1.template";
  return replaceAllText(readAssetTemplate(templateName), {
    "<check command>": command,
  });
}

async function writeSessionFile(filePath, content, options = {}) {
  const exists = await pathExists(filePath);
  if (exists && !options.overwrite) return { path: filePath, action: "kept" };
  await fsp.writeFile(filePath, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  if (options.executable) {
    await fsp.chmod(filePath, 0o755).catch(() => {});
  }
  return { path: filePath, action: exists ? "overwritten" : "created" };
}

function appendJsonl(workDir, entry) {
  fs.appendFileSync(jsonlPath(workDir), JSON.stringify(entry) + os.EOL);
}

function readJsonl(workDir) {
  const filePath = jsonlPath(workDir);
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at line ${index + 1}: ${error.message}`);
      }
    });
}

function currentState(workDir) {
  const entries = readJsonl(workDir);
  let config = {
    name: null,
    metricName: "metric",
    metricUnit: "",
    bestDirection: "lower",
  };
  let segment = 0;
  const results = [];
  for (const entry of entries) {
    if (entry.type === "config") {
      if (results.length > 0) segment += 1;
      config = {
        name: entry.name || config.name,
        metricName: entry.metricName || config.metricName,
        metricUnit: entry.metricUnit ?? config.metricUnit,
        bestDirection: entry.bestDirection === "higher" ? "higher" : "lower",
      };
      continue;
    }
    if (entry.run != null) {
      results.push({ ...entry, segment: entry.segment ?? segment });
    }
  }
  const current = results.filter((run) => run.segment === segment);
  const baseline = current.find((run) => Number(run.metric) > 0)?.metric ?? null;
  const best = bestMetric(current, config.bestDirection);
  const confidence = computeConfidence(current, config.bestDirection);
  return { config, segment, results, current, baseline, best, confidence };
}

function iterationLimitInfo(state, runtimeConfig) {
  const maxIterations = Number(runtimeConfig.maxIterations);
  if (!Number.isFinite(maxIterations) || maxIterations <= 0) {
    return {
      maxIterations: null,
      remainingIterations: null,
      limitReached: false,
    };
  }
  const max = Math.floor(maxIterations);
  const remaining = Math.max(0, max - state.current.length);
  return {
    maxIterations: max,
    remainingIterations: remaining,
    limitReached: state.current.length >= max,
  };
}

function bestMetric(runs, direction) {
  let best = null;
  for (const run of runs) {
    const metric = Number(run.metric);
    if (!Number.isFinite(metric) || metric <= 0) continue;
    if (best == null || isBetter(metric, best, direction)) best = metric;
  }
  return best;
}

function isBetter(value, current, direction) {
  return direction === "higher" ? value > current : value < current;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function computeConfidence(runs, direction) {
  const values = runs.map((run) => Number(run.metric)).filter((value) => Number.isFinite(value) && value > 0);
  if (values.length < 3) return null;
  const baseline = values[0];
  const best = bestMetric(runs, direction);
  if (best == null || best === baseline) return null;
  const med = median(values);
  const mad = median(values.map((value) => Math.abs(value - med)));
  if (mad === 0) return null;
  return Math.abs(best - baseline) / mad;
}

function parseMetricLines(output) {
  const metrics = {};
  const denied = new Set(["__proto__", "constructor", "prototype"]);
  const regex = /^METRIC\s+([^=\s]+)=(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*$/gim;
  let match;
  while ((match = regex.exec(output)) !== null) {
    const name = match[1];
    if (denied.has(name)) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) metrics[name] = value;
  }
  return metrics;
}

function tailText(text, maxLines = OUTPUT_MAX_LINES, maxBytes = OUTPUT_MAX_BYTES) {
  let trimmed = text;
  if (Buffer.byteLength(trimmed, "utf8") > maxBytes) {
    const buf = Buffer.from(trimmed, "utf8");
    trimmed = buf.subarray(Math.max(0, buf.length - maxBytes)).toString("utf8");
  }
  const lines = trimmed.split(/\r?\n/);
  if (lines.length > maxLines) trimmed = lines.slice(-maxLines).join("\n");
  return trimmed;
}

async function runShell(command, cwd, timeoutSeconds) {
  const startedAt = Date.now();
  return await new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      killProcess(child.pid);
    }, Math.max(1, timeoutSeconds) * 1000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        command,
        exitCode: null,
        timedOut,
        durationSeconds: (Date.now() - startedAt) / 1000,
        output: String(error.stack || error.message || error),
      });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        command,
        exitCode: code,
        timedOut,
        durationSeconds: (Date.now() - startedAt) / 1000,
        output,
      });
    });
  });
}

function killProcess(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

async function defaultBenchmarkCommand(workDir) {
  if (await pathExists(path.join(workDir, "autoresearch.ps1"))) {
    return "powershell -NoProfile -ExecutionPolicy Bypass -File ./autoresearch.ps1";
  }
  if (await pathExists(path.join(workDir, "autoresearch.sh"))) {
    return "bash ./autoresearch.sh";
  }
  throw new Error("No command provided and no autoresearch.ps1 or autoresearch.sh exists.");
}

async function defaultChecksCommand(workDir) {
  if (await pathExists(path.join(workDir, "autoresearch.checks.ps1"))) {
    return "powershell -NoProfile -ExecutionPolicy Bypass -File ./autoresearch.checks.ps1";
  }
  if (await pathExists(path.join(workDir, "autoresearch.checks.sh"))) {
    return "bash ./autoresearch.checks.sh";
  }
  return null;
}

async function runProcess(command, args, cwd, options = {}) {
  return await new Promise((resolve) => {
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
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: String(error.message || error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (options.timeoutMs) {
      setTimeout(() => killProcess(child.pid), options.timeoutMs);
    }
  });
}

async function git(args, cwd) {
  return await runProcess("git", args, cwd);
}

async function insideGitRepo(cwd) {
  const result = await git(["rev-parse", "--is-inside-work-tree"], cwd);
  return result.code === 0 && result.stdout.trim() === "true";
}

async function shortHead(cwd) {
  const result = await git(["rev-parse", "--short=7", "HEAD"], cwd);
  return result.code === 0 ? result.stdout.trim() : "";
}

async function hasStagedChanges(cwd) {
  const result = await git(["diff", "--cached", "--quiet"], cwd);
  return result.code === 1;
}

async function preserveSessionFiles(workDir) {
  const saved = new Map();
  for (const file of SESSION_FILES) {
    const filePath = path.join(workDir, file);
    if (fs.existsSync(filePath)) saved.set(file, fs.readFileSync(filePath));
  }
  return saved;
}

async function restoreSessionFiles(workDir, saved) {
  for (const [file, bytes] of saved.entries()) {
    const filePath = path.join(workDir, file);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, bytes);
  }
}

async function revertExceptSessionFiles(workDir) {
  if (!(await insideGitRepo(workDir))) return "Git: not a repo, skipped revert.";
  const saved = await preserveSessionFiles(workDir);
  await git(["restore", "--worktree", "--staged", "--", "."], workDir);
  await git(["clean", "-fd"], workDir);
  await restoreSessionFiles(workDir, saved);
  return "Git: reverted non-session changes; autoresearch files preserved.";
}

async function setupSession(args) {
  const { sessionCwd, workDir } = resolveWorkDir(args.working_dir || args.cwd);
  if (!args.name) throw new Error("name is required");
  if (!args.metric_name && !args.metricName) throw new Error("metric_name is required");
  const overwrite = boolOption(args.overwrite, false);
  const shellKind = shellKindFromArgs(args);
  const benchmarkFile = shellKind === "bash" ? "autoresearch.sh" : "autoresearch.ps1";
  const checksFile = shellKind === "bash" ? "autoresearch.checks.sh" : "autoresearch.checks.ps1";
  const files = [];

  files.push(await writeSessionFile(
    path.join(workDir, "autoresearch.md"),
    renderSessionDocument(args),
    { overwrite },
  ));
  files.push(await writeSessionFile(
    path.join(workDir, benchmarkFile),
    renderBenchmarkScript(args, shellKind),
    { overwrite, executable: shellKind === "bash" },
  ));
  files.push(await writeSessionFile(
    path.join(workDir, "autoresearch.ideas.md"),
    `# Autoresearch Ideas: ${args.name}\n\n- Add promising ideas here when they are not tried immediately.\n`,
    { overwrite },
  ));

  if (args.checks_command || args.checksCommand || boolOption(args.create_checks ?? args.createChecks, false)) {
    files.push(await writeSessionFile(
      path.join(workDir, checksFile),
      renderChecksScript(args, shellKind),
      { overwrite, executable: shellKind === "bash" },
    ));
  }

  const maxIterations = numberOption(args.max_iterations ?? args.maxIterations, null);
  if (maxIterations != null) {
    const configPath = path.join(sessionCwd, "autoresearch.config.json");
    const existing = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
    const nextConfig = { ...existing, maxIterations: Math.floor(maxIterations) };
    files.push(await writeSessionFile(
      configPath,
      JSON.stringify(nextConfig, null, 2),
      { overwrite: true },
    ));
  }

  let init = null;
  if (!boolOption(args.skip_init ?? args.skipInit, false)) {
    init = await initExperiment(args);
  }

  return {
    ok: true,
    workDir,
    sessionCwd,
    shell: shellKind,
    files,
    init,
  };
}

async function initExperiment(args) {
  const { workDir } = resolveWorkDir(args.working_dir || args.cwd);
  if (!args.name) throw new Error("name is required");
  if (!args.metric_name && !args.metricName) throw new Error("metric_name is required");
  const metricName = args.metric_name || args.metricName;
  const direction = args.direction === "higher" ? "higher" : "lower";
  const entry = {
    type: "config",
    name: args.name,
    metricName,
    metricUnit: args.metric_unit ?? args.metricUnit ?? "",
    bestDirection: direction,
  };
  appendJsonl(workDir, entry);
  return {
    ok: true,
    workDir,
    message: `Initialized ${entry.name}: ${entry.metricName} (${entry.metricUnit || "unitless"}, ${entry.bestDirection} is better).`,
    config: entry,
  };
}

async function runExperiment(args) {
  const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
  const state = currentState(workDir);
  const limit = iterationLimitInfo(state, config);
  if (limit.limitReached) {
    throw new Error(`maxIterations reached (${limit.maxIterations}). Start a new segment with init/setup or raise maxIterations before running more experiments.`);
  }
  const command = args.command || await defaultBenchmarkCommand(workDir);
  const benchmark = await runShell(command, workDir, numberOption(args.timeout_seconds ?? args.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS));
  const benchmarkPassed = benchmark.exitCode === 0 && !benchmark.timedOut;
  const parsedMetrics = parseMetricLines(benchmark.output);
  const primary = parsedMetrics[state.config.metricName] ?? null;
  let checks = null;
  const checksCommand = args.checks_command || args.checksCommand || await defaultChecksCommand(workDir);
  if (benchmarkPassed && checksCommand) {
    checks = await runShell(checksCommand, workDir, numberOption(args.checks_timeout_seconds ?? args.checksTimeoutSeconds, DEFAULT_CHECKS_TIMEOUT_SECONDS));
  }
  const checksPassed = checks ? checks.exitCode === 0 && !checks.timedOut : null;
  const passed = benchmarkPassed && (checksPassed === null || checksPassed);
  return {
    ok: passed,
    workDir,
    command,
    exitCode: benchmark.exitCode,
    timedOut: benchmark.timedOut,
    durationSeconds: benchmark.durationSeconds,
    parsedMetrics,
    parsedPrimary: primary,
    metricName: state.config.metricName,
    metricUnit: state.config.metricUnit,
    checks: checks ? {
      command: checksCommand,
      exitCode: checks.exitCode,
      timedOut: checks.timedOut,
      durationSeconds: checks.durationSeconds,
      passed: checksPassed,
      tailOutput: tailText(checks.output, 80, 16000),
    } : null,
    tailOutput: tailText(benchmark.output),
    logHint: {
      metric: primary,
      metrics: Object.fromEntries(Object.entries(parsedMetrics).filter(([key]) => key !== state.config.metricName)),
      status: passed ? "keep_or_discard" : (benchmarkPassed ? "checks_failed" : "crash"),
    },
    limit,
  };
}

async function logExperiment(args) {
  const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
  const metric = numberOption(args.metric, null);
  if (metric == null) throw new Error("metric is required");
  if (!STATUS_VALUES.has(args.status)) throw new Error(`status must be one of ${[...STATUS_VALUES].join(", ")}`);
  if (!args.description) throw new Error("description is required");

  const stateBefore = currentState(workDir);
  const inGit = await insideGitRepo(workDir);
  let commit = args.commit || (inGit ? await shortHead(workDir) : "");
  let gitMessage = inGit ? "Git: no commit created." : "Git: not a repo.";

  if (args.status === "keep" && inGit) {
    const resultData = {
      status: args.status,
      [stateBefore.config.metricName || "metric"]: metric,
      ...(args.metrics || {}),
    };
    await git(["add", "-A"], workDir);
    if (await hasStagedChanges(workDir)) {
      const commitResult = await git([
        "commit",
        "-m",
        args.description,
        "-m",
        `Result: ${JSON.stringify(resultData)}`,
      ], workDir);
      if (commitResult.code === 0) {
        commit = await shortHead(workDir);
        gitMessage = `Git: committed ${commit}.`;
      } else {
        gitMessage = `Git: commit failed: ${(commitResult.stderr || commitResult.stdout).trim()}`;
      }
    } else {
      gitMessage = "Git: nothing to commit.";
    }
  }

  const currentRuns = stateBefore.current;
  const experiment = {
    run: stateBefore.results.length + 1,
    commit: String(commit || "").slice(0, 12),
    metric,
    metrics: args.metrics || {},
    status: args.status,
    description: args.description,
    timestamp: Date.now(),
    segment: stateBefore.segment,
    confidence: null,
  };
  if (args.asi && Object.keys(args.asi).length > 0) experiment.asi = args.asi;
  experiment.confidence = computeConfidence([...currentRuns, experiment], stateBefore.config.bestDirection);
  appendJsonl(workDir, experiment);

  let revertMessage = "";
  if (args.status !== "keep") {
    revertMessage = await revertExceptSessionFiles(workDir);
  }

  const stateAfter = currentState(workDir);
  const limit = iterationLimitInfo(stateAfter, config);
  return {
    ok: true,
    workDir,
    experiment,
    baseline: stateAfter.baseline,
    best: stateAfter.best,
    confidence: stateAfter.confidence,
    limit,
    git: gitMessage,
    revert: revertMessage,
  };
}

async function exportDashboard(args) {
  const { workDir } = resolveWorkDir(args.working_dir || args.cwd);
  const entries = readJsonl(workDir);
  if (entries.length === 0) throw new Error(`No autoresearch.jsonl found in ${workDir}`);
  const output = path.resolve(workDir, args.output || "autoresearch-dashboard.html");
  const html = dashboardHtml(entries);
  await fsp.writeFile(output, html, "utf8");
  return { ok: true, workDir, output };
}

async function clearSession(args) {
  if (!boolOption(args.confirm ?? args.yes, false)) {
    throw new Error("clear requires confirm=true for MCP or --yes for CLI");
  }
  const { sessionCwd, workDir } = resolveWorkDir(args.working_dir || args.cwd);
  const targets = new Set([
    ...SESSION_FILES.map((file) => path.join(workDir, file)),
    path.join(workDir, "autoresearch-dashboard.html"),
    path.join(sessionCwd, "autoresearch.config.json"),
  ]);
  const deleted = [];
  const missing = [];
  for (const filePath of [...targets].sort()) {
    if (await pathExists(filePath)) {
      await fsp.rm(filePath, { recursive: true, force: true });
      deleted.push(filePath);
    } else {
      missing.push(filePath);
    }
  }
  return {
    ok: true,
    workDir,
    sessionCwd,
    deleted,
    missing,
  };
}

function dashboardHtml(entries) {
  const data = JSON.stringify(entries).replace(/</g, "\\u003c");
  const template = fs.readFileSync(DASHBOARD_TEMPLATE_PATH, "utf8");
  if (!template.includes(DASHBOARD_DATA_PLACEHOLDER)) {
    throw new Error(`Dashboard template is missing ${DASHBOARD_DATA_PLACEHOLDER}`);
  }
  return template.replace(DASHBOARD_DATA_PLACEHOLDER, data);
}

function publicState(args) {
  const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
  const state = currentState(workDir);
  const statusCounts = Object.fromEntries([...STATUS_VALUES].map((status) => [
    status,
    state.current.filter((run) => run.status === status).length,
  ]));
  return {
    ok: true,
    workDir,
    config: state.config,
    segment: state.segment,
    runs: state.current.length,
    totalRuns: state.results.length,
    kept: statusCounts.keep,
    discarded: statusCounts.discard,
    crashed: statusCounts.crash,
    checksFailed: statusCounts.checks_failed,
    baseline: state.baseline,
    best: state.best,
    confidence: state.confidence,
    limit: iterationLimitInfo(state, config),
  };
}

async function callTool(name, args) {
  if (name === "setup_session") return await setupSession(args);
  if (name === "init_experiment") return await initExperiment(args);
  if (name === "run_experiment") return await runExperiment(args);
  if (name === "log_experiment") return await logExperiment({
    ...args,
    metrics: parseJsonOption(args.metrics, {}),
    asi: parseJsonOption(args.asi, {}),
  });
  if (name === "export_dashboard") return await exportDashboard(args);
  if (name === "clear_session") return await clearSession(args);
  if (name === "read_state") return publicState(args);
  throw new Error(`Unknown tool: ${name}`);
}

const toolSchemas = [
  {
    name: "setup_session",
    description: "Create autoresearch session files from templates and append an initial config header.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        name: { type: "string" },
        goal: { type: "string" },
        metric_name: { type: "string" },
        metric_unit: { type: "string" },
        direction: { type: "string", enum: ["lower", "higher"] },
        benchmark_command: { type: "string" },
        checks_command: { type: "string" },
        shell: { type: "string", enum: ["bash", "powershell"] },
        files_in_scope: { type: "array", items: { type: "string" } },
        off_limits: { type: "array", items: { type: "string" } },
        constraints: { type: "array", items: { type: "string" } },
        secondary_metrics: { type: "array", items: { type: "string" } },
        max_iterations: { type: "number" },
        overwrite: { type: "boolean" },
        create_checks: { type: "boolean" },
        skip_init: { type: "boolean" },
      },
      required: ["working_dir", "name", "metric_name"],
    },
  },
  {
    name: "init_experiment",
    description: "Append an autoresearch config header to autoresearch.jsonl.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        name: { type: "string" },
        metric_name: { type: "string" },
        metric_unit: { type: "string" },
        direction: { type: "string", enum: ["lower", "higher"] },
      },
      required: ["working_dir", "name", "metric_name"],
    },
  },
  {
    name: "run_experiment",
    description: "Run a timed benchmark command, parse METRIC lines, and optionally run checks.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        command: { type: "string" },
        timeout_seconds: { type: "number" },
        checks_command: { type: "string" },
        checks_timeout_seconds: { type: "number" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "log_experiment",
    description: "Append an experiment result and keep/commit or discard/revert changes.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        commit: { type: "string" },
        metric: { type: "number" },
        status: { type: "string", enum: ["keep", "discard", "crash", "checks_failed"] },
        description: { type: "string" },
        metrics: { type: "object" },
        asi: { type: "object" },
      },
      required: ["working_dir", "metric", "status", "description"],
    },
  },
  {
    name: "read_state",
    description: "Summarize the current autoresearch.jsonl state.",
    inputSchema: {
      type: "object",
      properties: { working_dir: { type: "string" } },
      required: ["working_dir"],
    },
  },
  {
    name: "export_dashboard",
    description: "Write a self-contained HTML dashboard for autoresearch.jsonl.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        output: { type: "string" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "clear_session",
    description: "Delete autoresearch runtime artifacts after explicit confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        confirm: { type: "boolean" },
      },
      required: ["working_dir", "confirm"],
    },
  },
];

function startMcpServer() {
  let buffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) return;
      const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      buffer = buffer.subarray(bodyStart + length);
      handleMcpMessage(JSON.parse(body)).catch((error) => {
        sendMcp({ jsonrpc: "2.0", id: null, error: { code: -32000, message: error.message } });
      });
    }
  });
}

async function handleMcpMessage(message) {
  if (message.method === "initialize") {
    sendMcp({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "codex-autoresearch", version: "0.1.2" },
      },
    });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    sendMcp({ jsonrpc: "2.0", id: message.id, result: { tools: toolSchemas } });
    return;
  }
  if (message.method === "tools/call") {
    try {
      const result = await callTool(message.params.name, message.params.arguments || {});
      sendMcp({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        },
      });
    } catch (error) {
      sendMcp({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          isError: true,
          content: [{ type: "text", text: error.stack || error.message || String(error) }],
        },
      });
    }
    return;
  }
  if (message.id != null) {
    sendMcp({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unknown method: ${message.method}` } });
  }
}

function sendMcp(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.mcp) {
    startMcpServer();
    return;
  }
  const command = args._[0];
  if (!command || args.help || command === "help") {
    console.log(usage());
    return;
  }
  let result;
  if (command === "setup") {
    result = await setupSession({
      cwd: args.cwd,
      name: args.name,
      goal: args.goal,
      metricName: args.metricName,
      metricUnit: args.metricUnit,
      direction: args.direction,
      benchmarkCommand: args.benchmarkCommand,
      checksCommand: args.checksCommand,
      shell: args.shell,
      filesInScope: args.filesInScope,
      offLimits: args.offLimits,
      constraints: args.constraints,
      secondaryMetrics: args.secondaryMetrics,
      maxIterations: args.maxIterations,
      overwrite: args.overwrite,
      createChecks: args.createChecks,
      skipInit: args.skipInit,
    });
  } else if (command === "init") {
    result = await initExperiment({
      cwd: args.cwd,
      name: args.name,
      metricName: args.metricName,
      metricUnit: args.metricUnit,
      direction: args.direction,
    });
  } else if (command === "run") {
    result = await runExperiment({
      cwd: args.cwd,
      command: args.command,
      timeoutSeconds: args.timeoutSeconds,
      checksCommand: args.checksCommand,
      checksTimeoutSeconds: args.checksTimeoutSeconds,
    });
  } else if (command === "log") {
    result = await logExperiment({
      cwd: args.cwd,
      commit: args.commit,
      metric: args.metric,
      status: args.status,
      description: args.description,
      metrics: parseJsonOption(args.metrics, {}),
      asi: parseJsonOption(args.asi, {}),
    });
  } else if (command === "state") {
    result = publicState({ cwd: args.cwd });
  } else if (command === "export") {
    result = await exportDashboard({ cwd: args.cwd, output: args.output });
  } else if (command === "clear") {
    result = await clearSession({ cwd: args.cwd, yes: args.yes, confirm: args.confirm });
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
