export const STATUS_VALUES = new Set(["keep", "discard", "crash", "checks_failed", "measure"]);
export const FAILURE_STATUSES = new Set(["crash", "checks_failed"]);
export const REJECTED_RUN_STATUSES = new Set(["discard", "crash", "checks_failed"]);
export const NON_METRIC_ELIGIBLE_STATUSES = new Set(["crash", "checks_failed", "measure"]);
export const NON_PROMOTIONAL_STATUSES = NON_METRIC_ELIGIBLE_STATUSES;

export function normalizeRunStatus(status: unknown): string {
  return String(status || "");
}

export function isKeepStatus(status: unknown): boolean {
  return normalizeRunStatus(status) === "keep";
}

export function isRejectedRunStatus(status: unknown): boolean {
  return REJECTED_RUN_STATUSES.has(normalizeRunStatus(status));
}

export function isFailureStatus(status: unknown): boolean {
  return FAILURE_STATUSES.has(normalizeRunStatus(status));
}

export function isMetricEligibleStatus(status: unknown): boolean {
  return !NON_METRIC_ELIGIBLE_STATUSES.has(normalizeRunStatus(status));
}

export function isPromotionalStatus(status: unknown): boolean {
  return isMetricEligibleStatus(status);
}
