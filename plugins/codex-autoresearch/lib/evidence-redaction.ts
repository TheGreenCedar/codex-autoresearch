import path from "node:path";

type LooseObject = Record<string, any>;

const SECRET_ASSIGNMENT =
  /\b(api[_-]?key|access[_-]?token|auth[_-]?token|bearer|client[_-]?secret|password|secret|token)\b\s*[:=]\s*["']?([A-Za-z0-9._~+/\-=]{8,})["']?/gi;
const SECRET_PHRASE =
  /\b(api\s+key|access\s+token|auth\s+token|bearer|client\s+secret|password|secret|token)\s+([A-Za-z0-9._~+/\-=]{8,})/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/\-=]{12,}/gi;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;
const WINDOWS_HOME = /[A-Za-z]:\\Users\\[^\\\s"'<>]+/g;
const POSIX_HOME = /\/(?:Users|home)\/[^/\s"'<>]+/g;
const ENV_FILE_PATH =
  /(?:[A-Za-z]:\\|\/|\.{1,2}[\\/])(?:[^\s"'<>|]+[\\/])*\.?env(?:\.[A-Za-z0-9_-]+)?/gi;

export function redactEvidenceObject<T = unknown>(value: T, context: LooseObject = {}): T {
  if (typeof value === "string") return redactEvidenceText(value, context) as T;
  if (Array.isArray(value)) return value.map((item) => redactEvidenceObject(item, context)) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as LooseObject).map(([key, child]) => [
      key,
      redactEvidenceObject(child, { ...context, key }),
    ]),
  ) as T;
}

export function redactEvidenceText(value: unknown, context: LooseObject = {}): string {
  let text = String(value || "");
  text = text.replace(URL_CREDENTIALS, "$1<credentials>@");
  text = text.replace(SECRET_ASSIGNMENT, (_match, key) => `${key}=<redacted>`);
  text = text.replace(BEARER_TOKEN, "Bearer <redacted>");
  text = text.replace(SECRET_PHRASE, (_match, key) => `${key} <redacted>`);
  text = text.replace(ENV_FILE_PATH, "<env-file>");
  text = text.replace(WINDOWS_HOME, "C:\\Users\\<user>");
  text = text.replace(POSIX_HOME, (match) =>
    match.startsWith("/Users/") ? "/Users/<user>" : "/home/<user>",
  );
  if (context.workDir) {
    text = text.split(String(context.workDir)).join("<workdir>");
  }
  return text;
}

export function redactCommandDisplay(value: unknown, context: LooseObject = {}): string {
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
