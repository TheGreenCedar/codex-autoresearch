import http from "node:http";
import type { ServerResponse } from "node:http";
import fsp from "node:fs/promises";
import path from "node:path";
import { redactEvidenceObject, redactEvidenceText } from "./evidence-redaction.js";

type LooseObject = Record<string, any>;

export async function serveAutoresearch(args: LooseObject) {
  const workDir = path.resolve(args.working_dir || args.cwd || process.cwd());
  const port = Number(args.port || 0);
  const dashboardHtml = args.dashboardHtml;
  const viewModel = args.viewModel;
  const startedAt = String(args.startedAt || new Date().toISOString());
  const version = String(args.pluginVersion || args.version || "");
  let serverPort = 0;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/") {
        send(res, 200, "text/html; charset=utf-8", await dashboardHtml({}));
        return;
      }
      if (req.method === "GET" && url.pathname === "/autoresearch.jsonl") {
        const jsonl = await fsp.readFile(path.join(workDir, "autoresearch.jsonl"), "utf8");
        send(res, 200, "application/jsonl; charset=utf-8", redactJsonl(jsonl, { workDir }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/view-model.json") {
        sendJson(res, redactEvidenceObject(await viewModel(), { workDir }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, {
          ok: true,
          workDir,
          dashboard: {
            cwd: workDir,
            liveness: "alive",
            pid: process.pid,
            port: serverPort || null,
            startedAt,
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
