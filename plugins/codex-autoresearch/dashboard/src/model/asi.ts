import type { RunAsi, SessionRun } from "../types";

export function asiText(run: SessionRun | null | undefined, keys: string[], fallback = ""): string {
  if (!run?.asi) return fallback;
  const asi = run.asi as RunAsi;
  for (const key of keys) {
    const value = asi[key];
    if (value != null && String(value).trim()) return String(value).trim();
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
