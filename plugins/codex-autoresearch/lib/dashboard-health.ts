import { unknownRecordOrNull } from "./types/json.js";

export type DashboardHealthLiveness = "alive" | "dead" | "unknown";

export interface DashboardHealthInput {
  url?: unknown;
  port?: unknown;
  pid?: unknown;
  registryPath?: unknown;
  cwd?: unknown;
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
  version: string;
  startedAt: string;
  previous: unknown;
  stale: boolean | null;
  liveness: DashboardHealthLiveness;
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
    version: cleanString(input.version),
    startedAt: cleanString(input.startedAt),
    previous,
    stale: previousStale(previous),
    liveness: previousLiveness(previous),
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
    if (dashboardIsAlive(payload, summary)) {
      return { ...summary, liveness: "alive", stale: false };
    }
    return { ...summary, liveness: "unknown", stale: true };
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

function dashboardMatchesSummary(dashboard: unknown, summary: DashboardHealthSummary): boolean {
  const port = recordValue(dashboard, "port");
  const cwd = cleanString(recordValue(dashboard, "cwd"));
  const version = cleanString(recordValue(dashboard, "version"));
  if (summary.port !== null && port !== summary.port) return false;
  if (summary.cwd && (!cwd || !samePathText(cwd, summary.cwd))) return false;
  if (summary.version && (!version || version !== summary.version)) return false;
  return true;
}

function cleanString(value: unknown): string {
  return String(value ?? "").trim();
}

function samePathText(left: string, right: string): boolean {
  return normalizePathText(left) === normalizePathText(right);
}

function normalizePathText(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
