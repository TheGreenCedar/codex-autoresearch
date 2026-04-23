import type { DashboardEntry, DashboardViewModel } from "../types";

export function parseJsonl(text: string): DashboardEntry[] {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DashboardEntry);
}

export function parseJsonObject(text: string): DashboardViewModel {
  if (!String(text || "").trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as DashboardViewModel)
      : {};
  } catch {
    return {};
  }
}
