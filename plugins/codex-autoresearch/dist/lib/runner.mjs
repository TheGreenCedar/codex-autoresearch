import { spawn } from "node:child_process";
//#region lib/runner.ts
const DENIED_METRIC_NAMES = new Set([
	"__proto__",
	"constructor",
	"prototype"
]);
const OUTPUT_MAX_LINES = 20;
const OUTPUT_MAX_BYTES = 8192;
const OUTPUT_CAPTURE_BYTES = 16384;
const FULL_OUTPUT_CAPTURE_BYTES = 1024 * 1024;
const METRIC_OUTPUT_CAPTURE_BYTES = 64 * 1024;
const PROCESS_OUTPUT_CAPTURE_BYTES = 32768;
const METRIC_LINE_MAX_CHARS = 4096;
function parseMetricLines(output, options = {}) {
	const metrics = Object.create(null);
	const maxMetrics = Number.isInteger(options.maxMetrics) && Number(options.maxMetrics) > 0 ? Number(options.maxMetrics) : Infinity;
	const primaryMetricName = options.primaryMetricName ? String(options.primaryMetricName) : "";
	const withTruncation = Boolean(options.withTruncation);
	let retainedCount = 0;
	let truncated = false;
	const collect = (line) => {
		const collected = collectMetricLine(metrics, line, {
			maxMetrics,
			primaryMetricName,
			retainedCount
		});
		retainedCount = collected.retainedCount;
		truncated = truncated || collected.truncated;
	};
	for (const line of String(output || "").split(/\r?\n/)) collect(line);
	return withTruncation ? {
		metrics,
		truncated
	} : metrics;
}
function createMetricCollector() {
	const metrics = Object.create(null);
	let pending = "";
	return {
		append(text) {
			pending += text;
			const lines = pending.split(/\r?\n/);
			pending = lines.pop() ?? "";
			if (pending.length > METRIC_LINE_MAX_CHARS) pending = pending.slice(-METRIC_LINE_MAX_CHARS);
			for (const line of lines) collectMetricLine(metrics, line);
		},
		finish() {
			if (pending) {
				collectMetricLine(metrics, pending);
				pending = "";
			}
			return metrics;
		}
	};
}
function collectMetricLine(metrics, line, options = {}) {
	let retainedCount = Number(options.retainedCount) || 0;
	const match = String(line).match(/^METRIC\s+([^=\s]+)=(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*$/i);
	if (!match) return {
		retainedCount,
		truncated: false
	};
	const name = match[1];
	if (DENIED_METRIC_NAMES.has(name)) return {
		retainedCount,
		truncated: false
	};
	const value = Number(match[2]);
	if (!Number.isFinite(value)) return {
		retainedCount,
		truncated: false
	};
	if (Object.hasOwn(metrics, name) || name === options.primaryMetricName || retainedCount < (options.maxMetrics ?? Infinity)) {
		if (!Object.hasOwn(metrics, name)) retainedCount += 1;
		metrics[name] = value;
		return {
			retainedCount,
			truncated: false
		};
	}
	return {
		retainedCount,
		truncated: true
	};
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
async function runShell(command, cwd, timeoutSeconds = 600, options = {}) {
	const startedAt = Date.now();
	return await new Promise((resolve) => {
		const child = spawn(command, {
			cwd,
			shell: true,
			detached: process.platform !== "win32",
			windowsHide: true,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		let output = "";
		let fullOutput = "";
		let metricOutput = "";
		let metricOutputBytes = 0;
		let pendingMetricText = "";
		const retainedMetricNames = new Set((options.retainMetricNames || []).map(String).filter(Boolean));
		const retainedMetricLines = /* @__PURE__ */ new Map();
		let outputTruncated = false;
		let fullOutputTruncated = false;
		let metricOutputTruncated = false;
		let timedOut = false;
		const metricCollector = createMetricCollector();
		const maxOutputBytes = positiveByteLimit(options.maxOutputBytes, OUTPUT_CAPTURE_BYTES);
		const maxFullOutputBytes = positiveByteLimit(options.maxFullOutputBytes, FULL_OUTPUT_CAPTURE_BYTES);
		const maxMetricOutputBytes = positiveByteLimit(options.maxMetricOutputBytes, METRIC_OUTPUT_CAPTURE_BYTES);
		const appendMetricLine = (line) => {
			const name = metricLineName(line);
			if (name && retainedMetricNames.has(name)) retainedMetricLines.set(name, line);
			const text = `${line}\n`;
			const bytes = Buffer.byteLength(text, "utf8");
			if (metricOutputBytes + bytes > maxMetricOutputBytes) {
				metricOutputTruncated = true;
				return;
			}
			metricOutput += text;
			metricOutputBytes += bytes;
		};
		const appendMetricLines = (text) => {
			pendingMetricText += text;
			const lines = pendingMetricText.split(/\r?\n/);
			pendingMetricText = lines.pop() || "";
			if (pendingMetricText.length > METRIC_LINE_MAX_CHARS) pendingMetricText = pendingMetricText.slice(-METRIC_LINE_MAX_CHARS);
			for (const line of lines) if (/^METRIC\s+/i.test(line.trim())) appendMetricLine(line);
		};
		const appendOutput = (text) => {
			metricCollector.append(text);
			appendMetricLines(text);
			fullOutput += text;
			if (Buffer.byteLength(fullOutput, "utf8") > maxFullOutputBytes) {
				const buf = Buffer.from(fullOutput, "utf8");
				fullOutput = buf.subarray(Math.max(0, buf.length - maxFullOutputBytes)).toString("utf8");
				fullOutputTruncated = true;
			}
			output += text;
			if (Buffer.byteLength(output, "utf8") > maxOutputBytes) {
				const buf = Buffer.from(output, "utf8");
				output = buf.subarray(Math.max(0, buf.length - maxOutputBytes)).toString("utf8");
				outputTruncated = true;
			}
		};
		const timeout = setTimeout(() => {
			timedOut = true;
			killProcess(child.pid);
		}, Math.max(1, timeoutSeconds) * 1e3);
		child.stdout.on("data", (chunk) => {
			appendOutput(chunk.toString("utf8"));
		});
		child.stderr.on("data", (chunk) => {
			appendOutput(chunk.toString("utf8"));
		});
		child.on("error", (error) => {
			clearTimeout(timeout);
			if (/^METRIC\s+/i.test(pendingMetricText.trim())) appendMetricLine(pendingMetricText);
			const errorText = String(error.stack || error.message || error);
			const retainedMetricOutput = retainedMetricText(retainedMetricLines);
			resolve({
				command,
				exitCode: null,
				timedOut,
				durationSeconds: (Date.now() - startedAt) / 1e3,
				output: errorText,
				fullOutput: `${fullOutput}${fullOutput ? "\n" : ""}${errorText}`,
				metricOutput,
				retainedMetricOutput,
				metricOutputTruncated,
				outputTruncated,
				fullOutputTruncated,
				parsedMetrics: metricCollector.finish()
			});
		});
		child.on("close", (code) => {
			clearTimeout(timeout);
			if (/^METRIC\s+/i.test(pendingMetricText.trim())) appendMetricLine(pendingMetricText);
			const retainedMetricOutput = retainedMetricText(retainedMetricLines);
			resolve({
				command,
				exitCode: code,
				timedOut,
				durationSeconds: (Date.now() - startedAt) / 1e3,
				output,
				fullOutput,
				metricOutput,
				retainedMetricOutput,
				metricOutputTruncated,
				outputTruncated,
				fullOutputTruncated,
				parsedMetrics: metricCollector.finish()
			});
		});
	});
}
async function runProcess(command, args = [], { cwd, timeoutSeconds = 600, maxOutputBytes = PROCESS_OUTPUT_CAPTURE_BYTES } = {}) {
	const startedAt = Date.now();
	const argv = Array.isArray(args) ? args.map(String) : [];
	const commandDisplay = [command, ...argv].map(shellDisplayPart).join(" ");
	return await new Promise((resolve) => {
		const child = spawn(command, argv, {
			cwd,
			detached: process.platform !== "win32",
			windowsHide: true,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		let stdout = "";
		let stderr = "";
		let stdoutTruncated = false;
		let stderrTruncated = false;
		let timedOut = false;
		const metricCollector = createMetricCollector();
		const appendOutput = (target, text) => {
			metricCollector.append(text);
			let value = target === "stdout" ? stdout : stderr;
			let truncated = target === "stdout" ? stdoutTruncated : stderrTruncated;
			value += text;
			if (Buffer.byteLength(value, "utf8") > maxOutputBytes) {
				const buf = Buffer.from(value, "utf8");
				value = buf.subarray(Math.max(0, buf.length - maxOutputBytes)).toString("utf8");
				truncated = true;
			}
			if (target === "stdout") {
				stdout = value;
				stdoutTruncated = truncated;
			} else {
				stderr = value;
				stderrTruncated = truncated;
			}
		};
		const timeout = setTimeout(() => {
			timedOut = true;
			killProcess(child.pid);
		}, Math.max(1, Number(timeoutSeconds) || 1) * 1e3);
		child.stdout.on("data", (chunk) => {
			appendOutput("stdout", chunk.toString("utf8"));
		});
		child.stderr.on("data", (chunk) => {
			appendOutput("stderr", chunk.toString("utf8"));
		});
		child.on("error", (error) => {
			clearTimeout(timeout);
			resolve(processResult({
				commandDisplay,
				exitCode: null,
				stdout,
				stderr: `${stderr}${stderr ? "\n" : ""}${error.message || String(error)}`,
				stdoutTruncated,
				stderrTruncated,
				timedOut,
				startedAt,
				parsedMetrics: metricCollector.finish()
			}));
		});
		child.on("close", (code) => {
			clearTimeout(timeout);
			resolve(processResult({
				commandDisplay,
				exitCode: code,
				stdout,
				stderr,
				stdoutTruncated,
				stderrTruncated,
				timedOut,
				startedAt,
				parsedMetrics: metricCollector.finish()
			}));
		});
	});
}
function processResult({ commandDisplay, exitCode, stdout, stderr, stdoutTruncated, stderrTruncated, timedOut, startedAt, parsedMetrics = Object.create(null) }) {
	const durationSeconds = (Date.now() - startedAt) / 1e3;
	return {
		command: commandDisplay,
		commandDisplay,
		code: exitCode,
		exitCode,
		stdout,
		stderr,
		combinedOutput: `${stdout || ""}${stderr ? `${stdout ? "\n" : ""}${stderr}` : ""}`,
		timedOut,
		durationSeconds,
		durationMs: Math.round(durationSeconds * 1e3),
		outputTruncated: Boolean(stdoutTruncated || stderrTruncated),
		stdoutTruncated,
		stderrTruncated,
		parsedMetrics
	};
}
function shellDisplayPart(value) {
	const text = String(value);
	return /^[A-Za-z0-9_./:=@-]+$/.test(text) ? text : `"${text.replace(/"/g, "\\\"")}"`;
}
function metricLineName(line) {
	const match = String(line || "").trim().match(/^METRIC\s+([^=\s]+)=/i);
	return match && !DENIED_METRIC_NAMES.has(match[1]) ? match[1] : "";
}
function positiveByteLimit(value, fallback) {
	const numberValue = Number(value);
	return Number.isFinite(numberValue) && numberValue > 0 ? Math.floor(numberValue) : fallback;
}
function retainedMetricText(lines) {
	return [...lines.values()].map((line) => `${line}\n`).join("");
}
function killProcess(pid) {
	if (!pid) return;
	if (process.platform === "win32") {
		spawn("taskkill", [
			"/pid",
			String(pid),
			"/t",
			"/f"
		], {
			windowsHide: true,
			stdio: "ignore"
		});
		return;
	}
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		try {
			process.kill(pid, "SIGTERM");
		} catch {}
	}
}
//#endregion
export { killProcess, parseMetricLines, runProcess, runShell, tailText };
