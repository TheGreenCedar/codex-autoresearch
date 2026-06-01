import fs from "node:fs";
import path from "node:path";

type LooseObject = Record<string, any>;

export const SESSION_DECISION_CAPSULE_SCHEMA_VERSION = 1;
export const SESSION_DECISION_CAPSULE_KIND = "session-decision-capsule";
const RESEARCH_DIR = "autoresearch.research";

export type SessionDecisionSeverity = "info" | "warning" | "blocker";
export type SessionDecisionEnforcementMode = "advisory" | "bounded-next" | "hard-block";

export interface SessionDecisionEnforcement {
  mode: SessionDecisionEnforcementMode;
  canRunNextPacket: boolean;
  allowBoundedNext: boolean;
  blocksFinalization: boolean;
  clearingCondition: string;
  commandHint: string;
  triggeredBy: string[];
}

export interface SessionDecisionCapsule {
  schemaVersion: 1;
  kind: "session-decision-capsule";
  status: "provisional" | "active" | "cleared";
  enforcement: SessionDecisionEnforcement;
  bottleneck: string;
  evidence: string[];
  nextExperiment: string;
  wrongNextActions: string[];
  doNotRepeat: string[];
  commandBudgetWarnings: string[];
  generatedFrom: {
    compactions: number;
    first: string | null;
    last: string | null;
    toolCounts: Record<string, number>;
    topCommandHeads: { commandHead: string; count: number }[];
  };
  importedAt?: string;
  sourcePath?: string;
  researchSlug?: string;
  capsulePath?: string;
}

export interface SessionDecisionRule {
  kind: string;
  severity: SessionDecisionSeverity;
  enforcement: SessionDecisionEnforcement;
  patterns: RegExp[];
  message: string;
  bottleneck: string;
  nextExperiment: string;
  wrongNextActions: string[];
}

export interface SessionDecisionFinding {
  kind: string;
  severity: SessionDecisionSeverity;
  message: string;
  source?: string;
}

export interface CapsuleSignal extends SessionDecisionFinding {
  count?: number;
  commandHead?: string;
  size?: { tokens?: number; lines?: number };
}

export interface SessionDecisionCapsuleInput {
  compactions: number;
  first: string | null;
  last: string | null;
  productSignals: CapsuleSignal[];
  workflowWaste: CapsuleSignal[];
  blockers: CapsuleSignal[];
  userCorrections: CapsuleSignal[];
  toolCounts: Record<string, number>;
  commandClasses: Record<string, number>;
  thresholds: {
    functionCalls: number;
    outputSegmentTokenBudget: number;
    repeatedCommandHeadCount: number;
    shellPolls: number;
  };
}

const HARD_BENCHMARK_CONTRACT: SessionDecisionEnforcement = {
  mode: "hard-block",
  canRunNextPacket: false,
  allowBoundedNext: false,
  blocksFinalization: true,
  clearingCondition:
    "Run benchmark-lint successfully or log measurement-contract repair, then start a fresh segment or acknowledge the capsule.",
  commandHint: "node scripts/autoresearch.mjs benchmark-lint --cwd <project>",
  triggeredBy: ["sessionDecisionCapsule", "benchmarkContract"],
};

const BOUNDED_NEXT_REQUIRED: SessionDecisionEnforcement = {
  mode: "bounded-next",
  canRunNextPacket: false,
  allowBoundedNext: true,
  blocksFinalization: false,
  clearingCondition:
    "Run an explicit bounded packet that targets this bottleneck, or log a fresh segment/acknowledgment after repair.",
  commandHint:
    "node scripts/autoresearch.mjs next --cwd <project> --compact --timeout-seconds <n> --command-file <path>",
  triggeredBy: ["sessionDecisionCapsule"],
};

const ADVISORY: SessionDecisionEnforcement = {
  mode: "advisory",
  canRunNextPacket: true,
  allowBoundedNext: true,
  blocksFinalization: false,
  clearingCondition: "Carry the lesson into ASI or a later logged decision.",
  commandHint: "node scripts/autoresearch.mjs recommend-next --cwd <project> --compact",
  triggeredBy: ["sessionDecisionCapsule"],
};

export const SESSION_DECISION_RULES: SessionDecisionRule[] = [
  {
    kind: "benchmark_contract_broken",
    severity: "blocker",
    enforcement: HARD_BENCHMARK_CONTRACT,
    patterns: [
      /benchmark-lint.*(timeout|timed out|zero `?METRIC|parses zero|no primary metric)/i,
      /primary benchmark contract.*broken/i,
      /wrapper.*too expensive.*contract/i,
      /run next packet.*unsafe/i,
      /scorer works.*wrapper/i,
    ],
    message:
      "The session found the benchmark lint contract broken: the wrapper timed out or emitted no primary METRIC line.",
    bottleneck:
      "The immediate blocker is the benchmark wrapper: it cannot prove the primary METRIC contract inside the lint budget.",
    nextExperiment:
      "Repair the benchmark wrapper so benchmark-lint emits the primary METRIC within timeout, then log that as measurement-contract repair before product work.",
    wrongNextActions: [
      "Do not run next or finalize while benchmark-lint cannot parse the primary metric.",
      "Do not count measurement-contract repair as product progress.",
    ],
  },
  {
    kind: "search_latency_bottleneck",
    severity: "warning",
    enforcement: BOUNDED_NEXT_REQUIRED,
    patterns: [
      /initial (packet )?(retrieval|search)/i,
      /search (step|latency|dominates|dominated)/i,
      /retrieval.*latency/i,
      /packet[- ]runtime.*search/i,
    ],
    message: "The session links the next high-leverage work to initial retrieval/search latency.",
    bottleneck:
      "The decision-grade bottleneck is initial retrieval/search latency, not another broad quality packet.",
    nextExperiment:
      "Run a bounded experiment against the initial retrieval/search phase and emit phase metrics before another end-to-end packet.",
    wrongNextActions: [
      "Do not keep tuning packet quality while search/retrieval latency is the named blocker.",
    ],
  },
  {
    kind: "metric_reframe_feedback",
    severity: "warning",
    enforcement: BOUNDED_NEXT_REQUIRED,
    patterns: [
      /not tracking the right metric/i,
      /wrong metric/i,
      /stuck on \d+ open quality gaps/i,
      /quality gaps.*30\+? hours/i,
    ],
    message:
      "The session contains explicit feedback that the active metric no longer represented progress.",
    bottleneck:
      "The active metric stopped representing progress and needs a metric or phase reframe before more packets.",
    nextExperiment:
      "Run a read-only metric-reframe scout, then start a fresh segment only when the new metric matches the product bottleneck.",
    wrongNextActions: [
      "Do not run another packet under a metric that the session already called misleading.",
    ],
  },
  {
    kind: "probe_churn_feedback",
    severity: "warning",
    enforcement: ADVISORY,
    patterns: [/too many small things/i, /small probes/i, /extreme cost/i, /cost in testing/i],
    message:
      "The session contains explicit feedback that too many small probes were burning test cost.",
    bottleneck:
      "Small implementation probes are consuming the loop; synthesize a wider hypothesis before another edit.",
    nextExperiment:
      "Synthesize the latest failures into one distant hypothesis before running another implementation probe.",
    wrongNextActions: ["Do not keep running near-neighbor probes without a new hypothesis."],
  },
  {
    kind: "skill_preflight_feedback",
    severity: "warning",
    enforcement: ADVISORY,
    patterns: [/not used any of the skills/i, /skills I told you to use/i, /instead spent/i],
    message:
      "The session contains feedback that requested analysis lanes must start before admin/logging work.",
    bottleneck: "Requested analysis skill preflight was skipped before low-value admin work.",
    nextExperiment:
      "Run the requested analysis/preflight lane first, then decide whether a packet is still needed.",
    wrongNextActions: ["Do not perform logging/admin work before requested analysis lanes start."],
  },
  {
    kind: "carry_forward_request",
    severity: "warning",
    enforcement: ADVISORY,
    patterns: [
      /persist that earlier report/i,
      /keep looking back/i,
      /carry.*forward/i,
      /left out anything/i,
    ],
    message: "The session asked for earlier findings to survive future resumes and comparisons.",
    bottleneck: "The loop is losing prior conclusions during handoff.",
    nextExperiment: "Write the carry-forward conclusion into ASI or the decision capsule.",
    wrongNextActions: [
      "Do not continue from raw transcript existence without carrying the lesson.",
    ],
  },
  {
    kind: "context_distillation_required",
    severity: "blocker",
    enforcement: {
      ...HARD_BENCHMARK_CONTRACT,
      blocksFinalization: false,
      clearingCondition:
        "Import or refresh bounded context, then acknowledge or start a fresh segment.",
      commandHint:
        "node scripts/autoresearch.mjs session-forensics --cwd <project> --session-jsonl <path> --research-slug <slug> --dry-run",
      triggeredBy: ["sessionDecisionCapsule", "contextDistillation"],
    },
    patterns: [],
    message: "The session exceeded context limits and needs bounded carry-forward state.",
    bottleneck:
      "The session exceeded context limits; import the carry-forward conclusion before continuing.",
    nextExperiment: "Refresh the context capsule before running another packet.",
    wrongNextActions: ["Do not run another generic packet after context loss without a capsule."],
  },
  {
    kind: "output_budget_exceeded",
    severity: "warning",
    enforcement: BOUNDED_NEXT_REQUIRED,
    patterns: [],
    message: "Command output exceeded the loop budget.",
    bottleneck:
      "Control-plane and command-output cost dominated; preserve the learning and narrow the next action before spending another packet.",
    nextExperiment:
      "Query bounded artifact summaries or an evidence index instead of recursively searching raw output trees.",
    wrongNextActions: [
      "Do not recursively grep broad artifact or target directories; use bounded summaries.",
    ],
  },
];

export function matchDecisionRules(text: string, source: string): SessionDecisionFinding[] {
  const findings: SessionDecisionFinding[] = [];
  for (const rule of SESSION_DECISION_RULES) {
    if (rule.patterns.length === 0) continue;
    if (!rule.patterns.some((pattern) => pattern.test(text))) continue;
    findings.push({
      kind: rule.kind,
      severity: rule.severity,
      message: rule.message,
      source,
    });
  }
  return findings;
}

export function buildSessionDecisionCapsule(
  input: SessionDecisionCapsuleInput,
): SessionDecisionCapsule {
  const signals = [
    ...input.productSignals,
    ...input.workflowWaste,
    ...input.blockers,
    ...input.userCorrections,
  ];
  const topCommandHeads = Object.entries(input.commandClasses)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([commandHead, count]) => ({ commandHead, count }));
  const repeatedCommands = topCommandHeads.filter(
    (entry) => entry.count >= input.thresholds.repeatedCommandHeadCount,
  );
  const outputBudget = input.workflowWaste.filter(
    (signal) => signal.kind === "output_budget_exceeded",
  );
  const rule = selectRule(signals, input, outputBudget);
  const execCount = input.toolCounts.exec_command || 0;
  const pollCount = input.toolCounts.shell_poll || input.toolCounts.write_stdin || 0;
  const evidence = [
    `Session window ${input.first || "unknown"} to ${input.last || "unknown"}.`,
    `${input.compactions} compactions, ${execCount} exec commands, ${pollCount} shell polls.`,
    ...prioritizedDecisionEvidence(input.productSignals, input.workflowWaste)
      .slice(0, 5)
      .map((signal) => signal.message),
    ...input.workflowWaste.slice(0, 4).map((signal) => signal.message),
  ].filter(Boolean);
  return {
    schemaVersion: SESSION_DECISION_CAPSULE_SCHEMA_VERSION,
    kind: SESSION_DECISION_CAPSULE_KIND,
    status: "provisional",
    enforcement: rule.enforcement,
    bottleneck: rule.bottleneck,
    evidence: dedupeText(evidence).slice(0, 10),
    nextExperiment: rule.nextExperiment,
    wrongNextActions: capsuleWrongActions(rule, outputBudget, repeatedCommands),
    doNotRepeat: repeatedCommands
      .slice(0, 6)
      .map(
        (entry) =>
          `Do not repeat '${entry.commandHead}' without a changed precondition; it appeared ${entry.count} times.`,
      ),
    commandBudgetWarnings: capsuleBudgetWarnings(input, outputBudget, execCount, pollCount),
    generatedFrom: {
      compactions: input.compactions,
      first: input.first,
      last: input.last,
      toolCounts: input.toolCounts,
      topCommandHeads,
    },
  };
}

export function readActiveSessionDecisionCapsule(
  workDir: string,
  entries: LooseObject[] = [],
): SessionDecisionCapsule | null {
  const researchRoot = path.join(path.resolve(workDir), RESEARCH_DIR);
  if (!fs.existsSync(researchRoot)) return null;
  const capsules: SessionDecisionCapsule[] = [];
  for (const entry of fs.readdirSync(researchRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const capsulePath = path.join(researchRoot, entry.name, "decision-capsule.json");
    const capsule = readCapsuleFile(capsulePath);
    if (!capsule) continue;
    if (capsule.status === "cleared") continue;
    capsules.push({
      ...capsule,
      status: "active",
      researchSlug: capsule.researchSlug || entry.name,
      capsulePath,
    });
  }
  return (
    capsules
      .sort((left, right) => capsuleTimeMs(right) - capsuleTimeMs(left))
      .find((capsule) => !isCapsuleCleared(capsule, entries)) || null
  );
}

export function isBoundedNextAllowedByCapsule(
  capsule: SessionDecisionCapsule | null | undefined,
  args: LooseObject,
): boolean {
  if (!capsule || capsule.enforcement.allowBoundedNext !== true) return false;
  const hasCommand = Boolean(args.command || args.command_file || args.commandFile);
  const hasCommandFile = Boolean(args.command_file || args.commandFile);
  const timeout = Number(args.timeout_seconds ?? args.timeoutSeconds);
  const hasExplicitTimeout = Number.isFinite(timeout) && timeout > 0;
  return hasCommandFile || (hasCommand && hasExplicitTimeout) || hasExplicitTimeout;
}

function selectRule(
  signals: CapsuleSignal[],
  input: SessionDecisionCapsuleInput,
  outputBudget: CapsuleSignal[],
): SessionDecisionRule {
  const kinds = new Set(signals.map((signal) => signal.kind));
  for (const kind of [
    "benchmark_contract_broken",
    "search_latency_bottleneck",
    "metric_reframe_feedback",
    "probe_churn_feedback",
    "skill_preflight_feedback",
    "carry_forward_request",
  ]) {
    const rule = ruleByKind(kind);
    if (rule && kinds.has(kind)) return rule;
  }
  if (kinds.has("context_distillation_required")) {
    return ruleByKind("context_distillation_required")!;
  }
  if (outputBudget.length) return ruleByKind("output_budget_exceeded")!;
  return {
    kind: "review_imported_session",
    severity: "warning",
    enforcement: ADVISORY,
    patterns: [],
    message: "Review the imported session signals before choosing another measured packet.",
    bottleneck: "Review the imported session signals before choosing another measured packet.",
    nextExperiment:
      "Use recommend-next --compact --operator-checklist and choose the cheapest action that can change the decision.",
    wrongNextActions: ["Do not run another generic packet just because the loop is still open."],
  };
}

function prioritizedDecisionEvidence(
  productSignals: CapsuleSignal[],
  workflowWaste: CapsuleSignal[],
): CapsuleSignal[] {
  const priority = new Map([
    ["benchmark_contract_broken", 0],
    ["search_latency_bottleneck", 1],
    ["metric_reframe_feedback", 2],
    ["probe_churn_feedback", 3],
    ["skill_preflight_feedback", 4],
    ["carry_forward_request", 5],
    ["context_distillation_required", 6],
    ["output_budget_exceeded", 7],
    ["quality_gap_wording", 8],
  ]);
  return [...productSignals, ...workflowWaste].sort(
    (left, right) => (priority.get(left.kind) ?? 99) - (priority.get(right.kind) ?? 99),
  );
}

function capsuleWrongActions(
  rule: SessionDecisionRule,
  outputBudget: CapsuleSignal[],
  repeatedCommands: { commandHead: string; count: number }[],
): string[] {
  const actions = [
    "Do not run another generic packet just because the loop is still open.",
    "Do not recompute baselines or broad suites when the current evidence already names a narrower bottleneck.",
    ...rule.wrongNextActions,
  ];
  if (outputBudget.length) {
    actions.push(
      "Do not recursively grep broad artifact or target directories; use bounded summaries.",
    );
  }
  if (repeatedCommands.length) {
    actions.push("Do not rerun repeated command heads without recording the changed precondition.");
  }
  return dedupeText(actions).slice(0, 8);
}

function capsuleBudgetWarnings(
  input: SessionDecisionCapsuleInput,
  outputBudget: CapsuleSignal[],
  execCount: number,
  pollCount: number,
): string[] {
  const warnings = [];
  if (execCount >= input.thresholds.functionCalls) {
    warnings.push(`Exec commands exceeded the context-distillation threshold: ${execCount}.`);
  }
  if (pollCount >= input.thresholds.shellPolls) {
    warnings.push(`Shell polling exceeded the budget threshold: ${pollCount}.`);
  }
  const largest = outputBudget
    .map((signal) => signal.size?.tokens || 0)
    .filter((value) => value > 0)
    .sort((left, right) => right - left)[0];
  if (largest) warnings.push(`Largest reported command output was ${largest} tokens.`);
  const totalOutput = outputBudget
    .map((signal) => (signal.message.includes("cumulative") ? signal.size?.tokens || 0 : 0))
    .sort((left, right) => right - left)[0];
  if (totalOutput && totalOutput >= input.thresholds.outputSegmentTokenBudget) {
    warnings.push(`Cumulative reported output was ${totalOutput} tokens.`);
  }
  return warnings;
}

function isCapsuleCleared(capsule: SessionDecisionCapsule, entries: LooseObject[]): boolean {
  const importedAt = capsuleTimeMs(capsule);
  if (!Number.isFinite(importedAt)) return false;
  return entries.some((entry) => {
    const entryTime = timestampMs(entry.timestamp);
    if (entryTime == null || entryTime <= importedAt) return false;
    if (entry.type === "config") return true;
    if (
      ["decision_capsule_ack", "session_decision_capsule_ack"].includes(String(entry.type || ""))
    ) {
      return true;
    }
    const asi = entry.asi && typeof entry.asi === "object" ? entry.asi : {};
    if (
      asi.decision_capsule_ack === true ||
      asi.session_decision_capsule_ack === true ||
      asi.sessionDecisionCapsuleCleared === true ||
      asi.measurement_contract_repair === true ||
      asi.measurementContractRepair === true
    ) {
      return true;
    }
    const text = [entry.description, asi.next_action_hint, asi.nextAction, asi.evidence]
      .map((value) => String(value || ""))
      .join("\n");
    return /measurement[- ]contract repair|benchmark[- ]contract repair|decision capsule (ack|clear|cleared)|capsule acknowledged/i.test(
      text,
    );
  });
}

function readCapsuleFile(filePath: string): SessionDecisionCapsule | null {
  try {
    return normalizeSessionDecisionCapsule(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

function normalizeSessionDecisionCapsule(value: unknown): SessionDecisionCapsule | null {
  if (!value || typeof value !== "object") return null;
  const input = value as LooseObject;
  if (input.kind !== SESSION_DECISION_CAPSULE_KIND) return null;
  const enforcement =
    input.enforcement && typeof input.enforcement === "object"
      ? (input.enforcement as LooseObject)
      : ADVISORY;
  return {
    schemaVersion: SESSION_DECISION_CAPSULE_SCHEMA_VERSION,
    kind: SESSION_DECISION_CAPSULE_KIND,
    status:
      input.status === "cleared" ? "cleared" : input.status === "active" ? "active" : "provisional",
    enforcement: {
      mode: ["hard-block", "bounded-next", "advisory"].includes(String(enforcement.mode))
        ? enforcement.mode
        : "advisory",
      canRunNextPacket: enforcement.canRunNextPacket === true,
      allowBoundedNext: enforcement.allowBoundedNext === true,
      blocksFinalization: enforcement.blocksFinalization === true,
      clearingCondition: stringValue(enforcement.clearingCondition),
      commandHint: stringValue(enforcement.commandHint),
      triggeredBy: Array.isArray(enforcement.triggeredBy)
        ? enforcement.triggeredBy.map(String).filter(Boolean)
        : ["sessionDecisionCapsule"],
    },
    bottleneck: stringValue(input.bottleneck),
    evidence: stringArray(input.evidence),
    nextExperiment: stringValue(input.nextExperiment),
    wrongNextActions: stringArray(input.wrongNextActions),
    doNotRepeat: stringArray(input.doNotRepeat),
    commandBudgetWarnings: stringArray(input.commandBudgetWarnings),
    generatedFrom: {
      compactions: Number(input.generatedFrom?.compactions || 0),
      first: input.generatedFrom?.first || null,
      last: input.generatedFrom?.last || null,
      toolCounts: objectOfNumbers(input.generatedFrom?.toolCounts),
      topCommandHeads: Array.isArray(input.generatedFrom?.topCommandHeads)
        ? input.generatedFrom.topCommandHeads
            .map((item: LooseObject) => ({
              commandHead: stringValue(item?.commandHead),
              count: Number(item?.count || 0),
            }))
            .filter((item: { commandHead: string }) => item.commandHead)
        : [],
    },
    importedAt: input.importedAt ? String(input.importedAt) : undefined,
    sourcePath: input.sourcePath ? String(input.sourcePath) : undefined,
    researchSlug: input.researchSlug ? String(input.researchSlug) : undefined,
  };
}

function ruleByKind(kind: string): SessionDecisionRule | null {
  return SESSION_DECISION_RULES.find((rule) => rule.kind === kind) || null;
}

function capsuleTimeMs(capsule: SessionDecisionCapsule): number {
  return (
    timestampMs(capsule.importedAt) ??
    timestampMs(capsule.generatedFrom.last) ??
    timestampMs(capsule.generatedFrom.first) ??
    0
  );
}

function timestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function objectOfNumbers(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as LooseObject)
      .map(([key, raw]) => [key, Number(raw)])
      .filter(([, numberValue]) => Number.isFinite(numberValue)),
  );
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function stringValue(value: unknown): string {
  return value == null ? "" : String(value);
}

function dedupeText(items: string[]): string[] {
  const seen = new Set<string>();
  const out = [];
  for (const item of items.map((value) => String(value || "").trim()).filter(Boolean)) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}
