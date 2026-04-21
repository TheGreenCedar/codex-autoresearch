import { applyToolContracts } from "./tool-contracts.mjs";

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
      required: ["working_dir", "research_slug"],
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
        allow_unsafe_command: { type: "boolean" },
      },
      required: ["working_dir", "research_slug"],
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
    description: "Write a self-contained HTML dashboard for autoresearch.jsonl.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        output: { type: "string" },
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
      },
      required: ["working_dir", "confirm"],
    },
  },
]);

export const mcpToolSchemas = toolSchemas.map(toMcpToolSchema);

export function createMcpInterface(deps) {
  const requireUnsafeCommandGate = (toolName, args) => {
    const hasCustomCommand = Boolean(args.command || args.checks_command || args.checksCommand || args.model_command || args.modelCommand);
    if (hasCustomCommand && !deps.boolOption(args.allow_unsafe_command ?? args.allowUnsafeCommand, false)) {
      throw new Error(`${toolName} custom shell commands require allow_unsafe_command=true over MCP. Prefer a configured autoresearch script when possible.`);
    }
  };

  const callTool = async (name, args) => {
    if (name === "setup_plan") return await deps.setupPlan(args);
    if (name === "guided_setup") return await deps.guidedSetup(args);
    if (name === "list_recipes") return await deps.recipeCommand("list", args);
    if (name === "setup_session") return await deps.setupSession(args);
    if (name === "setup_research_session") return await deps.setupResearchSession(args);
    if (name === "configure_session") return await deps.configureSession(args);
    if (name === "init_experiment") return await deps.initExperiment(args);
    if (name === "run_experiment") {
      requireUnsafeCommandGate(name, args);
      return await deps.runExperiment(args);
    }
    if (name === "next_experiment") {
      requireUnsafeCommandGate(name, args);
      return await deps.nextExperiment(args);
    }
    if (name === "log_experiment") return await deps.logExperiment({
      ...args,
      metrics: deps.parseJsonOption(args.metrics, null),
      asi: deps.parseJsonOption(args.asi, null),
    });
    if (name === "export_dashboard") return await deps.exportDashboard(args);
    if (name === "clear_session") return await deps.clearSession(args);
    if (name === "read_state") return deps.publicState(args);
    if (name === "measure_quality_gap") return await deps.measureQualityGap(args);
    if (name === "gap_candidates") {
      requireUnsafeCommandGate(name, args);
      return await deps.gapCandidates(args);
    }
    if (name === "finalize_preview") return await deps.finalizePreview(args);
    if (name === "integrations") return await deps.integrationsCommand(args.subcommand || "list", args);
    if (name === "doctor_session") {
      requireUnsafeCommandGate(name, args);
      return await deps.doctorSession(args);
    }
    throw new Error(`Unknown tool: ${name}`);
  };

  return {
    callTool,
    toolSchemas: mcpToolSchemas,
    validateToolArguments,
  };
}

export function validateToolArguments(name, args) {
  const schema = toolSchemas.find((tool) => tool.name === name)?.inputSchema;
  if (!schema) throw new Error(`Unknown tool: ${name}`);
  for (const required of schema.required || []) {
    if (args[required] == null || args[required] === "") throw new Error(`Missing required argument: ${required}`);
  }
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties?.[key];
    if (!property || value == null) continue;
    if (property.type === "array" && !Array.isArray(value)) throw new Error(`Argument ${key} must be an array.`);
    if (property.type === "object" && !isObjectArgument(value)) throw new Error(`Argument ${key} must be an object.`);
    if (property.type === "number" && typeof value !== "number") throw new Error(`Argument ${key} must be a number.`);
    if (property.type === "boolean" && typeof value !== "boolean") throw new Error(`Argument ${key} must be a boolean.`);
    if (property.type === "string" && typeof value !== "string") throw new Error(`Argument ${key} must be a string.`);
    if (property.enum && !property.enum.includes(value)) throw new Error(`Argument ${key} must be one of ${property.enum.join(", ")}.`);
  }
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
