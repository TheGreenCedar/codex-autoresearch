import http from "node:http";
import type { ServerResponse } from "node:http";
import fsp from "node:fs/promises";
import path from "node:path";
import { redactEvidenceObject, redactEvidenceText } from "./evidence-redaction.js";

type LooseObject = Record<string, unknown>;

interface LiveViewModelCache {
  expiresAt: number;
  fingerprint: string;
  payload: LooseObject;
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
  let viewModelCache: LiveViewModelCache | null = null;
  let serverPort = 0;
  const server = http.createServer(async (req, res) => {
    try {
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
        const jsonl = await fsp.readFile(path.join(workDir, "autoresearch.jsonl"), "utf8");
        send(res, 200, "application/jsonl; charset=utf-8", redactJsonl(jsonl, { workDir }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/view-model.json") {
        const payload = await readCachedLiveViewModel({
          workDir,
          viewModel,
          nowMs: Date.now(),
          ttlMs: viewModelCacheTtlMs,
          cached: viewModelCache,
        });
        viewModelCache = payload.cached;
        sendJson(res, payload.body);
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
  });
  res.end(body);
}

function redactJsonl(text: string, context: LooseObject): string {
  return text
    .split(/\r?\n/)
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
  cached,
}: {
  workDir: string;
  viewModel: () => Promise<LooseObject>;
  nowMs: number;
  ttlMs: number;
  cached: LiveViewModelCache | null;
}): Promise<{ body: LooseObject; cached: LiveViewModelCache }> {
  const fingerprint = await liveSessionFingerprint(workDir);
  if (cached && cached.fingerprint === fingerprint && cached.expiresAt > nowMs) {
    return { body: cached.payload, cached };
  }
  const ledgerEntries = await readRedactedLedgerEntries(workDir, { workDir });
  const body = redactEvidenceObject({ ...(await viewModel()), ledgerEntries }, { workDir });
  return {
    body,
    cached: {
      expiresAt: nowMs + ttlMs,
      fingerprint,
      payload: body,
    },
  };
}

async function liveSessionFingerprint(workDir: string): Promise<string> {
  const parts = await Promise.all([
    fingerprintPath(path.join(workDir, "autoresearch.jsonl"), "autoresearch.jsonl"),
    fingerprintPath(path.join(workDir, "autoresearch.config.json"), "autoresearch.config.json"),
    fingerprintPath(path.join(workDir, "autoresearch.last-run.json"), "autoresearch.last-run.json"),
    fingerprintPath(path.join(workDir, "autoresearch.md"), "autoresearch.md"),
    fingerprintPath(path.join(workDir, "autoresearch.ideas.md"), "autoresearch.ideas.md"),
    fingerprintTree(path.join(workDir, "autoresearch.research"), "autoresearch.research"),
  ]);
  return parts.join("|");
}

async function fingerprintTree(root: string, label: string): Promise<string> {
  const entries = await fsp
    .readdir(root, { withFileTypes: true })
    .catch((error: unknown) => (isFileNotFound(error) ? [] : Promise.reject(error)));
  if (!entries.length) return `${label}:missing`;
  const parts: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const fullPath = path.join(root, entry.name);
    const childLabel = `${label}/${entry.name}`;
    if (entry.isDirectory()) {
      parts.push(await fingerprintTree(fullPath, childLabel));
    } else if (entry.isFile()) {
      parts.push(await fingerprintPath(fullPath, childLabel));
    }
  }
  return parts.join("|");
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
): Promise<LooseObject[]> {
  const text = await fsp
    .readFile(path.join(workDir, "autoresearch.jsonl"), "utf8")
    .catch((error: unknown) => {
      if (isFileNotFound(error)) return "";
      throw error;
    });
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const entry = redactEvidenceObject(JSON.parse(line), context);
        return isLooseObject(entry) ? [entry] : [];
      } catch {
        return [];
      }
    });
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isLooseObject(value: unknown): value is LooseObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
