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
  "autoresearch.last-run.json",
];
const RESEARCH_DIR = "autoresearch.research";

const STATUS_VALUES = new Set(["keep", "discard", "crash", "checks_failed"]);
const AUTONOMY_MODES = new Set(["guarded", "owner-autonomous", "manual"]);
const CHECKS_POLICIES = new Set(["always", "on-improvement", "manual"]);
const KEEP_POLICIES = new Set(["primary-only", "primary-or-risk-reduction"]);
const DENIED_METRIC_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const METRIC_NAME_PATTERN = /^[^=\s]+$/;
const DEFAULT_TIMEOUT_SECONDS = 600;
const DEFAULT_CHECKS_TIMEOUT_SECONDS = 300;
const OUTPUT_MAX_LINES = 20;
const OUTPUT_MAX_BYTES = 8192;
const OUTPUT_CAPTURE_BYTES = 16384;
const MAX_MCP_FRAME_BYTES = 1024 * 1024;
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
  node scripts/autoresearch.mjs next --cwd <project> [--command <cmd>] [--timeout-seconds <n>]
  node scripts/autoresearch.mjs config --cwd <project> [--autonomy-mode guarded|owner-autonomous|manual] [--checks-policy always|on-improvement|manual] [--extend <n>]
  node scripts/autoresearch.mjs research-setup --cwd <project> --slug <slug> --goal <goal> [--checks-command <cmd>] [--max-iterations <n>]
  node scripts/autoresearch.mjs quality-gap --cwd <project> --research-slug <slug>
  node scripts/autoresearch.mjs log --cwd <project> (--metric <n>|--from-last) --status keep|discard|crash|checks_failed --description <text> [--metrics <json>] [--asi <json>] [--commit-paths <paths>] [--revert-paths <paths>]
  node scripts/autoresearch.mjs state --cwd <project>
  node scripts/autoresearch.mjs doctor --cwd <project> [--command <cmd>] [--check-benchmark]
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

function enumOption(value, allowed, fallback, optionName) {
  if (value == null || value === "") return fallback;
  const normalized = String(value).toLowerCase();
  if (!allowed.has(normalized)) {
    throw new Error(`${optionName} must be one of ${[...allowed].join(", ")}. Got ${value}`);
  }
  return normalized;
}

function listOption(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value == null || value === "") return [];
  return String(value)
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function safeSlug(value, fallback = "research") {
  const slug = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug || fallback;
}

function shellQuote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function validateMetricName(name) {
  if (!METRIC_NAME_PATTERN.test(String(name || "")) || DENIED_METRIC_NAMES.has(String(name))) {
    throw new Error(`Metric name must match the METRIC parser grammar: one non-empty token without whitespace or "=". Got ${name}`);
  }
  return String(name);
}

function finiteMetric(value) {
  if (value == null || value === "") return null;
  const metric = Number(value);
  return Number.isFinite(metric) ? metric : null;
}

function normalizeRelativePaths(paths, optionName = "paths") {
  return listOption(paths).map((item) => {
    const normalized = item.replace(/\\/g, "/").replace(/\/+/g, "/");
    if (
      !normalized ||
      normalized === "." ||
      path.isAbsolute(normalized) ||
      normalized.startsWith("../") ||
      normalized.includes("/../") ||
      normalized === ".." ||
      normalized.startsWith(".git/") ||
      normalized === ".git"
    ) {
      throw new Error(`${optionName} must contain project-relative paths that do not escape the working directory: ${item}`);
    }
    return normalized.replace(/\/$/, "");
  });
}

function resolveOutputInside(workDir, output) {
  const target = path.resolve(workDir, output || "autoresearch-dashboard.html");
  const relative = path.relative(workDir, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Dashboard output is outside the working directory: ${target}`);
  }
  return target;
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

function runtimeConfigPath(sessionCwd) {
  return path.join(sessionCwd, "autoresearch.config.json");
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
  const constraintsPlaceholder = "- <Correctness, compatibility, dependency,"
    + " or budget constraints>";
  const secondary = listOption(args.secondary_metrics ?? args.secondaryMetrics);
  const benchmarkCommand = args.benchmark_command || args.benchmarkCommand || "./autoresearch.sh";
  const metricUnit = args.metric_unit ?? args.metricUnit ?? "";
  const direction = args.direction === "higher" ? "higher" : "lower";
  const primaryMetric = validateMetricName(args.metric_name || args.metricName);
  return replaceAllText(readAssetTemplate("autoresearch.md.template"), {
    "<goal>": args.name,
    "<Specific description of what is being optimized and the workload.>": args.goal || args.name,
    "- Primary: <name> (<unit>, lower/higher is better)": `- Primary: ${primaryMetric} (${metricUnit || "unitless"}, ${direction} is better)`,
    "- Secondary: <name>, <name>": secondary.length ? `- Secondary: ${secondary.join(", ")}` : "- Secondary: none yet",
    "`<benchmark command>` prints `METRIC name=value` lines.": `\`${benchmarkCommand}\` prints \`METRIC name=value\` lines.`,
    "- `<path>`: <why it matters>": markdownList(scope, "TBD: add files after initial inspection"),
    "- `<path or behavior>`: <reason>": markdownList(offLimits, "TBD: add off-limits files or behaviors if needed"),
    [constraintsPlaceholder]: markdownList(constraints, "TBD: add correctness and compatibility constraints"),
    "- Baseline: <initial metric and notes>": "- Baseline: pending",
  });
}

function renderBenchmarkScript(args, shellKind) {
  const command = args.benchmark_command || args.benchmarkCommand || "# TODO: replace with the real workload";
  const metricName = validateMetricName(args.metric_name || args.metricName || "elapsed_seconds");
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

function researchSlugFromArgs(args) {
  return safeSlug(args.research_slug ?? args.researchSlug ?? args.slug ?? args.name ?? "research");
}

function researchRelativeDir(slug) {
  return `${RESEARCH_DIR}/${slug}`;
}

function researchDirPath(workDir, slug) {
  return path.join(workDir, RESEARCH_DIR, slug);
}

function renderQualityGapCommand(slug) {
  const script = path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs");
  return `${shellQuote(process.execPath)} ${shellQuote(script)} quality-gap --cwd . --research-slug ${shellQuote(slug)}`;
}

function renderResearchBenchmarkScript(slug, shellKind) {
  const script = path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs");
  if (shellKind === "bash") {
    return [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "",
      `${shellQuote(process.execPath)} ${shellQuote(script)} quality-gap --cwd . --research-slug ${shellQuote(slug)}`,
      "",
    ].join("\n");
  }
  return [
    "$ErrorActionPreference = \"Stop\"",
    "",
    `& ${shellQuote(process.execPath)} ${shellQuote(script)} quality-gap --cwd . --research-slug ${shellQuote(slug)}`,
    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    "",
  ].join("\n");
}

function researchTitle(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function renderResearchBrief({ title, goal, args }) {
  return `# Research Brief: ${title}

## Request
${goal}

## Decision To Support
- Identify source-backed changes worth testing through an autoresearch loop.

## Success Criteria
- The project essence is accurate.
- Sources and direct evidence are logged.
- High-impact findings are converted into quality gaps.
- Each implemented or rejected gap has evidence.

## Constraints
${markdownList(listOption(args.constraints), "TBD: add constraints as they are discovered")}

## Known Unknowns
- TBD: add unresolved questions before delegating or implementing.
`;
}

function renderResearchPlan({ title }) {
  return `# Research Plan: ${title}

## Workstreams
- Project essence and audience
- Current implementation and architecture evidence
- High-impact improvement candidates
- Risks, constraints, and validation strategy

## Sequencing
- Gather evidence first.
- Synthesize findings into \`synthesis.md\`.
- Convert actionable findings into \`quality-gaps.md\`.
- Iterate with \`/autoresearch next\` until \`quality_gap=0\`.
`;
}

function renderResearchTasks({ title }) {
  return `# Research Tasks: ${title}

## queued
- Capture project essence from repo evidence.
- Log primary sources and direct measurements.
- Convert recommendations into quality gaps.

## in_progress
- None.

## done
- Scratchpad initialized.

## blockers
- None.
`;
}

function renderResearchSources({ title }) {
  return `# Research Sources: ${title}

| Source | Date Checked | Claim Supported | Confidence |
| --- | --- | --- | --- |
| TBD | TBD | TBD | TBD |
`;
}

function renderResearchSynthesis({ title }) {
  return `# Research Synthesis: ${title}

## Project Essence
- TBD: summarize what the project is trying to become.

## High-Impact Findings
- TBD: list source-backed findings and why they matter.

## Quality-Gap Translation
- Keep \`quality-gaps.md\` aligned with the current synthesis.

## Confidence And Gaps
- TBD: record confidence, contradictions, and unresolved questions.
`;
}

function renderResearchQualityGaps({ title }) {
  return `# Quality Gaps: ${title}

- [ ] Project essence is accurate and source-backed.
- [ ] Sources are logged with dates, claims, and confidence.
- [ ] Synthesis separates high-impact changes from small QoL fixes.
- [ ] Each high-impact recommendation is implemented or rejected with evidence.
- [ ] Correctness checks pass after kept changes.
- [ ] Final handoff includes dashboard or state evidence.
`;
}

const RESEARCH_FILE_RENDERERS = {
  "brief.md": renderResearchBrief,
  "plan.md": renderResearchPlan,
  "tasks.md": renderResearchTasks,
  "sources.md": renderResearchSources,
  "synthesis.md": renderResearchSynthesis,
  "quality-gaps.md": renderResearchQualityGaps,
};

function renderResearchFile(fileName, args, slug) {
  const goal = args.goal || args.name || slug;
  const renderer = RESEARCH_FILE_RENDERERS[fileName];
  if (renderer) return renderer({ title: researchTitle(goal), goal, args });
  throw new Error(`Unknown research file template: ${fileName}`);
}

function parseQualityGaps(text) {
  let open = 0;
  let closed = 0;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s*\[([ xX])\]\s+\S/);
    if (!match) continue;
    if (match[1].toLowerCase() === "x") closed += 1;
    else open += 1;
  }
  return { open, closed, total: open + closed };
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
  const baseline = finiteMetric(current.find((run) => finiteMetric(run.metric) != null)?.metric);
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
    const metric = finiteMetric(run.metric);
    if (metric == null) continue;
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
  const values = runs.map((run) => finiteMetric(run.metric)).filter((value) => value != null);
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
  const regex = /^METRIC\s+([^=\s]+)=(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*$/gim;
  let match;
  while ((match = regex.exec(output)) !== null) {
    const name = match[1];
    if (DENIED_METRIC_NAMES.has(name)) continue;
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
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let outputTruncated = false;
    let timedOut = false;
    const appendOutput = (text) => {
      output += text;
      if (Buffer.byteLength(output, "utf8") > OUTPUT_CAPTURE_BYTES) {
        const buf = Buffer.from(output, "utf8");
        output = buf.subarray(Math.max(0, buf.length - OUTPUT_CAPTURE_BYTES)).toString("utf8");
        outputTruncated = true;
      }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      killProcess(child.pid);
    }, Math.max(1, timeoutSeconds) * 1000);
    child.stdout.on("data", (chunk) => {
      appendOutput(chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      appendOutput(chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        command,
        exitCode: null,
        timedOut,
        durationSeconds: (Date.now() - startedAt) / 1000,
        output: String(error.stack || error.message || error),
        outputTruncated,
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
        outputTruncated,
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
  throw new Error("No command provided; expected autoresearch.ps1 or autoresearch.sh in the work directory.");
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

function checksPolicyFromArgs(args, config) {
  return enumOption(args.checks_policy ?? args.checksPolicy ?? config.checksPolicy, CHECKS_POLICIES, "always", "checksPolicy");
}

function shouldRunChecks(policy, context) {
  if (!context.benchmarkPassed || !context.primaryPresent || !context.checksCommand) return false;
  if (policy === "always") return true;
  if (policy === "on-improvement") return context.improvesPrimary || context.explicitChecksCommand;
  return context.explicitChecksCommand;
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

function gitOutput(result, fallback) {
  return (result.stderr || result.stdout || fallback || "").trim();
}

async function insideGitRepo(cwd) {
  const result = await git(["rev-parse", "--is-inside-work-tree"], cwd);
  return result.code === 0 && result.stdout.trim() === "true";
}

async function gitPrivatePath(cwd, relativePath) {
  const result = await git(["rev-parse", "--git-path", relativePath], cwd);
  if (result.code !== 0) throw new Error(`Git path lookup failed: ${gitOutput(result, "unknown error")}`);
  const filePath = result.stdout.trim();
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

async function shortHead(cwd) {
  const result = await git(["rev-parse", "--short=7", "HEAD"], cwd);
  return result.code === 0 ? result.stdout.trim() : "";
}

async function hasStagedChanges(cwd) {
  const result = await git(["diff", "--cached", "--quiet"], cwd);
  return result.code === 1;
}

async function isGitClean(cwd) {
  if (!(await insideGitRepo(cwd))) return null;
  const result = await git(["status", "--porcelain"], cwd);
  if (result.code !== 0) return false;
  return result.stdout.trim() === "";
}

async function gitStatusShort(cwd) {
  const result = await git(["status", "--porcelain"], cwd);
  if (result.code !== 0) throw new Error(`Git status failed: ${gitOutput(result, "unknown error")}`);
  return result.stdout.trim();
}

async function preserveSessionFiles(workDir) {
  const saved = new Map();
  for (const file of SESSION_FILES) {
    const filePath = path.join(workDir, file);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      saved.set(file, { type: "file", bytes: fs.readFileSync(filePath) });
    }
  }
  const researchPath = path.join(workDir, RESEARCH_DIR);
  if (fs.existsSync(researchPath) && fs.statSync(researchPath).isDirectory()) {
    const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), "autoresearch-preserve-"));
    fs.cpSync(researchPath, tempPath, { recursive: true });
    saved.set(RESEARCH_DIR, { type: "dir", tempPath });
  }
  return saved;
}

async function restoreSessionFiles(workDir, saved) {
  for (const [file, artifact] of saved.entries()) {
    const filePath = path.join(workDir, file);
    if (artifact.type === "dir") {
      await fsp.rm(filePath, { recursive: true, force: true });
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await fsp.cp(artifact.tempPath, filePath, { recursive: true });
      await fsp.rm(artifact.tempPath, { recursive: true, force: true });
    } else {
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await fsp.writeFile(filePath, artifact.bytes);
    }
  }
}

async function appendSessionRunNote(workDir, experiment, state, messages = {}) {
  const filePath = path.join(workDir, "autoresearch.md");
  if (!(await pathExists(filePath))) return;
  const parts = [
    `- Run ${experiment.run} ${experiment.status}: ${experiment.description}`,
    `metric=${experiment.metric}`,
    `best=${state.best ?? "unknown"}`,
  ];
  if (experiment.commit) parts.push(`commit=${experiment.commit}`);
  if (messages.revertMessage) parts.push(messages.revertMessage);
  if (messages.gitMessage && experiment.status === "keep") parts.push(messages.gitMessage);
  await fsp.appendFile(filePath, `\n${parts.join("; ")}.\n`, "utf8");
}

async function revertExceptSessionFiles(workDir) {
  if (!(await insideGitRepo(workDir))) return "Git: not a repo, skipped revert.";
  const saved = await preserveSessionFiles(workDir);
  const restore = await git(["restore", "--worktree", "--staged", "--", "."], workDir);
  if (restore.code !== 0) {
    await restoreSessionFiles(workDir, saved);
    throw new Error(`Git restore failed during discard cleanup: ${gitOutput(restore, "unknown error")}`);
  }
  const clean = await git(["clean", "-fd"], workDir);
  if (clean.code !== 0) {
    await restoreSessionFiles(workDir, saved);
    throw new Error(`Git clean failed during discard cleanup: ${gitOutput(clean, "unknown error")}`);
  }
  await restoreSessionFiles(workDir, saved);
  return "Git: reverted non-session changes; autoresearch files preserved.";
}

async function revertScopedPathsExceptSessionFiles(workDir, paths) {
  if (!(await insideGitRepo(workDir))) return "Git: not a repo, skipped revert.";
  const safePaths = normalizeRelativePaths(paths, "revertPaths");
  if (!safePaths.length) throw new Error("No scoped paths were provided for discard cleanup.");
  const saved = await preserveSessionFiles(workDir);
  const restore = await git(["restore", "--worktree", "--staged", "--", ...safePaths], workDir);
  if (restore.code !== 0) {
    await restoreSessionFiles(workDir, saved);
    throw new Error(`Git scoped restore failed during discard cleanup: ${gitOutput(restore, "unknown error")}`);
  }
  const clean = await git(["clean", "-fd", "--", ...safePaths], workDir);
  if (clean.code !== 0) {
    await restoreSessionFiles(workDir, saved);
    throw new Error(`Git scoped clean failed during discard cleanup: ${gitOutput(clean, "unknown error")}`);
  }
  await restoreSessionFiles(workDir, saved);
  return `Git: reverted scoped experiment paths (${safePaths.join(", ")}); autoresearch files preserved.`;
}

async function cleanupDiscardChanges(workDir, args, config) {
  if (!(await insideGitRepo(workDir))) return "Git: not a repo, skipped revert.";
  const scopedPaths = normalizeRelativePaths(
    args.revert_paths ?? args.revertPaths ?? args.commit_paths ?? args.commitPaths ?? config.commitPaths,
    "revertPaths",
  );
  if (scopedPaths.length > 0) return await revertScopedPathsExceptSessionFiles(workDir, scopedPaths);
  const dirty = await gitStatusShort(workDir);
  if (!dirty) return "Git: clean tree, no discard cleanup needed.";
  if (boolOption(args.allow_dirty_revert ?? args.allowDirtyRevert, false)) {
    return await revertExceptSessionFiles(workDir);
  }
  throw new Error("Refusing broad discard cleanup in a dirty Git tree without scoped revert paths. Configure commitPaths/revertPaths or pass --allow-dirty-revert.");
}

async function appendRuntimeConfigFile(files, sessionCwd, updates) {
  if (Object.keys(updates).length === 0) return;
  const configPath = runtimeConfigPath(sessionCwd);
  const existing = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
  const nextConfig = { ...existing, ...updates };
  files.push(await writeSessionFile(
    configPath,
    JSON.stringify(nextConfig, null, 2),
    { overwrite: true },
  ));
}

async function writeRuntimeConfig(sessionCwd, updates) {
  if (Object.keys(updates).length === 0) return readConfig(sessionCwd);
  const configPath = runtimeConfigPath(sessionCwd);
  const existing = readConfig(sessionCwd);
  const nextConfig = { ...existing, ...updates };
  await fsp.writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  return nextConfig;
}

function runtimeConfigUpdatesFromArgs(args) {
  const updates = {};
  const autonomyMode = enumOption(args.autonomy_mode ?? args.autonomyMode, AUTONOMY_MODES, null, "autonomyMode");
  const checksPolicy = enumOption(args.checks_policy ?? args.checksPolicy, CHECKS_POLICIES, null, "checksPolicy");
  const keepPolicy = enumOption(args.keep_policy ?? args.keepPolicy, KEEP_POLICIES, null, "keepPolicy");
  const dashboardRefreshSeconds = numberOption(args.dashboard_refresh_seconds ?? args.dashboardRefreshSeconds, null);
  if (autonomyMode) updates.autonomyMode = autonomyMode;
  if (checksPolicy) updates.checksPolicy = checksPolicy;
  if (keepPolicy) updates.keepPolicy = keepPolicy;
  if (dashboardRefreshSeconds != null) updates.dashboardRefreshSeconds = Math.max(1, Math.floor(dashboardRefreshSeconds));
  return updates;
}

async function setupSession(args) {
  const { sessionCwd, workDir } = resolveWorkDir(args.working_dir || args.cwd);
  if (!args.name) throw new Error("name is required");
  if (!args.metric_name && !args.metricName) throw new Error("metric_name is required");
  validateMetricName(args.metric_name || args.metricName);
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
    await appendRuntimeConfigFile(files, sessionCwd, { maxIterations: Math.floor(maxIterations) });
  }
  const commitPaths = normalizeRelativePaths(args.commit_paths ?? args.commitPaths, "commitPaths");
  if (commitPaths.length > 0) {
    await appendRuntimeConfigFile(files, sessionCwd, { commitPaths });
  }
  const runtimeUpdates = runtimeConfigUpdatesFromArgs(args);
  if (Object.keys(runtimeUpdates).length > 0) {
    await appendRuntimeConfigFile(files, sessionCwd, runtimeUpdates);
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

async function setupResearchSession(args) {
  const { sessionCwd, workDir } = resolveWorkDir(args.working_dir || args.cwd);
  const slug = researchSlugFromArgs(args);
  const goal = args.goal || args.name || slug;
  const overwrite = boolOption(args.overwrite, false);
  const shellKind = shellKindFromArgs(args);
  const benchmarkFile = shellKind === "bash" ? "autoresearch.sh" : "autoresearch.ps1";
  const checksFile = shellKind === "bash" ? "autoresearch.checks.sh" : "autoresearch.checks.ps1";
  const benchmarkCommand = shellKind === "bash"
    ? "./autoresearch.sh"
    : "powershell -NoProfile -ExecutionPolicy Bypass -File ./autoresearch.ps1";
  const researchDir = researchDirPath(workDir, slug);
  const files = [];

  await fsp.mkdir(path.join(researchDir, "notes"), { recursive: true });
  await fsp.mkdir(path.join(researchDir, "deliverables"), { recursive: true });
  for (const fileName of ["brief.md", "plan.md", "tasks.md", "sources.md", "synthesis.md", "quality-gaps.md"]) {
    files.push(await writeSessionFile(
      path.join(researchDir, fileName),
      renderResearchFile(fileName, args, slug),
      { overwrite },
    ));
  }

  const scopedFiles = [
    researchRelativeDir(slug),
    ...listOption(args.files_in_scope ?? args.filesInScope ?? args.scope),
  ];
  files.push(await writeSessionFile(
    path.join(workDir, "autoresearch.md"),
    renderSessionDocument({
      ...args,
      name: args.name || `Deep research: ${goal}`,
      goal,
      metricName: "quality_gap",
      metricUnit: "gaps",
      direction: "lower",
      benchmarkCommand,
      filesInScope: scopedFiles,
      constraints: [
        ...listOption(args.constraints),
        `Keep research notes under ${researchRelativeDir(slug)}.`,
        "Use source-backed evidence before implementing recommendations.",
      ],
    }),
    { overwrite },
  ));
  files.push(await writeSessionFile(
    path.join(workDir, benchmarkFile),
    renderResearchBenchmarkScript(slug, shellKind),
    { overwrite, executable: shellKind === "bash" },
  ));
  files.push(await writeSessionFile(
    path.join(workDir, "autoresearch.ideas.md"),
    `# Autoresearch Ideas: ${goal}\n\n- Add promising research-backed ideas here when they are not tried immediately.\n`,
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
  const commitPaths = normalizeRelativePaths(args.commit_paths ?? args.commitPaths, "commitPaths");
  const runtimeUpdates = runtimeConfigUpdatesFromArgs(args);
  if (maxIterations != null || commitPaths.length > 0 || Object.keys(runtimeUpdates).length > 0) {
    const nextConfig = { ...runtimeUpdates };
    if (maxIterations != null) nextConfig.maxIterations = Math.floor(maxIterations);
    if (commitPaths.length > 0) nextConfig.commitPaths = commitPaths;
    await appendRuntimeConfigFile(files, sessionCwd, nextConfig);
  }

  let init = null;
  if (!boolOption(args.skip_init ?? args.skipInit, false)) {
    init = await initExperiment({
      cwd: workDir,
      name: args.name || `Deep research: ${goal}`,
      metricName: "quality_gap",
      metricUnit: "gaps",
      direction: "lower",
    });
  }

  const gap = await measureQualityGap({ cwd: workDir, researchSlug: slug });
  return {
    ok: true,
    workDir,
    sessionCwd,
    slug,
    researchDir,
    shell: shellKind,
    files,
    init,
    qualityGap: {
      open: gap.open,
      closed: gap.closed,
      total: gap.total,
    },
  };
}

async function measureQualityGap(args) {
  const { workDir } = resolveWorkDir(args.working_dir || args.cwd);
  const slug = researchSlugFromArgs(args);
  const researchDir = researchDirPath(workDir, slug);
  const gapsPath = path.join(researchDir, "quality-gaps.md");
  if (!(await pathExists(gapsPath))) {
    throw new Error(`No quality-gaps.md found for research slug '${slug}' at ${gapsPath}`);
  }
  const text = await fsp.readFile(gapsPath, "utf8");
  const counts = parseQualityGaps(text);
  const metricOutput = [
    `METRIC quality_gap=${counts.open}`,
    `METRIC quality_total=${counts.total}`,
    `METRIC quality_closed=${counts.closed}`,
  ].join("\n");
  return {
    ok: true,
    workDir,
    slug,
    researchDir,
    qualityGapsPath: gapsPath,
    open: counts.open,
    closed: counts.closed,
    total: counts.total,
    metricOutput,
  };
}

async function configureSession(args) {
  const { sessionCwd, workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
  const updates = runtimeConfigUpdatesFromArgs(args);
  const maxIterations = numberOption(args.max_iterations ?? args.maxIterations, null);
  const extend = numberOption(args.extend ?? args.extendLimit, null);
  const commitPaths = normalizeRelativePaths(args.commit_paths ?? args.commitPaths, "commitPaths");
  if (maxIterations != null) updates.maxIterations = Math.floor(maxIterations);
  if (extend != null) {
    const state = currentState(workDir);
    const activeRuns = state.current.length;
    const currentMax = Number.isFinite(Number(config.maxIterations)) ? Math.floor(Number(config.maxIterations)) : activeRuns;
    updates.maxIterations = Math.max(currentMax, activeRuns) + Math.floor(extend);
  }
  if (commitPaths.length > 0) updates.commitPaths = commitPaths;
  const nextConfig = await writeRuntimeConfig(sessionCwd, updates);
  return {
    ok: true,
    workDir,
    sessionCwd,
    config: nextConfig,
    updates,
  };
}

async function initExperiment(args) {
  const { workDir } = resolveWorkDir(args.working_dir || args.cwd);
  if (!args.name) throw new Error("name is required");
  if (!args.metric_name && !args.metricName) throw new Error("metric_name is required");
  const metricName = validateMetricName(args.metric_name || args.metricName);
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
  const primaryPresent = finiteMetric(primary) != null;
  const primaryMetric = finiteMetric(primary);
  const improvesPrimary = primaryMetric != null && (state.best == null || isBetter(primaryMetric, state.best, state.config.bestDirection));
  let checks = null;
  const checksCommand = args.checks_command || args.checksCommand || await defaultChecksCommand(workDir);
  const checksPolicy = checksPolicyFromArgs(args, config);
  const explicitChecksCommand = Boolean(args.checks_command || args.checksCommand);
  if (shouldRunChecks(checksPolicy, { benchmarkPassed, primaryPresent, checksCommand, improvesPrimary, explicitChecksCommand })) {
    checks = await runShell(checksCommand, workDir, numberOption(args.checks_timeout_seconds ?? args.checksTimeoutSeconds, DEFAULT_CHECKS_TIMEOUT_SECONDS));
  }
  const checksPassed = checks ? checks.exitCode === 0 && !checks.timedOut : null;
  const metricError = benchmarkPassed && !primaryPresent
    ? `Benchmark completed but did not print primary metric METRIC ${state.config.metricName}=<number>.`
    : null;
  const checksPassedOrSkipped = checksPassed === null || checksPassed;
  const passed = benchmarkPassed && primaryPresent && checksPassedOrSkipped;
  const failedStatus = benchmarkPassed && primaryPresent ? "checks_failed" : "crash";
  const allowedStatuses = passed ? ["keep", "discard"] : [failedStatus];
  return {
    ok: passed,
    workDir,
    command,
    exitCode: benchmark.exitCode,
    timedOut: benchmark.timedOut,
    durationSeconds: benchmark.durationSeconds,
    parsedMetrics,
    parsedPrimary: primary,
    metricError,
    checksPolicy,
    improvesPrimary,
    outputTruncated: Boolean(benchmark.outputTruncated || checks?.outputTruncated),
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
      status: passed ? null : failedStatus,
      needsDecision: passed,
      allowedStatuses,
    },
    limit,
  };
}

async function logExperiment(args) {
  const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
  const lastPacket = boolOption(args.from_last ?? args.fromLast, false) ? await readLastRunPacket(workDir) : null;
  const metric = numberOption(args.metric ?? lastPacket?.decision?.metric, null);
  if (metric == null) throw new Error("metric is required");
  const status = args.status || lastPacket?.decision?.suggestedStatus;
  if (!STATUS_VALUES.has(status)) throw new Error(`status must be one of ${[...STATUS_VALUES].join(", ")}`);
  const description = args.description || lastPacket?.run?.description || "";
  if (!description) throw new Error("description is required");
  const metrics = args.metrics ?? lastPacket?.decision?.metrics ?? {};
  const asi = args.asi ?? lastPacket?.decision?.asiTemplate ?? {};

  const stateBefore = currentState(workDir);
  const inGit = await insideGitRepo(workDir);
  let commit = args.commit || (inGit ? await shortHead(workDir) : "");
  let gitMessage = inGit ? "Git: no commit created." : "Git: not a repo.";
  let revertMessage = "";

  if (status === "keep" && inGit) {
    const resultData = {
      status,
      [stateBefore.config.metricName || "metric"]: metric,
      ...metrics,
    };
    const commitPaths = normalizeRelativePaths(args.commit_paths ?? args.commitPaths ?? config.commitPaths, "commitPaths");
    let addResult;
    if (commitPaths.length > 0) {
      addResult = await git(["add", "--", ...commitPaths], workDir);
    } else {
      addResult = await git(["add", "-A"], workDir);
    }
    if (addResult.code !== 0) {
      throw new Error(`Git add failed: ${gitOutput(addResult, "unknown error")}`);
    }
    if (await hasStagedChanges(workDir)) {
      const commitResult = await git([
        "commit",
        "-m",
        description,
        "-m",
        `Result: ${JSON.stringify(resultData)}`,
      ], workDir);
      if (commitResult.code === 0) {
        commit = await shortHead(workDir);
        gitMessage = `Git: committed ${commit}.`;
      } else {
        throw new Error(`Git commit failed: ${gitOutput(commitResult, "unknown error")}`);
      }
    } else {
      gitMessage = "Git: nothing to commit.";
    }
  } else if (status !== "keep") {
    revertMessage = await cleanupDiscardChanges(workDir, args, config);
  }

  const currentRuns = stateBefore.current;
  const experiment = {
    run: stateBefore.results.length + 1,
    commit: String(commit || "").slice(0, 12),
    metric,
    metrics,
    status,
    description,
    timestamp: Date.now(),
    segment: stateBefore.segment,
    confidence: null,
  };
  if (asi && Object.keys(asi).length > 0) experiment.asi = asi;
  experiment.confidence = computeConfidence([...currentRuns, experiment], stateBefore.config.bestDirection);
  appendJsonl(workDir, experiment);

  const stateAfter = currentState(workDir);
  const limit = iterationLimitInfo(stateAfter, config);
  await appendSessionRunNote(workDir, experiment, stateAfter, { gitMessage, revertMessage });
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
  const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
  const entries = readJsonl(workDir);
  if (entries.length === 0) throw new Error(`No autoresearch.jsonl found in ${workDir}`);
  const output = resolveOutputInside(workDir, args.output || "autoresearch-dashboard.html");
  const html = dashboardHtml(entries, {
    workDir,
    generatedAt: new Date().toISOString(),
    jsonlName: "autoresearch.jsonl",
    refreshMs: Math.max(1, Number(config.dashboardRefreshSeconds || 5)) * 1000,
    commands: dashboardCommands(workDir),
    settings: {
      autonomyMode: config.autonomyMode || "guarded",
      checksPolicy: config.checksPolicy || "always",
      keepPolicy: config.keepPolicy || "primary-only",
    },
  });
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
    await resolveLastRunPath(workDir),
    path.join(workDir, RESEARCH_DIR),
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

function dashboardHtml(entries, meta = {}) {
  const data = JSON.stringify(entries).replace(/</g, "\\u003c");
  const metaData = JSON.stringify(meta).replace(/</g, "\\u003c");
  const template = fs.readFileSync(DASHBOARD_TEMPLATE_PATH, "utf8");
  if (!template.includes(DASHBOARD_DATA_PLACEHOLDER)) {
    throw new Error(`Dashboard template is missing ${DASHBOARD_DATA_PLACEHOLDER}`);
  }
  return template
    .replace(DASHBOARD_DATA_PLACEHOLDER, data)
    .replace("__AUTORESEARCH_META__", metaData);
}

async function resolveLastRunPath(workDir) {
  if (await insideGitRepo(workDir)) {
    return await gitPrivatePath(workDir, "autoresearch/last-run.json");
  }
  return path.join(workDir, "autoresearch.last-run.json");
}

async function writeLastRunPacket(workDir, packet, filePath = null) {
  const target = filePath || await resolveLastRunPath(workDir);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  return target;
}

async function readLastRunPacket(workDir) {
  const filePath = await resolveLastRunPath(workDir);
  const legacyPath = path.join(workDir, "autoresearch.last-run.json");
  const readablePath = fs.existsSync(filePath) ? filePath : legacyPath;
  if (!fs.existsSync(readablePath)) throw new Error(`No last-run packet found for ${workDir}. Run next before using --from-last.`);
  return JSON.parse(fs.readFileSync(readablePath, "utf8"));
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
    settings: {
      autonomyMode: config.autonomyMode || "guarded",
      checksPolicy: config.checksPolicy || "always",
      keepPolicy: config.keepPolicy || "primary-only",
      dashboardRefreshSeconds: config.dashboardRefreshSeconds || 5,
      commitPaths: config.commitPaths || [],
    },
    commands: dashboardCommands(workDir),
  };
}

function dashboardCommands(workDir) {
  const cwd = shellQuote(workDir);
  const script = shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"));
  return [
    { label: "Doctor", command: `node ${script} doctor --cwd ${cwd} --check-benchmark` },
    { label: "Next run", command: `node ${script} next --cwd ${cwd}` },
    { label: "Keep last", command: `node ${script} log --cwd ${cwd} --from-last --status keep --description "Describe the kept change"` },
    { label: "Discard last", command: `node ${script} log --cwd ${cwd} --from-last --status discard --description "Describe the discarded change"` },
    { label: "Export dashboard", command: `node ${script} export --cwd ${cwd}` },
    { label: "Extend limit", command: `node ${script} config --cwd ${cwd} --extend 10` },
  ];
}

async function doctorSession(args) {
  const { workDir } = resolveWorkDir(args.working_dir || args.cwd);
  const state = publicState(args);
  const issues = [];
  const warnings = [];
  const inGit = await insideGitRepo(workDir);
  const clean = await isGitClean(workDir);

  if (!state.config.metricName) issues.push("No primary metric is configured.");
  if (state.runs === 0) warnings.push("No runs are logged yet. Run a baseline before experimenting.");
  if (inGit && clean === false) warnings.push("Git worktree is dirty; review unrelated changes before logging a keep result.");
  if (!inGit) warnings.push("Working directory is not a Git repository; keep commits and discard reverts are unavailable.");

  const benchmark = {
    checked: false,
    command: args.command || "",
    emitsPrimary: null,
    parsedMetrics: {},
    exitCode: null,
    timedOut: false,
    metricError: null,
  };

  if (boolOption(args.check_benchmark ?? args.checkBenchmark, false)) {
    benchmark.checked = true;
    benchmark.command = args.command || await defaultBenchmarkCommand(workDir);
    if (!benchmark.command) {
      benchmark.metricError = "No benchmark command was provided and no autoresearch script was found.";
      issues.push(benchmark.metricError);
    } else {
      const run = await runShell(benchmark.command, workDir, numberOption(args.timeout_seconds ?? args.timeoutSeconds, 60));
      benchmark.exitCode = run.exitCode;
      benchmark.timedOut = run.timedOut;
      benchmark.parsedMetrics = parseMetricLines(run.output);
      benchmark.emitsPrimary = finiteMetric(benchmark.parsedMetrics[state.config.metricName]) != null;
      if (run.exitCode !== 0 || run.timedOut) {
        issues.push(`Benchmark command failed during doctor check: exit ${run.exitCode ?? "none"}${run.timedOut ? " (timed out)" : ""}.`);
      } else if (!benchmark.emitsPrimary) {
        benchmark.metricError = `Benchmark did not emit primary metric METRIC ${state.config.metricName}=<number>.`;
        issues.push(benchmark.metricError);
      }
    }
  }

  let nextAction = "Run the next experiment, then log keep or discard with ASI.";
  if (issues.some((issue) => /primary metric|Benchmark/.test(issue))) {
    nextAction = "Fix the benchmark command so it emits the configured primary metric before continuing.";
  } else if (state.runs === 0) {
    nextAction = "Run and log a baseline before trying optimizations.";
  } else if (state.limit.limitReached) {
    nextAction = "Iteration limit reached; export the dashboard or start a new segment.";
  } else if (warnings.some((warning) => /dirty/.test(warning))) {
    nextAction = "Review the dirty Git state before logging a kept result.";
  }

  return {
    ok: issues.length === 0,
    workDir,
    config: state.config,
    state,
    git: {
      inside: inGit,
      clean,
    },
    benchmark,
    issues,
    warnings,
    nextAction,
  };
}

async function nextExperiment(args) {
  const doctor = await doctorSession({
    ...args,
    check_benchmark: false,
    checkBenchmark: false,
  });
  if (!doctor.ok) {
    return {
      ok: false,
      workDir: doctor.workDir,
      doctor,
      run: null,
      decision: null,
      nextAction: doctor.nextAction,
    };
  }
  const run = await runExperiment(args);
  const decision = {
    metric: run.parsedPrimary,
    metrics: run.logHint.metrics,
    allowedStatuses: run.logHint.allowedStatuses,
    suggestedStatus: run.logHint.status,
    needsDecision: run.logHint.needsDecision,
    asiTemplate: run.ok
      ? {
          hypothesis: "",
          evidence: `${run.metricName}=${run.parsedPrimary}${run.metricUnit || ""}`,
          next_action_hint: "",
        }
      : {
          evidence: run.metricError || `Benchmark exit ${run.exitCode ?? "none"}`,
          rollback_reason: "",
          next_action_hint: "",
        },
  };
  const lastRunFile = await resolveLastRunPath(run.workDir);
  const packet = {
    ok: doctor.ok && run.ok,
    workDir: run.workDir,
    lastRunPath: lastRunFile,
    doctor,
    run,
    decision,
    nextAction: run.ok
      ? "Log this run with status keep or discard, include ASI, then continue with the next hypothesis."
      : `Log this run as ${run.logHint.status} with rollback ASI before trying another change.`,
  };
  await writeLastRunPacket(run.workDir, packet, lastRunFile);
  return packet;
}

async function callTool(name, args) {
  if (name === "setup_session") return await setupSession(args);
  if (name === "setup_research_session") return await setupResearchSession(args);
  if (name === "configure_session") return await configureSession(args);
  if (name === "init_experiment") return await initExperiment(args);
  if (name === "run_experiment") {
    requireUnsafeCommandGate(name, args);
    return await runExperiment(args);
  }
  if (name === "next_experiment") {
    requireUnsafeCommandGate(name, args);
    return await nextExperiment(args);
  }
  if (name === "log_experiment") return await logExperiment({
    ...args,
    metrics: parseJsonOption(args.metrics, null),
    asi: parseJsonOption(args.asi, null),
  });
  if (name === "export_dashboard") return await exportDashboard(args);
  if (name === "clear_session") return await clearSession(args);
  if (name === "read_state") return publicState(args);
  if (name === "measure_quality_gap") return await measureQualityGap(args);
  if (name === "doctor_session") {
    requireUnsafeCommandGate(name, args);
    return await doctorSession(args);
  }
  throw new Error(`Unknown tool: ${name}`);
}

function requireUnsafeCommandGate(toolName, args) {
  const hasCustomCommand = Boolean(args.command || args.checks_command || args.checksCommand);
  if (hasCustomCommand && !boolOption(args.allow_unsafe_command ?? args.allowUnsafeCommand, false)) {
    throw new Error(`${toolName} custom shell commands require allow_unsafe_command=true over MCP. Prefer a configured autoresearch script when possible.`);
  }
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
        commit_paths: { type: "array", items: { type: "string" } },
        max_iterations: { type: "number" },
        autonomy_mode: { type: "string", enum: ["guarded", "owner-autonomous", "manual"] },
        checks_policy: { type: "string", enum: ["always", "on-improvement", "manual"] },
        keep_policy: { type: "string", enum: ["primary-only", "primary-or-risk-reduction"] },
        dashboard_refresh_seconds: { type: "number" },
        overwrite: { type: "boolean" },
        create_checks: { type: "boolean" },
        skip_init: { type: "boolean" },
      },
      required: ["working_dir", "name", "metric_name"],
    },
  },
  {
    name: "setup_research_session",
    description: "Create a deep-research scratchpad and initialize a quality_gap autoresearch session.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        slug: { type: "string" },
        goal: { type: "string" },
        name: { type: "string" },
        checks_command: { type: "string" },
        shell: { type: "string", enum: ["bash", "powershell"] },
        files_in_scope: { type: "array", items: { type: "string" } },
        constraints: { type: "array", items: { type: "string" } },
        commit_paths: { type: "array", items: { type: "string" } },
        max_iterations: { type: "number" },
        autonomy_mode: { type: "string", enum: ["guarded", "owner-autonomous", "manual"] },
        checks_policy: { type: "string", enum: ["always", "on-improvement", "manual"] },
        keep_policy: { type: "string", enum: ["primary-only", "primary-or-risk-reduction"] },
        dashboard_refresh_seconds: { type: "number" },
        overwrite: { type: "boolean" },
        create_checks: { type: "boolean" },
        skip_init: { type: "boolean" },
      },
      required: ["working_dir", "slug", "goal"],
    },
  },
  {
    name: "configure_session",
    description: "Update runtime settings such as autonomy mode, checks policy, keep policy, dashboard refresh, commit paths, or iteration limit.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        autonomy_mode: { type: "string", enum: ["guarded", "owner-autonomous", "manual"] },
        checks_policy: { type: "string", enum: ["always", "on-improvement", "manual"] },
        keep_policy: { type: "string", enum: ["primary-only", "primary-or-risk-reduction"] },
        dashboard_refresh_seconds: { type: "number" },
        max_iterations: { type: "number" },
        extend: { type: "number" },
        commit_paths: { type: "array", items: { type: "string" } },
      },
      required: ["working_dir"],
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
        checks_policy: { type: "string", enum: ["always", "on-improvement", "manual"] },
        allow_unsafe_command: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "next_experiment",
    description: "Run a preflight readout and benchmark in one packet, then return allowed log decisions and an ASI template.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        command: { type: "string" },
        timeout_seconds: { type: "number" },
        checks_command: { type: "string" },
        checks_timeout_seconds: { type: "number" },
        checks_policy: { type: "string", enum: ["always", "on-improvement", "manual"] },
        allow_unsafe_command: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "log_experiment",
    description: "Append an experiment result, then keep/commit or discard/revert changes.",
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
        commit_paths: { type: "array", items: { type: "string" } },
        revert_paths: { type: "array", items: { type: "string" } },
        allow_dirty_revert: { type: "boolean" },
        from_last: { type: "boolean" },
      },
      required: ["working_dir", "description"],
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
    name: "measure_quality_gap",
    description: "Count open and closed checklist items in autoresearch.research/<slug>/quality-gaps.md.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        research_slug: { type: "string" },
      },
      required: ["working_dir", "research_slug"],
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
    name: "doctor_session",
    description: "Run a preflight readout for an autoresearch session and optionally verify benchmark metric output.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        command: { type: "string" },
        check_benchmark: { type: "boolean" },
        timeout_seconds: { type: "number" },
        allow_unsafe_command: { type: "boolean" },
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
    if (buffer.length > MAX_MCP_FRAME_BYTES + 1024 && buffer.indexOf("\r\n\r\n") < 0) {
      buffer = Buffer.alloc(0);
      sendMcp({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Request too large." } });
      return;
    }
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
      if (!Number.isFinite(length) || length < 0 || length > MAX_MCP_FRAME_BYTES) {
        sendMcp({ jsonrpc: "2.0", id: null, error: { code: -32000, message: `Request too large. Max frame size is ${MAX_MCP_FRAME_BYTES} bytes.` } });
        buffer = buffer.length >= bodyStart + Math.max(0, length)
          ? buffer.subarray(bodyStart + Math.max(0, length))
          : Buffer.alloc(0);
        continue;
      }
      if (buffer.length < bodyStart + length) return;
      const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      buffer = buffer.subarray(bodyStart + length);
      let message;
      try {
        message = JSON.parse(body);
      } catch (error) {
        sendMcp({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${error.message}` } });
        continue;
      }
      handleMcpMessage(message).catch((error) => {
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
        serverInfo: { name: "codex-autoresearch", version: "0.1.5" },
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
      validateToolArguments(message.params?.name, message.params?.arguments || {});
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

function isObjectArgument(value) {
  return typeof value === "object" && !Array.isArray(value);
}

function validateToolArguments(name, args) {
  const schema = toolSchemas.find((tool) => tool.name === name)?.inputSchema;
  if (!schema) throw new Error(`Unknown tool: ${name}`);
  for (const required of schema.required || []) {
    if (args[required] == null || args[required] === "") throw new Error(`Missing required argument: ${required}`);
  }
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties?.[key];
    if (!property || value == null) continue;
    if (property.type === "array" && !Array.isArray(value)) throw new Error(`Argument ${key} must be an array.`);
    if (property.type === "object" && !isObjectArgument(value)) throw new Error(`Argument ${key} must be an object.`);
    if (property.type === "number" && typeof value !== "number") throw new Error(`Argument ${key} must be a number.`);
    if (property.type === "boolean" && typeof value !== "boolean") throw new Error(`Argument ${key} must be a boolean.`);
    if (property.type === "string" && typeof value !== "string") throw new Error(`Argument ${key} must be a string.`);
    if (property.enum && !property.enum.includes(value)) throw new Error(`Argument ${key} must be one of ${property.enum.join(", ")}.`);
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
      commitPaths: args.commitPaths,
      maxIterations: args.maxIterations,
      autonomyMode: args.autonomyMode,
      checksPolicy: args.checksPolicy,
      keepPolicy: args.keepPolicy,
      dashboardRefreshSeconds: args.dashboardRefreshSeconds,
      overwrite: args.overwrite,
      createChecks: args.createChecks,
      skipInit: args.skipInit,
    });
  } else if (command === "research-setup") {
    result = await setupResearchSession({
      cwd: args.cwd,
      slug: args.slug,
      goal: args.goal,
      name: args.name,
      checksCommand: args.checksCommand,
      shell: args.shell,
      filesInScope: args.filesInScope,
      constraints: args.constraints,
      commitPaths: args.commitPaths,
      maxIterations: args.maxIterations,
      autonomyMode: args.autonomyMode,
      checksPolicy: args.checksPolicy,
      keepPolicy: args.keepPolicy,
      dashboardRefreshSeconds: args.dashboardRefreshSeconds,
      overwrite: args.overwrite,
      createChecks: args.createChecks,
      skipInit: args.skipInit,
    });
  } else if (command === "config") {
    result = await configureSession({
      cwd: args.cwd,
      autonomyMode: args.autonomyMode,
      checksPolicy: args.checksPolicy,
      keepPolicy: args.keepPolicy,
      dashboardRefreshSeconds: args.dashboardRefreshSeconds,
      maxIterations: args.maxIterations,
      extend: args.extend,
      commitPaths: args.commitPaths,
    });
  } else if (command === "quality-gap") {
    result = await measureQualityGap({
      cwd: args.cwd,
      researchSlug: args.researchSlug,
      slug: args.slug,
    });
    console.log(result.metricOutput);
    return;
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
      checksPolicy: args.checksPolicy,
    });
  } else if (command === "next") {
    result = await nextExperiment({
      cwd: args.cwd,
      command: args.command,
      timeoutSeconds: args.timeoutSeconds,
      checksCommand: args.checksCommand,
      checksTimeoutSeconds: args.checksTimeoutSeconds,
      checksPolicy: args.checksPolicy,
    });
  } else if (command === "log") {
    result = await logExperiment({
      cwd: args.cwd,
      commit: args.commit,
      metric: args.metric,
      status: args.status,
      description: args.description,
      metrics: parseJsonOption(args.metrics, null),
      asi: parseJsonOption(args.asi, null),
      commitPaths: args.commitPaths,
      revertPaths: args.revertPaths,
      allowDirtyRevert: args.allowDirtyRevert,
      fromLast: args.fromLast,
    });
  } else if (command === "state") {
    result = publicState({ cwd: args.cwd });
  } else if (command === "doctor") {
    result = await doctorSession({
      cwd: args.cwd,
      command: args.command,
      checkBenchmark: args.checkBenchmark,
      timeoutSeconds: args.timeoutSeconds,
    });
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
