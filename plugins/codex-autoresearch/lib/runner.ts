import { spawn } from "node:child_process";

const DENIED_METRIC_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const OUTPUT_MAX_LINES = 20;
const OUTPUT_MAX_BYTES = 8192;
const OUTPUT_CAPTURE_BYTES = 16384;
const FULL_OUTPUT_CAPTURE_BYTES = 1024 * 1024;
const METRIC_OUTPUT_CAPTURE_BYTES = 64 * 1024;
const PROCESS_OUTPUT_CAPTURE_BYTES = 32768;
const METRIC_LINE_MAX_CHARS = 4096;

export interface MetricParseOptions {
  maxMetrics?: number;
  primaryMetricName?: string;
  withTruncation?: boolean;
}

export interface MetricParseResult {
  metrics: Record<string, number>;
  truncated: boolean;
}

export interface ProcessRunOptions {
  cwd?: string;
  maxOutputBytes?: number;
  timeoutSeconds?: number;
}

export interface ShellRunOptions {
  maxFullOutputBytes?: number;
  maxMetricOutputBytes?: number;
  maxOutputBytes?: number;
  retainMetricNames?: string[];
}

export interface ShellRunResult {
  command: string;
  durationSeconds: number;
  exitCode: number | null;
  fullOutput: string;
  fullOutputTruncated: boolean;
  metricOutput: string;
  metricOutputTruncated: boolean;
  output: string;
  outputTruncated: boolean;
  parsedMetrics: Record<string, number>;
  retainedMetricOutput: string;
  timedOut: boolean;
}

export interface ProcessRunResult {
  code: number | null;
  command: string;
  commandDisplay: string;
  combinedOutput: string;
  durationMs: number;
  durationSeconds: number;
  exitCode: number | null;
  outputTruncated: boolean;
  parsedMetrics: Record<string, number>;
  stderr: string;
  stderrTruncated: boolean;
  stdout: string;
  stdoutTruncated: boolean;
  timedOut: boolean;
}

export function parseMetricLines(output: string): Record<string, number>;
export function parseMetricLines(
  output: string,
  options: MetricParseOptions & { withTruncation: true },
): MetricParseResult;
export function parseMetricLines(
  output: string,
  options: MetricParseOptions,
): Record<string, number> | MetricParseResult;
export function parseMetricLines(
  output: string,
  options: MetricParseOptions = {},
): Record<string, number> | MetricParseResult {
  const metrics: Record<string, number> = Object.create(null);
  const maxMetrics =
    Number.isInteger(options.maxMetrics) && Number(options.maxMetrics) > 0
      ? Number(options.maxMetrics)
      : Infinity;
  const primaryMetricName = options.primaryMetricName ? String(options.primaryMetricName) : "";
  const withTruncation = Boolean(options.withTruncation);
  let retainedCount = 0;
  let truncated = false;
  const collect = (line: string) => {
    const collected = collectMetricLine(metrics, line, {
      maxMetrics,
      primaryMetricName,
      retainedCount,
    });
    retainedCount = collected.retainedCount;
    truncated = truncated || collected.truncated;
  };
  for (const line of String(output || "").split(/\r?\n/)) {
    collect(line);
  }
  return withTruncation ? { metrics, truncated } : metrics;
}

function createMetricCollector() {
  const metrics: Record<string, number> = Object.create(null);
  let pending = "";
  return {
    append(text: string) {
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      if (pending.length > METRIC_LINE_MAX_CHARS) pending = pending.slice(-METRIC_LINE_MAX_CHARS);
      for (const line of lines) collectMetricLine(metrics, line);
    },
    finish(): Record<string, number> {
      if (pending) {
        collectMetricLine(metrics, pending);
        pending = "";
      }
      return metrics;
    },
  };
}

function collectMetricLine(
  metrics: Record<string, number>,
  line: string,
  options: {
    maxMetrics?: number;
    primaryMetricName?: string;
    retainedCount?: number;
  } = {},
) {
  let retainedCount = Number(options.retainedCount) || 0;
  const match = String(line).match(
    /^METRIC\s+([^=\s]+)=(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*$/i,
  );
  if (!match) return { retainedCount, truncated: false };
  const name = match[1];
  if (DENIED_METRIC_NAMES.has(name)) return { retainedCount, truncated: false };
  const value = Number(match[2]);
  if (!Number.isFinite(value)) return { retainedCount, truncated: false };
  if (
    Object.hasOwn(metrics, name) ||
    name === options.primaryMetricName ||
    retainedCount < (options.maxMetrics ?? Infinity)
  ) {
    if (!Object.hasOwn(metrics, name)) retainedCount += 1;
    metrics[name] = value;
    return { retainedCount, truncated: false };
  }
  return { retainedCount, truncated: true };
}

export function tailText(
  text: string,
  maxLines = OUTPUT_MAX_LINES,
  maxBytes = OUTPUT_MAX_BYTES,
): string {
  let trimmed = text;
  if (Buffer.byteLength(trimmed, "utf8") > maxBytes) {
    const buf = Buffer.from(trimmed, "utf8");
    trimmed = buf.subarray(Math.max(0, buf.length - maxBytes)).toString("utf8");
  }
  const lines = trimmed.split(/\r?\n/);
  if (lines.length > maxLines) trimmed = lines.slice(-maxLines).join("\n");
  return trimmed;
}

export async function runShell(
  command: string,
  cwd: string,
  timeoutSeconds = 600,
  options: ShellRunOptions = {},
): Promise<ShellRunResult> {
  const startedAt = Date.now();
  return await new Promise<ShellRunResult>((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let fullOutput = "";
    let metricOutput = "";
    let metricOutputBytes = 0;
    let pendingMetricText = "";
    const retainedMetricNames = new Set(
      (options.retainMetricNames || []).map(String).filter(Boolean),
    );
    const retainedMetricLines = new Map<string, string>();
    let outputTruncated = false;
    let fullOutputTruncated = false;
    let metricOutputTruncated = false;
    let timedOut = false;
    const metricCollector = createMetricCollector();
    const maxOutputBytes = positiveByteLimit(options.maxOutputBytes, OUTPUT_CAPTURE_BYTES);
    const maxFullOutputBytes = positiveByteLimit(
      options.maxFullOutputBytes,
      FULL_OUTPUT_CAPTURE_BYTES,
    );
    const maxMetricOutputBytes = positiveByteLimit(
      options.maxMetricOutputBytes,
      METRIC_OUTPUT_CAPTURE_BYTES,
    );
    const appendMetricLine = (line: string) => {
      const name = metricLineName(line);
      if (name && retainedMetricNames.has(name)) {
        retainedMetricLines.set(name, line);
      }
      const text = `${line}\n`;
      const bytes = Buffer.byteLength(text, "utf8");
      if (metricOutputBytes + bytes > maxMetricOutputBytes) {
        metricOutputTruncated = true;
        return;
      }
      metricOutput += text;
      metricOutputBytes += bytes;
    };
    const appendMetricLines = (text: string) => {
      pendingMetricText += text;
      const lines = pendingMetricText.split(/\r?\n/);
      pendingMetricText = lines.pop() || "";
      if (pendingMetricText.length > METRIC_LINE_MAX_CHARS) {
        pendingMetricText = pendingMetricText.slice(-METRIC_LINE_MAX_CHARS);
      }
      for (const line of lines) {
        if (/^METRIC\s+/i.test(line.trim())) appendMetricLine(line);
      }
    };
    const appendOutput = (text: string) => {
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
    const timeout = setTimeout(
      () => {
        timedOut = true;
        killProcess(child.pid);
      },
      Math.max(1, timeoutSeconds) * 1000,
    );
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
        durationSeconds: (Date.now() - startedAt) / 1000,
        output: errorText,
        fullOutput: `${fullOutput}${fullOutput ? "\n" : ""}${errorText}`,
        metricOutput,
        retainedMetricOutput,
        metricOutputTruncated,
        outputTruncated,
        fullOutputTruncated,
        parsedMetrics: metricCollector.finish(),
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
        durationSeconds: (Date.now() - startedAt) / 1000,
        output,
        fullOutput,
        metricOutput,
        retainedMetricOutput,
        metricOutputTruncated,
        outputTruncated,
        fullOutputTruncated,
        parsedMetrics: metricCollector.finish(),
      });
    });
  });
}

export async function runProcess(
  command: string,
  args: string[] = [],
  {
    cwd,
    timeoutSeconds = 600,
    maxOutputBytes = PROCESS_OUTPUT_CAPTURE_BYTES,
  }: ProcessRunOptions = {},
): Promise<ProcessRunResult> {
  const startedAt = Date.now();
  const argv = Array.isArray(args) ? args.map(String) : [];
  const commandDisplay = [command, ...argv].map(shellDisplayPart).join(" ");
  return await new Promise<ProcessRunResult>((resolve) => {
    const child = spawn(command, argv, {
      cwd,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    const metricCollector = createMetricCollector();
    const appendOutput = (target: "stdout" | "stderr", text: string) => {
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
    const timeout = setTimeout(
      () => {
        timedOut = true;
        killProcess(child.pid);
      },
      Math.max(1, Number(timeoutSeconds) || 1) * 1000,
    );
    child.stdout.on("data", (chunk) => {
      appendOutput("stdout", chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      appendOutput("stderr", chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve(
        processResult({
          commandDisplay,
          exitCode: null,
          stdout,
          stderr: `${stderr}${stderr ? "\n" : ""}${error.message || String(error)}`,
          stdoutTruncated,
          stderrTruncated,
          timedOut,
          startedAt,
          parsedMetrics: metricCollector.finish(),
        }),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve(
        processResult({
          commandDisplay,
          exitCode: code,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
          timedOut,
          startedAt,
          parsedMetrics: metricCollector.finish(),
        }),
      );
    });
  });
}

function processResult({
  commandDisplay,
  exitCode,
  stdout,
  stderr,
  stdoutTruncated,
  stderrTruncated,
  timedOut,
  startedAt,
  parsedMetrics = Object.create(null),
}: {
  commandDisplay: string;
  exitCode: number | null;
  parsedMetrics?: Record<string, number>;
  startedAt: number;
  stderr: string;
  stderrTruncated: boolean;
  stdout: string;
  stdoutTruncated: boolean;
  timedOut: boolean;
}): ProcessRunResult {
  const durationSeconds = (Date.now() - startedAt) / 1000;
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
    durationMs: Math.round(durationSeconds * 1000),
    outputTruncated: Boolean(stdoutTruncated || stderrTruncated),
    stdoutTruncated,
    stderrTruncated,
    parsedMetrics,
  };
}

function shellDisplayPart(value: string): string {
  const text = String(value);
  return /^[A-Za-z0-9_./:=@-]+$/.test(text) ? text : `"${text.replace(/"/g, '\\"')}"`;
}

function metricLineName(line: string): string {
  const match = String(line || "")
    .trim()
    .match(/^METRIC\s+([^=\s]+)=/i);
  return match && !DENIED_METRIC_NAMES.has(match[1]) ? match[1] : "";
}

function positiveByteLimit(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? Math.floor(numberValue) : fallback;
}

function retainedMetricText(lines: Map<string, string>): string {
  return [...lines.values()].map((line) => `${line}\n`).join("");
}

export function killProcess(pid?: number): void {
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
