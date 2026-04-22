import { STATUS_VALUES } from "../constants.js";

export function statusCounts(runs) {
  return Object.fromEntries(STATUS_VALUES.map((status) => [status, runs.filter((run) => run.status === status).length]));
}
