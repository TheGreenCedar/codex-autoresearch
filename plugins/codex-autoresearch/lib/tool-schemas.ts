import {
  commandTable,
  validateToolArguments as validateCommandArguments,
  type ToolArgs,
} from "./command-table.js";
import { resolveResearchSlugForQualityGapSync } from "./research-gaps.js";
import { applyToolContracts } from "./tool-contracts.js";

export {
  normalizeCliCommandArguments,
  normalizeRuntimeToolArguments,
  normalizeToolArguments,
  requireUnsafeCommandGate,
} from "./command-table.js";

export const toolSchemas = applyToolContracts(
  commandTable.map(({ description, inputSchema, name }) => ({
    name,
    description,
    inputSchema,
  })),
);

const ACTIVE_RESEARCH_SLUG_TOOLS = new Set(["measure_quality_gap", "gap_candidates"]);

export function validateToolArguments(name: string, args: ToolArgs = {}, options: ToolArgs = {}) {
  const normalized = validateCommandArguments(name, args, options);
  if (
    ACTIVE_RESEARCH_SLUG_TOOLS.has(name) &&
    (normalized.research_slug == null || normalized.research_slug === "")
  ) {
    normalized.research_slug = resolveResearchSlugForQualityGapSync(
      normalized,
      String(normalized.working_dir || ""),
    ).slug;
  }
  return normalized;
}
