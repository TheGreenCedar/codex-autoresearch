import { applyToolContracts } from "./tool-contracts.js";
import { resolveResearchSlugForQualityGapSync } from "./research-gaps.js";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type ToolArgs = Record<string, JsonValue | undefined>;
type JsonSchema = {
  type?: string | string[];
  enum?: JsonValue[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
};
const ACTIVE_RESEARCH_SLUG_TOOLS = new Set(["measure_quality_gap", "gap_candidates"]);

const LOOP_INTENT_PROPERTIES = {
  name: { type: "string" },
  goal: { type: "string" },
  metric_name: { type: "string" },
  metric_unit: { type: "string" },
  direction: { type: "string", enum: ["lower", "higher"] },
  benchmark_command: { type: "string" },
  benchmark_prints_metric: { type: "boolean" },
  checks_command: { type: "string" },
  files_in_scope: { type: "array", items: { type: "string" } },
  off_limits: { type: "array", items: { type: "string" } },
  constraints: { type: "array", items: { type: "string" } },
  secondary_metrics: { type: "array", items: { type: "string" } },
  commit_paths: { type: "array", items: { type: "string" } },
  max_iterations: { type: "integer" },
} satisfies Record<string, JsonSchema>;

const SETUP_SOURCE_PROPERTIES = {
  recipe_id: { type: "string" },
  catalog: { type: "string" },
  trust_catalog: { type: "boolean" },
} satisfies Record<string, JsonSchema>;

const UNSAFE_COMMAND_PROPERTY = {
  allow_unsafe_command: { type: "boolean" },
} satisfies Record<string, JsonSchema>;

export const toolSchemas = applyToolContracts([
  {
    name: "setup_plan",
    description:
      "Return a read-only first-run setup readiness plan with missing fields, recipe suggestion, and next commands.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        ...SETUP_SOURCE_PROPERTIES,
        ...LOOP_INTENT_PROPERTIES,
        ...UNSAFE_COMMAND_PROPERTY,
      },
      required: ["working_dir"],
    },
  },
  {
    name: "guided_setup",
    description:
      "Return a guided first-run or resume packet with setup, doctor, baseline, log, and dashboard readout guidance.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        ...SETUP_SOURCE_PROPERTIES,
        ...LOOP_INTENT_PROPERTIES,
        start_dashboard: { type: "boolean" },
        port: { type: "number" },
        dashboard_refresh_seconds: { type: "number" },
        ...UNSAFE_COMMAND_PROPERTY,
      },
      required: ["working_dir"],
    },
  },
  {
    name: "prompt_plan",
    description:
      "Convert a natural-language Autoresearch request into inferred loop intent, missing essentials, setup defaults, and first safe commands.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        prompt: { type: "string" },
        ...SETUP_SOURCE_PROPERTIES,
        ...LOOP_INTENT_PROPERTIES,
        ...UNSAFE_COMMAND_PROPERTY,
      },
      required: ["working_dir", "prompt"],
    },
  },
  {
    name: "onboarding_packet",
    description:
      "Return a compact human-and-agent onboarding packet with state, hazards, report templates, and next commands.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        compact: { type: "boolean" },
        operator_checklist: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "recommend_next",
    description:
      "Return the single safest next action with why-it-is-safe evidence and copyable commands.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        compact: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "codex_goal_bridge",
    description:
      "Return a Codex Goal objective draft and evidence audit from Autoresearch state without mutating Codex Goal state.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        codex_goal_objective: { type: "string" },
        codex_goal_status: {
          type: "string",
          enum: ["active", "paused", "budget_limited", "complete", "unknown"],
        },
        codex_goal_token_budget: { type: "integer" },
        codex_goal_tokens_used: { type: "integer" },
        codex_goal_time_used_seconds: { type: "integer" },
        completion_evidence: { type: "string" },
        completion_confirmed: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "session_forensics",
    description:
      "Parse a Codex rollout JSONL into bounded session counts, waste signals, and optional safe context-capsule artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        session_jsonl: { type: "string" },
        research_slug: { type: "string" },
        dry_run: { type: "boolean" },
        apply: { type: "boolean" },
        allow_snippets: { type: "boolean" },
        allow_outside_workdir: { type: "boolean" },
        max_snippets: { type: "integer" },
        max_snippet_chars: { type: "integer" },
      },
      required: ["working_dir", "session_jsonl", "research_slug"],
    },
  },
  {
    name: "list_recipes",
    description: "List or recommend built-in and optional catalog benchmark recipes.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        catalog: { type: "string" },
        recommend: { type: "boolean" },
      },
      required: [],
    },
  },
  {
    name: "setup_session",
    description:
      "Create autoresearch session files from templates and append an initial config header.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        recipe_id: { type: "string" },
        catalog: { type: "string" },
        trust_catalog: { type: "boolean" },
        name: { type: "string" },
        goal: { type: "string" },
        metric_name: { type: "string" },
        metric_unit: { type: "string" },
        direction: { type: "string", enum: ["lower", "higher"] },
        benchmark_command: { type: "string" },
        benchmark_prints_metric: { type: "boolean" },
        checks_command: { type: "string" },
        shell: { type: "string", enum: ["bash", "powershell"] },
        files_in_scope: { type: "array", items: { type: "string" } },
        off_limits: { type: "array", items: { type: "string" } },
        constraints: { type: "array", items: { type: "string" } },
        secondary_metrics: { type: "array", items: { type: "string" } },
        commit_paths: { type: "array", items: { type: "string" } },
        max_iterations: { type: "integer" },
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
    description:
      "Create a deep-research scratchpad and initialize a quality_gap autoresearch session.",
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
        max_iterations: { type: "integer" },
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
    name: "research_fanout",
    description:
      "Create a generic parallel research lane plan from current session memory without mutating source files unless --yes is passed.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        lanes: { type: "integer" },
        lane_count: { type: "integer" },
        dry_run: { type: "boolean" },
        yes: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "lane_runner",
    description:
      "Run or record one coordinated research lane with conservative isolation and a single synthesized next packet recommendation.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        lane_id: { type: "string" },
        lane: { type: "string" },
        mode: { type: "string", enum: ["read_only_scout", "implementation"] },
        command: { type: "string" },
        worktree: { type: "string" },
        worktree_path: { type: "string" },
        write_scope: { type: "array", items: { type: "string" } },
        commit_paths: { type: "array", items: { type: "string" } },
        result_status: { type: "string", enum: ["completed", "blocked", "failed", "planned"] },
        summary: { type: "string" },
        recommendation: { type: "string" },
        next_action: { type: "string" },
        time_budget_seconds: { type: "integer" },
        timeout_seconds: { type: "integer" },
        dry_run: { type: "boolean" },
        yes: { type: "boolean" },
        allow_non_git_command: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "configure_session",
    description:
      "Update runtime settings such as autonomy mode, checks policy, keep policy, dashboard refresh, commit paths, or iteration limit.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        autonomy_mode: { type: "string", enum: ["guarded", "owner-autonomous", "manual"] },
        checks_policy: { type: "string", enum: ["always", "on-improvement", "manual"] },
        keep_policy: { type: "string", enum: ["primary-only", "primary-or-risk-reduction"] },
        dashboard_refresh_seconds: { type: "number" },
        max_iterations: { type: "integer" },
        extend: { type: "integer" },
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
        goal: { type: "string" },
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
        command_file: { type: "string" },
        env_file: { type: "string" },
        packet_env_file: { type: "string" },
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
    description:
      "Run a preflight readout and benchmark in one packet, then return allowed log decisions, an ASI template, and the active-loop continuation contract.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        command: { type: "string" },
        command_file: { type: "string" },
        env_file: { type: "string" },
        packet_env_file: { type: "string" },
        timeout_seconds: { type: "number" },
        checks_command: { type: "string" },
        checks_timeout_seconds: { type: "number" },
        checks_policy: { type: "string", enum: ["always", "on-improvement", "manual"] },
        compact: { type: "boolean" },
        allow_unsafe_command: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "partial_results",
    description:
      "Inspect or record diagnostic-only partial-result rows from a crashed or timed-out last-run artifact.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        from_last: { type: "boolean" },
        artifact: { type: "string" },
        record: { type: "string" },
        research_slug: { type: "string" },
        command_hash: { type: "string" },
        description: { type: "string" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "log_experiment",
    description:
      "Append an experiment result, keep/commit or discard/revert changes, then return whether the active loop should immediately continue.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        commit: { type: "string" },
        metric: { type: "number" },
        status: {
          type: "string",
          enum: ["keep", "discard", "crash", "checks_failed", "measure"],
        },
        description: { type: "string" },
        metrics: { type: "object" },
        metrics_file: { type: "string" },
        asi: { type: "object" },
        asi_json_file: { type: "string" },
        asi_file: { type: "string" },
        evidence_status: {
          type: "string",
          enum: ["accepted", "rejected", "provisional", "superseded"],
        },
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
      properties: {
        working_dir: { type: "string" },
        compact: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "measure_quality_gap",
    description:
      "Count open and closed checklist items in autoresearch.research/<slug>/quality-gaps.md.",
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
    description:
      "Extract or apply validated deep-research gap candidates from synthesis and optional model command output.",
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
    name: "finalize_current_tree",
    description:
      "Write a current-final-tree finalization plan that covers the current non-session branch diff.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        trunk: { type: "string" },
        exclude_session_artifacts: { type: "boolean" },
        include_session_artifacts: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "integrations",
    description:
      "List, doctor, or load external integration surfaces such as recipe catalogs and model commands.",
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
    name: "benchmark_inspect",
    description:
      "Safely inspect a benchmark list, dry-run, sample, or artifact command before running an expensive packet.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        command: { type: "string" },
        timeout_seconds: { type: "number" },
        allow_unsafe_command: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "benchmark_lint",
    description:
      "Validate sample benchmark output or a command for METRIC parsing without starting an experiment.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        metric_name: { type: "string" },
        sample: { type: "string" },
        command: { type: "string" },
        timeout_seconds: { type: "number" },
        allow_unsafe_command: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "checks_inspect",
    description:
      "Run and classify a correctness-check command before treating failures as experiment evidence.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        command: { type: "string" },
        checks_command: { type: "string" },
        timeout_seconds: { type: "number" },
        allow_unsafe_command: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "new_segment",
    description:
      "Start a fresh run segment while preserving old ledger history; requires confirmation unless dry-run.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        reason: { type: "string" },
        dry_run: { type: "boolean" },
        confirm: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "promote_gate",
    description:
      "Append or preview a promoted measurement gate as a fresh segment with gate metadata.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        reason: { type: "string" },
        gate_name: { type: "string" },
        query_count: { type: "integer" },
        benchmark_command: { type: "string" },
        checks_command: { type: "string" },
        notes: { type: "array", items: { type: "string" } },
        dry_run: { type: "boolean" },
        confirm: { type: "boolean" },
        allow_unsafe_command: { type: "boolean" },
      },
      required: ["working_dir", "reason"],
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
    description:
      "Run a preflight readout for an autoresearch session and optionally verify benchmark metric output.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        command: { type: "string" },
        check_benchmark: { type: "boolean" },
        check_installed: { type: "boolean" },
        explain: { type: "boolean" },
        hooks: { type: "boolean" },
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

const CLI_COMMAND_TO_TOOL: Record<string, string> = {
  setup: "setup_session",
  "setup-plan": "setup_plan",
  guide: "guided_setup",
  "prompt-plan": "prompt_plan",
  "onboarding-packet": "onboarding_packet",
  "recommend-next": "recommend_next",
  "codex-goal-brief": "codex_goal_bridge",
  "session-forensics": "session_forensics",
  recipes: "list_recipes",
  "research-setup": "setup_research_session",
  "research-fanout": "research_fanout",
  "lane-runner": "lane_runner",
  config: "configure_session",
  "quality-gap": "measure_quality_gap",
  "gap-candidates": "gap_candidates",
  "finalize-preview": "finalize_preview",
  "finalize-current-tree": "finalize_current_tree",
  integrations: "integrations",
  init: "init_experiment",
  run: "run_experiment",
  next: "next_experiment",
  "partial-results": "partial_results",
  log: "log_experiment",
  state: "read_state",
  doctor: "doctor_session",
  "benchmark-lint": "benchmark_lint",
  "benchmark-inspect": "benchmark_inspect",
  "checks-inspect": "checks_inspect",
  "new-segment": "new_segment",
  "promote-gate": "promote_gate",
  export: "export_dashboard",
  serve: "serve_dashboard",
  clear: "clear_session",
};

const RUNTIME_ARG_ALIASES: Record<string, string> = {
  allow_add_all: "allowAddAll",
  allow_non_git_command: "allowNonGitCommand",
  allow_outside_workdir: "allowOutsideWorkdir",
  allow_dirty_revert: "allowDirtyRevert",
  allow_snippets: "allowSnippets",
  asi_json_file: "asiJsonFile",
  asi_file: "asiFile",
  autonomy_mode: "autonomyMode",
  benchmark_command: "benchmarkCommand",
  benchmark_prints_metric: "benchmarkPrintsMetric",
  check_benchmark: "checkBenchmark",
  check_installed: "checkInstalled",
  checks_command: "checksCommand",
  checks_policy: "checksPolicy",
  checks_timeout_seconds: "checksTimeoutSeconds",
  codex_goal_objective: "codexGoalObjective",
  codex_goal_status: "codexGoalStatus",
  codex_goal_time_used_seconds: "codexGoalTimeUsedSeconds",
  codex_goal_token_budget: "codexGoalTokenBudget",
  codex_goal_tokens_used: "codexGoalTokensUsed",
  command_file: "commandFile",
  completion_confirmed: "completionConfirmed",
  completion_evidence: "completionEvidence",
  commit_paths: "commitPaths",
  create_checks: "createChecks",
  dashboard_refresh_seconds: "dashboardRefreshSeconds",
  dry_run: "dryRun",
  env_file: "envFile",
  exclude_session_artifacts: "excludeSessionArtifacts",
  include_session_artifacts: "includeSessionArtifacts",
  files_in_scope: "filesInScope",
  from_last: "fromLast",
  gate_name: "gateName",
  evidence_status: "evidenceStatus",
  json_full: "jsonFull",
  keep_policy: "keepPolicy",
  lane_id: "laneId",
  lane_count: "laneCount",
  max_iterations: "maxIterations",
  metrics_file: "metricsFile",
  max_snippet_chars: "maxSnippetChars",
  max_snippets: "maxSnippets",
  metric_name: "metricName",
  metric_unit: "metricUnit",
  model_command: "modelCommand",
  model_timeout_seconds: "modelTimeoutSeconds",
  off_limits: "offLimits",
  operator_checklist: "operatorChecklist",
  packet_env_file: "packetEnvFile",
  query_count: "queryCount",
  recipe_id: "recipeId",
  research_slug: "researchSlug",
  session_jsonl: "sessionJsonl",
  revert_paths: "revertPaths",
  secondary_metrics: "secondaryMetrics",
  result_status: "resultStatus",
  skip_init: "skipInit",
  start_dashboard: "startDashboard",
  timeout_seconds: "timeoutSeconds",
  time_budget_seconds: "timeBudgetSeconds",
  trust_catalog: "trustCatalog",
  worktree_path: "worktreePath",
  working_dir: "cwd",
  write_scope: "writeScope",
};

export function validateToolArguments(name: string, args: ToolArgs = {}, options: ToolArgs = {}) {
  const schema = schemaForTool(name);
  if (!schema) throw new Error(`Unknown tool: ${name}`);
  const normalized = normalizeToolArguments(name, args);
  for (const required of schema.required || []) {
    if (missingArgumentValue(normalized[required]))
      throw new Error(`Missing required argument: ${required}`);
  }
  const rejectUnknown = options.rejectUnknown !== false;
  for (const [key, value] of Object.entries(normalized)) {
    const property = schema.properties?.[key];
    if (!property) {
      if (rejectUnknown) throw new Error(`Unknown argument for ${name}: ${key}`);
      continue;
    }
    if (value == null) continue;
    assertSchemaArgument(key, value, property);
  }
  inferActiveResearchSlug(name, normalized);
  return normalized;
}

export function normalizeToolArguments(name: string, args: ToolArgs = {}): ToolArgs {
  const schema = schemaForTool(name);
  if (!schema) return args || {};
  const aliases = aliasesForSchema(schema);

  const normalized: ToolArgs = {};
  for (const [key, value] of Object.entries(args || {})) {
    normalized[aliases.get(key) || key] = value as JsonValue;
  }
  return normalized;
}

export function normalizeRuntimeToolArguments(name: string, args: ToolArgs = {}): ToolArgs {
  const normalized = normalizeToolArguments(name, args);
  const runtime: ToolArgs = {};
  for (const [key, value] of Object.entries(normalized)) {
    runtime[RUNTIME_ARG_ALIASES[key] || key] = value;
  }
  return runtime;
}

export function normalizeCliCommandArguments(command: string, args: ToolArgs = {}): ToolArgs {
  const toolName = CLI_COMMAND_TO_TOOL[command];
  if (!toolName) return args || {};
  return normalizeRuntimeToolArguments(toolName, args);
}

export function requireUnsafeCommandGate(
  toolName: string,
  args: ToolArgs = {},
  boolOption = defaultBoolOption,
) {
  const schema = schemaForTool(toolName);
  const normalized: ToolArgs = schema ? normalizeToolArguments(toolName, args) : args || {};
  const setupCatalogCanMaterializeCommands =
    (toolName === "setup_plan" ||
      toolName === "guided_setup" ||
      toolName === "prompt_plan" ||
      toolName === "setup_session") &&
    Boolean(normalized.catalog);
  const hasCustomCommand = Boolean(
    normalized.command ||
    normalized.command_file ||
    normalized.env_file ||
    normalized.packet_env_file ||
    normalized.benchmark_command ||
    normalized.checks_command ||
    normalized.model_command ||
    setupCatalogCanMaterializeCommands,
  );
  if (hasCustomCommand && !boolOption(normalized.allow_unsafe_command, false)) {
    throw new Error(
      `${toolName} custom shell commands require allow_unsafe_command=true. Prefer a configured autoresearch script when possible.`,
    );
  }
}

function schemaForTool(name: string): JsonSchema | null {
  return toolSchemas.find((tool) => tool.name === name)?.inputSchema || null;
}

function aliasesForSchema(schema: JsonSchema) {
  const aliases = new Map<string, string>();
  for (const key of Object.keys(schema.properties || {})) {
    aliases.set(key, key);
    aliases.set(toCamel(key), key);
  }
  if (schema.properties?.working_dir) {
    aliases.set("workingDir", "working_dir");
    aliases.set("cwd", "working_dir");
  }
  if (schema.properties?.recipe_id) aliases.set("recipe", "recipe_id");
  if (schema.properties?.research_slug) aliases.set("slug", "research_slug");
  if (schema.properties?.confirm) aliases.set("yes", "confirm");
  if (schema.properties?.json_full) aliases.set("full", "json_full");
  return aliases;
}

function inferActiveResearchSlug(name: string, normalized: ToolArgs) {
  if (!ACTIVE_RESEARCH_SLUG_TOOLS.has(name)) return;
  if (normalized.research_slug != null && normalized.research_slug !== "") return;
  normalized.research_slug = resolveResearchSlugForQualityGapSync(
    normalized,
    String(normalized.working_dir || ""),
  ).slug;
}

function missingArgumentValue(value: unknown) {
  return value == null || value === "";
}

function assertSchemaArgument(key: string, value: unknown, property: Record<string, any>) {
  if (property.type === "array" && !Array.isArray(value))
    throw new Error(`Argument ${key} must be an array.`);
  if (property.type === "object" && !isObjectArgument(value))
    throw new Error(`Argument ${key} must be an object.`);
  if (property.type === "number" && typeof value !== "number")
    throw new Error(`Argument ${key} must be a number.`);
  if (property.type === "integer" && (typeof value !== "number" || !Number.isInteger(value)))
    throw new Error(`Argument ${key} must be an integer.`);
  if (property.type === "boolean" && typeof value !== "boolean")
    throw new Error(`Argument ${key} must be a boolean.`);
  if (property.type === "string" && typeof value !== "string")
    throw new Error(`Argument ${key} must be a string.`);
  if (property.enum && !property.enum.includes(value))
    throw new Error(`Argument ${key} must be one of ${property.enum.join(", ")}.`);
}

function isObjectArgument(value: unknown) {
  return typeof value === "object" && !Array.isArray(value);
}

function toCamel(value: string) {
  return String(value).replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function defaultBoolOption(value: unknown, fallback = false) {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}
