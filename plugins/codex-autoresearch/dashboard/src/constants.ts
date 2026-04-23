import type { RunStatus } from "./types";

export const STATUS_VALUES: RunStatus[] = ["keep", "discard", "crash", "checks_failed"];

export const STATUS_LABELS = {
  keep: "Keep",
  discard: "Rejected",
  crash: "Crash",
  checks_failed: "Checks failed",
};

export const TONES = {
  keep: "good",
  discard: "bad",
  crash: "bad",
  checks_failed: "warn",
};

export const LEDGER_ROW_HEIGHT = 82;
export const LEDGER_VISIBLE_ROWS = 16;
