import { actionPolicyForTool } from "./tool-registry.js";
import {
  TOOL_STYLE_UNSAFE_COMMAND_GATE,
  toolSchemaRequiresUnsafeCommandGate,
} from "./tool-unsafe-command-gate.js";

type JsonSchema = {
  type?: string | string[];
  description?: string;
  enum?: string[];
  items?: JsonSchema;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
};

const OUTPUT_FIELD_SCHEMAS: Record<string, JsonSchema> = {
  action: stringSchema("Safe next action summary."),
  best: objectSchema("Best kept run summary."),
  backupPath: stringSchema("Backup file path written before ledger repair."),
  benchmark: objectSchema("Benchmark doctor check result."),
  blockingAction: objectSchema("Loop-governance action that refused a packet run."),
  candidates: arraySchema(objectSchema("Candidate quality-gap item."), "Candidate items."),
  canonicalNextAction: objectSchema("Canonical loop-governance next action."),
  checkedAt: stringSchema("ISO timestamp for a liveness check."),
  clearingCondition: stringSchema("Condition that clears a refused loop-governance blocker."),
  closed: numberSchema("Closed quality-gap item count."),
  code: stringSchema("Machine-readable status or refusal code."),
  commandHint: stringSchema("Copyable command for resolving a blocker or continuing safely."),
  commands: arraySchema(stringSchema("Command line."), "Copyable command list."),
  config: objectSchema("Autoresearch session config."),
  continuation: objectSchema("Active-loop continuation contract."),
  decision: objectSchema("Allowed logging decision packet."),
  decisionEnvelope: objectSchema("Decision guidance envelope with loop authority and audit state."),
  deferredViewModel: objectSchema("Deferred live dashboard diagnostics endpoint."),
  deleted: arraySchema(stringSchema("Deleted artifact path."), "Deleted artifact paths."),
  doctor: objectSchema("Doctor readiness result."),
  drift: objectSchema("Runtime/source drift report."),
  dryRun: booleanSchema("Whether the mutation was previewed only."),
  dashboard: objectSchema("Live dashboard startup status for guided setup."),
  dashboardHealth: objectSchema("Read-only live dashboard process health summary."),
  entry: objectSchema("Ledger/config entry."),
  experiment: objectSchema("Logged experiment entry."),
  explanation: objectSchema("Human-readable doctor verdict and supporting readiness details."),
  failedTests: arraySchema(stringSchema("Failed test or check."), "Failed tests or checks."),
  files: arraySchema(stringSchema("Created or touched file path."), "Created or touched files."),
  finalizePreview: objectSchema("Finalization readiness preview."),
  fullPacket: objectSchema("Full next-experiment packet payload."),
  git: objectSchema("Git repository cleanliness and availability summary."),
  guidedFlow: arraySchema(objectSchema("Guided workflow step."), "Guided workflow steps."),
  gateQuality: objectSchema("Benchmark and checks gate posture summary."),
  history: objectSchema("Last-run packet history metadata."),
  healthUrl: stringSchema("Dashboard health-check URL."),
  hints: arraySchema(stringSchema("Operator hint."), "Operator hints."),
  init: objectSchema("Initial ledger entry result."),
  intent: objectSchema("Inferred prompt intent."),
  issues: arraySchema(stringSchema("Validation or readiness issue."), "Issues."),
  lastRun: objectSchema("Pending last-run packet summary and freshness metadata."),
  lastRunPath: stringSchema("Path to the saved last-run packet."),
  ledgerHealth: objectSchema("Autoresearch JSONL run-number health summary."),
  ledgerPath: stringSchema("Autoresearch JSONL ledger path."),
  logHint: objectSchema("Suggested log command or payload."),
  memory: objectSchema("Experiment memory summary."),
  missing: arraySchema(stringSchema("Missing required setup field."), "Missing setup fields."),
  missingEssentials: arraySchema(
    stringSchema("Missing required setup field."),
    "Missing essentials for the first valid loop.",
  ),
  modeGuidance: objectSchema("Dashboard mode guidance."),
  nextAction: stringSchema("Recommended next operator action."),
  nextStep: objectSchema(
    "Shared next safe action contract with stage, reason, command/tool, safety, and gaps.",
  ),
  operatorChecklist: objectSchema(
    "Compact Codex handoff with one command, safety reason, blocker, evidence role, and source.",
  ),
  ok: booleanSchema("True when the tool completed successfully."),
  open: numberSchema("Open quality-gap item count."),
  openItems: arraySchema(stringSchema("Open quality-gap item."), "Open quality-gap items."),
  output: stringSchema("Output file path or command output."),
  outputPreview: stringSchema("Bounded command output preview."),
  packetEvidence: objectSchema(
    "Last-run packet evidence bundle with command identity, output tails, metrics, artifacts, checks, and fingerprint.",
  ),
  packetDiagnostics: objectSchema("Diagnostic taxonomy for unresolved packet evidence loss."),
  packetFingerprint: stringSchema("Freshness fingerprint from the packet evidence bundle."),
  parsedMetrics: objectSchema("Parsed METRIC values keyed by metric name."),
  pid: numberSchema("Local process identifier."),
  port: numberSchema("Local dashboard port."),
  preflight: objectSchema("First-packet readiness audit with blockers and next command."),
  portfolioRecommendation: objectSchema("Read-only portfolio lane recommendation."),
  protocol: objectSchema("Operator protocol guidance."),
  qualityGap: objectSchema("Quality-gap scratchpad summary."),
  promotion: objectSchema("Promotion state label and reasons for evidence readiness."),
  ready: booleanSchema("True when the preview is ready to apply."),
  readOnly: booleanSchema("True when the command made no file changes."),
  recipes: arraySchema(objectSchema("Recipe summary."), "Available recipes."),
  recommendedRecipe: objectSchema("Recommended benchmark recipe."),
  registryPath: stringSchema("Local dashboard registry path."),
  report: objectSchema("Compact terminal report with readable text and structured fields."),
  repair: objectSchema("Ledger repair summary."),
  repairedLedgerHealth: objectSchema("Ledger health after repair."),
  researchIntegrity: objectSchema("Research evidence readiness and blocker summary."),
  run: objectSchema("Benchmark run packet."),
  runs: objectSchema("Run-count summary."),
  laneLifecycle: objectSchema("Parallel lane lifecycle and stale-lane summary."),
  loopContract: objectSchema("Loop-governance contract blockers, warnings, and packet permission."),
  runtimeDriftSummary: objectSchema(
    "Source, installed, and built runtime status with smoke-check and next-action hints.",
  ),
  runtimeProvenance: objectSchema("Source, local, installed runtime, and drift provenance."),
  scaffoldHealth: objectSchema("Session scaffold integrity and automation safety checks."),
  sessionDecisionCapsule: objectSchema("Active session decision capsule when one is loaded."),
  sourceCleanliness: objectSchema("Source-vs-session-artifact cleanliness summary."),
  setup: objectSchema("Setup readiness packet."),
  slug: stringSchema("Research slug."),
  stage: stringSchema("Setup or resume stage."),
  startedAt: stringSchema("ISO timestamp for when the process started."),
  stopRecommended: booleanSchema("True when candidate extraction recommends stopping."),
  stopStatus: stringSchema("Recommended stop status."),
  state: objectSchema(
    "Full session state; for doctor output this is the stable container for decisionEnvelope and sessionDecisionCapsule.",
  ),
  summary: objectSchema("Dashboard export summary."),
  templates: arraySchema(objectSchema("Report template."), "Report templates."),
  updates: arraySchema(stringSchema("Applied config update."), "Applied updates."),
  url: stringSchema("Served local dashboard URL."),
  verified: booleanSchema("True when the dashboard health check passed."),
  version: stringSchema("Version string."),
  warnings: arraySchema(stringSchema("Warning message."), "Warnings."),
  warningDetails: arraySchema(objectSchema("Structured warning detail."), "Structured warnings."),
  whySafe: stringSchema("Evidence explaining why the next action is safe."),
  workDir: stringSchema("Resolved project working directory."),
  wouldDelete: arraySchema(stringSchema("Artifact path to delete."), "Previewed deletion targets."),
};

const CONTRACTS = {
  setup_plan: {
    purpose: "Read-only setup readiness and first-run command plan.",
    whenToUse:
      "Use before creating files or when the operator needs missing fields and recipe guidance.",
    contrast: "Use setup_session to actually create files.",
    safety: "Never mutates the project.",
    outputSchema: basicOutputSchema([
      "ok",
      "workDir",
      "missing",
      "missingEssentials",
      "recommendedRecipe",
      "guidedFlow",
      "nextStep",
      "gateQuality",
      "preflight",
    ]),
  },
  guided_setup: {
    purpose: "Return a complete first-run or resume action packet.",
    whenToUse: "Use when an operator asks what to do next from an existing or new session.",
    contrast: "Use setup_plan for read-only setup fields without resume state.",
    safety: "Read-only by default; starts a local dashboard only when start_dashboard=true.",
    outputSchema: basicOutputSchema([
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
    ]),
  },
  prompt_plan: {
    purpose: "Convert a natural-language request into an Autoresearch loop plan.",
    whenToUse: "Use when the user gives a broad goal before benchmark details are known.",
    contrast: "Use setup_plan when the metric and benchmark inputs are already explicit.",
    safety: "Read-only.",
    outputSchema: basicOutputSchema([
      "ok",
      "workDir",
      "intent",
      "setup",
      "missingEssentials",
      "nextAction",
      "nextStep",
    ]),
  },
  onboarding_packet: {
    purpose: "Return a compact resume packet for a new human or AI operator.",
    whenToUse: "Use at the start of a turn or handoff before reading the full docs.",
    contrast: "Use read_state for raw state or guided_setup for setup-only flow.",
    safety: "Read-only.",
    outputSchema: basicOutputSchema([
      "ok",
      "workDir",
      "protocol",
      "missingEssentials",
      "nextAction",
      "nextStep",
      "templates",
    ]),
  },
  recommend_next: {
    purpose: "Return the single safest next action and its evidence.",
    whenToUse: "Use when the operator asks what to do now or an agent needs one next command.",
    contrast: "Use onboarding_packet for broader handoff context.",
    safety: "Read-only.",
    outputSchema: outputSchemaWithOverrides(
      [
        "ok",
        "workDir",
        "action",
        "whySafe",
        "nextStep",
        "commands",
        "operatorChecklist",
        "decisionEnvelope",
        "sessionDecisionCapsule",
        "canonicalNextAction",
        "loopContract",
        "runtimeProvenance",
        "laneLifecycle",
        "packetDiagnostics",
        "portfolioRecommendation",
      ],
      {
        action: unionSchema(["string", "object"], "Safe next action summary or action object."),
        commands: unionSchema(["array", "object"], "Copyable command list or named command map."),
      },
    ),
  },
  codex_goal_bridge: {
    purpose: "Bridge Autoresearch state into Codex Goal objective and completion-audit language.",
    whenToUse: "Use for Codex Goal handoff or completion-audit evidence.",
    contrast: "Use recommend_next for ordinary continuation.",
    safety: "Read-only; does not read or mutate Codex private goal state.",
    outputSchema: basicOutputSchema([
      "ok",
      "workDir",
      "boundary",
      "objectiveDraft",
      "completionAudit",
      "commands",
    ]),
  },
  session_forensics: {
    purpose: "Parse Codex rollout JSONL into compact session and waste signals.",
    whenToUse: "Use to import a long Codex session before more Autoresearch packets.",
    contrast: "Use read_state for the current Autoresearch ledger only.",
    safety:
      "Dry-run is read-only; apply writes only validated research capsule files. Session JSONL reads are limited to --cwd unless allow_outside_workdir is explicit.",
    outputSchema: basicOutputSchema([
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
    ]),
  },
  list_recipes: {
    purpose: "List or recommend built-in and catalog benchmark recipes.",
    whenToUse: "Use when choosing or explaining a benchmark starting point.",
    contrast: "Use setup_plan to see a recommendation for one project.",
    safety: "Read-only.",
    outputSchema: basicOutputSchema(["ok", "recipes"]),
  },
  setup_session: {
    purpose: "Create session files and metric config.",
    whenToUse: "Use after setup_plan has enough inputs or a recipe supplies defaults.",
    contrast: "Use setup_research_session for qualitative research quality_gap loops.",
    safety: "Writes session artifacts and may initialize autoresearch.jsonl.",
    outputSchema: basicOutputSchema(["ok", "workDir", "files", "init"]),
  },
  setup_research_session: {
    purpose: "Create a deep-research scratchpad and quality_gap loop.",
    whenToUse: "Use for broad project study or source-backed recommendations.",
    contrast: "Use setup_session for direct numeric benchmark loops.",
    safety: "Writes research scratchpad and session artifacts.",
    outputSchema: basicOutputSchema(["ok", "workDir", "slug", "qualityGap"]),
  },
  start_research_loop: {
    purpose: "Start a qualitative quality_gap loop.",
    whenToUse:
      "Create the scratchpad, validate the benchmark, and optionally capture the first baseline.",
    contrast: "Use setup_research_session for scratchpad-only setup.",
    safety:
      "Writes research scratchpad and session artifacts unless dry_run=true; baseline logging is a measure record and can be disabled with no_baseline_log=true.",
    outputSchema: basicOutputSchema([
      "dryRun",
      "workDir",
      "slug",
      "metricName",
      "baselineLogged",
      "commands",
    ]),
  },
  research_fanout: {
    purpose: "Plan bounded parallel research lanes from current session memory.",
    whenToUse: "Use when the loop is spending too long serially exploring one hypothesis path.",
    contrast:
      "Use next_experiment to run a measured packet after a lane has produced a concrete hypothesis.",
    safety:
      "Dry-run/default is read-only; yes=true appends only a fanout plan to the Autoresearch ledger.",
    outputSchema: basicOutputSchema(["ok", "workDir", "dryRun", "fanoutPlan", "parallelLanes"]),
  },
  lane_runner: {
    purpose: "Run or record one planned lane and synthesize a single coordinator next action.",
    whenToUse: "Use after research_fanout when a lane needs bounded execution or a handoff.",
    contrast: "Use research_fanout to create lanes; use next_experiment for the measured packet.",
    safety: "Read-only scout by default; implementation requires --worktree or --write-scope.",
    outputSchema: basicOutputSchema([
      "ok",
      "workDir",
      "dryRun",
      "lane",
      "result",
      "coordinatorRecommendation",
    ]),
  },
  configure_session: {
    purpose: "Update runtime settings such as autonomy mode, policies, paths, and limits.",
    whenToUse: "Use to tune an existing session without recreating it.",
    contrast: "Use setup_session to create a new session.",
    safety: "Writes autoresearch.config.json.",
    outputSchema: basicOutputSchema(["ok", "workDir", "config", "updates"]),
  },
  init_experiment: {
    purpose: "Append a new metric config segment to autoresearch.jsonl.",
    whenToUse: "Use when changing the primary metric or starting a new segment.",
    contrast: "Use setup_session for initial file bootstrap.",
    safety: "Appends config to the run log.",
    outputSchema: basicOutputSchema(["ok", "workDir", "config"]),
  },
  run_experiment: {
    purpose: "Run only the benchmark/check packet.",
    whenToUse: "Use when you need raw benchmark output without preflight or continuation.",
    contrast: "Use next_experiment for the normal loop packet.",
    safety: "Runs configured commands but does not log results.",
    outputSchema: basicOutputSchema(["ok", "workDir", "parsedMetrics", "logHint"]),
  },
  next_experiment: {
    purpose: "Run preflight plus benchmark and produce the log decision packet.",
    whenToUse: "Use for the normal measured loop iteration.",
    contrast: "Use run_experiment only for low-level benchmark probing.",
    safety: "Runs commands and writes the last-run packet, but does not log keep/discard.",
    outputSchema: basicOutputSchema([
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
      "decisionEnvelope",
      "sessionDecisionCapsule",
      "loopContract",
      "nextAction",
      "clearingCondition",
      "commandHint",
      "continuation",
    ]),
  },
  partial_results: {
    purpose: "Inspect or record diagnostic rows from a crashed or timed-out packet artifact.",
    whenToUse:
      "Use before rerunning an expensive failed packet when last-run artifacts may contain completed rows.",
    contrast: "Use log_experiment for ordinary keep/discard/crash decisions.",
    safety:
      "Read-only unless record is supplied; recording appends measure-only diagnostic evidence and clears the last-run packet.",
    outputSchema: basicOutputSchema([
      "ok",
      "workDir",
      "candidates",
      "skippedArtifacts",
      "experiment",
      "evidenceClaim",
    ]),
  },
  log_experiment: {
    purpose: "Record a keep/discard/measure/crash/checks_failed decision.",
    whenToUse: "Use after next_experiment, preferably with from_last.",
    contrast: "Use next_experiment before this to create a decision packet.",
    safety:
      "Can commit kept changes or revert scoped discarded changes; measure only appends trend evidence.",
    outputSchema: basicOutputSchema(["ok", "workDir", "experiment", "continuation"]),
  },
  read_state: {
    purpose: "Summarize current run state and continuation.",
    whenToUse: "Use to resume, inspect progress, or feed dashboards.",
    contrast: "Use doctor_session for readiness checks.",
    safety: "Read-only.",
    outputSchema: basicOutputSchema([
      "ok",
      "workDir",
      "runs",
      "best",
      "warnings",
      "memory",
      "decisionEnvelope",
      "sessionDecisionCapsule",
      "canonicalNextAction",
      "loopContract",
      "runtimeProvenance",
      "runtimeDriftSummary",
      "dashboardHealth",
      "sourceCleanliness",
      "ledgerHealth",
      "gateQuality",
      "preflight",
      "portfolioRecommendation",
      "laneLifecycle",
      "packetDiagnostics",
      "report",
    ]),
  },
  ledger_doctor: {
    purpose: "Check Autoresearch JSONL run-number health and guarded duplicate-run repair.",
    whenToUse: "Use when run numbering is duplicated, missing, malformed, or non-monotonic.",
    contrast: "Use read_state for ordinary progress.",
    safety:
      "Read-only by default. repair=true requires yes=true and writes a timestamped backup before changing run numbers.",
    outputSchema: basicOutputSchema([
      "ok",
      "workDir",
      "ledgerPath",
      "readOnly",
      "ledgerHealth",
      "repairedLedgerHealth",
      "backupPath",
      "repair",
      "warnings",
    ]),
  },
  measure_quality_gap: {
    purpose: "Measure open and closed research checklist gaps.",
    whenToUse: "Use as the benchmark for qualitative research loops.",
    contrast: "Use gap_candidates to extract new candidate checklist items.",
    safety: "Read-only.",
    outputSchema: basicOutputSchema(["ok", "workDir", "open", "closed", "openItems"]),
  },
  gap_candidates: {
    purpose: "Preview or apply source-backed quality-gap candidates.",
    whenToUse: "Use after synthesis contains recommendations.",
    contrast: "Use measure_quality_gap to count the current checklist.",
    safety: "Preview is read-only; apply mutates quality-gaps.md.",
    outputSchema: basicOutputSchema([
      "ok",
      "workDir",
      "candidates",
      "qualityGap",
      "stopRecommended",
      "stopStatus",
    ]),
  },
  finalize_preview: {
    purpose: "Preview review-branch readiness without creating branches.",
    whenToUse: "Use before finalizing kept autoresearch work into review branches.",
    contrast: "Use the finalizer command to create review branches.",
    safety: "Read-only.",
    outputSchema: basicOutputSchema([
      "ok",
      "ready",
      "warnings",
      "nextAction",
      "semanticSafety",
      "finalTreeCoverage",
    ]),
  },
  finalize_current_tree: {
    purpose: "Write a current-final-tree finalization plan.",
    whenToUse:
      "Use when kept-run commits are stale or incomplete but the current branch content is the desired review unit.",
    contrast: "Use finalize_preview first when commit-backed kept evidence is trustworthy.",
    safety: "Writes a plan file under the Git private autoresearch-finalize directory.",
    outputSchema: basicOutputSchema(["ok", "ready", "files", "planOutput", "currentTreeCoverage"]),
  },
  integrations: {
    purpose: "Inspect additive catalogs and model-command integrations.",
    whenToUse: "Use to list, doctor, or sync recipe catalogs.",
    contrast: "Use list_recipes for the current recipe list only.",
    safety: "May write synced catalog state for sync-recipes.",
    outputSchema: basicOutputSchema(["ok"]),
  },
  benchmark_inspect: {
    purpose: "Inspect a bounded benchmark probe before a full packet.",
    whenToUse:
      "Use before benchmark_lint or next_experiment when a list/dry-run/artifact command might prevent an accidental full run.",
    contrast: "Use benchmark_lint to validate METRIC parsing after the probe is known bounded.",
    safety:
      "Read-only unless a command is explicitly provided; command execution requires allow_unsafe_command=true.",
    outputSchema: basicOutputSchema(["ok", "workDir", "warnings", "hints", "outputPreview"]),
  },
  benchmark_lint: {
    purpose: "Validate benchmark METRIC output without starting a loop.",
    whenToUse: "Use before setup, doctor, or next when the benchmark contract is uncertain.",
    contrast: "Use run_experiment or next_experiment to execute the actual loop packet.",
    safety:
      "Read-only unless a command is explicitly provided; command execution requires allow_unsafe_command=true.",
    outputSchema: basicOutputSchema(["ok", "workDir", "issues", "parsedMetrics"]),
  },
  checks_inspect: {
    purpose: "Classify correctness-check command failures before logging a decision.",
    whenToUse:
      "Use when a checks command fails, looks broad, or may be malformed before treating it as experiment evidence.",
    contrast: "Use benchmark_inspect for metric-producing commands.",
    safety:
      "Read-only unless a command is explicitly provided; command execution requires allow_unsafe_command=true.",
    outputSchema: basicOutputSchema(["ok", "workDir", "failedTests", "warnings", "hints"]),
  },
  new_segment: {
    purpose: "Start a fresh session segment while preserving old ledger history.",
    whenToUse: "Use when a session is maxed, stale, or intentionally changing phase.",
    contrast: "Use clear_session only when deleting artifacts is intended.",
    safety: "Dry-run is read-only; confirmed run appends a config entry.",
    outputSchema: basicOutputSchema(["ok", "workDir", "dryRun", "entry"]),
  },
  promote_gate: {
    purpose: "Preview or append a promoted measurement gate as a fresh segment.",
    whenToUse: "Use when moving from exploration to a stronger measurement contract.",
    contrast: "Use new_segment for a generic phase reset without measurement-gate metadata.",
    safety: "Dry-run is read-only; confirmed run appends a config entry.",
    outputSchema: basicOutputSchema(["ok", "workDir", "dryRun", "entry"]),
  },
  export_dashboard: {
    purpose: "Write the self-contained fallback dashboard HTML.",
    whenToUse:
      "Use only when an offline snapshot is needed; pass full=true only when the full viewModel is needed.",
    contrast: "Use serve_dashboard for the normal live operator dashboard.",
    safety: "Writes dashboard HTML inside the workdir.",
    outputSchema: basicOutputSchema([
      "ok",
      "workDir",
      "output",
      "summary",
      "best",
      "nextAction",
      "modeGuidance",
    ]),
  },
  serve_dashboard: {
    purpose: "Start the live local dashboard and return its URL.",
    whenToUse:
      "Use when the operator asks for the dashboard, a browser readout matters, or stale/static state needs a fresh liveness check.",
    contrast: "Use export_dashboard only for an offline fallback snapshot.",
    safety:
      "Starts a local server bound to 127.0.0.1. Raw ledger access stays disabled unless debug_ledger is explicitly true.",
    outputSchema: basicOutputSchema([
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
    ]),
  },
  doctor_session: {
    purpose: "Check readiness, git state, benchmark metrics, and version drift.",
    whenToUse: "Use before next or when a session behaves surprisingly.",
    contrast: "Use read_state for a lighter summary.",
    safety: "Read-only unless benchmark check runs configured commands.",
    outputSchema: basicOutputSchema([
      "ok",
      "workDir",
      "config",
      "state",
      "git",
      "benchmarkContract",
      "benchmark",
      "issues",
      "warnings",
      "warningDetails",
      "drift",
      "runtimeDriftSummary",
      "gateQuality",
      "preflight",
      "loopContract",
      "canonicalNextAction",
      "commandExecutionBoundary",
      "commandAuthority",
      "runtimeProvenance",
      "decisionEnvelope",
      "sessionDecisionCapsule",
      "scaffoldHealth",
      "researchIntegrity",
      "nextAction",
      "continuation",
      "explanation",
    ]),
  },
  clear_session: {
    purpose: "Preview or delete session artifacts after confirmation.",
    whenToUse:
      "Use dry_run first to preview targets; use confirmed clear only when the operator explicitly wants to clear a session.",
    contrast: "Use off/stop behavior to pause without deleting files.",
    safety: "Dry-run is read-only; destructive clear requires confirmation.",
    outputSchema: basicOutputSchema([
      "ok",
      "workDir",
      "dryRun",
      "wouldDelete",
      "deleted",
      "missing",
    ]),
  },
};

const READ_ONLY_TOOLS = new Set([
  "setup_plan",
  "prompt_plan",
  "onboarding_packet",
  "recommend_next",
  "codex_goal_bridge",
  "list_recipes",
  "read_state",
  "measure_quality_gap",
  "finalize_preview",
]);

const DESTRUCTIVE_TOOLS = new Set(["log_experiment", "clear_session"]);
const CONDITIONALLY_OPEN_WORLD_TOOLS = new Set([
  "guided_setup",
  "benchmark_inspect",
  "benchmark_lint",
  "checks_inspect",
  "doctor_session",
  "gap_candidates",
  "lane_runner",
]);

type ToolName = keyof typeof CONTRACTS;
type ToolSchema = {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: Record<string, unknown>;
  [key: string]: unknown;
};

function contractFor(name: string) {
  return CONTRACTS[name as ToolName] || null;
}

export function applyToolContracts(toolSchemas: ToolSchema[]): ToolSchema[] {
  return toolSchemas.map((tool) => {
    const contract = contractFor(tool.name);
    if (!contract) return tool;
    return {
      ...tool,
      description: `${contract.purpose} Use when: ${contract.whenToUse} Contrast: ${contract.contrast}`,
      outputSchema: contract.outputSchema,
      annotations: {
        ...tool.annotations,
        ...toolHintAnnotations(tool.name, tool.inputSchema),
        safety: contract.safety,
      },
    };
  });
}

export function validateToolContracts(toolSchemas: ToolSchema[]) {
  const issues: string[] = [];
  for (const tool of toolSchemas) {
    const contract = contractFor(tool.name);
    if (!contract) {
      issues.push(`${tool.name}: missing contract`);
      continue;
    }
    for (const field of ["purpose", "whenToUse", "contrast", "safety", "outputSchema"] as const) {
      if (!contract[field]) issues.push(`${tool.name}: missing ${field}`);
    }
    if (String(tool.description || "").length > 280) {
      issues.push(`${tool.name}: description is too long`);
    }
  }
  return { ok: issues.length === 0, issues };
}

export function toolGuidanceFor(name: string) {
  return contractFor(name);
}

export function outputContractFor(name: string) {
  return contractFor(name)?.outputSchema || null;
}

function toolHintAnnotations(name: string, inputSchema: JsonSchema) {
  const readOnly = READ_ONLY_TOOLS.has(name);
  const policy = actionPolicyForTool(name);
  const openWorld = policy === "process_start" || CONDITIONALLY_OPEN_WORLD_TOOLS.has(name);
  const unsafeCommandGate = toolSchemaRequiresUnsafeCommandGate(name, inputSchema);
  return {
    title: humanizeToolName(name),
    readOnlyHint: readOnly,
    destructiveHint: DESTRUCTIVE_TOOLS.has(name),
    idempotentHint: readOnly,
    openWorldHint: openWorld,
    unsafeCommandGate: unsafeCommandGate ? TOOL_STYLE_UNSAFE_COMMAND_GATE : undefined,
  };
}

function humanizeToolName(name: string) {
  return String(name)
    .split("_")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function basicOutputSchema(required: string[]): JsonSchema {
  const properties = Object.fromEntries(
    required.map((field) => [field, schemaForOutputField(field)]),
  );
  return {
    type: "object",
    required: required.filter((field) => field === "ok" || field === "workDir"),
    properties,
    additionalProperties: true,
  };
}

function outputSchemaWithOverrides(
  required: string[],
  overrides: Record<string, JsonSchema>,
): JsonSchema {
  const schema = basicOutputSchema(required);
  schema.properties = {
    ...schema.properties,
    ...overrides,
  };
  return schema;
}

function schemaForOutputField(field: string): JsonSchema {
  return (
    OUTPUT_FIELD_SCHEMAS[field] || {
      description: `${field} value.`,
      type: ["string", "number", "boolean", "object", "array", "null"],
    }
  );
}

function stringSchema(description: string): JsonSchema {
  return { type: "string", description };
}

function numberSchema(description: string): JsonSchema {
  return { type: "number", description };
}

function booleanSchema(description: string): JsonSchema {
  return { type: "boolean", description };
}

function unionSchema(types: string[], description: string): JsonSchema {
  return { type: types, description, additionalProperties: types.includes("object") };
}

function objectSchema(description: string): JsonSchema {
  return { type: "object", description, additionalProperties: true };
}

function arraySchema(items: JsonSchema, description: string): JsonSchema {
  return { type: "array", description, items };
}
