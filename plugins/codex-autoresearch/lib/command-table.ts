import {
  UNSAFE_COMMAND_APPROVAL_FIELD,
  UNSAFE_COMMAND_PROPERTY,
  toolArgumentsContainUnsafeCommand,
} from "./tool-unsafe-command-gate.js";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type ToolArgs = Record<string, JsonValue | undefined>;
export type JsonSchema = {
  type?: string | string[];
  enum?: string[];
  properties?: Record<string, JsonSchema | undefined>;
  required?: string[];
  items?: JsonSchema;
};

export type ActionPolicy =
  | "read"
  | "preview"
  | "artifact_write"
  | "state_mutation"
  | "git_mutation"
  | "process_start"
  | "destructive"
  | "unsafe_open_world";
export type CommandCategory =
  | "happy_path"
  | "setup"
  | "diagnostic"
  | "advanced"
  | "integration"
  | "dangerous";
export type CommandAudience = "default" | "advanced" | "maintainer";
export type CliOptionKind = "boolean" | "list" | "string";
export interface CommandCliOption {
  aliases?: readonly string[];
  key: string;
  kind: CliOptionKind;
  name: string;
}

export interface CompatibilityCommand {
  error: string;
  removeAfter: string;
  replacement: string;
}

export interface CommandDefinition {
  actionAliases?: Readonly<Record<string, string | undefined>>;
  actionPolicy: ActionPolicy;
  audience: CommandAudience;
  category: CommandCategory;
  cliCommand: string;
  cliOptions?: readonly CommandCliOption[];
  compatibility?: CompatibilityCommand;
  conditionallyMutating?: boolean;
  dashboardRequiresDryRun?: boolean;
  defaultHelp?: boolean;
  description: string;
  handler: string;
  help: readonly string[];
  inputSchema: JsonSchema;
  name: string;
  openWorld?: boolean;
  resolveActionPolicy?: (args: Readonly<Record<string, unknown>>) => ActionPolicy;
}
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
  quality_constraints: { type: "array", items: { type: "object" } },
  secondary_metrics: { type: "array", items: { type: "string" } },
  secondary_metric_constraints: { type: "array", items: { type: "string" } },
  secondary_metric_constraint_mode: { type: "string", enum: ["advisory", "blocking"] },
  protected_benchmark_paths: { type: "array", items: { type: "string" } },
  commit_paths: { type: "array", items: { type: "string" } },
  max_iterations: { type: "integer" },
  packet_budget: { type: "integer" },
  wall_clock_budget_seconds: { type: "integer" },
  budget_note: { type: "string" },
} satisfies Record<string, JsonSchema>;

const SETUP_SOURCE_PROPERTIES = {
  recipe_id: { type: "string" },
  catalog: { type: "string" },
  trust_catalog: { type: "boolean" },
} satisfies Record<string, JsonSchema>;

const RESEARCH_LOOP_SETUP_PROPERTIES = {
  working_dir: { type: "string" },
  slug: { type: "string" },
  goal: { type: "string" },
  name: { type: "string" },
  checks_command: { type: "string" },
  shell: { type: "string", enum: ["bash", "powershell"] },
  files_in_scope: { type: "array", items: { type: "string" } },
  constraints: { type: "array", items: { type: "string" } },
  secondary_metric_constraints: { type: "array", items: { type: "string" } },
  secondary_metric_constraint_mode: { type: "string", enum: ["advisory", "blocking"] },
  protected_benchmark_paths: { type: "array", items: { type: "string" } },
  commit_paths: { type: "array", items: { type: "string" } },
  max_iterations: { type: "integer" },
  packet_budget: { type: "integer" },
  wall_clock_budget_seconds: { type: "integer" },
  budget_note: { type: "string" },
  autonomy_mode: { type: "string", enum: ["guarded", "owner-autonomous", "manual"] },
  checks_policy: { type: "string", enum: ["always", "on-improvement", "manual"] },
  keep_policy: { type: "string", enum: ["primary-only", "primary-or-risk-reduction"] },
  dashboard_refresh_seconds: { type: "number" },
  overwrite: { type: "boolean" },
  create_checks: { type: "boolean" },
  skip_init: { type: "boolean" },
  allow_unsafe_command: { type: "boolean" },
} satisfies Record<string, JsonSchema>;

const PACKET_RUN_PROPERTIES = {
  working_dir: { type: "string" },
  command: { type: "string" },
  command_file: { type: "string" },
  env_file: { type: "string" },
  packet_env_file: { type: "string" },
  packet_env_mode: { type: "string", enum: ["inherit", "minimal"] },
  timeout_seconds: { type: "number" },
  checks_command: { type: "string" },
  checks_timeout_seconds: { type: "number" },
  checks_policy: { type: "string", enum: ["always", "on-improvement", "manual"] },
  allow_unsafe_command: { type: "boolean" },
  allow_fixed_control_rerun: { type: "boolean" },
} satisfies Record<string, JsonSchema>;

export const commandTable = [
  {
    name: "setup_plan",
    cliCommand: "setup-plan",
    actionPolicy: "read",
    category: "setup",
    audience: "default",
    handler: "setupPlan",
    defaultHelp: true,
    help: [
      "node scripts/autoresearch.mjs setup-plan --cwd <project> [--recipe <id>] [--catalog <path-or-url>] [--trust-catalog] [--name <name>] [--metric-name <name>] [--direction lower|higher] [--benchmark-command <cmd>] [--checks-command <cmd>] [--shell bash|powershell] [--commit-paths <paths>] [--protected-benchmark-paths <paths>] [--secondary-metric-constraints <rules>] [--secondary-metric-constraint-mode advisory|blocking] [--max-iterations <n>] [--packet-budget <n>] [--wall-clock-budget-seconds <n>] [--budget-note <text>]",
    ],
    cliOptions: [
      { name: "shell", key: "shell", kind: "string" },
      { name: "compact", key: "compact", kind: "boolean" },
    ],
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
    cliCommand: "guide",
    actionPolicy: "read",
    category: "setup",
    audience: "default",
    handler: "guidedSetup",
    help: [
      "node scripts/autoresearch.mjs guide --cwd <project> [--recipe <id>] [--catalog <path-or-url>] [--trust-catalog] [--name <name>] [--metric-name <name>] [--direction lower|higher] [--benchmark-command <cmd>] [--checks-command <cmd>] [--shell bash|powershell] [--commit-paths <paths>] [--protected-benchmark-paths <paths>] [--secondary-metric-constraints <rules>] [--secondary-metric-constraint-mode advisory|blocking] [--max-iterations <n>] [--packet-budget <n>] [--wall-clock-budget-seconds <n>] [--budget-note <text>]",
    ],
    cliOptions: [
      { name: "shell", key: "shell", kind: "string" },
      { name: "compact", key: "compact", kind: "boolean" },
    ],
    conditionallyMutating: true,
    openWorld: true,
    resolveActionPolicy: (args) =>
      enabledArg(args.start_dashboard ?? args.startDashboard) ? "process_start" : "read",
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
    cliCommand: "prompt-plan",
    actionPolicy: "read",
    category: "setup",
    audience: "default",
    handler: "promptPlan",
    defaultHelp: true,
    help: ["node scripts/autoresearch.mjs prompt-plan --cwd <project> --prompt <text>"],
    cliOptions: [
      { name: "shell", key: "shell", kind: "string" },
      { name: "compact", key: "compact", kind: "boolean" },
    ],
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
    cliCommand: "onboarding-packet",
    actionPolicy: "read",
    category: "setup",
    audience: "default",
    handler: "onboardingPacket",
    help: ["node scripts/autoresearch.mjs onboarding-packet --cwd <project> [--compact]"],
    description:
      "Return a compact human-and-agent onboarding packet with state, hazards, report templates, and next commands.",
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
    name: "recommend_next",
    cliCommand: "recommend-next",
    actionPolicy: "read",
    category: "diagnostic",
    audience: "default",
    handler: "recommendNext",
    help: [
      "node scripts/autoresearch.mjs recommend-next --cwd <project> [--compact] [--operator-checklist]",
    ],
    description:
      "Return the single safest next action with why-it-is-safe evidence and copyable commands.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        compact: { type: "boolean" },
        operator_checklist: { type: "boolean" },
        codex_goal_objective: { type: "string" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "codex_goal_bridge",
    cliCommand: "codex-goal-brief",
    actionPolicy: "read",
    category: "integration",
    audience: "advanced",
    handler: "codexGoalBrief",
    help: [
      "node scripts/autoresearch.mjs codex-goal-brief --cwd <project> [--codex-goal-objective <text>] [--codex-goal-status active|paused|budget_limited|complete]",
    ],
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
    cliCommand: "session-forensics",
    actionPolicy: "read",
    category: "diagnostic",
    audience: "advanced",
    handler: "sessionForensics",
    help: [
      "node scripts/autoresearch.mjs session-forensics --cwd <project> --session-jsonl <path> --research-slug <slug> [--dry-run|--apply] [--allow-snippets] [--allow-outside-workdir] [--json-full|--verbose]",
    ],
    conditionallyMutating: true,
    dashboardRequiresDryRun: true,
    resolveActionPolicy: (args) => (enabledArg(args.apply) ? "artifact_write" : "read"),
    description:
      "Parse a Codex rollout JSONL into compact session counts, waste signals, and optional safe context-capsule artifacts. Pass json_full for full signal arrays.",
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
        json_full: { type: "boolean" },
        verbose: { type: "boolean" },
      },
      required: ["working_dir", "session_jsonl", "research_slug"],
    },
  },
  {
    name: "list_recipes",
    cliCommand: "recipes",
    actionPolicy: "read",
    category: "setup",
    audience: "advanced",
    handler: "recipeCommand",
    help: [
      "node scripts/autoresearch.mjs recipes list|show|recommend [recipe-id] [--cwd <project>] [--catalog <path-or-url>]",
    ],
    cliOptions: [
      { name: "id", key: "id", kind: "string" },
      { name: "recipe", key: "recipe", kind: "string" },
      {
        name: "recipe-id",
        key: "recipeId",
        kind: "string",
        aliases: ["recipeId", "recipe_id"],
      },
    ],
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
    cliCommand: "setup",
    actionPolicy: "state_mutation",
    category: "happy_path",
    audience: "default",
    handler: "setupSession",
    defaultHelp: true,
    help: [
      "node scripts/autoresearch.mjs setup --cwd <project> --name <name> --metric-name <name> [--recipe <id>] [--catalog <path-or-url>] [--trust-catalog] [--direction lower|higher] [--benchmark-command <cmd>] [--benchmark-prints-metric true|false] [--checks-command <cmd>] [--shell bash|powershell] [--protected-benchmark-paths <paths>] [--secondary-metric-constraints <rules>] [--secondary-metric-constraint-mode advisory|blocking] [--max-iterations <n>] [--packet-budget <n>] [--wall-clock-budget-seconds <n>] [--budget-note <text>]",
      "node scripts/autoresearch.mjs setup --cwd <project> --interactive",
    ],
    cliOptions: [
      { name: "interactive", key: "interactive", kind: "boolean" },
      { name: "scope", key: "filesInScope", kind: "list" },
    ],
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
        secondary_metric_constraints: { type: "array", items: { type: "string" } },
        secondary_metric_constraint_mode: { type: "string", enum: ["advisory", "blocking"] },
        protected_benchmark_paths: { type: "array", items: { type: "string" } },
        commit_paths: { type: "array", items: { type: "string" } },
        max_iterations: { type: "integer" },
        packet_budget: { type: "integer" },
        wall_clock_budget_seconds: { type: "integer" },
        budget_note: { type: "string" },
        autonomy_mode: { type: "string", enum: ["guarded", "owner-autonomous", "manual"] },
        checks_policy: { type: "string", enum: ["always", "on-improvement", "manual"] },
        keep_policy: { type: "string", enum: ["primary-only", "primary-or-risk-reduction"] },
        dashboard_refresh_seconds: { type: "number" },
        overwrite: { type: "boolean" },
        create_checks: { type: "boolean" },
        skip_init: { type: "boolean" },
        allow_unsafe_command: { type: "boolean" },
        quality_constraints: { type: "array", items: { type: "object" } },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "setup_research_session",
    cliCommand: "research-setup",
    actionPolicy: "state_mutation",
    category: "advanced",
    audience: "advanced",
    handler: "setupResearchSession",
    help: [
      "node scripts/autoresearch.mjs research-setup --cwd <project> --slug <slug> --goal <goal> [--checks-command <cmd>] [--max-iterations <n>] [--packet-budget <n>] [--wall-clock-budget-seconds <n>]",
    ],
    description:
      "Create a deep-research scratchpad and initialize a quality_gap autoresearch session.",
    inputSchema: {
      type: "object",
      properties: {
        ...RESEARCH_LOOP_SETUP_PROPERTIES,
      },
      required: ["working_dir", "slug", "goal"],
    },
  },
  {
    name: "start_research_loop",
    cliCommand: "research-start",
    actionPolicy: "process_start",
    category: "happy_path",
    audience: "default",
    handler: "researchStart",
    help: [
      "node scripts/autoresearch.mjs research-start --cwd <project> --slug <slug> --goal <goal> [--checks-command <cmd>] [--commit-paths <paths>] [--protected-benchmark-paths <paths>] [--packet-budget <n>] [--wall-clock-budget-seconds <n>] [--dry-run] [--skip-init] [--no-baseline-log]",
    ],
    description: "Start a quality_gap scratchpad with validation and optional baseline.",
    inputSchema: {
      type: "object",
      properties: {
        ...RESEARCH_LOOP_SETUP_PROPERTIES,
        dry_run: { type: "boolean" },
        baseline_log: { type: "boolean" },
        no_baseline_log: { type: "boolean" },
      },
      required: ["working_dir", "slug", "goal"],
    },
  },
  {
    name: "research_fanout",
    cliCommand: "research-fanout",
    actionPolicy: "read",
    category: "advanced",
    audience: "advanced",
    handler: "researchFanout",
    help: [
      "node scripts/autoresearch.mjs research-fanout --cwd <project> [--lanes <n>] [--dry-run|--yes]",
    ],
    conditionallyMutating: true,
    dashboardRequiresDryRun: true,
    resolveActionPolicy: (args) => (enabledArg(args.yes) ? "state_mutation" : "read"),
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
    cliCommand: "lane-runner",
    actionPolicy: "read",
    category: "advanced",
    audience: "advanced",
    handler: "laneRunner",
    help: [
      "node scripts/autoresearch.mjs lane-runner --cwd <project> [--lane-id <id>] [--mode read_only_scout|implementation|big_idea] [--command <allowlisted-git-read>] [--worktree <path>|--write-scope <paths>] [--summary <text>] [--recommendation <text>] [--evidence <items>] [--risks <items>] [--human-approval] [--time-budget-seconds <n>] [--dry-run|--yes]",
    ],
    conditionallyMutating: true,
    dashboardRequiresDryRun: true,
    openWorld: true,
    resolveActionPolicy: (args) =>
      args.command ? "process_start" : enabledArg(args.yes) ? "state_mutation" : "read",
    description:
      "Run or record one coordinated research lane. Scout commands use a strict Git read-only argv allowlist; Git porcelain is best-effort post-run detection, not containment.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        lane_id: { type: "string" },
        lane: { type: "string" },
        mode: { type: "string", enum: ["read_only_scout", "implementation", "big_idea"] },
        command: { type: "string" },
        worktree: { type: "string" },
        worktree_path: { type: "string" },
        write_scope: { type: "array", items: { type: "string" } },
        commit_paths: { type: "array", items: { type: "string" } },
        result_status: {
          type: "string",
          enum: ["completed", "blocked", "failed", "planned", "approved"],
        },
        summary: { type: "string" },
        recommendation: { type: "string" },
        evidence: { type: "array", items: { type: "string" } },
        risks: { type: "array", items: { type: "string" } },
        human_approval: { type: "boolean" },
        approved: { type: "boolean" },
        next_action: { type: "string" },
        time_budget_seconds: { type: "integer" },
        timeout_seconds: { type: "integer" },
        dry_run: { type: "boolean" },
        yes: { type: "boolean" },
        ...UNSAFE_COMMAND_PROPERTY,
      },
      required: ["working_dir"],
    },
  },
  {
    name: "configure_session",
    cliCommand: "config",
    actionPolicy: "state_mutation",
    category: "advanced",
    audience: "advanced",
    handler: "configureSession",
    help: [
      "node scripts/autoresearch.mjs config --cwd <project> [--autonomy-mode guarded|owner-autonomous|manual] [--checks-policy always|on-improvement|manual] [--extend <n>] [--commit-paths <paths>] [--packet-budget <n>] [--wall-clock-budget-seconds <n>] [--budget-note <text>] [--protected-benchmark-paths <paths>] [--secondary-metric-constraints <rules>] [--secondary-metric-constraint-mode advisory|blocking]",
    ],
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
        packet_budget: { type: "integer" },
        clear_packet_budget: { type: "boolean" },
        wall_clock_budget_seconds: { type: "integer" },
        clear_wall_clock_budget: { type: "boolean" },
        budget_note: { type: "string" },
        protected_benchmark_paths: { type: "array", items: { type: "string" } },
        secondary_metric_constraints: { type: "array", items: { type: "string" } },
        secondary_metric_constraint_mode: { type: "string", enum: ["advisory", "blocking"] },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "init_experiment",
    cliCommand: "init",
    actionPolicy: "read",
    category: "advanced",
    audience: "maintainer",
    handler: "compatibilityError",
    help: [
      "node scripts/autoresearch.mjs init --cwd <project> --name <name> --metric-name <name> [--goal <goal>] [--metric-unit <unit>] [--direction lower|higher]",
    ],
    compatibility: {
      replacement: "setup",
      removeAfter: "2026-10-01",
      error:
        "init is a compatibility command scheduled for removal after 2026-10-01; migrate to setup, which creates the complete session contract.",
    },
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
    cliCommand: "run",
    actionPolicy: "read",
    category: "advanced",
    audience: "advanced",
    handler: "compatibilityError",
    help: [
      "node scripts/autoresearch.mjs run --cwd <project> [--command <cmd>|--command-file <path>] [--packet-env-file <path>] [--packet-env-mode minimal|inherit] [--timeout-seconds <n>] [--allow-fixed-control-rerun]",
    ],
    compatibility: {
      replacement: "next",
      removeAfter: "2026-10-01",
      error:
        "run is a compatibility command scheduled for removal after 2026-10-01; migrate measured packets to next or use benchmark-inspect for a read-only probe.",
    },
    description: "Run a timed benchmark command, parse METRIC lines, and optionally run checks.",
    inputSchema: {
      type: "object",
      properties: {
        ...PACKET_RUN_PROPERTIES,
      },
      required: ["working_dir"],
    },
  },
  {
    name: "next_experiment",
    cliCommand: "next",
    actionPolicy: "process_start",
    category: "happy_path",
    audience: "default",
    handler: "nextExperiment",
    defaultHelp: true,
    help: [
      "node scripts/autoresearch.mjs next --cwd <project> [--compact] [--command <cmd>|--command-file <path>] [--packet-env-file <path>] [--packet-env-mode minimal|inherit] [--timeout-seconds <n>] [--allow-fixed-control-rerun]",
    ],
    description:
      "Run a preflight readout and benchmark in one packet, then return allowed log decisions, an ASI template, and the active-loop continuation contract.",
    inputSchema: {
      type: "object",
      properties: {
        ...PACKET_RUN_PROPERTIES,
        compact: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "partial_results",
    cliCommand: "partial-results",
    actionPolicy: "read",
    category: "diagnostic",
    audience: "advanced",
    handler: "partialResultsCommand",
    help: [
      "node scripts/autoresearch.mjs partial-results --cwd <project> [--from-last|--artifact <path>] [--record <candidate-id>] [--research-slug <slug>]",
    ],
    conditionallyMutating: true,
    resolveActionPolicy: (args) => (enabledArg(args.record) ? "artifact_write" : "read"),
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
    cliCommand: "log",
    actionPolicy: "git_mutation",
    category: "happy_path",
    audience: "default",
    handler: "logExperiment",
    defaultHelp: true,
    help: [
      "node scripts/autoresearch.mjs log --cwd <project> (--metric <n>|--from-last) --status keep|discard|crash|checks_failed|measure --description <text> [--metrics <json>|--metrics-file <path>] [--asi <json>|--asi-json-file <path>] [--evidence-status accepted|rejected|provisional|superseded] [--commit <hash>] [--commit-paths <paths>] [--allow-add-all] [--revert-paths <paths>]",
    ],
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
    cliCommand: "state",
    actionPolicy: "read",
    category: "happy_path",
    audience: "default",
    handler: "publicState",
    defaultHelp: true,
    help: [
      "node scripts/autoresearch.mjs state --cwd <project> [--compact] [--report] [--json-full]",
    ],
    description: "Summarize the current autoresearch.jsonl state.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        compact: { type: "boolean" },
        report: { type: "boolean" },
        json_full: { type: "boolean" },
        codex_goal_objective: { type: "string" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "ledger_doctor",
    cliCommand: "ledger-doctor",
    actionPolicy: "read",
    category: "diagnostic",
    audience: "default",
    handler: "ledgerDoctor",
    defaultHelp: true,
    help: ["node scripts/autoresearch.mjs ledger-doctor --cwd <project> [--json] [--repair --yes]"],
    conditionallyMutating: true,
    resolveActionPolicy: (args) => (enabledArg(args.repair) ? "artifact_write" : "read"),
    description:
      "Analyze autoresearch.jsonl numbering health and optionally repair duplicate run numbers after confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        json: { type: "boolean" },
        repair: { type: "boolean" },
        yes: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "measure_quality_gap",
    cliCommand: "quality-gap",
    actionPolicy: "read",
    category: "diagnostic",
    audience: "advanced",
    handler: "measureQualityGap",
    help: [
      "node scripts/autoresearch.mjs quality-gap --cwd <project> [--research-slug <slug>] [--list] [--json]",
    ],
    cliOptions: [
      { name: "list", key: "list", kind: "boolean" },
      { name: "json", key: "json", kind: "boolean" },
    ],
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
    cliCommand: "gap-candidates",
    actionPolicy: "preview",
    category: "diagnostic",
    audience: "advanced",
    handler: "gapCandidates",
    help: [
      "node scripts/autoresearch.mjs gap-candidates --cwd <project> --research-slug <slug> [--apply] [--model-command <cmd>] [--model-timeout-seconds <n>]",
    ],
    conditionallyMutating: true,
    openWorld: true,
    resolveActionPolicy: (args) => (enabledArg(args.apply) ? "state_mutation" : "preview"),
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
    cliCommand: "finalize-preview",
    actionPolicy: "read",
    category: "happy_path",
    audience: "default",
    handler: "finalizePreview",
    defaultHelp: true,
    help: [
      "node scripts/autoresearch.mjs finalize-preview --cwd <project> [--trunk main] [--progress]",
    ],
    description: "Return a read-only finalization readiness preview without creating branches.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        trunk: { type: "string" },
        progress: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "finalize_current_tree",
    cliCommand: "finalize-current-tree",
    actionPolicy: "artifact_write",
    category: "dangerous",
    audience: "advanced",
    handler: "finalizeCurrentTree",
    help: [
      "node scripts/autoresearch.mjs finalize-current-tree --cwd <project> [--trunk main] [--exclude-session-artifacts|--include-session-artifacts] [--progress]",
    ],
    description:
      "Write a current-final-tree finalization plan that covers the current non-session branch diff.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        trunk: { type: "string" },
        exclude_session_artifacts: { type: "boolean" },
        include_session_artifacts: { type: "boolean" },
        progress: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "integrations",
    cliCommand: "integrations",
    actionPolicy: "read",
    category: "integration",
    audience: "advanced",
    handler: "compatibilityError",
    help: [
      "node scripts/autoresearch.mjs integrations list|doctor|sync-recipes [--catalog <path-or-url>]",
    ],
    compatibility: {
      replacement: "recipes",
      removeAfter: "2026-10-01",
      error:
        "integrations is a compatibility command scheduled for removal after 2026-10-01; migrate catalog discovery and validation to recipes list/show --catalog <path-or-url>.",
    },
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
    cliCommand: "benchmark-inspect",
    actionPolicy: "read",
    category: "diagnostic",
    audience: "advanced",
    handler: "benchmarkInspect",
    help: [
      "node scripts/autoresearch.mjs benchmark-inspect --cwd <project> [--command <cmd>] [--timeout-seconds <n>] [--allow-fixed-control-rerun]",
    ],
    conditionallyMutating: true,
    openWorld: true,
    resolveActionPolicy: (args) => (args.command ? "process_start" : "read"),
    description:
      "Safely inspect a benchmark list, dry-run, sample, or artifact command before running an expensive packet.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        command: { type: "string" },
        timeout_seconds: { type: "number" },
        allow_unsafe_command: { type: "boolean" },
        allow_fixed_control_rerun: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "benchmark_lint",
    cliCommand: "benchmark-lint",
    actionPolicy: "read",
    category: "diagnostic",
    audience: "default",
    handler: "benchmarkLint",
    help: [
      "node scripts/autoresearch.mjs benchmark-lint --cwd <project> [--metric-name <name>] [--sample <text>|--command <cmd>] [--allow-fixed-control-rerun]",
    ],
    conditionallyMutating: true,
    openWorld: true,
    resolveActionPolicy: (args) =>
      (args.sample ?? args.sampleText ?? args.sample_text) ? "read" : "process_start",
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
        allow_fixed_control_rerun: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "checks_inspect",
    cliCommand: "checks-inspect",
    actionPolicy: "read",
    category: "diagnostic",
    audience: "advanced",
    handler: "checksInspect",
    help: [
      "node scripts/autoresearch.mjs checks-inspect --cwd <project> --command <cmd> [--timeout-seconds <n>]",
    ],
    conditionallyMutating: true,
    openWorld: true,
    resolveActionPolicy: (args) =>
      (args.command ?? args.checks_command ?? args.checksCommand) ? "process_start" : "read",
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
    cliCommand: "new-segment",
    actionPolicy: "state_mutation",
    category: "advanced",
    audience: "advanced",
    handler: "newSegment",
    help: [
      "node scripts/autoresearch.mjs new-segment --cwd <project> [--reason <text>] [--metric-name <name>] [--metric-unit <unit>] [--direction lower|higher] [--benchmark-command <cmd>] [--checks-command <cmd>] [--dry-run|--yes]",
    ],
    cliOptions: [
      {
        name: "best-direction",
        key: "bestDirection",
        kind: "string",
        aliases: ["bestDirection", "best_direction"],
      },
    ],
    actionAliases: { newSegmentDryRun: "new segment" },
    dashboardRequiresDryRun: true,
    resolveActionPolicy: (args) =>
      enabledArg(args.dry_run ?? args.dryRun) ? "preview" : "state_mutation",
    description:
      "Start a fresh run segment while preserving old ledger history; requires confirmation unless dry-run.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        reason: { type: "string" },
        metric_name: { type: "string" },
        metric_unit: { type: "string" },
        direction: { type: "string", enum: ["lower", "higher"] },
        benchmark_command: { type: "string" },
        checks_command: { type: "string" },
        dry_run: { type: "boolean" },
        confirm: { type: "boolean" },
        allow_unsafe_command: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "promote_gate",
    cliCommand: "promote-gate",
    actionPolicy: "state_mutation",
    category: "advanced",
    audience: "advanced",
    handler: "promoteGate",
    help: [
      "node scripts/autoresearch.mjs promote-gate --cwd <project> --reason <text> [--gate-name <name>] [--query-count <n>] [--benchmark-command <cmd>] [--checks-command <cmd>] [--dry-run|--yes]",
    ],
    actionAliases: { promoteGateDryRun: "promote gate" },
    dashboardRequiresDryRun: true,
    resolveActionPolicy: (args) =>
      enabledArg(args.dry_run ?? args.dryRun) ? "preview" : "state_mutation",
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
    cliCommand: "export",
    actionPolicy: "artifact_write",
    category: "advanced",
    audience: "advanced",
    handler: "exportDashboard",
    help: [
      "node scripts/autoresearch.mjs export --cwd <project> [--output <html>] [--showcase] [--json-full|--verbose] [--progress]",
    ],
    cliOptions: [
      { name: "showcase", key: "showcase", kind: "boolean" },
      {
        name: "showcase-mode",
        key: "showcaseMode",
        kind: "string",
        aliases: ["showcaseMode", "showcase_mode"],
      },
      { name: "verbose", key: "verbose", kind: "boolean" },
      {
        name: "progress-stderr",
        key: "progress",
        kind: "boolean",
        aliases: ["progressStderr", "progress_stderr"],
      },
    ],
    description: "Write a self-contained fallback HTML snapshot for autoresearch.jsonl.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        output: { type: "string" },
        full: { type: "boolean" },
        json_full: { type: "boolean" },
        progress: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "serve_dashboard",
    cliCommand: "serve",
    actionPolicy: "process_start",
    category: "advanced",
    audience: "advanced",
    handler: "serveDashboard",
    help: ["node scripts/autoresearch.mjs serve --cwd <project> [--port <n>] [--debug-ledger]"],
    actionAliases: { liveDashboard: "serve dashboard" },
    description: "Start a local live dashboard for autoresearch.jsonl and return the operator URL.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        port: { type: "number" },
        debug_ledger: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "doctor_session",
    cliCommand: "doctor",
    actionPolicy: "read",
    category: "happy_path",
    audience: "default",
    handler: "doctorSession",
    defaultHelp: true,
    help: [
      "node scripts/autoresearch.mjs doctor --cwd <project> [--command <cmd>] [--check-benchmark] [--revalidate-catalog] [--allow-fixed-control-rerun] [--explain] [--json-full]",
      "node scripts/autoresearch.mjs doctor hooks",
    ],
    actionAliases: { doctorExplain: "doctor" },
    conditionallyMutating: true,
    openWorld: true,
    resolveActionPolicy: (args) =>
      enabledArg(args.check_benchmark ?? args.checkBenchmark) ? "process_start" : "read",
    description:
      "Run a preflight readout for an autoresearch session and optionally verify benchmark metric output.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        command: { type: "string" },
        check_benchmark: { type: "boolean" },
        check_installed: { type: "boolean" },
        revalidate_catalog: { type: "boolean" },
        packet_env_mode: { type: "string", enum: ["minimal", "inherit"] },
        explain: { type: "boolean" },
        json_full: { type: "boolean" },
        hooks: { type: "boolean" },
        timeout_seconds: { type: "number" },
        allow_unsafe_command: { type: "boolean" },
        allow_fixed_control_rerun: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "clear_session",
    cliCommand: "clear",
    actionPolicy: "destructive",
    category: "dangerous",
    audience: "maintainer",
    handler: "clearSession",
    help: ["node scripts/autoresearch.mjs clear --cwd <project> [--dry-run|--yes]"],
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
] satisfies readonly CommandDefinition[];

export type CommandHandlerBinding = (typeof commandTable)[number]["handler"];

const COMMAND_BY_TOOL = new Map(commandTable.map((command) => [command.name, command]));
const COMMAND_BY_CLI = new Map(commandTable.map((command) => [command.cliCommand, command]));

export function commandDefinitionForTool(name: string): CommandDefinition | null {
  return COMMAND_BY_TOOL.get(name) || null;
}

export function commandDefinitionForCli(command: string): CommandDefinition | null {
  return COMMAND_BY_CLI.get(command) || null;
}

export function compatibilityErrorForCli(command: string): string | null {
  return commandDefinitionForCli(command)?.compatibility?.error || null;
}

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
  if (options.enforceUnsafeCommandGate !== false) {
    requireUnsafeCommandGate(name, normalized);
  }
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
    runtime[runtimeKey(key)] = value;
  }
  return runtime;
}

export function normalizeCliCommandArguments(command: string, args: ToolArgs = {}): ToolArgs {
  const definition = commandDefinitionForCli(command);
  if (!definition) throw new Error(`Unknown command: ${command}`);
  const aliases = aliasesForCommand(definition);
  const runtime: ToolArgs = {};
  for (const [key, value] of Object.entries(args || {})) {
    if (key === "_") {
      runtime._ = value;
      continue;
    }
    if (["all", "debug", "help"].includes(key)) continue;
    const canonical = aliases.get(key);
    if (!canonical && ["allowOutsideWorkdir", "json"].includes(key)) continue;
    if (!canonical) throw new Error(`Unknown argument for ${definition.name}: ${key}`);
    runtime[runtimeKey(canonical)] = value as JsonValue;
  }
  return runtime;
}

export function requireUnsafeCommandGate(
  toolName: string,
  args: ToolArgs = {},
  boolOption = defaultBoolOption,
) {
  const schema = schemaForTool(toolName);
  const normalized: ToolArgs = schema ? normalizeToolArguments(toolName, args) : args || {};
  const hasCustomCommand = toolArgumentsContainUnsafeCommand(toolName, normalized);
  if (hasCustomCommand && !boolOption(normalized[UNSAFE_COMMAND_APPROVAL_FIELD], false)) {
    throw new Error(
      `${toolName} custom shell commands require allow_unsafe_command=true. Prefer a configured autoresearch script when possible.`,
    );
  }
}

function schemaForTool(name: string): JsonSchema | null {
  return commandDefinitionForTool(name)?.inputSchema || null;
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

function aliasesForCommand(definition: CommandDefinition): Map<string, string> {
  const aliases = aliasesForSchema(definition.inputSchema);
  for (const option of definition.cliOptions || []) {
    const canonical = aliases.get(option.key) || option.key;
    for (const alias of [option.name, option.key, ...(option.aliases || [])]) {
      aliases.set(alias, canonical);
    }
  }
  return aliases;
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

function runtimeKey(value: string): string {
  if (value === "working_dir") return "cwd";
  if (value === "allow_unsafe_command") return value;
  return toCamel(value);
}

function enabledArg(value: unknown): boolean {
  if (value == null || value === false) return false;
  if (typeof value === "string") return !["", "0", "false", "no"].includes(value.toLowerCase());
  return true;
}

function defaultBoolOption(value: unknown, fallback = false) {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}
