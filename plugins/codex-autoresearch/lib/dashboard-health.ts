import { unknownRecordOrNull } from "./types/json.js";

export type DashboardHealthLiveness = "alive" | "dead" | "unknown";

export interface DashboardHealthInput {
  url?: unknown;
  port?: unknown;
  pid?: unknown;
  registryPath?: unknown;
  cwd?: unknown;
  sessionCwd?: unknown;
  sessionPathIdentity?: unknown;
  version?: unknown;
  startedAt?: unknown;
  previous?: unknown;
  timeoutMs?: unknown;
}

export interface DashboardHealthSummary {
  url: string;
  port: number | null;
  pid: number | null;
  healthUrl: string;
  registryPath: string;
  cwd: string;
  sessionCwd: string;
  sessionPathIdentity: string;
  version: string;
  mode: string;
  lastReadAt: string;
  startedAt: string;
  previous: unknown;
  stale: boolean | null;
  liveness: DashboardHealthLiveness;
  recoveryCommand: string;
}

export function buildDashboardHealthSummary(input: DashboardHealthInput): DashboardHealthSummary {
  const url = cleanString(input.url);
  const previous = input.previous;
  return {
    url,
    port: finitePositiveInteger(input.port),
    pid: finitePositiveInteger(input.pid),
    healthUrl: healthUrlFromUrl(url),
    registryPath: cleanString(input.registryPath),
    cwd: cleanString(input.cwd),
    sessionCwd: cleanString(input.sessionCwd),
    sessionPathIdentity: cleanString(input.sessionPathIdentity),
    version: cleanString(input.version),
    mode: "",
    lastReadAt: "",
    startedAt: cleanString(input.startedAt),
    previous,
    stale: previousStale(previous),
    liveness: previousLiveness(previous),
    recoveryCommand: dashboardHealthRecoveryCommand(cleanString(input.cwd)),
  };
}

export async function verifyDashboardHealthSummary(
  input: DashboardHealthInput,
): Promise<DashboardHealthSummary> {
  const summary = buildDashboardHealthSummary(input);
  if (!summary.healthUrl || summary.healthUrl === "/health") {
    return { ...summary, liveness: "unknown" };
  }

  const controller = new AbortController();
  const timeoutMs = finitePositiveInteger(input.timeoutMs) ?? 500;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(summary.healthUrl, { signal: controller.signal });
    if (!response.ok) return { ...summary, liveness: "dead", stale: true };
    const payload = await response.json().catch((): null => null);
    const details = dashboardHealthDetails(payload);
    if (dashboardIsAlive(payload, summary)) {
      return { ...summary, ...details, liveness: "alive", stale: false };
    }
    return { ...summary, ...details, liveness: "unknown", stale: true };
  } catch {
    return { ...summary, liveness: "dead", stale: true };
  } finally {
    clearTimeout(timeout);
  }
}

function finitePositiveInteger(value: unknown): number | null {
  if (typeof value !== "number") return null;
  return Number.isFinite(value) && Number.isInteger(value) && value > 0 ? value : null;
}

function healthUrlFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.pathname = "/health";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    const trimmed = url.replace(/\/+$/, "");
    return trimmed ? `${trimmed}/health` : "/health";
  }
}

function previousStale(previous: unknown): boolean | null {
  const stale = recordValue(previous, "stale");
  return typeof stale === "boolean" ? stale : null;
}

function previousLiveness(previous: unknown): DashboardHealthLiveness {
  const liveness = recordValue(previous, "liveness");
  return liveness === "alive" || liveness === "dead" || liveness === "unknown"
    ? liveness
    : "unknown";
}

function recordValue(record: unknown, key: string): unknown {
  return unknownRecordOrNull(record)?.[key];
}

function dashboardIsAlive(payload: unknown, summary: DashboardHealthSummary): boolean {
  const dashboard = recordValue(payload, "dashboard");
  if (!dashboard || typeof dashboard !== "object" || Array.isArray(dashboard)) return false;
  return recordValue(payload, "ok") === true && dashboardMatchesSummary(dashboard, summary);
}

function dashboardHealthDetails(payload: unknown): { mode: string; lastReadAt: string } {
  const dashboard = recordValue(payload, "dashboard");
  const mode =
    cleanString(recordValue(dashboard, "mode")) || cleanString(recordValue(payload, "mode"));
  const lastReadAt =
    cleanString(recordValue(dashboard, "lastReadAt")) ||
    cleanString(recordValue(payload, "lastReadAt"));
  return { mode, lastReadAt };
}

function dashboardMatchesSummary(dashboard: unknown, summary: DashboardHealthSummary): boolean {
  const port = recordValue(dashboard, "port");
  const sessionIdentity = cleanString(recordValue(dashboard, "sessionIdentity"));
  const version = cleanString(recordValue(dashboard, "version"));
  if (summary.port !== null && port !== summary.port) return false;
  if ((summary.cwd || summary.sessionCwd) && !summary.sessionPathIdentity) return false;
  if (summary.sessionPathIdentity && sessionIdentity !== summary.sessionPathIdentity) {
    return false;
  }
  if (summary.version && (!version || version !== summary.version)) return false;
  return true;
}

function dashboardHealthRecoveryCommand(cwd: string): string {
  return cwd ? `node scripts/autoresearch.mjs serve --cwd ${quoteCommandArg(cwd)}` : "";
}

function quoteCommandArg(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : JSON.stringify(value);
}

function cleanString(value: unknown): string {
  return String(value ?? "").trim();
}
