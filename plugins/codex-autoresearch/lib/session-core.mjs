import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const STATUS_VALUES = new Set(["keep", "discard", "crash", "checks_failed"]);
export const RESEARCH_DIR = "autoresearch.research";

export function listOption(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value == null || value === "") return [];
  return String(value)
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function safeSlug(value, fallback = "research") {
  const slug = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug || fallback;
}

export function shellQuote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

export function finiteMetric(value) {
  if (value == null || value === "") return null;
  const metric = Number(value);
  return Number.isFinite(metric) ? metric : null;
}

export async function pathExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function readConfig(sessionCwd) {
  const configPath = path.join(sessionCwd, "autoresearch.config.json");
  if (!fs.existsSync(configPath)) return {};
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

export function resolveWorkDir(cwdArg) {
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

export function jsonlPath(workDir) {
  return path.join(workDir, "autoresearch.jsonl");
}

export function appendJsonl(workDir, entry) {
  fs.appendFileSync(jsonlPath(workDir), JSON.stringify(entry) + os.EOL);
}

export function readJsonl(workDir) {
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

export function bestMetric(runs, direction) {
  let best = null;
  for (const run of runs) {
    const metric = finiteMetric(run.metric);
    if (metric == null) continue;
    if (best == null || isBetter(metric, best, direction)) best = metric;
  }
  return best;
}

export function isBetter(value, current, direction) {
  return direction === "higher" ? value > current : value < current;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function computeConfidence(runs, direction) {
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

export function currentState(workDir) {
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

export function iterationLimitInfo(state, runtimeConfig) {
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

export function parseQualityGaps(text) {
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

export function researchSlugFromArgs(args) {
  return safeSlug(args.research_slug ?? args.researchSlug ?? args.slug ?? args.name ?? "research");
}

export function researchDirPath(workDir, slug) {
  return path.join(workDir, RESEARCH_DIR, slug);
}
