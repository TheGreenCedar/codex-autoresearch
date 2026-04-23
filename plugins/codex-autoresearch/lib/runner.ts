import { spawn } from "node:child_process";

const DENIED_METRIC_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const OUTPUT_MAX_LINES = 20;
const OUTPUT_MAX_BYTES = 8192;
const OUTPUT_CAPTURE_BYTES = 16384;
const PROCESS_OUTPUT_CAPTURE_BYTES = 32768;
const METRIC_LINE_MAX_CHARS = 4096;

export interface ProcessRunOptions {
  cwd?: string;
  maxOutputBytes?: number;
  timeoutSeconds?: number;
}

export interface ShellRunResult {
  command: string;
  durationSeconds: number;
  exitCode: number | null;
  output: string;
  outputTruncated: boolean;
  parsedMetrics: Record<string, number>;
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

export function parseMetricLines(output: string): Record<string, number> {
  const metrics: Record<string, number> = Object.create(null);
  for (const line of String(output || "").split(/\r?\n/)) {
    collectMetricLine(metrics, line);
  }
  return metrics;
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

function collectMetricLine(metrics: Record<string, number>, line: string) {
  const match = String(line).match(
    /^METRIC\s+([^=\s]+)=(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*$/i,
  );
  if (!match) return;
  const name = match[1];
  if (DENIED_METRIC_NAMES.has(name)) return;
  const value = Number(match[2]);
  if (Number.isFinite(value)) metrics[name] = value;
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
    let outputTruncated = false;
    let timedOut = false;
    const metricCollector = createMetricCollector();
    const appendOutput = (text: string) => {
      metricCollector.append(text);
      output += text;
      if (Buffer.byteLength(output, "utf8") > OUTPUT_CAPTURE_BYTES) {
        const buf = Buffer.from(output, "utf8");
        output = buf.subarray(Math.max(0, buf.length - OUTPUT_CAPTURE_BYTES)).toString("utf8");
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
      resolve({
        command,
        exitCode: null,
        timedOut,
        durationSeconds: (Date.now() - startedAt) / 1000,
        output: String(error.stack || error.message || error),
        outputTruncated,
        parsedMetrics: metricCollector.finish(),
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
