import { execFile, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import type { ExecutableCommand } from "./experiment-contract.js";

const DENIED_METRIC_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const METRIC_NAME_PATTERN = /^[^=\s]+$/;
const OUTPUT_MAX_LINES = 20;
const OUTPUT_MAX_BYTES = 8192;
const OUTPUT_CAPTURE_BYTES = 16384;
const FULL_OUTPUT_CAPTURE_BYTES = 1024 * 1024;
const METRIC_OUTPUT_CAPTURE_BYTES = 64 * 1024;
const PROCESS_OUTPUT_CAPTURE_BYTES = 32768;
const METRIC_LINE_MAX_CHARS = 4096;
const PROCESS_TREE_GRACE_MS = 500;
const PROCESS_TREE_VERIFY_MS = 3000;
const WINDOWS_PROCESS_QUERY_MS = 10_000;
const PROCESS_TREE_PID_LIMIT = 256;
const PROCESS_TREE_HANDLER_TIMEOUT_MS = 20_000;

type ProcessIdentity = { pid: number; ppid: number; pgid?: number; started: string };
type ProcessTreeSnapshot = {
  entries: ProcessIdentity[];
  proven: boolean;
  reason: string;
  trackedPids: number[];
};
type WindowsProcessIdentitySnapshot = {
  identities: Map<number, string>;
  proven: boolean;
  reason: string;
};
type WindowsProcessIdentityQuery = (
  pids: number[],
  signal?: AbortSignal,
) => Promise<WindowsProcessIdentitySnapshot>;
type WindowsProcessIdentityVerification = {
  pids: number[];
  proven: boolean;
  reason: string;
};

export interface ProcessTreeTermination {
  attempted: boolean;
  escalated: boolean;
  method: "none" | "posix-process-group" | "windows-taskkill-tree";
  pid: number | null;
  platform: NodeJS.Platform;
  proven: boolean;
  reason: string;
  remainingPids: number[];
  trackedPids: number[];
}

export type ProcessTreeTerminator = (
  pid?: number,
  signal?: AbortSignal,
) => Promise<ProcessTreeTermination>;

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
  env?: NodeJS.ProcessEnv;
  envMode?: "inherit" | "minimal";
  maxOutputBytes?: number;
  onProgress?: (event: { observedAt: string; output: string }) => void;
  terminateProcessTree?: ProcessTreeTerminator;
  terminationTimeoutMs?: number;
  timeoutSeconds?: number;
}

export interface ShellRunOptions {
  env?: NodeJS.ProcessEnv;
  envMode?: "inherit" | "minimal";
  maxFullOutputBytes?: number;
  maxMetricOutputBytes?: number;
  maxOutputBytes?: number;
  onProgress?: (event: { observedAt: string; output: string }) => void;
  retainMetricNames?: string[];
  terminateProcessTree?: ProcessTreeTerminator;
  terminationTimeoutMs?: number;
}

export interface ShellRunResult {
  command: string;
  durationSeconds: number;
  exitCode: number | null;
  finishedAt: string;
  fullOutput: string;
  fullOutputTruncated: boolean;
  lastOutputAt: string | null;
  metricOutput: string;
  metricOutputTruncated: boolean;
  output: string;
  outputTruncated: boolean;
  parsedMetrics: Record<string, number>;
  retainedMetricOutput: string;
  spawnError: string | null;
  spawnState: ProcessSpawnState;
  startedAt: string;
  termination: ProcessTreeTermination | null;
  terminationFailed: boolean;
  timedOut: boolean;
}

export type ProcessSpawnState = "unknown" | "spawned" | "failed-before-spawn";

export function validateMetricName(name: unknown): string {
  const value = String(name || "");
  if (!METRIC_NAME_PATTERN.test(value) || DENIED_METRIC_NAMES.has(value)) {
    throw new Error(
      `Metric name must match the METRIC parser grammar: one non-empty token without whitespace or "=". Got ${value}`,
    );
  }
  return value;
}

export function metricParseSource(result: Partial<ShellRunResult> | null | undefined): string {
  if (!result) return "";
  const retained = result.retainedMetricOutput || "";
  if (result.metricOutput) {
    return [
      result.metricOutput,
      result.metricOutputTruncated && result.fullOutput ? result.fullOutput : "",
      retained,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [result.fullOutput || result.output || "", retained].filter(Boolean).join("\n");
}

export interface ProcessRunResult {
  code: number | null;
  command: string;
  commandDisplay: string;
  combinedOutput: string;
  durationMs: number;
  durationSeconds: number;
  exitCode: number | null;
  finishedAt: string;
  lastOutputAt: string | null;
  outputTruncated: boolean;
  parsedMetrics: Record<string, number>;
  spawnError: string | null;
  spawnState: ProcessSpawnState;
  startedAt: string;
  stderr: string;
  stderrTruncated: boolean;
  stdout: string;
  stdoutTruncated: boolean;
  termination: ProcessTreeTermination | null;
  terminationFailed: boolean;
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
  const startedAtIso = new Date(startedAt).toISOString();
  return await new Promise<ShellRunResult>((resolve) => {
    const env = shellEnvironment(options);
    const child = spawn(command, {
      cwd,
      env,
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
    let lastOutputAt: string | null = null;
    let timedOut = false;
    let termination: ProcessTreeTermination | null = null;
    let spawnState: ProcessSpawnState = "unknown";
    let spawnError: string | null = null;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
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
      if (settled) return;
      lastOutputAt = new Date().toISOString();
      options.onProgress?.({ observedAt: lastOutputAt, output: text });
      metricCollector.append(text);
      appendMetricLines(text);
      const boundedFullOutput = appendBoundedOutput(fullOutput, text, maxFullOutputBytes);
      fullOutput = boundedFullOutput.text;
      fullOutputTruncated = fullOutputTruncated || boundedFullOutput.truncated;
      const boundedOutput = appendBoundedOutput(output, text, maxOutputBytes);
      output = boundedOutput.text;
      outputTruncated = outputTruncated || boundedOutput.truncated;
    };
    const finish = ({
      exitCode,
      output: resultOutput,
      fullOutput: resultFullOutput,
    }: {
      exitCode: number | null;
      output: string;
      fullOutput: string;
    }) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (/^METRIC\s+/i.test(pendingMetricText.trim())) appendMetricLine(pendingMetricText);
      const retainedMetricOutput = retainedMetricText(retainedMetricLines);
      resolve(
        shellRunResult({
          command,
          exitCode,
          timedOut,
          startedAt,
          startedAtIso,
          lastOutputAt,
          output: resultOutput,
          fullOutput: resultFullOutput,
          metricOutput,
          retainedMetricOutput,
          metricOutputTruncated,
          outputTruncated,
          fullOutputTruncated,
          parsedMetrics: metricCollector.finish(),
          termination,
          spawnState,
          spawnError,
        }),
      );
    };
    timeout = setTimeout(
      () => {
        timedOut = true;
        void terminateAfterTimeout(
          child.pid,
          options.terminateProcessTree,
          options.terminationTimeoutMs,
        ).then((result) => {
          termination = result;
          finish({ exitCode: null, output, fullOutput });
        });
      },
      Math.max(1, timeoutSeconds) * 1000,
    );
    child.stdout.on("data", (chunk) => {
      appendOutput(chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      appendOutput(chunk.toString("utf8"));
    });
    child.once("spawn", () => {
      spawnState = "spawned";
    });
    child.on("error", (error) => {
      const errorText = String(error.stack || error.message || error);
      if (spawnState !== "spawned") {
        spawnState = "failed-before-spawn";
        spawnError = errorText;
      }
      if (timedOut) {
        appendOutput(errorText);
        return;
      }
      finish({
        exitCode: null,
        output: errorText,
        fullOutput: `${fullOutput}${fullOutput ? "\n" : ""}${errorText}`,
      });
    });
    child.on("close", (code) => {
      if (timedOut) return;
      finish({ exitCode: code, output, fullOutput });
    });
  });
}

function shellEnvironment(options: ShellRunOptions): NodeJS.ProcessEnv {
  const base = options.envMode === "minimal" ? minimalProcessEnvironment() : { ...process.env };
  return options.env ? { ...base, ...options.env } : base;
}

export function minimalProcessEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowed = new Set(["comspec", "path", "pathext", "systemroot", "temp", "tmp"]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (allowed.has(key.toLowerCase()) && value != null) env[key] = value;
  }
  return env;
}

export async function runProcess(
  command: string,
  args: string[] = [],
  {
    cwd,
    env: extraEnv,
    envMode = "inherit",
    timeoutSeconds = 600,
    maxOutputBytes = PROCESS_OUTPUT_CAPTURE_BYTES,
    onProgress,
    terminateProcessTree: terminate = terminateProcessTree,
    terminationTimeoutMs,
  }: ProcessRunOptions = {},
): Promise<ProcessRunResult> {
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const argv = Array.isArray(args) ? args.map(String) : [];
  const commandDisplay = [command, ...argv].map(shellDisplayPart).join(" ");
  return await new Promise<ProcessRunResult>((resolve) => {
    const child = spawn(command, argv, {
      cwd,
      detached: process.platform !== "win32",
      env:
        envMode === "minimal"
          ? { ...minimalProcessEnvironment(), ...extraEnv }
          : extraEnv
            ? { ...process.env, ...extraEnv }
            : undefined,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let lastOutputAt: string | null = null;
    let timedOut = false;
    let termination: ProcessTreeTermination | null = null;
    let spawnState: ProcessSpawnState = "unknown";
    let spawnError: string | null = null;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const metricCollector = createMetricCollector();
    const appendOutput = (target: "stdout" | "stderr", text: string) => {
      if (settled) return;
      lastOutputAt = new Date().toISOString();
      onProgress?.({ observedAt: lastOutputAt, output: text });
      metricCollector.append(text);
      let value = target === "stdout" ? stdout : stderr;
      let truncated = target === "stdout" ? stdoutTruncated : stderrTruncated;
      const bounded = appendBoundedOutput(value, text, maxOutputBytes);
      value = bounded.text;
      truncated = truncated || bounded.truncated;
      if (target === "stdout") {
        stdout = value;
        stdoutTruncated = truncated;
      } else {
        stderr = value;
        stderrTruncated = truncated;
      }
    };
    const finish = ({
      exitCode,
      stdout: resultStdout,
      stderr: resultStderr,
    }: {
      exitCode: number | null;
      stdout: string;
      stderr: string;
    }) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(
        processResult({
          commandDisplay,
          exitCode,
          stdout: resultStdout,
          stderr: resultStderr,
          stdoutTruncated,
          stderrTruncated,
          timedOut,
          startedAt,
          startedAtIso,
          lastOutputAt,
          parsedMetrics: metricCollector.finish(),
          termination,
          spawnState,
          spawnError,
        }),
      );
    };
    timeout = setTimeout(
      () => {
        timedOut = true;
        void terminateAfterTimeout(child.pid, terminate, terminationTimeoutMs).then((result) => {
          termination = result;
          finish({ exitCode: null, stdout, stderr });
        });
      },
      Math.max(1, Number(timeoutSeconds) || 1) * 1000,
    );
    child.stdout.on("data", (chunk) => {
      appendOutput("stdout", stdoutDecoder.write(chunk));
    });
    child.stderr.on("data", (chunk) => {
      appendOutput("stderr", stderrDecoder.write(chunk));
    });
    child.once("spawn", () => {
      spawnState = "spawned";
    });
    child.on("error", (error) => {
      if (spawnState !== "spawned") {
        spawnState = "failed-before-spawn";
        spawnError = error.message || String(error);
      }
      if (timedOut) {
        appendOutput("stderr", error.message || String(error));
        return;
      }
      finish({
        exitCode: null,
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}${error.message || String(error)}`,
      });
    });
    child.on("close", (code) => {
      appendOutput("stdout", stdoutDecoder.end());
      appendOutput("stderr", stderrDecoder.end());
      if (timedOut) return;
      finish({ exitCode: code, stdout, stderr });
    });
  });
}

export async function runExecutableCommand(
  command: ExecutableCommand,
  cwd: string,
  timeoutSeconds = 600,
  options: ShellRunOptions = {},
): Promise<ShellRunResult> {
  const processCommand =
    command.kind === "argv" ? command.executable : command.shell === "bash" ? "bash" : "powershell";
  const processArgs =
    command.kind === "argv"
      ? command.args
      : command.shell === "bash"
        ? ["-c", command.script]
        : ["-NoProfile", "-NonInteractive", "-Command", command.script];
  const result = await runProcess(processCommand, processArgs, {
    cwd,
    env: options.env,
    envMode: options.envMode,
    maxOutputBytes: options.maxFullOutputBytes ?? FULL_OUTPUT_CAPTURE_BYTES,
    onProgress: options.onProgress,
    terminateProcessTree: options.terminateProcessTree,
    terminationTimeoutMs: options.terminationTimeoutMs,
    timeoutSeconds,
  });
  const combinedOutput = result.combinedOutput;
  return {
    command: command.kind === "shell" ? command.script : result.commandDisplay,
    durationSeconds: result.durationSeconds,
    exitCode: result.exitCode,
    finishedAt: result.finishedAt,
    fullOutput: combinedOutput,
    fullOutputTruncated: result.outputTruncated,
    lastOutputAt: result.lastOutputAt,
    metricOutput: "",
    metricOutputTruncated: false,
    output: tailText(
      combinedOutput,
      Number.MAX_SAFE_INTEGER,
      options.maxOutputBytes ?? OUTPUT_CAPTURE_BYTES,
    ),
    outputTruncated:
      result.outputTruncated ||
      Buffer.byteLength(combinedOutput, "utf8") > (options.maxOutputBytes ?? OUTPUT_CAPTURE_BYTES),
    parsedMetrics: result.parsedMetrics,
    retainedMetricOutput: "",
    spawnError: result.spawnError,
    spawnState: result.spawnState,
    startedAt: result.startedAt,
    termination: result.termination,
    terminationFailed: result.terminationFailed,
    timedOut: result.timedOut,
  };
}

function appendBoundedOutput(current: string, text: string, maxBytes: number) {
  const appended = current + text;
  if (Buffer.byteLength(appended, "utf8") <= maxBytes) {
    return { text: appended, truncated: false };
  }
  const buf = Buffer.from(appended, "utf8");
  return {
    text: buf.subarray(Math.max(0, buf.length - maxBytes)).toString("utf8"),
    truncated: true,
  };
}

function shellRunResult({
  command,
  exitCode,
  timedOut,
  startedAt,
  startedAtIso,
  lastOutputAt,
  output,
  fullOutput,
  metricOutput,
  retainedMetricOutput,
  metricOutputTruncated,
  outputTruncated,
  fullOutputTruncated,
  parsedMetrics,
  termination,
  spawnState,
  spawnError,
}: {
  command: string;
  exitCode: number | null;
  fullOutput: string;
  fullOutputTruncated: boolean;
  lastOutputAt?: string | null;
  metricOutput: string;
  metricOutputTruncated: boolean;
  output: string;
  outputTruncated: boolean;
  parsedMetrics: Record<string, number>;
  retainedMetricOutput: string;
  startedAt: number;
  startedAtIso?: string;
  spawnError: string | null;
  spawnState: ProcessSpawnState;
  termination: ProcessTreeTermination | null;
  timedOut: boolean;
}): ShellRunResult {
  return {
    command,
    exitCode,
    timedOut,
    durationSeconds: (Date.now() - startedAt) / 1000,
    startedAt: startedAtIso || new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    lastOutputAt: lastOutputAt || null,
    output,
    fullOutput,
    metricOutput,
    retainedMetricOutput,
    metricOutputTruncated,
    outputTruncated,
    fullOutputTruncated,
    parsedMetrics,
    spawnError,
    spawnState,
    termination,
    terminationFailed: Boolean(timedOut && !termination?.proven),
  };
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
  startedAtIso,
  lastOutputAt,
  parsedMetrics = Object.create(null),
  termination,
  spawnState,
  spawnError,
}: {
  commandDisplay: string;
  exitCode: number | null;
  lastOutputAt?: string | null;
  parsedMetrics?: Record<string, number>;
  startedAt: number;
  startedAtIso?: string;
  spawnError: string | null;
  spawnState: ProcessSpawnState;
  stderr: string;
  stderrTruncated: boolean;
  stdout: string;
  stdoutTruncated: boolean;
  termination: ProcessTreeTermination | null;
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
    startedAt: startedAtIso || new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    lastOutputAt: lastOutputAt || null,
    durationMs: Math.round(durationSeconds * 1000),
    outputTruncated: Boolean(stdoutTruncated || stderrTruncated),
    stdoutTruncated,
    stderrTruncated,
    parsedMetrics,
    spawnError,
    spawnState,
    termination,
    terminationFailed: Boolean(timedOut && !termination?.proven),
  };
}

function shellDisplayPart(value: string): string {
  const text = String(value);
  return /^[A-Za-z0-9_./:=@-]+$/.test(text) ? text : `"${text.replace(/[\\"]/g, "\\$&")}"`;
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

export async function terminateProcessTree(
  pid?: number,
  signal?: AbortSignal,
): Promise<ProcessTreeTermination> {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0) {
    return terminationResult(pid, false, false, "none", "missing_root_pid");
  }
  if (signal?.aborted) return abortedTermination(pid);
  return process.platform === "win32"
    ? await terminateWindowsTree(Number(pid), signal)
    : await terminatePosixProcessGroup(Number(pid), signal);
}

export async function terminateAfterTimeout(
  pid: number | undefined,
  terminate: ProcessTreeTerminator = terminateProcessTree,
  timeoutMs = PROCESS_TREE_HANDLER_TIMEOUT_MS,
): Promise<ProcessTreeTermination> {
  const boundedMs = Math.max(1, Number(timeoutMs) || PROCESS_TREE_HANDLER_TIMEOUT_MS);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const handled = Promise.resolve()
    .then(() => terminate(pid, controller.signal))
    .then((result) =>
      validTerminationResult(result)
        ? result
        : terminationResult(pid, true, false, "none", "termination_handler_invalid"),
    )
    .catch(() => terminationResult(pid, true, false, "none", "termination_handler_failed"));
  const timedOut = new Promise<ProcessTreeTermination>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(terminationResult(pid, true, false, "none", "termination_handler_timeout"));
    }, boundedMs);
  });
  const result = await Promise.race([handled, timedOut]);
  if (timer) clearTimeout(timer);
  return result;
}

async function terminatePosixProcessGroup(
  pid: number,
  signal?: AbortSignal,
): Promise<ProcessTreeTermination> {
  if (signal?.aborted) return abortedTermination(pid, "posix-process-group");
  const initial = await posixProcessTreeSnapshot(pid, signal);
  if (signal?.aborted) return abortedTermination(pid, "posix-process-group");
  const graceful = signalProcessGroup(pid, "SIGTERM");
  signalTrackedPosix(initial.entries, "SIGTERM");
  const gracefulRemaining = await waitForPidsGone(
    initial.trackedPids,
    PROCESS_TREE_GRACE_MS,
    signal,
  );
  if (signal?.aborted) return abortedTermination(pid, "posix-process-group");
  if (
    initial.proven &&
    graceful !== "failed" &&
    gracefulRemaining.length === 0 &&
    processGroupState(pid) === "gone"
  ) {
    return terminationResult(
      pid,
      true,
      true,
      "posix-process-group",
      "process_group_exited_after_sigterm",
      false,
      initial.trackedPids,
      [],
    );
  }
  const second = await posixProcessTreeSnapshot(pid, signal);
  if (signal?.aborted) return abortedTermination(pid, "posix-process-group");
  const entries = mergeProcessEntries(initial.entries, second.entries);
  const trackedPids = entries.map((entry) => entry.pid);
  const forced = signalProcessGroup(pid, "SIGKILL");
  signalTrackedPosix(entries, "SIGKILL");
  const remainingPids = await waitForPidsGone(trackedPids, PROCESS_TREE_VERIFY_MS, signal);
  if (signal?.aborted) return abortedTermination(pid, "posix-process-group");
  const proven =
    initial.proven &&
    second.proven &&
    forced !== "failed" &&
    processGroupState(pid) === "gone" &&
    remainingPids.length === 0;
  return terminationResult(
    pid,
    true,
    proven,
    "posix-process-group",
    proven ? "process_group_absent_after_sigkill" : "process_group_termination_unproven",
    true,
    trackedPids,
    remainingPids,
  );
}

async function terminateWindowsTree(
  pid: number,
  signal?: AbortSignal,
): Promise<ProcessTreeTermination> {
  if (signal?.aborted) return abortedTermination(pid, "windows-taskkill-tree");
  let snapshot = await windowsProcessTreeSnapshot(pid, [], true, signal);
  if (signal?.aborted) return abortedTermination(pid, "windows-taskkill-tree");
  if (!snapshot.proven && pidState(pid) !== "gone") {
    snapshot = await windowsProcessTreeSnapshot(pid, [], true, signal);
    if (signal?.aborted) return abortedTermination(pid, "windows-taskkill-tree");
  }
  const gracefulCode = await taskkill(pid, false, signal);
  if (signal?.aborted) return abortedTermination(pid, "windows-taskkill-tree");
  let remainingPids = await waitForPidsGone(snapshot.trackedPids, PROCESS_TREE_GRACE_MS, signal);
  if (signal?.aborted) return abortedTermination(pid, "windows-taskkill-tree");
  if (snapshot.proven && remainingPids.length === 0) {
    return terminationResult(
      pid,
      true,
      true,
      "windows-taskkill-tree",
      gracefulCode === 0 ? "taskkill_tree_exited_gracefully" : "process_tree_absent_after_grace",
      false,
      snapshot.trackedPids,
      [],
    );
  }
  const refreshed = await windowsProcessTreeSnapshot(pid, snapshot.entries, false, signal);
  if (signal?.aborted) return abortedTermination(pid, "windows-taskkill-tree");
  const originalRoot = snapshot.entries.find((entry) => entry.pid === pid);
  const refreshedRoot = refreshed.entries.find((entry) => entry.pid === pid);
  const rootIdentityChanged = Boolean(
    refreshedRoot && originalRoot && refreshedRoot.started !== originalRoot.started,
  );
  const second = !rootIdentityChanged
    ? refreshed
    : {
        ...refreshed,
        entries: [],
        proven: false,
        reason: "windows_root_process_identity_changed",
        trackedPids: [],
      };
  const entries = mergeProcessEntries(snapshot.entries, second.entries);
  const trackedPids = entries.map((entry) => entry.pid);
  const forcedCode = rootIdentityChanged ? null : await taskkill(pid, true, signal);
  if (signal?.aborted) return abortedTermination(pid, "windows-taskkill-tree");
  const forcedRemaining = await waitForPidsGone(trackedPids, PROCESS_TREE_GRACE_MS, signal);
  if (signal?.aborted) return abortedTermination(pid, "windows-taskkill-tree");
  if (forcedRemaining.length > 0) {
    const preForceVerification = await verifyWindowsProcessIdentities(
      entries,
      forcedRemaining,
      windowsProcessIdentities,
      signal,
    );
    if (signal?.aborted) return abortedTermination(pid, "windows-taskkill-tree");
    if (preForceVerification.proven && preForceVerification.pids.length > 0) {
      await taskkillPids(preForceVerification.pids, true, signal);
      if (signal?.aborted) return abortedTermination(pid, "windows-taskkill-tree");
    }
  }
  const finalCandidates = await waitForPidsGone(trackedPids, PROCESS_TREE_VERIFY_MS, signal);
  if (signal?.aborted) return abortedTermination(pid, "windows-taskkill-tree");
  let finalVerification: WindowsProcessIdentityVerification | null = null;
  if (finalCandidates.length > 0) {
    finalVerification = await verifyWindowsProcessIdentities(
      entries,
      finalCandidates,
      windowsProcessIdentities,
      signal,
    );
    if (signal?.aborted) return abortedTermination(pid, "windows-taskkill-tree");
  }
  const identityVerification = authoritativeWindowsIdentityVerification(
    finalCandidates,
    finalVerification,
  );
  remainingPids = identityVerification.pids;
  const identityFailureReason = identityVerification.proven ? "" : identityVerification.reason;
  const proven =
    snapshot.proven && second.proven && !identityFailureReason && remainingPids.length === 0;
  return terminationResult(
    pid,
    true,
    proven,
    "windows-taskkill-tree",
    proven
      ? "taskkill_tree_absent_after_force"
      : identityFailureReason ||
          (snapshot.proven && second.proven
            ? `taskkill_tree_termination_unproven_${gracefulCode ?? "unknown"}_${forcedCode ?? "unknown"}`
            : !snapshot.proven
              ? snapshot.reason
              : second.reason),
    true,
    trackedPids,
    remainingPids,
  );
}

async function posixProcessTreeSnapshot(
  pid: number,
  signal?: AbortSignal,
): Promise<ProcessTreeSnapshot> {
  const result = await execFileResult(
    "ps",
    ["-axo", "pid=,ppid=,pgid=,lstart="],
    PROCESS_TREE_VERIFY_MS,
    signal,
  );
  if (result.code !== 0) {
    return {
      entries: [],
      proven: false,
      reason: "posix_process_tree_enumeration_failed",
      trackedPids: [pid],
    };
  }
  const table = result.stdout
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      started: match[4],
    }));
  if (table.length === 0) {
    return {
      entries: [],
      proven: false,
      reason: "posix_process_tree_enumeration_invalid",
      trackedPids: [pid],
    };
  }
  return recursiveProcessTreeSnapshot(pid, table, "posix_process_tree_enumerated");
}

function recursiveProcessTreeSnapshot(
  pid: number,
  table: ProcessIdentity[],
  successReason: string,
): ProcessTreeSnapshot {
  const ids = new Set<number>([
    pid,
    ...table.filter((entry) => entry.pgid === pid).map((entry) => entry.pid),
  ]);
  for (;;) {
    const children = table.filter((entry) => ids.has(entry.ppid) && !ids.has(entry.pid));
    if (children.length === 0) break;
    for (const child of children) ids.add(child.pid);
    if (ids.size > PROCESS_TREE_PID_LIMIT) {
      return {
        entries: table.filter((entry) => ids.has(entry.pid)).slice(0, PROCESS_TREE_PID_LIMIT),
        proven: false,
        reason: "process_tree_too_large",
        trackedPids: [...ids].slice(0, PROCESS_TREE_PID_LIMIT),
      };
    }
  }
  const entries = table.filter((entry) => ids.has(entry.pid));
  const absent = entries.length === 0 && processGroupState(pid) === "gone";
  return {
    entries,
    proven: entries.length > 0 || absent,
    reason: entries.length > 0 || absent ? successReason : "process_tree_enumeration_invalid",
    trackedPids: entries.length > 0 ? entries.map((entry) => entry.pid) : [pid],
  };
}

function mergeProcessEntries(...groups: ProcessIdentity[][]): ProcessIdentity[] {
  const merged = new Map<string, ProcessIdentity>();
  for (const entry of groups.flat()) merged.set(`${entry.pid}:${entry.started}`, entry);
  return [...merged.values()].slice(0, PROCESS_TREE_PID_LIMIT);
}

function signalTrackedPosix(entries: ProcessIdentity[], signal: NodeJS.Signals): void {
  for (const entry of entries) {
    try {
      process.kill(entry.pid, signal);
    } catch {
      // Already gone or not signalable; verification below fails closed.
    }
  }
}

async function windowsProcessTreeSnapshot(
  pid: number,
  seeds: ProcessIdentity[] = [],
  requireRoot = true,
  signal?: AbortSignal,
): Promise<ProcessTreeSnapshot> {
  const fallbackPids = [...new Set([pid, ...seeds.map((entry) => entry.pid)])].slice(
    0,
    PROCESS_TREE_PID_LIMIT,
  );
  const script = [
    "& {",
    "param([int]$RootProcessId, [string]$SeedsBase64, [int]$RequireRoot)",
    "$all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate -ErrorAction Stop)",
    "$rootPresent = @($all | Where-Object { [int]$_.ProcessId -eq $RootProcessId }).Count -gt 0",
    "if ($RequireRoot -eq 1 -and -not $rootPresent) { throw 'root_missing' }",
    "$seeds = @((ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($SeedsBase64)))))",
    "$ids = @($RootProcessId)",
    "foreach ($seed in $seeds) {",
    "  $seedProcess = $all | Where-Object { [int]$_.ProcessId -eq [int]$seed.pid } | Select-Object -First 1",
    "  if ($null -ne $seedProcess -and $seedProcess.CreationDate.ToUniversalTime().ToString('o') -eq [string]$seed.started -and $ids -notcontains [int]$seed.pid) { $ids += [int]$seed.pid }",
    "}",
    "do {",
    "  $children = @($all | Where-Object { $ids -contains [int]$_.ParentProcessId -and $ids -notcontains [int]$_.ProcessId } | ForEach-Object { [int]$_.ProcessId })",
    "  if ($children.Count -eq 0) { break }",
    "  $ids += $children",
    `  if ($ids.Count -gt ${PROCESS_TREE_PID_LIMIT}) { throw 'tree_too_large' }`,
    "} while ($true)",
    "$rows = @($all | Where-Object { $ids -contains [int]$_.ProcessId } | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; started = $_.CreationDate.ToUniversalTime().ToString('o') } })",
    "if ($rows.Count -eq 0) { '[]' } else { $rows | ConvertTo-Json -Compress }",
    "}",
  ].join("\n");
  const result = await execFileResult(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
      String(pid),
      Buffer.from(
        JSON.stringify(seeds.map(({ pid: seedPid, started }) => ({ pid: seedPid, started }))),
        "utf8",
      ).toString("base64"),
      requireRoot ? "1" : "0",
    ],
    WINDOWS_PROCESS_QUERY_MS,
    signal,
  );
  if (result.code !== 0) {
    return {
      entries: [],
      proven: false,
      reason: "windows_process_tree_enumeration_failed",
      trackedPids: fallbackPids,
    };
  }
  try {
    const parsed = JSON.parse(result.stdout.trim() || "[]");
    const values = Array.isArray(parsed) ? parsed : [parsed];
    const entries = values.map((value) => ({
      pid: Number(value?.pid),
      ppid: Number(value?.ppid),
      started: String(value?.started || ""),
    }));
    const trackedPids = [...new Set(entries.map((entry) => entry.pid))];
    const valid =
      (!requireRoot || trackedPids.includes(pid)) &&
      trackedPids.length <= PROCESS_TREE_PID_LIMIT &&
      entries.every(
        (entry) =>
          Number.isSafeInteger(entry.pid) &&
          entry.pid > 0 &&
          Number.isSafeInteger(entry.ppid) &&
          entry.ppid >= 0 &&
          entry.started.length > 0,
      );
    return valid
      ? { entries, proven: true, reason: "windows_process_tree_enumerated", trackedPids }
      : {
          entries: [],
          proven: false,
          reason: "windows_process_tree_enumeration_invalid",
          trackedPids: fallbackPids,
        };
  } catch {
    return {
      entries: [],
      proven: false,
      reason: "windows_process_tree_enumeration_invalid",
      trackedPids: fallbackPids,
    };
  }
}

async function windowsProcessIdentities(
  pids: number[],
  signal?: AbortSignal,
): Promise<WindowsProcessIdentitySnapshot> {
  if (pids.length === 0) {
    return {
      identities: new Map(),
      proven: true,
      reason: "windows_process_identities_enumerated",
    };
  }
  const script = [
    "& {",
    "param([string]$IdsJson)",
    "$ids = @((ConvertFrom-Json $IdsJson) | ForEach-Object { [int]$_ })",
    "@(Get-CimInstance Win32_Process -Property ProcessId, CreationDate -ErrorAction Stop | Where-Object { $ids -contains [int]$_.ProcessId } | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; started = $_.CreationDate.ToUniversalTime().ToString('o') } }) | ConvertTo-Json -Compress",
    "}",
  ].join("\n");
  const result = await execFileResult(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script, JSON.stringify(pids)],
    WINDOWS_PROCESS_QUERY_MS,
    signal,
  );
  if (result.code !== 0) {
    return {
      identities: new Map(),
      proven: false,
      reason: "windows_process_identity_enumeration_failed",
    };
  }
  try {
    const parsed = JSON.parse(result.stdout.trim() || "[]");
    const values = Array.isArray(parsed) ? parsed : [parsed];
    const entries = values.map((value) => [
      Number(value?.pid),
      String(value?.started || ""),
    ]) as Array<[number, string]>;
    const valid =
      entries.length <= pids.length &&
      entries.every(
        ([entryPid, started]) =>
          Number.isSafeInteger(entryPid) &&
          entryPid > 0 &&
          pids.includes(entryPid) &&
          started.length > 0,
      ) &&
      new Set(entries.map(([entryPid]) => entryPid)).size === entries.length;
    return valid
      ? {
          identities: new Map(entries),
          proven: true,
          reason: "windows_process_identities_enumerated",
        }
      : {
          identities: new Map(),
          proven: false,
          reason: "windows_process_identity_enumeration_invalid",
        };
  } catch {
    return {
      identities: new Map(),
      proven: false,
      reason: "windows_process_identity_enumeration_invalid",
    };
  }
}

export async function verifyWindowsProcessIdentities(
  entries: Array<Pick<ProcessIdentity, "pid" | "started">>,
  pids: number[],
  query: WindowsProcessIdentityQuery = windowsProcessIdentities,
  signal?: AbortSignal,
): Promise<WindowsProcessIdentityVerification> {
  const candidates = [...new Set(pids)];
  const snapshot = await query(candidates, signal);
  if (!snapshot.proven) {
    return { pids: candidates, proven: false, reason: snapshot.reason };
  }
  const identitiesByPid = new Map(entries.map((entry) => [entry.pid, entry.started]));
  return {
    pids: candidates.filter(
      (candidate) => snapshot.identities.get(candidate) === identitiesByPid.get(candidate),
    ),
    proven: true,
    reason: snapshot.reason,
  };
}

export function authoritativeWindowsIdentityVerification(
  finalCandidates: number[],
  finalVerification: WindowsProcessIdentityVerification | null,
): WindowsProcessIdentityVerification {
  const candidates = [...new Set(finalCandidates)];
  if (candidates.length === 0) {
    return { pids: [], proven: true, reason: "windows_process_identities_absent" };
  }
  if (finalVerification) return finalVerification;
  return {
    pids: candidates,
    proven: false,
    reason: "windows_process_identity_verification_missing",
  };
}

function taskkill(pid: number, force: boolean, signal?: AbortSignal): Promise<number | null> {
  return taskkillPids([pid], force, signal);
}

function taskkillPids(
  pids: number[],
  force: boolean,
  signal?: AbortSignal,
): Promise<number | null> {
  return execFileResult(
    "taskkill",
    [...pids.flatMap((pid) => ["/pid", String(pid)]), "/t", ...(force ? ["/f"] : [])],
    force ? PROCESS_TREE_VERIFY_MS : PROCESS_TREE_GRACE_MS,
    signal,
  ).then((result) => result.code);
}

function execFileResult(
  command: string,
  args: string[],
  timeout: number,
  signal?: AbortSignal,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ code: null, stdout: "" });
      return;
    }
    try {
      execFile(
        command,
        args,
        { maxBuffer: 64 * 1024, signal, timeout, windowsHide: true },
        (error, stdout) => {
          resolve({
            code: error ? (typeof error.code === "number" ? error.code : null) : 0,
            stdout: String(stdout || ""),
          });
        },
      );
    } catch {
      resolve({ code: null, stdout: "" });
    }
  });
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): "sent" | "gone" | "failed" {
  try {
    process.kill(-pid, signal);
    return "sent";
  } catch (error) {
    return errorCode(error) === "ESRCH" ? "gone" : "failed";
  }
}

async function waitForPidsGone(
  pids: number[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let remaining = pids.filter((pid) => pidState(pid) !== "gone");
  while (remaining.length > 0 && Date.now() < deadline && !signal?.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    remaining = remaining.filter((pid) => pidState(pid) !== "gone");
  }
  return remaining;
}

function processGroupState(pid: number): "alive" | "gone" | "unknown" {
  try {
    process.kill(-pid, 0);
    return "alive";
  } catch (error) {
    return errorCode(error) === "ESRCH" ? "gone" : "unknown";
  }
}

function pidState(pid: number): "alive" | "gone" | "unknown" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return errorCode(error) === "ESRCH" ? "gone" : "unknown";
  }
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "";
}

function terminationResult(
  pid: number | undefined,
  attempted: boolean,
  proven: boolean,
  method: ProcessTreeTermination["method"],
  reason: string,
  escalated = false,
  trackedPids = Number.isSafeInteger(pid) && Number(pid) > 0 ? [Number(pid)] : [],
  remainingPids = proven ? [] : trackedPids,
): ProcessTreeTermination {
  return {
    attempted,
    escalated,
    method,
    pid: Number.isSafeInteger(pid) && Number(pid) > 0 ? Number(pid) : null,
    platform: process.platform,
    proven,
    reason,
    remainingPids: remainingPids.slice(0, PROCESS_TREE_PID_LIMIT),
    trackedPids: trackedPids.slice(0, PROCESS_TREE_PID_LIMIT),
  };
}

function abortedTermination(
  pid: number | undefined,
  method: ProcessTreeTermination["method"] = "none",
): ProcessTreeTermination {
  return terminationResult(pid, true, false, method, "termination_handler_aborted");
}

function validTerminationResult(value: unknown): value is ProcessTreeTermination {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<ProcessTreeTermination>;
  const validPids = (pids: unknown[]) =>
    pids.length <= PROCESS_TREE_PID_LIMIT &&
    pids.every((pid) => Number.isSafeInteger(pid) && Number(pid) > 0);
  return (
    typeof result.attempted === "boolean" &&
    typeof result.escalated === "boolean" &&
    typeof result.proven === "boolean" &&
    typeof result.reason === "string" &&
    /^[a-z0-9_]+$/.test(result.reason) &&
    result.reason.length <= 160 &&
    ["none", "posix-process-group", "windows-taskkill-tree"].includes(String(result.method)) &&
    result.platform === process.platform &&
    (result.pid === null || (Number.isSafeInteger(result.pid) && Number(result.pid) > 0)) &&
    Array.isArray(result.remainingPids) &&
    Array.isArray(result.trackedPids) &&
    validPids(result.remainingPids) &&
    validPids(result.trackedPids) &&
    (!result.proven || result.remainingPids.length === 0)
  );
}
