import type { RunAsi, SessionRun } from "../types";

export function asiText(run: SessionRun | null | undefined, keys: string[], fallback = ""): string {
  if (!run?.asi) return fallback;
  const asi = run.asi as RunAsi;
  for (const key of keys) {
    const value = formatAsiValue(asi[key]);
    if (value) return value;
  }
  return fallback;
}

export function asiPreview(run: SessionRun | null | undefined): string {
  return asiText(
    run,
    ["next_action_hint", "hypothesis", "evidence", "rollback_reason"],
    "No ASI note",
  );
}

export function formatAsiValue(value: unknown, depth = 0): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => formatAsiValue(item, depth + 1))
      .filter(Boolean)
      .join("; ");
  }
  if (typeof value !== "object") return "";
  if (depth > 2) return "";
  return formatAsiObject(value as Record<string, unknown>, depth);
}

function formatAsiObject(value: Record<string, unknown>, depth: number): string {
  const label = firstAsiText(value, ["label", "title", "name", "id"], depth);
  const detail = firstAsiText(
    value,
    ["text", "message", "detail", "summary", "evidence", "reason", "value", "command"],
    depth,
  );
  if (label && detail && label !== detail) return `${label}: ${detail}`;
  if (detail) return detail;
  if (label) return label;
  return Object.entries(value)
    .map(([key, entry]) => {
      const text = formatAsiValue(entry, depth + 1);
      return text ? `${humanizeAsiKey(key)}=${text}` : "";
    })
    .filter(Boolean)
    .slice(0, 6)
    .join(", ");
}

function firstAsiText(value: Record<string, unknown>, keys: string[], depth: number): string {
  for (const key of keys) {
    const text = formatAsiValue(value[key], depth + 1);
    if (text) return text;
  }
  return "";
}

function humanizeAsiKey(value: string): string {
  return value.replace(/[_-]+/g, " ");
}
