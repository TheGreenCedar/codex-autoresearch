import path from "node:path";

import { type UnknownRecord } from "./types/json.js";

const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?token|auth[_-]?token|bearer|client[_-]?secret|credential|credentials|password|secret|token)[A-Za-z0-9_-]*)\b\s*[:=]\s*(?:"[^"\r\n]{8,}"|'[^'\r\n]{8,}'|[^\s"'<>]{8,})/gi;
const SECRET_FLAG =
  /(^|[\s([{:;,])(--(?:api[-_]?key|access[-_]?token|auth[-_]?token|bearer|client[-_]?secret|password|secret|token|credential|credentials))(?:(=)\s*|\s+)(?:"[^"\r\n]{8,}"|'[^'\r\n]{8,}'|(?!--)[^\s"'<>]{8,})/gi;
const SECRET_PHRASE =
  /\b(api\s+key|access\s+token|auth\s+token|bearer|client\s+secret|password|secret|token)\s+([A-Za-z0-9._~+/\-=]{8,})/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/\-=]{12,}/gi;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;
const WINDOWS_HOME = /[A-Za-z]:\\Users\\[^\\\s"'<>]+/g;
const WINDOWS_HOME_SLASH = /[A-Za-z]:\/Users\/[^/\s"'<>]+/g;
const UNC_PATH = /\\\\[^\\\s"'<>]+\\[^\\\s"'<>]+(?:\\[^\\\s"'<>]+)*/g;
const POSIX_HOME = /\/(?:Users|home)\/[^/\s"'<>]+/g;
const NODE_STACK_FRAME =
  /^([ \t]*)at\s+.*(?:\((?:file:\/\/)?(?:[A-Za-z]:\\|\/)[^)]+:\d+:\d+\)|(?:file:\/\/)?(?:[A-Za-z]:\\|\/)\S+:\d+:\d+).*$/gm;
const PYTHON_STACK_FRAME = /^([ \t]*)File\s+["'].*["'],\s+line\s+\d+,\s+in\s+.*$/gm;
const TOKEN = /[^\s"'<>|]+/g;
const TRAILING_ENV_TOKEN_PUNCTUATION = new Set([")", ",", ".", ";", ":"]);
const SENSITIVE_VALUE_KEYS = new Set([
  "apikey",
  "accesstoken",
  "authtoken",
  "authorization",
  "bearer",
  "clientsecret",
  "credential",
  "credentials",
  "password",
  "secret",
  "secrets",
  "token",
]);

export function redactEvidenceObject<T = unknown>(value: T, context: UnknownRecord = {}): T {
  if (isSensitiveEvidenceKey(context.key) && value != null && value !== "") {
    return "<redacted>" as T;
  }
  if (typeof value === "string") return redactEvidenceText(value, context) as T;
  if (Array.isArray(value)) return value.map((item) => redactEvidenceObject(item, context)) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as UnknownRecord).map(([key, child]) => [
      key,
      redactEvidenceObject(child, { ...context, key }),
    ]),
  ) as T;
}

export function redactEvidenceText(value: unknown, context: UnknownRecord = {}): string {
  let text = String(value || "");
  text = text.replace(URL_CREDENTIALS, "$1<credentials>@");
  text = text.replace(SECRET_ASSIGNMENT, (_match, key) => `${key}=<redacted>`);
  text = text.replace(
    SECRET_FLAG,
    (_match, prefix, flag, equals) => `${prefix}${flag}${equals ? "=" : " "}<redacted>`,
  );
  text = text.replace(BEARER_TOKEN, "Bearer <redacted>");
  text = text.replace(SECRET_PHRASE, (_match, key) => `${key} <redacted>`);
  text = redactEnvFileTokens(text);
  text = redactStackTraceFrames(text);
  text = redactScopedWorkDir(text, context.workDir);
  text = text.replace(UNC_PATH, "<network-path>");
  text = text.replace(WINDOWS_HOME, "C:\\Users\\<user>");
  text = text.replace(WINDOWS_HOME_SLASH, "C:/Users/<user>");
  text = text.replace(POSIX_HOME, (match) =>
    match.startsWith("/Users/") ? "/Users/<user>" : "/home/<user>",
  );
  return text;
}

function redactScopedWorkDir(text: string, workDir: unknown): string {
  const raw = String(workDir || "").trim();
  if (raw.length <= 3) return text;
  const variants = new Set([raw, raw.replace(/\\/g, "/"), raw.replace(/\//g, "\\")]);
  if (path.isAbsolute(raw)) {
    const resolved = path.resolve(raw);
    variants.add(resolved);
    variants.add(resolved.replace(/\\/g, "/"));
    variants.add(resolved.replace(/\//g, "\\"));
  }
  for (const variant of [...variants].sort((a, b) => b.length - a.length)) {
    if (variant.length > 3) text = text.split(variant).join("<workdir>");
  }
  return text;
}

function redactStackTraceFrames(text: string): string {
  return text
    .replace(NODE_STACK_FRAME, (_match, indent) => `${indent}at <stack-frame>`)
    .replace(PYTHON_STACK_FRAME, (_match, indent) => `${indent}File "<stack-frame>"`);
}

function redactEnvFileTokens(text: string): string {
  return text.replace(TOKEN, (token) => {
    const { core, suffix } = splitTrailingEnvTokenPunctuation(token);
    return isEnvFileToken(core) ? `<env-file>${suffix}` : token;
  });
}

function splitTrailingEnvTokenPunctuation(token: string): { core: string; suffix: string } {
  let end = token.length;
  while (end > 0 && TRAILING_ENV_TOKEN_PUNCTUATION.has(token[end - 1] || "")) {
    end -= 1;
  }
  return { core: token.slice(0, end), suffix: token.slice(end) };
}

function isEnvFileToken(token: string): boolean {
  const normalized = token.replace(/\\/g, "/");
  return /(^|[=/])\.env(\.[A-Za-z0-9_-]+)?$/.test(normalized);
}

function isSensitiveEvidenceKey(key: unknown): boolean {
  const normalized = String(key || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return (
    SENSITIVE_VALUE_KEYS.has(normalized) ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret")
  );
}

export function redactCommandDisplay(value: unknown, context: UnknownRecord = {}): string {
  return redactEvidenceText(value, context);
}

export function redactPathDisplay(value: unknown, workDir = ""): string {
  const text = String(value || "");
  if (!text) return "";
  const resolved = path.isAbsolute(text) ? text : path.resolve(workDir || process.cwd(), text);
  const relative = workDir ? path.relative(workDir, resolved) : "";
  if (workDir && relative === "") return ".";
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.replace(/\\/g, "/");
  }
  return redactEvidenceText("<outside-workdir>");
}
