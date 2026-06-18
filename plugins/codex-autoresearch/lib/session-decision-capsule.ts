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
    kind: "setup_not_started",
    severity: "blocker",
    enforcement: {
      mode: "hard-block",
      canRunNextPacket: false,
      allowBoundedNext: false,
      blocksFinalization: true,
      clearingCondition:
        "Run doctor and a first trusted next/log or baseline measurement, then record the loop-start evidence before claiming Autoresearch progress.",
      commandHint:
        "node scripts/autoresearch.mjs doctor --cwd <project> --check-benchmark --explain",
      triggeredBy: ["sessionDecisionCapsule", "loopStart"],
    },
    patterns: [],
    message:
      "The session says setup or scaffold work happened, but the measured Autoresearch loop did not start.",
    bottleneck:
      "The loop has not started; scaffold files and setup output are not measurement evidence.",
    nextExperiment:
      "Run doctor, prove the benchmark contract, then execute and log the first bounded packet or explicit baseline measurement.",
    wrongNextActions: [
      "Do not mark setup or scaffold creation as an Autoresearch run.",
      "Do not finalize, complete the Codex goal, or summarize progress before the loop has measured evidence.",
    ],
  },
  {
    kind: "fixed_control_rerun_correction",
    severity: "blocker",
    enforcement: {
      mode: "hard-block",
      canRunNextPacket: false,
      allowBoundedNext: false,
      blocksFinalization: true,
      clearingCondition:
        "Reuse the configured fixed control artifact, or document the manual invalidator check and explicit override before any control rerun.",
      commandHint: "node scripts/autoresearch.mjs state --cwd <project> --compact",
      triggeredBy: ["sessionDecisionCapsule", "fixedControl"],
    },
    patterns: [],
    message:
      "The session corrected a control rerun; reuse the fixed control artifact unless an operator has documented an invalidator change.",
    bottleneck:
      "The fixed control artifact is the comparison baseline; rerunning the control would break comparability.",
    nextExperiment:
      "Load or reuse the fixed control artifact. If an invalidator changed, update fixedControl manually and pass an explicit override before rerunning control work.",
    wrongNextActions: [
      "Do not rerun a named baseline or control just because the benchmark command is available.",
      "Do not replace a fixed control artifact without recording the manual invalidator check.",
    ],
  },
  {
    kind: "overfit_correction",
    severity: "blocker",
    enforcement: {
      mode: "hard-block",
      canRunNextPacket: false,
      allowBoundedNext: false,
      blocksFinalization: true,
      clearingCondition:
        "Remove answer-key, filename-specific, or repo-specific steering and pass a blind holdout, breadth gate, or explicit generalization audit.",
      commandHint: "node scripts/autoresearch.mjs state --cwd <project> --compact",
      triggeredBy: ["sessionDecisionCapsule", "overfitCorrection"],
    },
    patterns: [],
    message:
      "The session flags hard-coded, repo-specific, or answer-key-shaped evidence that needs generalization proof.",
    bottleneck:
      "The immediate blocker is generalization trust: the evidence may be hard-coded to known answers instead of product behavior.",
    nextExperiment:
      "Strip the hard-coded or repo-specific steering, rerun on a blind holdout or broader fixture, and downgrade existing evidence until that passes.",
    wrongNextActions: [
      "Do not ship filename-specific, repo-specific, or answer-key-shaped fixes as product evidence.",
      "Do not finalize broad claims until a holdout or breadth gate proves the behavior generalizes.",
    ],
  },
  {
    kind: "product_bar_rejection",
    severity: "blocker",
    enforcement: {
      ...BOUNDED_NEXT_REQUIRED,
      blocksFinalization: true,
      clearingCondition:
        "Add claim coverage evidence or restart with explicit product-grade acceptance before finalization.",
      commandHint: "node scripts/autoresearch.mjs state --cwd <project> --compact",
    },
    patterns: [],
    message: "The session rejected done status because product-grade proof was missing.",
    bottleneck:
      "The immediate blocker is product proof: the loop must cover the shipped claim before finalization.",
    nextExperiment:
      "Add claim coverage evidence for the product claim, then rerun the narrow acceptance check.",
    wrongNextActions: [
      "Do not finalize from loop completion alone.",
      "Do not treat a metric improvement as shippable product proof without claim coverage.",
    ],
  },
  {
    kind: "false_done_admission",
    severity: "warning",
    enforcement: BOUNDED_NEXT_REQUIRED,
    patterns: [],
    message: "The assistant admitted loop completion was mistaken for product proof.",
    bottleneck:
      "Evidence maturity is overstated; downgrade the claim or restart with product-grade acceptance.",
    nextExperiment:
      "Reclassify the evidence maturity, name the missing acceptance proof, and run a bounded acceptance packet.",
    wrongNextActions: [
      "Do not continue as if the previous done claim was valid.",
      "Do not hide the maturity downgrade in summary prose.",
    ],
  },
  {
    kind: "stale_segment_pickup",
    severity: "warning",
    enforcement: BOUNDED_NEXT_REQUIRED,
    patterns: [],
    message: "The session indicates a stale or unexpected segment was picked up.",
    bottleneck:
      "Segment state is stale; continuing from the wrong segment can spend packets against obsolete evidence.",
    nextExperiment:
      "Inspect state --compact, then start a fresh segment or explicitly acknowledge the current segment before another bounded packet.",
    wrongNextActions: [
      "Do not continue from an old segment without checking the active segment and latest packet freshness.",
    ],
  },
  {
    kind: "goal_churn_or_early_completion",
    severity: "warning",
    enforcement: BOUNDED_NEXT_REQUIRED,
    patterns: [],
    message:
      "The session indicates Codex goal churn or early completion before loop evidence was resolved.",
    bottleneck:
      "Codex Goal lifecycle is drifting ahead of Autoresearch evidence and unresolved blockers.",
    nextExperiment:
      "Run codex-goal-brief with the current Goal status and completion evidence, then obey the completion audit before update_goal.",
    wrongNextActions: [
      "Do not call update_goal(status=complete) while Autoresearch state still has blockers or unresolved review evidence.",
    ],
  },
  {
    kind: "benchmark_contract_broken",
    severity: "blocker",
    enforcement: HARD_BENCHMARK_CONTRACT,
    patterns: [
      /benchmark-lint.*(timeout|timed out|zero `?METRIC|parses zero|no primary metric)/i,
      /primary benchmark contract.*broken/i,
      /wrapper.*too expensive.*contract/i,
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
    kind: "benchmark_overfit_steering",
    severity: "blocker",
    enforcement: {
      mode: "hard-block",
      canRunNextPacket: false,
      allowBoundedNext: false,
      blocksFinalization: true,
      clearingCondition:
        "Record the overfit/generalization audit, downgrade row-specific evidence, and pass a blind holdout, breadth, or promotion gate before finalization.",
      commandHint: "node scripts/autoresearch.mjs state --cwd <project> --compact",
      triggeredBy: ["sessionDecisionCapsule", "benchmarkOverfit"],
    },
    patterns: [
      /\boverfit(?:ted|ting)?\b/i,
      /benchmark[- ]specific|test[- ]specific|row[- ]specific/i,
      /task[- ]family detectors?|protected probes?|static citations?|exact (?:files?|symbols?|libraries?)/i,
      /retrieval steering|answer key|learned the test/i,
    ],
    message: "The session flagged benchmark-specific steering or overfit row wins.",
    bottleneck:
      "The immediate blocker is epistemic trust: targeted benchmark wins may be row-specific repairs rather than general product proof.",
    nextExperiment:
      "Split general harness changes from row-specific repairs, log row wins as diagnostic/provisional, then run a blind holdout or breadth gate before promotion.",
    wrongNextActions: [
      "Do not add more task-family detectors, protected probes, or static citations as product wins.",
      "Do not finalize broad product superiority claims from targeted row metrics.",
      "Do not reuse changed benchmark rows as holdout evidence.",
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
    kind: "goal_frame_mismatch",
    severity: "warning",
    enforcement: BOUNDED_NEXT_REQUIRED,
    patterns: [
      /not (the )?goal of (the )?autoresearch/i,
      /not (the )?(autoresearch|research) goal/i,
      /that'?s not.*goal.*(prompt|instruction)/i,
      /(codex|operator|user) prompt.*not.*(autoresearch|research) goal/i,
      /prompt is not the (autoresearch|research) goal/i,
    ],
    message:
      "The session contains explicit feedback that the Codex prompt was mistaken for the durable Autoresearch goal.",
    bottleneck:
      "The immediate loop risk is goal-frame drift: the Codex prompt is an operator instruction, not the research goal.",
    nextExperiment:
      "Restate the durable Autoresearch goal from project state, then run only a bounded packet that targets that goal.",
    wrongNextActions: [
      "Do not treat the latest Codex prompt as the research goal.",
      "Do not run a broad packet until the durable Autoresearch goal is restated.",
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
    if (rule.kind === "benchmark_overfit_steering" && !isBenchmarkOverfitSteeringFeedback(text)) {
      continue;
    }
    findings.push({
      kind: rule.kind,
      severity: rule.severity,
      message: rule.message,
      source,
    });
  }
  return findings;
}

function isBenchmarkOverfitSteeringFeedback(text: string): boolean {
  return benchmarkOverfitFeedbackSegments(text).some(isBenchmarkOverfitSteeringSegment);
}

function benchmarkOverfitFeedbackSegments(text: string): string[] {
  return text
    .split(
      /(?:[.!?;]+|\bbut\b|\bhowever\b|\band the current\b|\band the latest\b|\bwhile the current\b|\bwhile the latest\b)/i,
    )
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function isBenchmarkOverfitSteeringSegment(segment: string): boolean {
  const hasOverfitClaim =
    /\boverfit(?:ted|ting)?\b/i.test(segment) && !hasNegatedOverfitFeedback(segment);
  const hasLearnedTestClaim =
    /learned the test/i.test(segment) && !hasNegatedLearnedTestFeedback(segment);
  const hasAnswerKeyClaim =
    /\banswer key\b/i.test(segment) && !hasNegatedAnswerKeyFeedback(segment);
  const hasScopedSteeringClaim =
    hasPositiveBenchmarkScope(segment) && hasPositiveSteeringMechanism(segment);
  return hasOverfitClaim || hasLearnedTestClaim || hasAnswerKeyClaim || hasScopedSteeringClaim;
}

function hasPositiveBenchmarkScope(text: string): boolean {
  return (
    /benchmark[- ]specific|test[- ]specific|row[- ]specific/i.test(text) &&
    !/\b(?:not|no|without)\s+(?:benchmark[- ]specific|test[- ]specific|row[- ]specific)\b/i.test(
      text,
    )
  );
}

function hasPositiveSteeringMechanism(text: string): boolean {
  return (
    hasPositiveBareScopedSteering(text) ||
    (/\bretrieval steering\b/i.test(text) && !hasNegatedRetrievalSteeringFeedback(text)) ||
    (/\btask[- ]family detectors?\b/i.test(text) && !hasNegatedTaskFamilyDetectorFeedback(text)) ||
    (/\bprotected probes?\b/i.test(text) && !hasNegatedProtectedProbeFeedback(text)) ||
    (/\bstatic citations?\b/i.test(text) && !hasNegatedStaticCitationFeedback(text)) ||
    hasPositiveExactReference(text)
  );
}

function hasPositiveExactReference(text: string): boolean {
  return (
    /\bexact (?:files?|symbols?|libraries?)\b/i.test(text) &&
    !hasNegatedExactReferenceFeedback(text)
  );
}

function hasPositiveBareScopedSteering(text: string): boolean {
  return (
    /\b(?:benchmark[- ]specific|test[- ]specific|row[- ]specific)\s+steering\b/i.test(text) &&
    !hasNegatedBareScopedSteeringFeedback(text)
  );
}

function hasNegatedOverfitFeedback(text: string): boolean {
  return (
    /\bnot\s+(?:an?\s+|substantially\s+)?overfit(?:ted|ting)?\b/i.test(text) ||
    /\bno evidence(?:\s+of)?\b[^.?!;]*\boverfit(?:ted|ting)?\b/i.test(text) ||
    /\bruled out\b[^.?!;]*\boverfit(?:ted|ting)?\b/i.test(text) ||
    /\bavoided\b[^.?!;]*\boverfit(?:ted|ting)?\b/i.test(text)
  );
}

function hasNegatedAnswerKeyFeedback(text: string): boolean {
  return (
    hasDirectiveNegationFor(text, String.raw`answer key(?:\s+logic)?`) ||
    /\bno evidence(?:\s+of)?\b[^.?!;]*\banswer key(?:\s+logic)?\b/i.test(text) ||
    /\b(?:no|not)\s+answer key(?:\s+logic)?\b/i.test(text) ||
    /\bwithout\b[^.?!;]*\banswer key(?:\s+logic)?\b/i.test(text) ||
    /\bavoided\b[^.?!;]*\banswer key(?:\s+logic)?\b/i.test(text) ||
    /\bruled out\b[^.?!;]*\banswer key(?:\s+logic)?\b/i.test(text)
  );
}

function hasNegatedLearnedTestFeedback(text: string): boolean {
  return (
    /\b(?:had\s+)?not\s+learned the test\b/i.test(text) ||
    /\bnever\s+learned the test\b/i.test(text) ||
    /\bno evidence\b[^.?!;]*\blearned the test\b/i.test(text)
  );
}

function hasNegatedBareScopedSteeringFeedback(text: string): boolean {
  return (
    hasDirectiveNegationFor(
      text,
      String.raw`(?:benchmark[- ]specific|test[- ]specific|row[- ]specific)\s+steering`,
    ) ||
    /\b(?:not|no)\s+(?:benchmark[- ]specific|test[- ]specific|row[- ]specific)\s+steering\b/i.test(
      text,
    ) ||
    /\bwithout\s+(?:row[- ]specific|benchmark[- ]specific|test[- ]specific)\s+steering\b/i.test(
      text,
    )
  );
}

function hasNegatedRetrievalSteeringFeedback(text: string): boolean {
  return (
    hasDirectiveNegationFor(
      text,
      String.raw`(?:(?:benchmark|test|row)[- ]specific\s+)?retrieval steering`,
    ) ||
    /\bnot\s+(?:(?:benchmark|test|row)[- ]specific\s+)?retrieval steering\b/i.test(text) ||
    /\bno\s+(?:(?:benchmark|test|row)[- ]specific\s+)?retrieval steering\b/i.test(text)
  );
}

function hasNegatedTaskFamilyDetectorFeedback(text: string): boolean {
  return (
    hasDirectiveNegationFor(text, String.raw`task[- ]family detectors?`) ||
    /\b(?:no|not|without)\s+task[- ]family detectors?\b/i.test(text)
  );
}

function hasNegatedProtectedProbeFeedback(text: string): boolean {
  return (
    hasDirectiveNegationFor(text, String.raw`protected probes?`) ||
    /\b(?:no|not|without)\s+protected probes?\b/i.test(text)
  );
}

function hasNegatedStaticCitationFeedback(text: string): boolean {
  return (
    hasDirectiveNegationFor(text, String.raw`static citations?`) ||
    /\b(?:no|not|without)\s+static citations?\b/i.test(text)
  );
}

function hasNegatedExactReferenceFeedback(text: string): boolean {
  return (
    hasDirectiveNegationFor(text, String.raw`exact (?:files?|symbols?|libraries?)`) ||
    /\b(?:no|not|without)\s+exact (?:files?|symbols?|libraries?)\b/i.test(text)
  );
}

function hasDirectiveNegationFor(text: string, targetPattern: string): boolean {
  return new RegExp(
    String.raw`\bdo\s+not\s+(?:add|use|introduce|rely\s+on|count|treat|reuse)\b[^.?!;]*\b(?:${targetPattern})\b`,
    "i",
  ).test(text);
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
      .map(decisionEvidenceMessage),
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
  return hasCommandFile || (hasCommand && hasExplicitTimeout);
}

function selectRule(
  signals: CapsuleSignal[],
  input: SessionDecisionCapsuleInput,
  outputBudget: CapsuleSignal[],
): SessionDecisionRule {
  const kinds = new Set(signals.map((signal) => signal.kind));
  for (const kind of [
    "benchmark_contract_broken",
    "setup_not_started",
    "fixed_control_rerun_correction",
    "overfit_correction",
    "benchmark_overfit_steering",
    "product_bar_rejection",
    "false_done_admission",
    "goal_frame_mismatch",
    "stale_segment_pickup",
    "goal_churn_or_early_completion",
    "search_latency_bottleneck",
    "metric_reframe_feedback",
  ]) {
    const rule = ruleByKind(kind);
    if (rule && kinds.has(kind)) return rule;
  }
  if (kinds.has("context_distillation_required")) {
    return ruleByKind("context_distillation_required")!;
  }
  if (outputBudget.length) return ruleByKind("output_budget_exceeded")!;
  for (const kind of [
    "probe_churn_feedback",
    "skill_preflight_feedback",
    "carry_forward_request",
  ]) {
    const rule = ruleByKind(kind);
    if (rule && kinds.has(kind)) return rule;
  }
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
    ["setup_not_started", 1],
    ["fixed_control_rerun_correction", 2],
    ["overfit_correction", 3],
    ["benchmark_overfit_steering", 4],
    ["product_bar_rejection", 5],
    ["false_done_admission", 6],
    ["goal_frame_mismatch", 7],
    ["stale_segment_pickup", 8],
    ["goal_churn_or_early_completion", 9],
    ["search_latency_bottleneck", 10],
    ["metric_reframe_feedback", 11],
    ["probe_churn_feedback", 12],
    ["skill_preflight_feedback", 13],
    ["carry_forward_request", 14],
    ["context_distillation_required", 15],
    ["oversized_tool_output", 16],
    ["closed_stdin_poll", 17],
    ["output_budget_exceeded", 18],
    ["quality_gap_wording", 19],
  ]);
  const byKind = new Map<string, CapsuleSignal>();
  for (const signal of [...productSignals, ...workflowWaste].sort(
    (left, right) => (priority.get(left.kind) ?? 99) - (priority.get(right.kind) ?? 99),
  )) {
    const existing = byKind.get(signal.kind);
    if (existing) {
      existing.count = Number(existing.count || 1) + 1;
      continue;
    }
    byKind.set(signal.kind, { ...signal, count: signal.count || 1 });
  }
  return [...byKind.values()];
}

function decisionEvidenceMessage(signal: CapsuleSignal): string {
  const count = Number(signal.count || 0);
  return count > 1 ? `${signal.message} (${count} occurrences)` : signal.message;
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
