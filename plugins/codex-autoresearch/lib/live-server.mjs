import http from "node:http";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";

const SAFE_DASHBOARD_ACTIONS = new Set([
  "doctor",
  "setup-plan",
  "guide",
  "recipes",
  "gap-candidates",
  "finalize-preview",
  "export",
  "log-keep",
  "log-discard",
  "log-crash",
  "log-checks-failed",
]);
const LOG_ACTION_STATUS = new Map([
  ["log-keep", "keep"],
  ["log-discard", "discard"],
  ["log-crash", "crash"],
  ["log-checks-failed", "checks_failed"],
]);

export async function serveAutoresearch(args) {
  const workDir = path.resolve(args.working_dir || args.cwd || process.cwd());
  const scriptPath = args.scriptPath;
  const port = Number(args.port || 0);
  const dashboardHtml = args.dashboardHtml;
  const viewModel = args.viewModel;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/") {
        send(res, 200, "text/html; charset=utf-8", await dashboardHtml());
        return;
      }
      if (req.method === "GET" && url.pathname === "/autoresearch.jsonl") {
        send(res, 200, "application/jsonl; charset=utf-8", await fsp.readFile(path.join(workDir, "autoresearch.jsonl"), "utf8"));
        return;
      }
      if (req.method === "GET" && url.pathname === "/view-model.json") {
        sendJson(res, await viewModel());
        return;
      }
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, { ok: true, workDir });
        return;
      }
      if (req.method === "POST" && url.pathname.startsWith("/actions/")) {
        const action = url.pathname.split("/").at(-1);
        if (!SAFE_DASHBOARD_ACTIONS.has(action)) {
          sendJson(res, { ok: false, error: "Action is not allowed from the dashboard." }, 403);
          return;
        }
        const body = await readJsonBody(req);
        const cliArgs = await actionArgs(action, workDir, body);
        const result = await runNode(scriptPath, cliArgs, workDir);
        sendJson(res, { ok: result.code === 0, action, stdout: result.stdout, stderr: result.stderr, code: result.code });
        return;
      }
      sendJson(res, { ok: false, error: "Not found" }, 404);
    } catch (error) {
      sendJson(res, { ok: false, error: error.stack || error.message || String(error) }, error.statusCode || 500);
    }
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  return {
    ok: true,
    workDir,
    port: address.port,
    url: `http://127.0.0.1:${address.port}/`,
    server,
  };
}

async function actionArgs(action, workDir, body) {
  if (action === "doctor") return ["doctor", "--cwd", workDir, "--check-benchmark"];
  if (action === "setup-plan") return ["setup-plan", "--cwd", workDir];
  if (action === "guide") return ["guide", "--cwd", workDir];
  if (action === "recipes") return ["recipes", "list"];
  if (action === "gap-candidates") return ["gap-candidates", "--cwd", workDir, "--research-slug", body.researchSlug || body.slug || await firstResearchSlug(workDir) || "research"];
  if (action === "finalize-preview") return ["finalize-preview", "--cwd", workDir];
  if (action === "export") return ["export", "--cwd", workDir];
  if (LOG_ACTION_STATUS.has(action)) return logActionArgs(action, workDir, body);
  return [];
}

function logActionArgs(action, workDir, body) {
  const status = LOG_ACTION_STATUS.get(action);
  if (!body?.confirm) throw new DashboardActionError("Log actions require confirm=true.");
  const description = String(body.description || "").trim();
  if (!description || /^Describe the /.test(description)) {
    throw new DashboardActionError("Log actions require a specific description.");
  }
  const args = ["log", "--cwd", workDir, "--from-last", "--status", status, "--description", description];
  if (body.asi && typeof body.asi === "object" && Object.keys(body.asi).length > 0) {
    args.push("--asi", JSON.stringify(body.asi));
  }
  if (body.metrics && typeof body.metrics === "object" && Object.keys(body.metrics).length > 0) {
    args.push("--metrics", JSON.stringify(body.metrics));
  }
  return args;
}

class DashboardActionError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function firstResearchSlug(workDir) {
  const researchRoot = path.join(workDir, "autoresearch.research");
  try {
    const entries = await fsp.readdir(researchRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        await fsp.access(path.join(researchRoot, entry.name, "quality-gaps.md"));
        return entry.name;
      } catch {
        // Keep looking.
      }
    }
  } catch {
    return "";
  }
  return "";
}

async function readJsonBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk.toString("utf8");
  if (!body.trim()) return {};
  return JSON.parse(body);
}

async function runNode(scriptPath, args, cwd) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: String(error.message || error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function sendJson(res, body, status = 200) {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(body, null, 2));
}

function send(res, status, contentType, body) {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  res.end(body);
}
