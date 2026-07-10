import { execFile, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const DENIED_METRIC_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const OUTPUT_MAX_LINES = 20;
const OUTPUT_MAX_BYTES = 8192;
const OUTPUT_CAPTURE_BYTES = 16384;
const FULL_OUTPUT_CAPTURE_BYTES = 1024 * 1024;
const METRIC_OUTPUT_CAPTURE_BYTES = 64 * 1024;
const PROCESS_OUTPUT_CAPTURE_BYTES = 32768;
const METRIC_LINE_MAX_CHARS = 4096;
const PROCESS_TREE_GRACE_MS = 500;
const PROCESS_TREE_VERIFY_MS = 3000;
const PROCESS_TREE_PID_LIMIT = 256;
const PROCESS_TREE_HANDLER_TIMEOUT_MS = 20_000;

type ProcessIdentity = { pid: number; ppid: number; pgid?: number; started: string };
type ProcessTreeSnapshot = {
  entries: ProcessIdentity[];
  proven: boolean;
  reason: string;
  trackedPids: number[];
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

export type ProcessTreeTerminator = (pid?: number) => Promise<ProcessTreeTermination>;

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
  maxOutputBytes?: number;
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
  startedAt: string;
  termination: ProcessTreeTermination | null;
  terminationFailed: boolean;
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
  finishedAt: string;
  lastOutputAt: string | null;
  outputTruncated: boolean;
  parsedMetrics: Record<string, number>;
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
    child.on("error", (error) => {
      const errorText = String(error.stack || error.message || error);
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

function minimalProcessEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set(["path", "systemroot", "temp", "tmp"]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
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
    timeoutSeconds = 600,
    maxOutputBytes = PROCESS_OUTPUT_CAPTURE_BYTES,
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
      env: extraEnv ? { ...process.env, ...extraEnv } : undefined,
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
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const metricCollector = createMetricCollector();
    const appendOutput = (target: "stdout" | "stderr", text: string) => {
      if (settled) return;
      lastOutputAt = new Date().toISOString();
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
    child.on("error", (error) => {
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
}: {
  commandDisplay: string;
  exitCode: number | null;
  lastOutputAt?: string | null;
  parsedMetrics?: Record<string, number>;
  startedAt: number;
  startedAtIso?: string;
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

export async function terminateProcessTree(pid?: number): Promise<ProcessTreeTermination> {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0) {
    return terminationResult(pid, false, false, "none", "missing_root_pid");
  }
  return process.platform === "win32"
    ? await terminateWindowsTree(Number(pid))
    : await terminatePosixProcessGroup(Number(pid));
}

export async function terminateAfterTimeout(
  pid: number | undefined,
  terminate: ProcessTreeTerminator = terminateProcessTree,
  timeoutMs = PROCESS_TREE_HANDLER_TIMEOUT_MS,
): Promise<ProcessTreeTermination> {
  const boundedMs = Math.max(1, Number(timeoutMs) || PROCESS_TREE_HANDLER_TIMEOUT_MS);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const handled = Promise.resolve()
    .then(() => terminate(pid))
    .then((result) =>
      validTerminationResult(result)
        ? result
        : terminationResult(pid, true, false, "none", "termination_handler_invalid"),
    )
    .catch(() => terminationResult(pid, true, false, "none", "termination_handler_failed"));
  const timedOut = new Promise<ProcessTreeTermination>((resolve) => {
    timer = setTimeout(
      () => resolve(terminationResult(pid, true, false, "none", "termination_handler_timeout")),
      boundedMs,
    );
  });
  const result = await Promise.race([handled, timedOut]);
  if (timer) clearTimeout(timer);
  return result;
}

async function terminatePosixProcessGroup(pid: number): Promise<ProcessTreeTermination> {
  const initial = await posixProcessTreeSnapshot(pid);
  const graceful = signalProcessGroup(pid, "SIGTERM");
  signalTrackedPosix(initial.entries, "SIGTERM");
  const gracefulRemaining = await waitForPidsGone(initial.trackedPids, PROCESS_TREE_GRACE_MS);
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
  const second = await posixProcessTreeSnapshot(pid);
  const entries = mergeProcessEntries(initial.entries, second.entries);
  const trackedPids = entries.map((entry) => entry.pid);
  const forced = signalProcessGroup(pid, "SIGKILL");
  signalTrackedPosix(entries, "SIGKILL");
  const remainingPids = await waitForPidsGone(trackedPids, PROCESS_TREE_VERIFY_MS);
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

async function terminateWindowsTree(pid: number): Promise<ProcessTreeTermination> {
  const snapshot = await windowsProcessTreeSnapshot(pid);
  const gracefulCode = await taskkill(pid, false);
  let remainingPids = await waitForPidsGone(snapshot.trackedPids, PROCESS_TREE_GRACE_MS);
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
  const refreshed = pidState(pid) === "gone" ? snapshot : await windowsProcessTreeSnapshot(pid);
  const originalRoot = snapshot.entries.find((entry) => entry.pid === pid);
  const refreshedRoot = refreshed.entries.find((entry) => entry.pid === pid);
  const sameRoot =
    !refreshedRoot || !originalRoot || refreshedRoot.started === originalRoot.started;
  const second = sameRoot
    ? refreshed
    : { ...refreshed, proven: false, reason: "windows_root_process_identity_changed" };
  const entries = mergeProcessEntries(snapshot.entries, second.entries);
  const trackedPids = entries.map((entry) => entry.pid);
  const forcedCode = sameRoot ? await taskkill(pid, true) : null;
  let forcedRemaining = await waitForPidsGone(trackedPids, PROCESS_TREE_GRACE_MS);
  if (forcedRemaining.length > 0) {
    const identities = await windowsProcessIdentities(forcedRemaining);
    const safePids = entries
      .filter((entry) => identities.get(entry.pid) === entry.started)
      .map((entry) => entry.pid);
    if (safePids.length > 0) await taskkillPids(safePids, true);
  }
  remainingPids = await waitForPidsGone(trackedPids, PROCESS_TREE_VERIFY_MS);
  if (remainingPids.length > 0) {
    const identities = await windowsProcessIdentities(remainingPids);
    remainingPids = entries
      .filter((entry) => remainingPids.includes(entry.pid))
      .filter((entry) => identities.get(entry.pid) === entry.started)
      .map((entry) => entry.pid);
  }
  const proven = snapshot.proven && second.proven && remainingPids.length === 0;
  return terminationResult(
    pid,
    true,
    proven,
    "windows-taskkill-tree",
    proven
      ? "taskkill_tree_absent_after_force"
      : snapshot.proven && second.proven
        ? `taskkill_tree_termination_unproven_${gracefulCode ?? "unknown"}_${forcedCode ?? "unknown"}`
        : !snapshot.proven
          ? snapshot.reason
          : second.reason,
    true,
    trackedPids,
    remainingPids,
  );
}

async function posixProcessTreeSnapshot(pid: number): Promise<ProcessTreeSnapshot> {
  const result = await execFileResult(
    "ps",
    ["-axo", "pid=,ppid=,pgid=,lstart="],
    PROCESS_TREE_VERIFY_MS,
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

async function windowsProcessTreeSnapshot(pid: number): Promise<ProcessTreeSnapshot> {
  const script = [
    "& {",
    "param([int]$RootProcessId)",
    "$all = @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId, ParentProcessId, CreationDate)",
    "if (-not ($all | Where-Object { [int]$_.ProcessId -eq $RootProcessId })) { throw 'root_missing' }",
    "$ids = @($RootProcessId)",
    "do {",
    "  $children = @($all | Where-Object { $ids -contains [int]$_.ParentProcessId -and $ids -notcontains [int]$_.ProcessId } | ForEach-Object { [int]$_.ProcessId })",
    "  if ($children.Count -eq 0) { break }",
    "  $ids += $children",
    `  if ($ids.Count -gt ${PROCESS_TREE_PID_LIMIT}) { throw 'tree_too_large' }`,
    "} while ($true)",
    "@($all | Where-Object { $ids -contains [int]$_.ProcessId } | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; started = $_.CreationDate.ToUniversalTime().ToString('o') } }) | ConvertTo-Json -Compress",
    "}",
  ].join("\n");
  const result = await execFileResult(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script, String(pid)],
    PROCESS_TREE_VERIFY_MS,
  );
  if (result.code !== 0) {
    return {
      entries: [],
      proven: false,
      reason: "windows_process_tree_enumeration_failed",
      trackedPids: [pid],
    };
  }
  try {
    const parsed = JSON.parse(result.stdout.trim());
    const values = Array.isArray(parsed) ? parsed : [parsed];
    const entries = values.map((value) => ({
      pid: Number(value?.pid),
      ppid: Number(value?.ppid),
      started: String(value?.started || ""),
    }));
    const trackedPids = [...new Set(entries.map((entry) => entry.pid))];
    const valid =
      trackedPids.includes(pid) &&
      trackedPids.length > 0 &&
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
          trackedPids: [pid],
        };
  } catch {
    return {
      entries: [],
      proven: false,
      reason: "windows_process_tree_enumeration_invalid",
      trackedPids: [pid],
    };
  }
}

async function windowsProcessIdentities(pids: number[]): Promise<Map<number, string>> {
  if (pids.length === 0) return new Map();
  const script = [
    "& {",
    "param([string]$IdsJson)",
    "$ids = @((ConvertFrom-Json $IdsJson) | ForEach-Object { [int]$_ })",
    "@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $ids -contains [int]$_.ProcessId } | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; started = $_.CreationDate.ToUniversalTime().ToString('o') } }) | ConvertTo-Json -Compress",
    "}",
  ].join("\n");
  const result = await execFileResult(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script, JSON.stringify(pids)],
    PROCESS_TREE_VERIFY_MS,
  );
  if (result.code !== 0) return new Map();
  try {
    const parsed = JSON.parse(result.stdout.trim() || "[]");
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return new Map(values.map((value) => [Number(value.pid), String(value.started || "")]));
  } catch {
    return new Map();
  }
}

function taskkill(pid: number, force: boolean): Promise<number | null> {
  return taskkillPids([pid], force);
}

function taskkillPids(pids: number[], force: boolean): Promise<number | null> {
  return execFileResult(
    "taskkill",
    [...pids.flatMap((pid) => ["/pid", String(pid)]), "/t", ...(force ? ["/f"] : [])],
    force ? PROCESS_TREE_VERIFY_MS : PROCESS_TREE_GRACE_MS,
  ).then((result) => result.code);
}

function execFileResult(
  command: string,
  args: string[],
  timeout: number,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { maxBuffer: 64 * 1024, timeout, windowsHide: true },
      (error, stdout) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : null) : 0,
          stdout: String(stdout || ""),
        });
      },
    );
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

async function waitForPidsGone(pids: number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let remaining = pids.filter((pid) => pidState(pid) !== "gone");
  while (remaining.length > 0 && Date.now() < deadline) {
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
