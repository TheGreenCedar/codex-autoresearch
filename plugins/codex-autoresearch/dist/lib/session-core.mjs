import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
//#region lib/session-core.ts
const STATUS_VALUES = new Set([
	"keep",
	"discard",
	"crash",
	"checks_failed"
]);
const FAILURE_STATUSES = new Set(["crash", "checks_failed"]);
const RESEARCH_DIR = "autoresearch.research";
function listOption(value) {
	if (Array.isArray(value)) return value.map(String).filter(Boolean);
	if (value == null || value === "") return [];
	return String(value).split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
}
function safeSlug(value, fallback = "research") {
	return String(value || fallback).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/g, "") || fallback;
}
function shellQuote(value) {
	return `"${String(value).replace(/"/g, "\\\"")}"`;
}
const METRIC_VALUE_PATTERN = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
function finiteMetric(value) {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed || !METRIC_VALUE_PATTERN.test(trimmed)) return null;
	const metric = Number(trimmed);
	return Number.isFinite(metric) ? metric : null;
}
function hasFiniteMetric(run) {
	return finiteMetric(run?.metric) != null;
}
function isFailureStatus(status) {
	return FAILURE_STATUSES.has(status);
}
function isBaselineEligibleMetricRun(run) {
	return hasFiniteMetric(run) && !isFailureStatus(run?.status);
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
	const workDir = config.workingDir ? path.resolve(sessionCwd, config.workingDir) : sessionCwd;
	if (!fs.existsSync(workDir) || !fs.statSync(workDir).isDirectory()) throw new Error(`Working directory does not exist: ${workDir}`);
	return {
		sessionCwd,
		workDir,
		config
	};
}
function jsonlPath(workDir) {
	return path.join(workDir, "autoresearch.jsonl");
}
function appendJsonl(workDir, entry) {
	fs.appendFileSync(jsonlPath(workDir), JSON.stringify(entry) + os.EOL);
}
function readJsonl(workDir) {
	const filePath = jsonlPath(workDir);
	if (!fs.existsSync(filePath)) return [];
	return fs.readFileSync(filePath, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
		try {
			return JSON.parse(line);
		} catch (error) {
			throw new Error(`Invalid JSONL in ${filePath} at line ${index + 1}: ${error.message}`);
		}
	});
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
function bestKeptMetric(runs, direction) {
	return bestMetric(runs.filter((run) => run.status === "keep"), direction);
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
	const values = runs.filter(isBaselineEligibleMetricRun).map((run) => finiteMetric(run.metric));
	if (values.length < 3) return null;
	const baseline = values[0];
	const best = bestKeptMetric(runs, direction);
	if (best == null || best === baseline) return null;
	const med = median(values);
	const mad = median(values.map((value) => Math.abs(value - med)));
	if (mad === 0) return null;
	return Math.abs(best - baseline) / mad;
}
function currentState(workDir) {
	const entries = readJsonl(workDir);
	let config = {
		name: null,
		metricName: "metric",
		metricUnit: "",
		bestDirection: "lower"
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
				bestDirection: entry.bestDirection === "higher" ? "higher" : "lower"
			};
			continue;
		}
		if (entry.run != null) {
			const run = {
				...entry,
				segment: entry.segment ?? segment
			};
			if (Object.hasOwn(entry, "metric")) run.metric = finiteMetric(entry.metric);
			results.push(run);
		}
	}
	const current = results.filter((run) => run.segment === segment);
	const baseline = finiteMetric(current.find(isBaselineEligibleMetricRun)?.metric);
	const best = bestKeptMetric(current, config.bestDirection);
	const confidence = computeConfidence(current, config.bestDirection);
	return {
		config,
		segment,
		results,
		current,
		baseline,
		best,
		confidence
	};
}
function lastRunConfigSnapshot(config = {}) {
	return {
		name: config.name || null,
		metricName: config.metricName || "metric",
		metricUnit: config.metricUnit ?? "",
		bestDirection: config.bestDirection === "higher" ? "higher" : "lower"
	};
}
function statusHash(value) {
	return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}
function normalizeScopedFileFingerprints(fingerprints) {
	if (!fingerprints || typeof fingerprints !== "object" || Array.isArray(fingerprints)) return {};
	return Object.fromEntries(Object.entries(fingerprints).filter(([key, value]) => key && value != null).map(([key, value]) => [String(key).replace(/\\/g, "/"), String(value)]).sort(([left], [right]) => left.localeCompare(right)));
}
function buildLastRunFreshnessSnapshot(workDir, context = {}) {
	const state = context.state || currentState(workDir);
	const snapshot = {
		segment: state.segment,
		config: context.configSnapshot || lastRunConfigSnapshot(state.config),
		currentRuns: state.current.length,
		totalRuns: state.results.length,
		nextRun: state.results.length + 1
	};
	addSnapshotString(snapshot, "command", context.command);
	addSnapshotPath(snapshot, "cwd", context.cwd);
	addSnapshotPath(snapshot, "workingDir", context.workingDir);
	addSnapshotString(snapshot, "gitHead", context.gitHead);
	addSnapshotString(snapshot, "dirtyStatusHash", context.dirtyStatusHash);
	if (context.scopedFileFingerprints != null) snapshot.scopedFileFingerprints = normalizeScopedFileFingerprints(context.scopedFileFingerprints);
	return snapshot;
}
function lastRunPacketFreshness(workDir, packet, context = {}) {
	const expected = packet?.history;
	if (!expected || typeof expected !== "object") return {
		fresh: false,
		reason: "Last-run packet is missing history metadata. Run next again before logging."
	};
	const actual = buildLastRunFreshnessSnapshot(workDir, context);
	if (!Number.isFinite(Number(expected.nextRun))) return {
		fresh: false,
		reason: "Last-run packet is missing history metadata. Run next again before logging."
	};
	if (Number.isFinite(Number(expected.segment)) && actual.segment !== Number(expected.segment)) return {
		fresh: false,
		expectedSegment: Number(expected.segment),
		actualSegment: actual.segment,
		reason: `Last-run packet is stale: expected segment #${Number(expected.segment)}, but current segment is #${actual.segment}. Run next again before logging.`
	};
	if (!expected.config || typeof expected.config !== "object") return {
		fresh: false,
		reason: "Last-run packet is missing config metadata. Run next again before logging."
	};
	if (JSON.stringify(expected.config) !== JSON.stringify(actual.config)) return {
		fresh: false,
		expectedConfig: expected.config,
		actualConfig: actual.config,
		reason: "Last-run packet is stale: session config changed since the packet was created. Run next again before logging."
	};
	if (Number(expected.nextRun) !== actual.nextRun) return {
		fresh: false,
		expectedNextRun: Number(expected.nextRun),
		actualNextRun: actual.nextRun,
		reason: `Last-run packet is stale: expected next log run #${Number(expected.nextRun)}, but current history would log #${actual.nextRun}. Run next again before logging.`
	};
	const contextualMismatch = firstFreshnessContextMismatch(expected, actual);
	if (contextualMismatch) return contextualMismatch;
	return {
		fresh: true,
		expectedNextRun: Number(expected.nextRun),
		actualNextRun: actual.nextRun,
		reason: "Last-run packet matches the current ledger."
	};
}
function assertFreshLastRunPacket(workDir, packet, context = {}) {
	const freshness = lastRunPacketFreshness(workDir, packet, context);
	if (!freshness.fresh) throw new Error(freshness.reason);
	return freshness;
}
function addSnapshotString(snapshot, key, value) {
	if (value != null && value !== "") snapshot[key] = String(value);
}
function addSnapshotPath(snapshot, key, value) {
	if (value != null && value !== "") snapshot[key] = path.resolve(String(value));
}
function firstFreshnessContextMismatch(expected, actual) {
	for (const key of [
		"command",
		"cwd",
		"workingDir",
		"gitHead",
		"dirtyStatusHash"
	]) {
		if (!Object.hasOwn(expected, key)) continue;
		if (expected[key] !== actual[key]) return {
			fresh: false,
			expectedValue: expected[key],
			actualValue: actual[key] ?? null,
			reason: `Last-run packet is stale: ${key} changed since the packet was created. Run next again before logging.`
		};
	}
	if (Object.hasOwn(expected, "scopedFileFingerprints")) {
		const expectedFingerprints = normalizeScopedFileFingerprints(expected.scopedFileFingerprints);
		const actualFingerprints = normalizeScopedFileFingerprints(actual.scopedFileFingerprints);
		if (JSON.stringify(expectedFingerprints) !== JSON.stringify(actualFingerprints)) return {
			fresh: false,
			expectedValue: expectedFingerprints,
			actualValue: actualFingerprints,
			reason: "Last-run packet is stale: scoped file fingerprints changed since the packet was created. Run next again before logging."
		};
	}
	return null;
}
function iterationLimitInfo(state, runtimeConfig) {
	const maxIterations = Number(runtimeConfig.maxIterations);
	if (!Number.isFinite(maxIterations) || maxIterations <= 0) return {
		maxIterations: null,
		remainingIterations: null,
		limitReached: false
	};
	const max = Math.floor(maxIterations);
	return {
		maxIterations: max,
		remainingIterations: Math.max(0, max - state.current.length),
		limitReached: state.current.length >= max
	};
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
	return {
		open,
		closed,
		total: open + closed
	};
}
function researchSlugFromArgs(args) {
	return safeSlug(args.research_slug ?? args.researchSlug ?? args.slug ?? args.name ?? "research");
}
function researchDirPath(workDir, slug) {
	return path.join(workDir, RESEARCH_DIR, slug);
}
//#endregion
export { FAILURE_STATUSES, RESEARCH_DIR, STATUS_VALUES, appendJsonl, assertFreshLastRunPacket, bestKeptMetric, bestMetric, buildLastRunFreshnessSnapshot, computeConfidence, currentState, finiteMetric, hasFiniteMetric, isBaselineEligibleMetricRun, isBetter, isFailureStatus, iterationLimitInfo, jsonlPath, lastRunConfigSnapshot, lastRunPacketFreshness, listOption, normalizeScopedFileFingerprints, parseQualityGaps, pathExists, readConfig, readJsonl, researchDirPath, researchSlugFromArgs, resolveWorkDir, safeSlug, shellQuote, statusHash };
