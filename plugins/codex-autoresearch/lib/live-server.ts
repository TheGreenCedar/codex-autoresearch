import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { runProcess, tailText } from "./runner.js";

type LooseObject = Record<string, any>;

const ACTION_NONCE_HEADER = "x-autoresearch-action-nonce";
const ACTION_BODY_MAX_BYTES = 16 * 1024;
const ACTION_OUTPUT_MAX_BYTES = 32 * 1024;
const DEFAULT_ACTION_TIMEOUT_SECONDS = 60;
const LOG_ACTION_STATUS = new Map([
  ["log-keep", "keep"],
  ["log-discard", "discard"],
  ["log-crash", "crash"],
  ["log-checks-failed", "checks_failed"],
]);
const DASHBOARD_ACTIONS = new Map([
  ["doctor", { className: "read", allowedBodyKeys: [] }],
  ["doctor-explain", { className: "read", allowedBodyKeys: [] }],
  ["onboarding-packet", { className: "read", allowedBodyKeys: [] }],
  ["recommend-next", { className: "read", allowedBodyKeys: [] }],
  ["benchmark-lint", { className: "read", allowedBodyKeys: [] }],
  ["new-segment-dry-run", { className: "preview", allowedBodyKeys: [] }],
  ["setup-plan", { className: "read", allowedBodyKeys: [] }],
  ["guide", { className: "read", allowedBodyKeys: [] }],
  ["recipes", { className: "read", allowedBodyKeys: [] }],
  ["gap-candidates", { className: "preview", allowedBodyKeys: ["researchSlug", "slug"] }],
  ["finalize-preview", { className: "preview", allowedBodyKeys: [] }],
  ["export", { className: "export", allowedBodyKeys: [] }],
  [
    "log-keep",
    {
      className: "log-decision",
      allowedBodyKeys: ["confirm", "lastRunFingerprint", "description", "asi"],
    },
  ],
  [
    "log-discard",
    {
      className: "log-decision",
      allowedBodyKeys: ["confirm", "lastRunFingerprint", "description", "asi"],
    },
  ],
  [
    "log-crash",
    {
      className: "log-decision",
      allowedBodyKeys: ["confirm", "lastRunFingerprint", "description", "asi"],
    },
  ],
  [
    "log-checks-failed",
    {
      className: "log-decision",
      allowedBodyKeys: ["confirm", "lastRunFingerprint", "description", "asi"],
    },
  ],
]);

export async function serveAutoresearch(args: LooseObject) {
  const workDir = path.resolve(args.working_dir || args.cwd || process.cwd());
  const scriptPath = args.scriptPath;
  const port = Number(args.port || 0);
  const dashboardHtml = args.dashboardHtml;
  const viewModel = args.viewModel;
  const actionNonce = randomBytes(32).toString("base64url");
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/") {
        send(
          res,
          200,
          "text/html; charset=utf-8",
          await dashboardHtml({ actionNonce, actionNonceHeader: "X-Autoresearch-Action-Nonce" }),
        );
        return;
      }
      if (req.method === "GET" && url.pathname === "/autoresearch.jsonl") {
        send(
          res,
          200,
          "application/jsonl; charset=utf-8",
          await fsp.readFile(path.join(workDir, "autoresearch.jsonl"), "utf8"),
        );
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
        try {
          const policy = DASHBOARD_ACTIONS.get(action);
          if (!policy || url.pathname !== `/actions/${action}`) {
            sendJson(
              res,
              actionErrorEnvelope(
                action,
                "Action is not allowed from the dashboard.",
                "action_forbidden",
              ),
              403,
            );
            return;
          }
          const admission = validateActionRequest(req, { actionNonce });
          if (!admission.ok) {
            sendJson(
              res,
              actionErrorEnvelope(action, admission.error, admission.code),
              admission.status,
            );
            return;
          }
          const body = await readJsonBody(req, ACTION_BODY_MAX_BYTES);
          validateActionBody(action, policy, body);
          const cliArgs = await actionArgs(action, workDir, body);
          const result = await runDashboardCliAction(scriptPath, cliArgs, workDir, policy);
          sendJson(res, actionResultEnvelope(action, cliArgs, result), result.timedOut ? 504 : 200);
        } catch (error) {
          const failure = error as DashboardActionError;
          sendJson(
            res,
            actionErrorEnvelope(
              action,
              failure.message || String(failure),
              failure.code || "dashboard_action_failed",
            ),
            failure.statusCode || 500,
          );
        }
        return;
      }
      sendJson(res, { ok: false, error: "Not found" }, 404);
    } catch (error) {
      const failure = error as DashboardActionError;
      sendJson(
        res,
        actionErrorEnvelope(
          "dashboard",
          failure.message || String(failure),
          failure.code || "dashboard_action_failed",
        ),
        failure.statusCode || 500,
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
  return {
    ok: true,
    workDir,
    port: address.port,
    url: `http://127.0.0.1:${address.port}/`,
    actionNonce,
    server,
  };
}

async function actionArgs(action, workDir, body) {
  if (action === "doctor") return ["doctor", "--cwd", workDir];
  if (action === "doctor-explain") return ["doctor", "--cwd", workDir, "--explain"];
  if (action === "onboarding-packet") return ["onboarding-packet", "--cwd", workDir, "--compact"];
  if (action === "recommend-next") return ["recommend-next", "--cwd", workDir, "--compact"];
  if (action === "benchmark-lint") return ["benchmark-lint", "--cwd", workDir];
  if (action === "new-segment-dry-run") return ["new-segment", "--cwd", workDir, "--dry-run"];
  if (action === "setup-plan") return ["setup-plan", "--cwd", workDir];
  if (action === "guide") return ["guide", "--cwd", workDir];
  if (action === "recipes") return ["recipes", "list"];
  if (action === "gap-candidates")
    return [
      "gap-candidates",
      "--cwd",
      workDir,
      "--research-slug",
      body.researchSlug || body.slug || (await firstResearchSlug(workDir)) || "research",
    ];
  if (action === "finalize-preview") return ["finalize-preview", "--cwd", workDir];
  if (action === "export") return ["export", "--cwd", workDir];
  if (LOG_ACTION_STATUS.has(action)) return logActionArgs(action, workDir, body);
  return [];
}

async function logActionArgs(action, workDir, body) {
  const status = LOG_ACTION_STATUS.get(action);
  if (body?.confirm !== action)
    throw new DashboardActionError(
      `Log actions require confirm="${action}".`,
      400,
      "log_confirmation_required",
    );
  await assertLastRunFingerprint(workDir, body.lastRunFingerprint);
  const description = String(body.description || "").trim();
  if (!description || description.startsWith("Describe the ")) {
    throw new DashboardActionError(
      "Log actions require a specific description.",
      400,
      "log_description_required",
    );
  }
  const asi = normalizeAsi(status, body.asi);
  if (!asi.ok) {
    throw new DashboardActionError(asi.error, 400, "log_asi_invalid");
  }
  const args = [
    "log",
    "--cwd",
    workDir,
    "--from-last",
    "--status",
    status,
    "--description",
    description,
  ];
  args.push("--asi", JSON.stringify(asi.value));
  return args;
}

class DashboardActionError extends Error {
  code: string;
  statusCode: number;

  constructor(message, statusCode = 400, code = "dashboard_action_invalid") {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function validateActionRequest(req, { actionNonce }) {
  const nonce = req.headers[ACTION_NONCE_HEADER];
  if (nonce !== actionNonce) {
    return {
      ok: false,
      status: 403,
      code: "action_nonce_invalid",
      error: "Live action token is missing or invalid.",
    };
  }
  const host = String(req.headers.host || "");
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host)) {
    return {
      ok: false,
      status: 403,
      code: "host_forbidden",
      error: "Live actions are only available on the loopback dashboard host.",
    };
  }
  const origin = String(req.headers.origin || "");
  if (origin && !sameLoopbackOrigin(origin, host)) {
    return {
      ok: false,
      status: 403,
      code: "origin_forbidden",
      error: "Cross-origin dashboard actions are not allowed.",
    };
  }
  const referer = String(req.headers.referer || "");
  if (!origin && referer) {
    try {
      if (!sameLoopbackOrigin(new URL(referer).origin, host)) {
        return {
          ok: false,
          status: 403,
          code: "referer_forbidden",
          error: "Cross-origin dashboard actions are not allowed.",
        };
      }
    } catch {
      return {
        ok: false,
        status: 403,
        code: "referer_invalid",
        error: "Invalid dashboard action referer.",
      };
    }
  }
  if (String(req.headers["sec-fetch-site"] || "").toLowerCase() === "cross-site") {
    return {
      ok: false,
      status: 403,
      code: "fetch_site_forbidden",
      error: "Cross-site dashboard actions are not allowed.",
    };
  }
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    return {
      ok: false,
      status: 415,
      code: "unsupported_media_type",
      error: "Dashboard actions require application/json.",
    };
  }
  const contentLength = Number(req.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > ACTION_BODY_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      code: "body_too_large",
      error: `Dashboard action bodies are limited to ${ACTION_BODY_MAX_BYTES} bytes.`,
    };
  }
  return { ok: true };
}

function sameLoopbackOrigin(origin, host) {
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && parsed.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function validateActionBody(action, policy, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new DashboardActionError(
      "Dashboard action body must be a JSON object.",
      400,
      "body_not_object",
    );
  }
  const allowed = new Set(policy.allowedBodyKeys || []);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw new DashboardActionError(
        `Dashboard action body field is not allowed: ${key}.`,
        400,
        "body_field_forbidden",
      );
    }
  }
  if (action === "gap-candidates") {
    for (const key of [
      "apply",
      "model_command",
      "modelCommand",
      "allow_unsafe_command",
      "allowUnsafeCommand",
      "command",
      "checks_command",
    ]) {
      if (Object.hasOwn(body, key)) {
        throw new DashboardActionError(
          `Dashboard gap preview cannot accept ${key}.`,
          400,
          "body_field_forbidden",
        );
      }
    }
  }
}

function normalizeAsi(status, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Log actions require ASI JSON object evidence." };
  }
  const out: LooseObject = {};
  for (const key of ["hypothesis", "evidence", "rollback_reason", "next_action_hint"]) {
    const text = String(value[key] || "").trim();
    if (text) out[key] = text.slice(0, 4000);
  }
  if (status === "keep" && (!out.hypothesis || !out.evidence)) {
    return { ok: false, error: "Keep decisions require ASI hypothesis and evidence." };
  }
  if (status !== "keep" && !out.evidence && !out.rollback_reason) {
    return {
      ok: false,
      error: "Rejected or failed decisions require ASI evidence or rollback_reason.",
    };
  }
  return { ok: true, value: out };
}

async function assertLastRunFingerprint(workDir, submitted) {
  if (!submitted) {
    throw new DashboardActionError(
      "Log actions require the current last-run fingerprint.",
      400,
      "last_run_fingerprint_required",
    );
  }
  const current = await currentLastRunFingerprint(workDir);
  if (!current) {
    throw new DashboardActionError(
      "No last-run packet is available to log.",
      409,
      "last_run_missing",
    );
  }
  if (submitted !== current) {
    throw new DashboardActionError(
      "Last-run packet changed. Refresh the dashboard before logging.",
      409,
      "last_run_stale",
    );
  }
}

async function currentLastRunFingerprint(workDir) {
  const candidates = [];
  const gitPath = await runProcess(
    "git",
    ["rev-parse", "--git-path", "autoresearch/last-run.json"],
    {
      cwd: workDir,
      timeoutSeconds: 5,
      maxOutputBytes: 4096,
    },
  ).catch(() => null);
  if (gitPath?.exitCode === 0 && gitPath.stdout.trim())
    candidates.push(path.resolve(workDir, gitPath.stdout.trim()));
  candidates.push(path.join(workDir, "autoresearch.last-run.json"));
  for (const file of candidates) {
    try {
      const text = await fsp.readFile(file, "utf8");
      return createHash("sha256").update(text).digest("hex");
    } catch {
      // Try the next known location.
    }
  }
  return "";
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

async function readJsonBody(req, maxBytes) {
  let body = "";
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes)
      throw new DashboardActionError(
        `Dashboard action bodies are limited to ${maxBytes} bytes.`,
        413,
        "body_too_large",
      );
    body += chunk.toString("utf8");
  }
  if (!body.trim()) return {};
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new DashboardActionError(
        "Dashboard action body must be a JSON object.",
        400,
        "body_not_object",
      );
    }
    return parsed;
  } catch (error) {
    if (error instanceof DashboardActionError) throw error;
    throw new DashboardActionError(
      `Malformed dashboard action JSON: ${error.message}`,
      400,
      "body_malformed_json",
    );
  }
}

async function runDashboardCliAction(scriptPath, args, cwd, policy) {
  return await runProcess(process.execPath, [scriptPath, ...args], {
    cwd,
    timeoutSeconds: policy.timeoutSeconds || DEFAULT_ACTION_TIMEOUT_SECONDS,
    maxOutputBytes: ACTION_OUTPUT_MAX_BYTES,
  });
}

function actionResultEnvelope(action, cliArgs, result) {
  const ok = result.exitCode === 0 && !result.timedOut;
  const parsed = parseJsonObject(result.stdout);
  const receipt = {
    ok,
    action,
    receiptId: createHash("sha256")
      .update(`${action}:${Date.now()}:${result.commandDisplay}`)
      .digest("hex")
      .slice(0, 16),
    startedAt: new Date(Date.now() - Math.round(result.durationMs || 0)).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: result.durationMs,
    command: [process.execPath, ...cliArgs],
    status: ok ? "completed" : result.timedOut ? "timed_out" : "failed",
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    outputTruncated: result.outputTruncated,
    stdoutSummary: tailText(result.stdout || "", 10, 4096),
    stderrSummary: tailText(result.stderr || "", 10, 4096),
    lastRunCleared: parsed?.lastRunCleared,
    ledgerRun: parsed?.run || null,
    nextStep:
      parsed?.continuation?.nextAction ||
      parsed?.nextAction ||
      (ok ? "Refresh complete." : "Inspect the action output before retrying."),
  };
  return {
    ok,
    action,
    receipt,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.exitCode,
    timedOut: result.timedOut,
  };
}

function actionErrorEnvelope(action, error, code = "dashboard_action_failed", details = null) {
  return {
    ok: false,
    action,
    error,
    code,
    details,
    receipt: {
      ok: false,
      action,
      status: "failed",
      finishedAt: new Date().toISOString(),
      stderrSummary: error,
      nextStep: "Refresh the dashboard state before retrying.",
    },
  };
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(text || "");
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
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
