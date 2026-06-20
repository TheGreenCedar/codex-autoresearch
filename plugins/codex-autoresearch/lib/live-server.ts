import http from "node:http";
import type { ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { DashboardLedgerBounds } from "./dashboard-ledger-bounds.js";
import { compactDashboardTransportViewModel } from "./dashboard-transport.js";
import { redactEvidenceObject, redactEvidenceText } from "./evidence-redaction.js";
import { resolveSessionPaths } from "./session-paths.js";

type LooseObject = Record<string, unknown>;

export const LIVE_LEDGER_MAX_ENTRIES = 5000;
export const LIVE_RESEARCH_FINGERPRINT_MAX_ENTRIES = 200;
export const LIVE_RESEARCH_FINGERPRINT_MAX_DEPTH = 2;
const LIVE_VIEW_MODEL_REFRESH_RETRY_LIMIT = 1;

interface LiveViewModelCache {
  expiresAt: number;
  fingerprint: string;
  fingerprintExpiresAt: number;
  fingerprintStamp: string;
  payload: LooseObject;
}

interface LiveViewModelCacheState {
  current: LiveViewModelCache | null;
  pending: LiveViewModelRefresh | null;
}

interface LiveViewModelRefresh {
  fingerprint: string;
  promise: Promise<LiveViewModelResult>;
}

interface LiveViewModelResult {
  body: LooseObject;
  cacheable: boolean;
  cached: LiveViewModelCache;
  statusCode?: number;
}

interface LiveSessionSnapshot {
  fingerprint: string;
  stamp: string;
}

interface LedgerReadout {
  entries: LooseObject[];
  ledgerBounds: DashboardLedgerBounds;
}

interface BoundedLedgerLines extends DashboardLedgerBounds {
  lines: string[];
}

export async function serveAutoresearch(args: LooseObject) {
  const workDir = path.resolve(String(args.working_dir || args.cwd || process.cwd()));
  const port = Number(args.port || 0);
  const dashboardHtml = args.dashboardHtml as (context?: LooseObject) => Promise<string>;
  const viewModel = args.viewModel as () => Promise<LooseObject>;
  const startedAt = String(args.startedAt || new Date().toISOString());
  const version = String(args.pluginVersion || args.version || "");
  const debugLedger = args.debugLedger === true;
  const viewModelCacheTtlMs = normalizeCacheTtlMs(args.viewModelCacheTtlMs);
  const viewModelCache: LiveViewModelCacheState = { current: null, pending: null };
  let serverPort = 0;
  const server = http.createServer(async (req, res) => {
    try {
      if (!isAllowedHostHeader(req.headers.host, serverPort)) {
        sendJson(
          res,
          { ok: false, error: "Host header is not allowed for this local server." },
          403,
        );
        return;
      }
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/") {
        send(res, 200, "text/html; charset=utf-8", await dashboardHtml({}));
        return;
      }
      if (req.method === "GET" && url.pathname === "/autoresearch.jsonl") {
        if (!debugLedger) {
          sendJson(
            res,
            {
              ok: false,
              error:
                "Raw ledger endpoint is disabled. Restart the live dashboard with --debug-ledger to inspect the redacted ledger.",
            },
            404,
          );
          return;
        }
        const ledgerLines = await readBoundedLedgerLines(
          resolveSessionPaths({ workDir }).ledgerPath,
        );
        send(
          res,
          200,
          "application/jsonl; charset=utf-8",
          redactLedgerLines(ledgerLines.lines, { workDir }),
        );
        return;
      }
      if (req.method === "GET" && url.pathname === "/view-model.json") {
        const payload = await readCachedLiveViewModel({
          workDir,
          viewModel,
          nowMs: Date.now(),
          ttlMs: viewModelCacheTtlMs,
          cache: viewModelCache,
        });
        sendJson(res, payload.body, payload.statusCode ?? 200);
        return;
      }
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, {
          ok: true,
          workDir,
          dashboard: {
            cwd: workDir,
            liveness: "alive",
            mode: "live-server",
            pid: process.pid,
            port: serverPort || null,
            startedAt,
            lastReadAt: new Date().toISOString(),
            version,
            debugLedger,
          },
        });
        return;
      }
      sendJson(res, { ok: false, error: "Not found" }, 404);
    } catch (error) {
      sendJson(
        res,
        {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "Autoresearch dashboard server failed unexpectedly.",
        },
        500,
      );
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Autoresearch live dashboard did not expose a numeric loopback port.");
  }
  serverPort = address.port;
  return {
    ok: true,
    workDir,
    port: address.port,
    url: `http://127.0.0.1:${address.port}/`,
    pid: process.pid,
    cwd: workDir,
    startedAt,
    version,
    debugLedger,
    server,
  };
}

function sendJson(res: ServerResponse, body: LooseObject, status = 200): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(body, null, 2));
}

function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  res.end(body);
}

function isAllowedHostHeader(host: string | string[] | undefined, activePort: number): boolean {
  if (!host || Array.isArray(host) || activePort <= 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(`http://${host}`);
  } catch {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  const port = Number(parsed.port || 80);
  return (
    port === activePort &&
    (hostname === "127.0.0.1" ||
      hostname === "localhost" ||
      hostname === "::1" ||
      hostname === "[::1]")
  );
}

function redactLedgerLines(lines: string[], context: LooseObject): string {
  return lines
    .map((line) => {
      if (!line.trim()) return line;
      try {
        return JSON.stringify(redactEvidenceObject(JSON.parse(line), context));
      } catch {
        return redactEvidenceText(line, context);
      }
    })
    .join("\n");
}

async function readCachedLiveViewModel({
  workDir,
  viewModel,
  nowMs,
  ttlMs,
  cache,
}: {
  workDir: string;
  viewModel: () => Promise<LooseObject>;
  nowMs: number;
  ttlMs: number;
  cache: LiveViewModelCacheState;
}): Promise<LiveViewModelResult> {
  const cached = cache.current;
  const snapshot = await liveSessionSnapshot(workDir, {
    cached,
    nowMs,
    ttlMs,
  });
  const fingerprint = snapshot.fingerprint;
  if (cached && cached.fingerprint === fingerprint && cached.expiresAt > nowMs) {
    return { body: cached.payload, cacheable: true, cached };
  }
  if (cache.pending && cache.pending.fingerprint === fingerprint) {
    return cache.pending.promise;
  }
  const pending: LiveViewModelRefresh = {
    fingerprint,
    promise: buildLiveViewModelRefresh({ workDir, viewModel, ttlMs, fingerprint }),
  };
  cache.pending = pending;
  try {
    const payload = await pending.promise;
    if (payload.cacheable) cache.current = payload.cached;
    return payload;
  } finally {
    if (cache.pending === pending) cache.pending = null;
  }
}

async function buildLiveViewModelRefresh({
  workDir,
  viewModel,
  ttlMs,
  fingerprint,
}: {
  workDir: string;
  viewModel: () => Promise<LooseObject>;
  ttlMs: number;
  fingerprint: string;
}): Promise<LiveViewModelResult> {
  let expectedFingerprint = fingerprint;
  for (let attempt = 0; ; attempt += 1) {
    const refresh = await buildLiveViewModelBody({ workDir, viewModel });
    if (refresh.completedSnapshot.fingerprint === expectedFingerprint) {
      return liveViewModelResult({
        body: refresh.body,
        cacheable: true,
        completedAt: refresh.completedAt,
        fingerprint: expectedFingerprint,
        fingerprintStamp: refresh.completedSnapshot.stamp,
        ttlMs,
      });
    }
    if (attempt >= LIVE_VIEW_MODEL_REFRESH_RETRY_LIMIT) {
      return liveViewModelChangedDuringRefreshResult({
        completedAt: refresh.completedAt,
        completedSnapshot: refresh.completedSnapshot,
        ttlMs,
      });
    }
    expectedFingerprint = refresh.completedSnapshot.fingerprint;
  }
}

async function buildLiveViewModelBody({
  workDir,
  viewModel,
}: {
  workDir: string;
  viewModel: () => Promise<LooseObject>;
}): Promise<{
  body: LooseObject;
  completedAt: number;
  completedSnapshot: LiveSessionSnapshot;
}> {
  const ledgerReadout = await readRedactedLedgerEntries(workDir, { workDir });
  const body = redactEvidenceObject(
    {
      ...compactDashboardTransportViewModel(await viewModel()),
      ledgerEntries: ledgerReadout.entries,
      ledgerBounds: ledgerReadout.ledgerBounds,
    },
    { workDir },
  );
  const completedAt = Date.now();
  const completedSnapshot = await liveSessionSnapshot(workDir, {
    cached: null,
    nowMs: completedAt,
    ttlMs: 0,
  });
  return { body, completedAt, completedSnapshot };
}

function liveViewModelResult({
  body,
  cacheable,
  completedAt,
  fingerprint,
  fingerprintStamp,
  ttlMs,
  statusCode,
}: {
  body: LooseObject;
  cacheable: boolean;
  completedAt: number;
  fingerprint: string;
  fingerprintStamp: string;
  ttlMs: number;
  statusCode?: number;
}): LiveViewModelResult {
  return {
    body,
    cacheable,
    statusCode,
    cached: {
      expiresAt: cacheable ? completedAt + ttlMs : 0,
      fingerprint,
      fingerprintExpiresAt: cacheable ? completedAt + ttlMs : 0,
      fingerprintStamp,
      payload: body,
    },
  };
}

function liveViewModelChangedDuringRefreshResult({
  completedAt,
  completedSnapshot,
  ttlMs,
}: {
  completedAt: number;
  completedSnapshot: LiveSessionSnapshot;
  ttlMs: number;
}): LiveViewModelResult {
  return liveViewModelResult({
    body: {
      ok: false,
      code: "live_view_model_changed_during_refresh",
      retryable: true,
      message:
        "Session files changed while the live dashboard readout was refreshing. Retry to avoid a mixed ledger/readout snapshot.",
    },
    cacheable: false,
    completedAt,
    fingerprint: completedSnapshot.fingerprint,
    fingerprintStamp: completedSnapshot.stamp,
    ttlMs,
    statusCode: 409,
  });
}

export async function liveSessionFingerprint(
  workDir: string,
  options: {
    cached: LiveViewModelCache | null;
    nowMs: number;
    ttlMs: number;
  },
): Promise<string> {
  return (await liveSessionSnapshot(workDir, options)).fingerprint;
}

async function liveSessionSnapshot(
  workDir: string,
  options: {
    cached: LiveViewModelCache | null;
    nowMs: number;
    ttlMs: number;
  },
): Promise<LiveSessionSnapshot> {
  const stamp = await liveSessionStamp(workDir);
  if (
    options.cached &&
    options.cached.fingerprintStamp === stamp &&
    options.cached.fingerprintExpiresAt > options.nowMs
  ) {
    return { fingerprint: options.cached.fingerprint, stamp };
  }
  const sessionPaths = resolveSessionPaths({ workDir });
  const parts = await Promise.all([
    fingerprintPath(sessionPaths.ledgerPath, "autoresearch.jsonl"),
    fingerprintPath(sessionPaths.configPath, "autoresearch.config.json"),
    fingerprintPath(sessionPaths.lastRunFallbackPath, "autoresearch.last-run.json"),
    fingerprintPath(sessionPaths.notesPath, "autoresearch.md"),
    fingerprintPath(sessionPaths.ideasPath, "autoresearch.ideas.md"),
    fingerprintTree(sessionPaths.researchRoot, "autoresearch.research"),
  ]);
  return { fingerprint: parts.join("|"), stamp };
}

async function liveSessionStamp(workDir: string): Promise<string> {
  // TTL-bounded dashboard reuse compares this stamp; a stale stamp can serve briefly
  // until the next health poll notices ledger/config drift.
  const sessionPaths = resolveSessionPaths({ workDir });
  const parts = await Promise.all([
    fingerprintPath(sessionPaths.ledgerPath, "autoresearch.jsonl"),
    fingerprintPath(sessionPaths.configPath, "autoresearch.config.json"),
    fingerprintPath(sessionPaths.lastRunFallbackPath, "autoresearch.last-run.json"),
    fingerprintPath(sessionPaths.notesPath, "autoresearch.md"),
    fingerprintPath(sessionPaths.ideasPath, "autoresearch.ideas.md"),
    fingerprintPath(sessionPaths.researchRoot, "autoresearch.research"),
  ]);
  return parts.join("|");
}

async function fingerprintTree(
  root: string,
  label: string,
  options: {
    budget?: { entries: number; truncated: boolean };
    depth?: number;
  } = {},
): Promise<string> {
  const depth = options.depth || 0;
  const budget = options.budget || { entries: 0, truncated: false };
  const rootStats = await fsp
    .stat(root)
    .catch((error: unknown) => (isFileNotFound(error) ? null : Promise.reject(error)));
  if (!rootStats) return `${label}:missing`;
  if (!rootStats.isDirectory()) return `${label}:${rootStats.size}:${rootStats.mtimeMs}`;
  if (depth >= LIVE_RESEARCH_FINGERPRINT_MAX_DEPTH) {
    return `${label}:dir:${rootStats.mtimeMs}:depth-capped`;
  }
  const entries = await fsp
    .readdir(root, { withFileTypes: true })
    .catch((error: unknown) => (isFileNotFound(error) ? [] : Promise.reject(error)));
  if (!entries.length) return `${label}:dir:${rootStats.mtimeMs}:empty`;
  const parts: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (budget.entries >= LIVE_RESEARCH_FINGERPRINT_MAX_ENTRIES) {
      budget.truncated = true;
      break;
    }
    budget.entries += 1;
    const fullPath = path.join(root, entry.name);
    const childLabel = `${label}/${entry.name}`;
    if (entry.isDirectory()) {
      parts.push(await fingerprintTree(fullPath, childLabel, { budget, depth: depth + 1 }));
    } else if (entry.isFile()) {
      parts.push(await fingerprintPath(fullPath, childLabel));
    }
  }
  if (budget.truncated) parts.push(`${label}:truncated:${budget.entries}`);
  return `${label}:dir:${rootStats.mtimeMs}:${parts.join("|")}`;
}

async function fingerprintPath(filePath: string, label: string): Promise<string> {
  const stats = await fsp
    .stat(filePath)
    .catch((error: unknown) => (isFileNotFound(error) ? null : Promise.reject(error)));
  if (!stats) return `${label}:missing`;
  return `${label}:${stats.size}:${stats.mtimeMs}`;
}

function normalizeCacheTtlMs(value: unknown): number {
  const ttl = Number(value ?? 1000);
  return Number.isFinite(ttl) && ttl >= 0 ? ttl : 1000;
}

async function readRedactedLedgerEntries(
  workDir: string,
  context: LooseObject,
): Promise<LedgerReadout> {
  const boundedLines = await readBoundedLedgerLines(resolveSessionPaths({ workDir }).ledgerPath);
  const parsedEntries = boundedLines.lines.flatMap((line) => {
    try {
      const entry = redactEvidenceObject(JSON.parse(line), context);
      return isLooseObject(entry) ? [entry] : [];
    } catch {
      return [];
    }
  });
  return {
    entries: parsedEntries,
    ledgerBounds: {
      maxEntries: boundedLines.maxEntries,
      omittedEntries: boundedLines.omittedEntries,
      truncated: boundedLines.truncated,
    },
  };
}

async function readBoundedLedgerLines(filePath: string): Promise<BoundedLedgerLines> {
  const maxEntries = LIVE_LEDGER_MAX_ENTRIES;
  const empty = { lines: [], maxEntries, omittedEntries: 0, truncated: false };
  const stats = await fsp
    .stat(filePath)
    .catch((error: unknown) => (isFileNotFound(error) ? null : Promise.reject(error)));
  if (!stats) return empty;

  const lines: string[] = [];
  let totalLines = 0;
  let latestConfigBeforeTail: string | null = null;

  if (maxEntries <= 0) {
    return { ...empty, truncated: stats.size > 0 };
  }

  const stream = createReadStream(filePath, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const rawLine of reader) {
      const line = String(rawLine).trim();
      if (!line) continue;
      totalLines += 1;
      lines.push(line);
      if (lines.length > maxEntries) {
        const removed = lines.shift();
        if (isConfigLedgerLine(removed)) latestConfigBeforeTail = removed || null;
      }
    }
  } catch (error) {
    if (isFileNotFound(error)) return empty;
    throw error;
  } finally {
    reader.close();
    stream.destroy();
  }

  const bounded =
    maxEntries > 1 && latestConfigBeforeTail && tailNeedsGoverningConfig(lines)
      ? trimBoundLedgerLines([latestConfigBeforeTail, ...lines], maxEntries)
      : lines;
  return {
    lines: bounded,
    maxEntries,
    omittedEntries: Math.max(0, totalLines - bounded.length),
    truncated: totalLines > bounded.length,
  };
}

function tailNeedsGoverningConfig(lines: string[]): boolean {
  const firstRunOffset = lines.findIndex(isRunLedgerLine);
  if (firstRunOffset < 0) return false;
  for (let index = firstRunOffset; index >= 0; index -= 1) {
    if (isConfigLedgerLine(lines[index])) return false;
  }
  return true;
}

function trimBoundLedgerLines(lines: string[], maxEntries: number): string[] {
  const bounded = [...lines];
  while (bounded.length > maxEntries) {
    const removable = bounded.findIndex((line, index) => index > 0 && !isConfigLedgerLine(line));
    bounded.splice(removable >= 0 ? removable : bounded.length - 1, 1);
  }
  return bounded;
}

function isConfigLedgerLine(line: string | undefined): boolean {
  return ledgerLineType(line) === "config";
}

function isRunLedgerLine(line: string | undefined): boolean {
  return ledgerLineType(line) === "run";
}

function ledgerLineType(line: string | undefined): "config" | "run" | "other" {
  if (!line) return "other";
  if (
    !line.includes('"type"') &&
    !line.includes('"run"') &&
    !line.includes('"metric"') &&
    !line.includes('"status"')
  ) {
    return "other";
  }
  try {
    const entry = JSON.parse(line);
    if (!isLooseObject(entry)) return "other";
    if (entry.type === "config") return "config";
    if (
      entry.type === "run" ||
      (!entry.type && ("run" in entry || "metric" in entry || "status" in entry))
    ) {
      return "run";
    }
  } catch {
    return "other";
  }
  return "other";
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isLooseObject(value: unknown): value is LooseObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
