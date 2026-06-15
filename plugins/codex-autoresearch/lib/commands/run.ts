import {
  buildResourcePreflight,
  resourceBudgetFromConfig,
  type ResourcePreflightStatus,
} from "../process-governor.js";
import type { UnknownRecord } from "../types/json.js";

export function assertRunResourcePreflight({
  command,
  config,
  entries,
}: {
  command: string;
  config: UnknownRecord;
  entries: UnknownRecord[];
}): ResourcePreflightStatus {
  const resourcePreflight = buildResourcePreflight({
    command,
    entries,
    budgets: resourceBudgetFromConfig(config),
  });
  if (!resourcePreflight.canStart) {
    throw new Error(`Resource preflight blocked packet start: ${resourcePreflight.nextAction}`);
  }
  return resourcePreflight;
}

export function buildActiveRunPacketId(nextRun: unknown): string {
  return `packet-${nextRun}-active`;
}
