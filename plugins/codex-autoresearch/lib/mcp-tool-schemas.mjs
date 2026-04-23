import { applyToolContracts } from "./tool-contracts.mjs";
import { resolveResearchSlugForQualityGapSync } from "./research-gaps.mjs";

const MCP_ACTIVE_RESEARCH_SLUG_TOOLS = new Set(["measure_quality_gap", "gap_candidates"]);
const READ_ONLY_COMMAND_MATERIALIZATION_TOOLS = new Set(["setup_plan", "guided_setup"]);

export const toolSchemas = applyToolContracts([
  {
    name: "setup_plan",
    description: "Return a read-only first-run setup readiness plan with missing fields, recipe suggestion, and next commands.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        recipe_id: { type: "string" },
        catalog: { type: "string" },
        name: { type: "string" },
        metric_name: { type: "string" },
        benchmark_command: { type: "string" },
        checks_command: { type: "string" },
        commit_paths: { type: "array", items: { type: "string" } },
        max_iterations: { type: "number" },
        allow_unsafe_command: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "guided_setup",
    description: "Return a guided first-run or resume packet with setup, doctor, baseline, log, and dashboard actions.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        recipe_id: { type: "string" },
        catalog: { type: "string" },
        name: { type: "string" },
        metric_name: { type: "string" },
        benchmark_command: { type: "string" },
        checks_command: { type: "string" },
        commit_paths: { type: "array", items: { type: "string" } },
        max_iterations: { type: "number" },
        allow_unsafe_command: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "list_recipes",
    description: "List built-in and optional catalog recipes.",
    inputSchema: {
      type: "object",
      properties: {
        catalog: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "setup_session",
    description: "Create autoresearch session files from templates and append an initial config header.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        recipe_id: { type: "string" },
        catalog: { type: "string" },
        name: { type: "string" },
        goal: { type: "string" },
        metric_name: { type: "string" },
        metric_unit: { type: "string" },
        direction: { type: "string", enum: ["lower", "higher"] },
        benchmark_command: { type: "string" },
        checks_command: { type: "string" },
        shell: { type: "string", enum: ["bash", "powershell"] },
        files_in_scope: { type: "array", items: { type: "string" } },
        off_limits: { type: "array", items: { type: "string" } },
        constraints: { type: "array", items: { type: "string" } },
        secondary_metrics: { type: "array", items: { type: "string" } },
        commit_paths: { type: "array", items: { type: "string" } },
        max_iterations: { type: "number" },
        autonomy_mode: { type: "string", enum: ["guarded", "owner-autonomous", "manual"] },
        checks_policy: { type: "string", enum: ["always", "on-improvement", "manual"] },
        keep_policy: { type: "string", enum: ["primary-only", "primary-or-risk-reduction"] },
        dashboard_refresh_seconds: { type: "number" },
        overwrite: { type: "boolean" },
        create_checks: { type: "boolean" },
        skip_init: { type: "boolean" },
        allow_unsafe_command: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "setup_research_session",
    description: "Create a deep-research scratchpad and initialize a quality_gap autoresearch session.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        slug: { type: "string" },
        goal: { type: "string" },
        name: { type: "string" },
        checks_command: { type: "string" },
        shell: { type: "string", enum: ["bash", "powershell"] },
        files_in_scope: { type: "array", items: { type: "string" } },
        constraints: { type: "array", items: { type: "string" } },
        commit_paths: { type: "array", items: { type: "string" } },
        max_iterations: { type: "number" },
        autonomy_mode: { type: "string", enum: ["guarded", "owner-autonomous", "manual"] },
        checks_policy: { type: "string", enum: ["always", "on-improvement", "manual"] },
        keep_policy: { type: "string", enum: ["primary-only", "primary-or-risk-reduction"] },
        dashboard_refresh_seconds: { type: "number" },
        overwrite: { type: "boolean" },
        create_checks: { type: "boolean" },
        skip_init: { type: "boolean" },
        allow_unsafe_command: { type: "boolean" },
      },
      required: ["working_dir", "slug", "goal"],
    },
  },
  {
    name: "configure_session",
    description: "Update runtime settings such as autonomy mode, checks policy, keep policy, dashboard refresh, commit paths, or iteration limit.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        autonomy_mode: { type: "string", enum: ["guarded", "owner-autonomous", "manual"] },
        checks_policy: { type: "string", enum: ["always", "on-improvement", "manual"] },
        keep_policy: { type: "string", enum: ["primary-only", "primary-or-risk-reduction"] },
        dashboard_refresh_seconds: { type: "number" },
        max_iterations: { type: "number" },
        extend: { type: "number" },
        commit_paths: { type: "array", items: { type: "string" } },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "init_experiment",
    description: "Append an autoresearch config header to autoresearch.jsonl.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        name: { type: "string" },
        metric_name: { type: "string" },
        metric_unit: { type: "string" },
        direction: { type: "string", enum: ["lower", "higher"] },
      },
      required: ["working_dir", "name", "metric_name"],
    },
  },
  {
    name: "run_experiment",
    description: "Run a timed benchmark command, parse METRIC lines, and optionally run checks.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        command: { type: "string" },
        timeout_seconds: { type: "number" },
        checks_command: { type: "string" },
        checks_timeout_seconds: { type: "number" },
        checks_policy: { type: "string", enum: ["always", "on-improvement", "manual"] },
        allow_unsafe_command: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "next_experiment",
    description: "Run a preflight readout and benchmark in one packet, then return allowed log decisions, an ASI template, and the active-loop continuation contract.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        command: { type: "string" },
        timeout_seconds: { type: "number" },
        checks_command: { type: "string" },
        checks_timeout_seconds: { type: "number" },
        checks_policy: { type: "string", enum: ["always", "on-improvement", "manual"] },
        allow_unsafe_command: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "log_experiment",
    description: "Append an experiment result, keep/commit or discard/revert changes, then return whether the active loop should immediately continue.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        commit: { type: "string" },
        metric: { type: "number" },
        status: { type: "string", enum: ["keep", "discard", "crash", "checks_failed"] },
        description: { type: "string" },
        metrics: { type: "object" },
        asi: { type: "object" },
        commit_paths: { type: "array", items: { type: "string" } },
        revert_paths: { type: "array", items: { type: "string" } },
        allow_add_all: { type: "boolean" },
        allow_dirty_revert: { type: "boolean" },
        from_last: { type: "boolean" },
      },
      required: ["working_dir", "description"],
    },
  },
  {
    name: "read_state",
    description: "Summarize the current autoresearch.jsonl state.",
    inputSchema: {
      type: "object",
      properties: { working_dir: { type: "string" } },
      required: ["working_dir"],
    },
  },
  {
    name: "measure_quality_gap",
    description: "Count open and closed checklist items in autoresearch.research/<slug>/quality-gaps.md.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        research_slug: { type: "string" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "gap_candidates",
    description: "Extract or apply validated deep-research gap candidates from synthesis and optional model command output.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        research_slug: { type: "string" },
        apply: { type: "boolean" },
        model_command: { type: "string" },
        model_timeout_seconds: { type: "number" },
        allow_unsafe_command: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "finalize_preview",
    description: "Return a read-only finalization readiness preview without creating branches.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        trunk: { type: "string" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "integrations",
    description: "List, doctor, or load external integration surfaces such as recipe catalogs and model commands.",
    inputSchema: {
      type: "object",
      properties: {
        subcommand: { type: "string", enum: ["list", "doctor", "sync-recipes"] },
        catalog: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "export_dashboard",
    description: "Write a self-contained fallback HTML snapshot for autoresearch.jsonl.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        output: { type: "string" },
        full: { type: "boolean" },
        json_full: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "serve_dashboard",
    description: "Start a local live dashboard for autoresearch.jsonl and return the operator URL.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        port: { type: "number" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "doctor_session",
    description: "Run a preflight readout for an autoresearch session and optionally verify benchmark metric output.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        command: { type: "string" },
        check_benchmark: { type: "boolean" },
        check_installed: { type: "boolean" },
        timeout_seconds: { type: "number" },
        allow_unsafe_command: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "clear_session",
    description: "Delete autoresearch runtime artifacts after explicit confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        confirm: { type: "boolean" },
        dry_run: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
]);

export const mcpToolSchemas = toolSchemas.map(toMcpToolSchema);

export function validateToolArguments(name, args, options = {}) {
  const schema = toolSchemas.find((tool) => tool.name === name)?.inputSchema;
  if (!schema) throw new Error(`Unknown tool: ${name}`);
  const normalized = normalizeToolArguments(name, args);
  for (const required of schema.required || []) {
    if (normalized[required] == null || normalized[required] === "") throw new Error(`Missing required argument: ${required}`);
  }
  const rejectUnknown = options.rejectUnknown !== false;
  for (const [key, value] of Object.entries(normalized)) {
    const property = schema.properties?.[key];
    if (!property) {
      if (rejectUnknown) throw new Error(`Unknown argument for ${name}: ${key}`);
      continue;
    }
    if (value == null) continue;
    if (property.type === "array" && !Array.isArray(value)) throw new Error(`Argument ${key} must be an array.`);
    if (property.type === "object" && !isObjectArgument(value)) throw new Error(`Argument ${key} must be an object.`);
    if (property.type === "number" && typeof value !== "number") throw new Error(`Argument ${key} must be a number.`);
    if (property.type === "boolean" && typeof value !== "boolean") throw new Error(`Argument ${key} must be a boolean.`);
    if (property.type === "string" && typeof value !== "string") throw new Error(`Argument ${key} must be a string.`);
    if (property.enum && !property.enum.includes(value)) throw new Error(`Argument ${key} must be one of ${property.enum.join(", ")}.`);
  }
  inferMcpResearchSlug(name, normalized);
  return normalized;
}

export function normalizeToolArguments(name, args = {}) {
  const schema = toolSchemas.find((tool) => tool.name === name)?.inputSchema;
  if (!schema) return args || {};
  const aliases = new Map();
  for (const key of Object.keys(schema.properties || {})) {
    aliases.set(key, key);
    aliases.set(toCamel(key), key);
  }
  if (schema.properties?.working_dir) {
    aliases.set("workingDir", "working_dir");
    aliases.set("cwd", "working_dir");
  }
  const normalized = {};
  for (const [key, value] of Object.entries(args || {})) {
    normalized[aliases.get(key) || key] = value;
  }
  return normalized;
}

export function requireUnsafeCommandGate(toolName, args, boolOption = defaultBoolOption) {
  if (READ_ONLY_COMMAND_MATERIALIZATION_TOOLS.has(toolName)) return;
  const normalized = normalizeToolArguments(toolName, args);
  const hasCustomCommand = Boolean(
    normalized.command
      || normalized.benchmark_command
      || normalized.checks_command
      || normalized.model_command
  );
  if (hasCustomCommand && !boolOption(normalized.allow_unsafe_command, false)) {
    throw new Error(`${toolName} custom shell commands require allow_unsafe_command=true over MCP. Prefer a configured autoresearch script when possible.`);
  }
}

function inferMcpResearchSlug(name, normalized) {
  if (!MCP_ACTIVE_RESEARCH_SLUG_TOOLS.has(name)) return;
  if (normalized.research_slug != null && normalized.research_slug !== "") return;
  normalized.research_slug = resolveResearchSlugForQualityGapSync(normalized, normalized.working_dir).slug;
}

function isObjectArgument(value) {
  return typeof value === "object" && !Array.isArray(value);
}

function toMcpToolSchema(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

function toCamel(value) {
  return String(value).replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function defaultBoolOption(value, fallback = false) {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}
