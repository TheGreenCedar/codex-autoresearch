import type { RunStatus } from "./types";

export const STATUS_VALUES: RunStatus[] = ["keep", "discard", "crash", "checks_failed", "measure"];

export const STATUS_LABELS = {
  keep: "Keep",
  discard: "Rejected",
  crash: "Crash",
  checks_failed: "Checks failed",
  measure: "Measurement",
};

export const TONES = {
  keep: "good",
  discard: "bad",
  crash: "bad",
  checks_failed: "warn",
  measure: "info",
};

export const LEDGER_ROW_HEIGHT = 82;
export const LEDGER_VISIBLE_ROWS = 16;

export const DASHBOARD_VIEWS = ["operate", "audit"] as const;
export type DashboardView = (typeof DASHBOARD_VIEWS)[number];
export const DEFAULT_DASHBOARD_VIEW: DashboardView = "audit";
