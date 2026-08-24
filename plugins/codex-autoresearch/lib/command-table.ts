import {
  UNSAFE_COMMAND_APPROVAL_FIELD,
  UNSAFE_COMMAND_PROPERTY,
  toolArgumentsContainUnsafeCommand,
} from "./tool-unsafe-command-gate.js";
import {
  failureLayerPreconditions,
  type DecisionCapability,
  type DecisionDiagnosticCode,
} from "./decision-compiler.js";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type ToolArgs = Record<string, JsonValue | undefined>;
export type JsonSchema = {
  type?: string | string[];
  description?: string;
  enum?: JsonPrimitive[];
  properties?: Record<string, JsonSchema | undefined>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  maxItems?: number;
  minItems?: number;
  minLength?: number;
  minimum?: number;
  not?: JsonSchema;
  oneOf?: JsonSchema[];
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
export type SessionLockPolicy = "action" | "always" | "none";
export type DecisionProtocolPolicy = "session-mutation";
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
  decisionProtocol?: DecisionProtocolPolicy;
  decisionCapability?: DecisionCapability;
  requiredDecisionDiagnostics?: readonly DecisionDiagnosticCode[];
  recoveryForDiagnostics?: readonly DecisionDiagnosticCode[];
  resolveDecisionCapability?: (
    args: Readonly<Record<string, unknown>>,
    context: Readonly<{ config: Readonly<Record<string, unknown>> }>,
  ) => DecisionCapability | null;
  handler: string;
  help: readonly string[];
  inputSchema: JsonSchema;
  name: string;
  openWorld?: boolean;
  outputFields: readonly string[];
  outputSchemaOverrides?: Readonly<Record<string, JsonSchema>>;
  resolveActionPolicy?: (args: Readonly<Record<string, unknown>>) => ActionPolicy;
  sessionLock?: SessionLockPolicy;
}
const defineOutputSchemaOverrides = (
  schemas: Readonly<Record<string, JsonSchema>>,
): Readonly<Record<string, JsonSchema>> => schemas;
const closedInputObject = (
  properties: Record<string, JsonSchema>,
  required = Object.keys(properties),
): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const LEARNING_INPUT_SCHEMA: JsonSchema = {
  oneOf: [
    closedInputObject({ kind: { type: "string", enum: ["none"] } }),
    closedInputObject({
      kind: { type: "string", enum: ["causal", "discriminating"] },
      changedBelief: { type: "string", minLength: 1 },
      evidence: {
        type: "array",
        minItems: 1,
        items: { type: "string", minLength: 1 },
      },
    }),
  ],
};
const FAILURE_INPUT_SCHEMA: JsonSchema = {
  oneOf: Object.entries(failureLayerPreconditions).map(([layer, preconditions]) =>
    closedInputObject({
      layer: { type: "string", enum: [layer] },
      code: { type: "string" },
      preconditions: closedInputObject(
        Object.fromEntries(preconditions.map((name) => [name, { type: "string" }])),
      ),
    }),
  ),
};
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
    outputFields: [
      "ok",
      "workDir",
      "missing",
      "missingEssentials",
      "recommendedRecipe",
      "guidedFlow",
      "nextStep",
      "gateQuality",
      "preflight",
    ],
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
    outputFields: [
      "ok",
      "workDir",
      "stage",
      "commands",
      "nextAction",
      "nextStep",
      "lastRun",
      "dashboard",
      "gateQuality",
      "preflight",
    ],
    outputSchemaOverrides: defineOutputSchemaOverrides({
      commands: {
        type: "object",
        description: "Named guided workflow command map.",
        additionalProperties: true,
      },
    }),
    sessionLock: "none",
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
    outputFields: ["ok", "workDir", "fit", "directEvidence", "contractCandidate", "nextAction"],
    defaultHelp: true,
    help: ["node scripts/autoresearch.mjs prompt-plan --cwd <project> --prompt <text>"],
    cliOptions: [
      { name: "shell", key: "shell", kind: "string" },
      { name: "compact", key: "compact", kind: "boolean" },
    ],
    description:
      "Classify a natural-language request before discovery, then return direct evidence, clarification, or an in-memory loop candidate.",
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
    outputFields: ["ok", "workDir", "operatorSnapshot", "nextAction", "nextStep", "templates"],
    help: [
      "node scripts/autoresearch.mjs onboarding-packet --cwd <project> [--compact] [--json-full]",
    ],
    cliOptions: [{ name: "json-full", key: "jsonFull", kind: "boolean" }],
    description:
      "Return a compact human-and-agent onboarding packet with state, hazards, report templates, and next commands.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        compact: { type: "boolean" },
        json_full: { type: "boolean" },
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
    outputFields: [
      "ok",
      "workDir",
      "action",
      "whySafe",
      "nextStep",
      "commands",
      "operatorChecklist",
      "decisionPlanProjection",
      "resolvedDecision",
      "sessionDecisionCapsule",
      "runtimeProvenance",
      "laneLifecycle",
      "packetDiagnostics",
      "portfolioRecommendation",
    ],
    outputSchemaOverrides: defineOutputSchemaOverrides({
      action: {
        type: ["string", "object"],
        description: "Safe next action summary or action object.",
      },
      commands: {
        type: ["array", "object"],
        description: "Copyable command list or named command map.",
      },
    }),
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
    outputFields: [
      "ok",
      "workDir",
      "canMarkCodexGoalComplete",
      "completionBlocker",
      "boundary",
      "objectiveDraft",
      "completionAudit",
      "commands",
    ],
    outputSchemaOverrides: defineOutputSchemaOverrides({
      commands: {
        type: "object",
        description: "Named Codex Goal workflow command map.",
        additionalProperties: true,
      },
    }),
    help: [
      "node scripts/autoresearch.mjs codex-goal-brief --cwd <project> [--codex-goal-objective <text>] [--codex-goal-status active|paused|budget_limited|complete] [--enforce-completion]",
    ],
    cliOptions: [{ name: "enforce-completion", key: "enforceCompletion", kind: "boolean" }],
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
        enforce_completion: { type: "boolean" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "session_forensics",
    cliCommand: "session-forensics",
    actionPolicy: "read",
    decisionProtocol: "session-mutation",
    category: "diagnostic",
    audience: "advanced",
    handler: "sessionForensics",
    outputFields: [
      "ok",
      "workDir",
      "dryRun",
      "wrote",
      "outputDir",
      "plannedFiles",
      "counts",
      "workflowWaste",
      "decisionCapsule",
      "canonicalNextAction",
      "nextAction",
    ],
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
    outputFields: ["ok", "recipes"],
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
    decisionProtocol: "session-mutation",
    category: "happy_path",
    audience: "default",
    handler: "setupSession",
    outputFields: ["ok", "workDir", "files", "init"],
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
      "Accept a complete loop contract, then create session files and the initial config record.",
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
    decisionProtocol: "session-mutation",
    category: "advanced",
    audience: "advanced",
    handler: "setupResearchSession",
    outputFields: ["ok", "workDir", "slug", "qualityGap"],
    help: [
      "node scripts/autoresearch.mjs research-setup --cwd <project> --slug <slug> --goal <goal> [--checks-command <cmd>] [--max-iterations <n>] [--packet-budget <n>] [--wall-clock-budget-seconds <n>]",
    ],
    description:
      "Create an explicitly selected qualitative-loop scratchpad and initialize quality_gap evidence.",
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
    decisionProtocol: "session-mutation",
    resolveDecisionCapability: (args, { config }) => {
      const dryRun = enabledArg(args.dry_run ?? args.dryRun);
      const skipInit = enabledArg(args.skip_init ?? args.skipInit);
      const noBaseline = enabledArg(args.no_baseline_log ?? args.noBaselineLog);
      const baselineEnabled = defaultBoolOption(args.baseline_log ?? args.baselineLog, true);
      const configuredMetric = String(config.metricName || "").trim();
      const preservesExecutableMetric =
        Boolean(configuredMetric && config.benchmarkCommand) && configuredMetric !== "quality_gap";
      return !dryRun && !skipInit && !noBaseline && baselineEnabled && !preservesExecutableMetric
        ? "run-packet"
        : null;
    },
    recoveryForDiagnostics: ["setup-required"],
    category: "happy_path",
    audience: "default",
    handler: "researchStart",
    outputFields: ["dryRun", "workDir", "slug", "metricName", "baselineLogged", "commands"],
    outputSchemaOverrides: defineOutputSchemaOverrides({
      commands: {
        type: "object",
        description: "Named research workflow command map.",
        additionalProperties: true,
      },
    }),
    help: [
      "node scripts/autoresearch.mjs research-start --cwd <project> --slug <slug> --goal <goal> [--checks-command <cmd>] [--commit-paths <paths>] [--protected-benchmark-paths <paths>] [--packet-budget <n>] [--wall-clock-budget-seconds <n>] [--dry-run] [--skip-init] [--no-baseline-log] [--json-full]",
    ],
    conditionallyMutating: true,
    cliOptions: [{ name: "json-full", key: "jsonFull", kind: "boolean" }],
    description:
      "Start an explicitly selected quality_gap loop with contract validation and an optional baseline.",
    inputSchema: {
      type: "object",
      properties: {
        ...RESEARCH_LOOP_SETUP_PROPERTIES,
        dry_run: { type: "boolean" },
        baseline_log: { type: "boolean" },
        no_baseline_log: { type: "boolean" },
        json_full: { type: "boolean" },
      },
      required: ["working_dir", "slug", "goal"],
    },
  },
  {
    name: "research_fanout",
    cliCommand: "research-fanout",
    actionPolicy: "read",
    decisionProtocol: "session-mutation",
    category: "advanced",
    audience: "advanced",
    handler: "researchFanout",
    outputFields: ["ok", "workDir", "dryRun", "fanoutPlan", "parallelLanes"],
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
    decisionProtocol: "session-mutation",
    category: "advanced",
    audience: "advanced",
    handler: "laneRunner",
    outputFields: ["ok", "workDir", "dryRun", "lane", "result", "coordinatorRecommendation"],
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
    decisionProtocol: "session-mutation",
    category: "advanced",
    audience: "advanced",
    handler: "configureSession",
    outputFields: ["ok", "workDir", "config", "updates"],
    outputSchemaOverrides: defineOutputSchemaOverrides({
      updates: {
        type: "object",
        description: "Applied configuration updates keyed by setting.",
        additionalProperties: true,
      },
    }),
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
    outputFields: [],
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
    outputFields: [],
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
    decisionProtocol: "session-mutation",
    decisionCapability: "run-packet",
    recoveryForDiagnostics: [
      "stale-packet",
      "legacy-contract-acceptance-required",
      "legacy-contract-conflict",
    ],
    category: "happy_path",
    audience: "default",
    handler: "nextExperiment",
    outputFields: [
      "ok",
      "workDir",
      "doctor",
      "run",
      "decision",
      "packetEvidence",
      "fullPacket",
      "history",
      "lastRunPath",
      "report",
      "refused",
      "code",
      "blockingAction",
      "decisionPlanProjection",
      "resolvedDecision",
      "sessionDecisionCapsule",
      "nextAction",
      "clearingCondition",
      "commandHint",
      "continuation",
    ],
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
    decisionProtocol: "session-mutation",
    resolveDecisionCapability: (args) => (enabledArg(args.record) ? "run-packet" : null),
    recoveryForDiagnostics: ["pending-packet"],
    category: "diagnostic",
    audience: "advanced",
    handler: "partialResultsCommand",
    outputFields: [
      "ok",
      "workDir",
      "candidates",
      "skippedArtifacts",
      "experiment",
      "evidenceClaim",
    ],
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
    decisionProtocol: "session-mutation",
    resolveDecisionCapability: (args) => (args.status === "keep" ? "authorize-keep" : null),
    recoveryForDiagnostics: ["pending-log-transaction", "pending-log-transaction-inconsistent"],
    category: "happy_path",
    audience: "default",
    handler: "logExperiment",
    outputFields: ["ok", "workDir", "experiment", "continuation"],
    defaultHelp: true,
    help: [
      "node scripts/autoresearch.mjs log --cwd <project> (--metric <n>|--from-last) --status keep|discard|crash|checks_failed|measure --description <text> [--metrics <json>|--metrics-file <path>] [--asi <json>|--asi-json-file <path>] [--learning <json>|--learning-json-file <path>] [--failure <json>|--failure-json-file <path>] [--evidence-status accepted|rejected|provisional|superseded] [--commit <hash>] [--commit-paths <paths>] [--allow-add-all] [--revert-paths <paths>]",
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
        learning: LEARNING_INPUT_SCHEMA,
        learning_json_file: { type: "string" },
        failure: FAILURE_INPUT_SCHEMA,
        failure_json_file: { type: "string" },
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
    outputFields: [
      "ok",
      "workDir",
      "runs",
      "best",
      "warnings",
      "memory",
      "decisionPlan",
      "decisionPlanProjection",
      "resolvedDecision",
      "sessionDecisionCapsule",
      "runtimeProvenance",
      "runtimeDriftSummary",
      "runtimeAuthority",
      "dashboardHealth",
      "sourceCleanliness",
      "ledgerHealth",
      "gateQuality",
      "preflight",
      "portfolioRecommendation",
      "laneLifecycle",
      "packetDiagnostics",
      "report",
    ],
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
    decisionProtocol: "session-mutation",
    recoveryForDiagnostics: ["ledger-integrity"],
    category: "diagnostic",
    audience: "default",
    handler: "ledgerDoctor",
    outputFields: [
      "ok",
      "workDir",
      "ledgerPath",
      "readOnly",
      "ledgerHealth",
      "repairedLedgerHealth",
      "backupPath",
      "repair",
      "warnings",
    ],
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
    outputFields: ["ok", "workDir", "open", "closed", "openItems"],
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
    decisionProtocol: "session-mutation",
    category: "diagnostic",
    audience: "advanced",
    handler: "gapCandidates",
    outputFields: ["ok", "workDir", "candidates", "qualityGap", "stopRecommended", "stopStatus"],
    help: [
      "node scripts/autoresearch.mjs gap-candidates --cwd <project> --research-slug <slug> [--apply] [--model-command <cmd>] [--model-timeout-seconds <n>]",
    ],
    conditionallyMutating: true,
    openWorld: true,
    resolveActionPolicy: (args) =>
      enabledArg(args.apply)
        ? "state_mutation"
        : args.model_command || args.modelCommand
          ? "process_start"
          : "preview",
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
    name: "decide_quality_gap",
    cliCommand: "gap-decide",
    actionPolicy: "state_mutation",
    decisionProtocol: "session-mutation",
    category: "happy_path",
    audience: "default",
    handler: "recordQualityGapDecision",
    outputFields: ["ok", "workDir", "slug", "gap", "decision", "qualityGap"],
    help: [
      "node scripts/autoresearch.mjs gap-decide --cwd <project> --research-slug <slug> --gap-id <gap-id> --decision implemented|rejected --evidence <reference> --validation <result>",
    ],
    description:
      "Record an evidence-bearing implemented or rejected decision for one stable qualitative gap id.",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        research_slug: { type: "string" },
        gap_id: { type: "string" },
        decision: { type: "string", enum: ["implemented", "rejected"] },
        evidence: { type: "string" },
        validation: { type: "string" },
      },
      required: ["working_dir", "gap_id", "decision", "evidence", "validation"],
    },
  },
  {
    name: "finalize_preview",
    cliCommand: "finalize-preview",
    actionPolicy: "read",
    category: "happy_path",
    audience: "default",
    handler: "finalizePreview",
    outputFields: ["ok", "ready", "warnings", "nextAction", "semanticSafety", "finalTreeCoverage"],
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
    decisionProtocol: "session-mutation",
    decisionCapability: "finalize",
    requiredDecisionDiagnostics: ["current-tree-finalization"],
    recoveryForDiagnostics: ["current-tree-finalization"],
    category: "dangerous",
    audience: "advanced",
    handler: "finalizeCurrentTree",
    outputFields: ["ok", "ready", "files", "planOutput", "currentTreeCoverage"],
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
    outputFields: [],
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
    decisionProtocol: "session-mutation",
    category: "diagnostic",
    audience: "advanced",
    handler: "benchmarkInspect",
    outputFields: ["ok", "workDir", "warnings", "hints", "outputPreview"],
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
    decisionProtocol: "session-mutation",
    category: "diagnostic",
    audience: "default",
    handler: "benchmarkLint",
    outputFields: ["ok", "workDir", "issues", "parsedMetrics"],
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
    decisionProtocol: "session-mutation",
    category: "diagnostic",
    audience: "advanced",
    handler: "checksInspect",
    outputFields: ["ok", "workDir", "failedTests", "warnings", "hints"],
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
    decisionProtocol: "session-mutation",
    decisionCapability: "transition-segment",
    category: "advanced",
    audience: "advanced",
    handler: "newSegment",
    outputFields: ["ok", "workDir", "dryRun", "entry"],
    help: [
      "node scripts/autoresearch.mjs new-segment --cwd <project> [--reason <text>] [--metric-name <name>] [--metric-unit <unit>] [--direction lower|higher] [--benchmark-command <cmd>] [--checks-command <cmd>] [--packet-env-file <path>] [--packet-env-mode minimal|inherit] [--dry-run|--yes]",
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
    conditionallyMutating: true,
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
        packet_env_file: { type: "string" },
        packet_env_mode: { type: "string", enum: ["inherit", "minimal"] },
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
    decisionProtocol: "session-mutation",
    decisionCapability: "transition-segment",
    category: "advanced",
    audience: "advanced",
    handler: "promoteGate",
    outputFields: ["ok", "workDir", "dryRun", "entry"],
    help: [
      "node scripts/autoresearch.mjs promote-gate --cwd <project> --reason <text> [--gate-name <name>] [--query-count <n>] [--benchmark-command <cmd>] [--checks-command <cmd>] [--dry-run|--yes]",
    ],
    actionAliases: { promoteGateDryRun: "promote gate" },
    conditionallyMutating: true,
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
    outputFields: ["ok", "workDir", "output", "summary", "best", "nextAction", "modeGuidance"],
    sessionLock: "none",
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
    outputFields: [
      "ok",
      "workDir",
      "url",
      "port",
      "pid",
      "version",
      "startedAt",
      "healthUrl",
      "registryPath",
      "debugLedger",
      "dashboardHealth",
      "verified",
      "deferredViewModel",
      "modeGuidance",
    ],
    sessionLock: "none",
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
    decisionProtocol: "session-mutation",
    category: "happy_path",
    audience: "default",
    handler: "doctorSession",
    outputFields: [
      "ok",
      "workDir",
      "config",
      "state",
      "git",
      "benchmarkContract",
      "benchmark",
      "catalogTrust",
      "issues",
      "warnings",
      "warningDetails",
      "drift",
      "runtimeDriftSummary",
      "runtimeAuthority",
      "gateQuality",
      "preflight",
      "decisionPlan",
      "resolvedDecision",
      "commandExecutionBoundary",
      "commandAuthority",
      "runtimeProvenance",
      "sessionDecisionCapsule",
      "scaffoldHealth",
      "researchIntegrity",
      "nextAction",
      "continuation",
      "explanation",
    ],
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
    name: "recover_process_integrity",
    cliCommand: "process-recover",
    actionPolicy: "state_mutation",
    decisionProtocol: "session-mutation",
    recoveryForDiagnostics: ["process-integrity", "termination-unproven"],
    category: "diagnostic",
    audience: "advanced",
    handler: "recoverProcessIntegrity",
    outputFields: ["ok", "workDir", "recovered", "markerPath", "provenDeadPids", "proof"],
    help: ["node scripts/autoresearch.mjs process-recover --cwd <project>"],
    description:
      "Prove every PID in a retained termination-failed process tree is absent, then remove only that progress marker.",
    inputSchema: {
      type: "object",
      properties: { working_dir: { type: "string" } },
      required: ["working_dir"],
    },
  },
  {
    name: "clear_session",
    cliCommand: "clear",
    actionPolicy: "destructive",
    decisionProtocol: "session-mutation",
    category: "dangerous",
    audience: "maintainer",
    handler: "clearSession",
    outputFields: ["ok", "workDir", "dryRun", "wouldDelete", "deleted", "missing"],
    help: ["node scripts/autoresearch.mjs clear --cwd <project> [--dry-run|--yes]"],
    conditionallyMutating: true,
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

export function commandRequiresSessionMutationLock(
  command: string,
  args: Readonly<Record<string, unknown>> = {},
): boolean {
  const definition = commandDefinitionForCli(command);
  if (!definition || definition.compatibility) return false;
  if (enabledArg(args.dry_run ?? args.dryRun)) return false;
  if (definition.sessionLock === "none") return false;
  if (definition.sessionLock === "always") return true;
  const policy = definition.resolveActionPolicy?.(args) || definition.actionPolicy;
  return actionPolicyRequiresSessionLock(policy);
}

export function commandUsesSessionDecisionProtocol(
  command: string,
  args: Readonly<Record<string, unknown>> = {},
): boolean {
  return (
    commandDefinitionForCli(command)?.decisionProtocol === "session-mutation" &&
    commandRequiresSessionMutationLock(command, args)
  );
}

export function decisionCapabilityForCommand(
  command: string,
  args: Readonly<Record<string, unknown>> = {},
  context: Readonly<{ config: Readonly<Record<string, unknown>> }> = { config: {} },
): DecisionCapability | null {
  if (command === "finalize-autoresearch:apply" || command === "finalize-autoresearch:plan") {
    return "finalize";
  }
  const definition = commandDefinitionForCli(command);
  return (
    definition?.resolveDecisionCapability?.(args, context) ?? definition?.decisionCapability ?? null
  );
}

export function recoveryDiagnosticsForCommand(command: string): readonly DecisionDiagnosticCode[] {
  if (command === "finalize-autoresearch:apply") return ["current-tree-finalization"];
  if (command === "finalize-autoresearch:plan") return [];
  return commandDefinitionForCli(command)?.recoveryForDiagnostics || [];
}

export function requiredDecisionDiagnosticsForCommand(
  command: string,
): readonly DecisionDiagnosticCode[] {
  return commandDefinitionForCli(command)?.requiredDecisionDiagnostics || [];
}

export function actionPolicyRequiresSessionLock(policy: ActionPolicy): boolean {
  return [
    "artifact_write",
    "state_mutation",
    "git_mutation",
    "process_start",
    "destructive",
    "unsafe_open_world",
  ].includes(policy);
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
  assertSchemaValue(`Argument ${key}`, value, property as JsonSchema);
}

function assertSchemaValue(label: string, value: unknown, schema: JsonSchema): void {
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((branch) => schemaValueMatches(value, branch)).length;
    if (matches !== 1) throw new Error(`${label} does not match exactly one allowed schema.`);
  }
  if (schema.anyOf && !schema.anyOf.some((branch) => schemaValueMatches(value, branch))) {
    throw new Error(`${label} does not match any allowed schema.`);
  }
  if (schema.not && schemaValueMatches(value, schema.not)) {
    throw new Error(`${label} matches a forbidden schema.`);
  }
  if (schema.type && !schemaTypeMatches(value, schema.type)) {
    const expected = Array.isArray(schema.type) ? schema.type.join(" or ") : schema.type;
    throw new Error(`${label} must be ${article(expected)} ${expected}.`);
  }
  if (schema.enum && !schema.enum.includes(value as JsonPrimitive)) {
    throw new Error(`${label} must be one of ${schema.enum.join(", ")}.`);
  }
  if (typeof value === "number" && schema.minimum != null && value < schema.minimum) {
    throw new Error(`${label} must be at least ${schema.minimum}.`);
  }
  if (typeof value === "string" && schema.minLength != null && value.length < schema.minLength) {
    throw new Error(`${label} must contain at least ${schema.minLength} character(s).`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) {
      throw new Error(`${label} must contain at least ${schema.minItems} item(s).`);
    }
    if (schema.maxItems != null && value.length > schema.maxItems) {
      throw new Error(`${label} must contain at most ${schema.maxItems} item(s).`);
    }
    if (schema.items) {
      value.forEach((item, index) => assertSchemaValue(`${label}[${index}]`, item, schema.items!));
    }
  }
  if (isObjectArgument(value)) {
    for (const required of schema.required || []) {
      if (!Object.hasOwn(value, required) || missingArgumentValue(value[required])) {
        throw new Error(`${label}.${required} is required.`);
      }
    }
    for (const [key, item] of Object.entries(value)) {
      const property = schema.properties?.[key];
      if (property) {
        assertSchemaValue(`${label}.${key}`, item, property);
        continue;
      }
      if (schema.additionalProperties === false) {
        throw new Error(`${label}.${key} is not allowed.`);
      }
      if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        assertSchemaValue(`${label}.${key}`, item, schema.additionalProperties);
      }
    }
  }
}

function schemaValueMatches(value: unknown, schema: JsonSchema): boolean {
  try {
    assertSchemaValue("Value", value, schema);
    return true;
  } catch {
    return false;
  }
}

function schemaTypeMatches(value: unknown, type: string | string[]): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((candidate) => {
    if (candidate === "null") return value === null;
    if (candidate === "array") return Array.isArray(value);
    if (candidate === "object") return isObjectArgument(value);
    if (candidate === "integer") return typeof value === "number" && Number.isInteger(value);
    if (candidate === "number") return typeof value === "number" && Number.isFinite(value);
    return typeof value === candidate;
  });
}

function isObjectArgument(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function article(value: string): "a" | "an" {
  return /^[aeiou]/i.test(value) ? "an" : "a";
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
