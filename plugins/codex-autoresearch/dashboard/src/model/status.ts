import { STATUS_VALUES } from "../constants";
import type { RunStatus, SessionRun } from "../types";

export function statusCounts(runs: SessionRun[]): Record<RunStatus, number> {
  return Object.fromEntries(
    STATUS_VALUES.map((status) => [status, runs.filter((run) => run.status === status).length]),
  ) as Record<RunStatus, number>;
}
