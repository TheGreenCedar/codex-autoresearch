import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { runProcess, tailText } from "./runner.js";

type LooseObject = Record<string, any>;
type DashboardActionPolicy = {
  className: string;
  allowedBodyKeys: string[];
  timeoutSeconds?: number;
};
type DashboardActionResult = {
  ok: boolean;
  action: string;
  [key: string]: any;
};
type AsiValidationResult = { ok: true; value: LooseObject } | { ok: false; error: string };

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
const DASHBOARD_ACTIONS = new Map<string, DashboardActionPolicy>([
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
const DASHBOARD_CLI_ACTIONS = new Map<
  string,
  (workDir: string, body: LooseObject) => Promise<string[]> | string[]
>([
  ["doctor", (workDir) => ["doctor", "--cwd", workDir]],
  ["doctor-explain", (workDir) => ["doctor", "--cwd", workDir, "--explain"]],
  ["onboarding-packet", (workDir) => ["onboarding-packet", "--cwd", workDir, "--compact"]],
  ["recommend-next", (workDir) => ["recommend-next", "--cwd", workDir, "--compact"]],
  ["benchmark-lint", (workDir) => ["benchmark-lint", "--cwd", workDir]],
  ["new-segment-dry-run", (workDir) => ["new-segment", "--cwd", workDir, "--dry-run"]],
  ["setup-plan", (workDir) => ["setup-plan", "--cwd", workDir]],
  ["guide", (workDir) => ["guide", "--cwd", workDir]],
  ["recipes", () => ["recipes", "list"]],
  [
    "gap-candidates",
    async (workDir, body) => [
      "gap-candidates",
      "--cwd",
      workDir,
      "--research-slug",
      body.researchSlug || body.slug || (await firstResearchSlug(workDir)) || "research",
    ],
  ],
  ["finalize-preview", (workDir) => ["finalize-preview", "--cwd", workDir]],
  ["export", (workDir) => ["export", "--cwd", workDir]],
]);

export async function serveAutoresearch(args: LooseObject) {
  const workDir = path.resolve(args.working_dir || args.cwd || process.cwd());
  const scriptPath = args.scriptPath;
  const port = Number(args.port || 0);
  const dashboardHtml = args.dashboardHtml;
  const viewModel = args.viewModel;
  const actionsEnabled = Boolean(args.actionsEnabled);
  const actionNonce = randomBytes(32).toString("base64url");
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/") {
        send(
          res,
          200,
          "text/html; charset=utf-8",
          await dashboardHtml({
            actionNonce: actionsEnabled ? actionNonce : undefined,
            actionNonceHeader: actionsEnabled ? "X-Autoresearch-Action-Nonce" : undefined,
          }),
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
        const action = url.pathname.split("/").at(-1) || "";
        try {
          if (!actionsEnabled) {
            sendJson(
              res,
              actionErrorEnvelope(
                action,
                "Live dashboard actions are disabled. Use CLI for actions.",
                "actions_disabled",
              ),
              403,
            );
            return;
          }
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
              actionErrorEnvelope(
                action,
                admission.error || "Dashboard action request was rejected.",
                admission.code || "action_request_invalid",
              ),
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
          const failure = dashboardActionFailure(action, error);
          sendJson(res, failure.body, failure.status);
        }
        return;
      }
      sendJson(res, { ok: false, error: "Not found" }, 404);
    } catch (error) {
      const failure = dashboardActionFailure("dashboard", error);
      sendJson(res, failure.body, failure.status);
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

async function actionArgs(action: string, workDir: string, body: LooseObject): Promise<string[]> {
  const factory = DASHBOARD_CLI_ACTIONS.get(action);
  if (factory) return await factory(workDir, body);
  if (LOG_ACTION_STATUS.has(action)) return logActionArgs(action, workDir, body);
  return [];
}

async function logActionArgs(
  action: string,
  workDir: string,
  body: LooseObject,
): Promise<string[]> {
  const status = LOG_ACTION_STATUS.get(action);
  if (!status) {
    throw new DashboardActionError(`Unsupported log action: ${action}`, 400, "log_action_unknown");
  }
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
    throw new DashboardActionError(
      (asi as { ok: false; error: string }).error,
      400,
      "log_asi_invalid",
    );
  }
  const args: string[] = [
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

  constructor(message: string, statusCode = 400, code = "dashboard_action_invalid") {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function validateActionRequest(req: IncomingMessage, { actionNonce }: { actionNonce: string }) {
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

function sameLoopbackOrigin(origin: string, host: string): boolean {
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && parsed.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function validateActionBody(
  action: string,
  policy: DashboardActionPolicy,
  body: LooseObject,
): void {
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

function normalizeAsi(status: string | undefined, value: unknown): AsiValidationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Log actions require ASI JSON object evidence." };
  }
  const out: LooseObject = {};
  for (const key of ["hypothesis", "evidence", "rollback_reason", "next_action_hint"]) {
    const text = String((value as LooseObject)[key] || "").trim();
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

async function assertLastRunFingerprint(workDir: string, submitted: unknown): Promise<void> {
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

async function currentLastRunFingerprint(workDir: string): Promise<string> {
  const candidates: string[] = [];
  const gitPath = await runProcess(
    "git",
    ["rev-parse", "--git-path", "autoresearch/last-run.json"],
    {
      cwd: workDir,
      timeoutSeconds: 5,
      maxOutputBytes: 4096,
    },
  ).catch((): null => null);
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

async function firstResearchSlug(workDir: string): Promise<string> {
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

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<LooseObject> {
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
    throw new DashboardActionError("Malformed dashboard action JSON.", 400, "body_malformed_json");
  }
}

async function runDashboardCliAction(
  scriptPath: string,
  args: string[],
  cwd: string,
  policy: DashboardActionPolicy,
) {
  return await runProcess(process.execPath, [scriptPath, ...args], {
    cwd,
    timeoutSeconds: policy.timeoutSeconds || DEFAULT_ACTION_TIMEOUT_SECONDS,
    maxOutputBytes: ACTION_OUTPUT_MAX_BYTES,
  });
}

function actionResultEnvelope(
  action: string,
  cliArgs: string[],
  result: LooseObject,
): DashboardActionResult {
  const ok = result.exitCode === 0 && !result.timedOut;
  const parsed = parseJsonObject(result.stdout);
  const stdout = dashboardSafeText(result.stdout || "");
  const stderr = dashboardSafeText(result.stderr || "");
  const parsedNextStep =
    parsed?.continuation?.nextAction ||
    parsed?.nextAction ||
    (ok ? "Refresh complete." : "Inspect the action output before retrying.");
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
    stdoutSummary: tailText(stdout, 10, 4096),
    stderrSummary: tailText(stderr, 10, 4096),
    lastRunCleared: parsed?.lastRunCleared,
    ledgerRun: parsed?.run || null,
    nextStep:
      typeof parsedNextStep === "string" ? dashboardSafeText(parsedNextStep) : parsedNextStep,
  };
  return {
    ok,
    action,
    receipt,
    code: result.exitCode,
    timedOut: result.timedOut,
  };
}

function dashboardActionFailure(
  action: string,
  error: unknown,
): { body: DashboardActionResult; status: number } {
  if (error instanceof DashboardActionError) {
    return {
      body: actionErrorEnvelope(action, dashboardSafeText(error.message), error.code),
      status: error.statusCode,
    };
  }
  return {
    body: actionErrorEnvelope(
      action,
      "Dashboard action failed unexpectedly. Check the server terminal for details.",
      "dashboard_action_failed",
    ),
    status: 500,
  };
}

function actionErrorEnvelope(
  action: string,
  error: string,
  code = "dashboard_action_failed",
  details: LooseObject | null = null,
): DashboardActionResult {
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

function dashboardSafeText(value: unknown): string {
  const text = String(value || "");
  const lines = text.split(/\r?\n/);
  let omitted = 0;
  const safeLines = lines.filter((line) => {
    if (!isStackTraceLine(line)) return true;
    omitted += 1;
    return false;
  });
  if (omitted === 0) return text;
  const suffix = `[${omitted} stack trace line${omitted === 1 ? "" : "s"} omitted]`;
  return [...safeLines, suffix].filter(Boolean).join("\n");
}

function isStackTraceLine(line: string): boolean {
  return /^\s*at\s+\S/.test(line) || /^\s*(?:file|node):.+:\d+:\d+/.test(line);
}

function parseJsonObject(text: string): LooseObject | null {
  try {
    const parsed = JSON.parse(text || "");
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
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
