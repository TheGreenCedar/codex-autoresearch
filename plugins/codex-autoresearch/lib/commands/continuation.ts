import path from "node:path";
import { quoteShellArg } from "../command-rendering.js";
import { buildDashboardSettings } from "./dashboard.js";
import { buildExperimentMemory } from "../experiment-memory.js";
import { activeQualityGapSlugCandidatesSync } from "../research-gaps.js";
import { resolvePackageRoot } from "../runtime-paths.js";
import { iterationLimitInfo } from "../session-core.js";
import type { UnknownRecord } from "../types/json.js";

type ContinuationCommandOptions = {
  researchSlug?: string;
  scriptPath: string;
  shellQuote: (value: string) => string;
  workDir: string;
};

type ContinuationStage = "state" | "doctor" | "logged" | "needs-log-decision" | string;

export function loopContinuation(
  workDir: string,
  state: UnknownRecord,
  config: UnknownRecord = {},
  stage: ContinuationStage | null = "state",
  options: { requiredStatus?: string | null; stopReason?: string } = {},
) {
  const mode = String(config.autonomyMode || "guarded");
  const limit = iterationLimitInfo(state as Parameters<typeof iterationLimitInfo>[0], config);
  const activeBudget = loopBudgetActive(limit) && mode !== "manual";
  const remainingBudget = loopBudgetRemainingText(limit);
  const commands = continuationCommands(workDir);
  const stateConfig = state.config as UnknownRecord;
  const memory = buildExperimentMemory({
    runs: Array.isArray(state.current) ? state.current : [],
    direction: String(stateConfig?.bestDirection || "lower"),
    settings: buildDashboardSettings(config),
  });
  const topLane = memory.diversityGuidance || memory.lanePortfolio?.[0];
  const stopConditions = [
    "user interrupts or turns the loop off",
    "packet, wall-clock, or iteration budget is reached",
    "benchmark or correctness checks are blocked",
    "the task is genuinely exhausted",
  ];
  if (options.stopReason) {
    return {
      mode,
      stage,
      shouldContinue: false,
      shouldAskUser: false,
      stopReason: options.stopReason,
      nextAction: options.stopReason,
      commands,
      stopConditions,
    };
  }
  if (stage === "needs-log-decision") {
    const logThenContinue = options.requiredStatus
      ? `Log this packet as ${options.requiredStatus} with rollback ASI, then continue to the next hypothesis.`
      : "Log this packet as keep or discard with ASI, then continue to the next hypothesis.";
    return {
      mode,
      stage,
      activeBudget,
      shouldContinue: activeBudget,
      shouldAskUser: false,
      requiresLogDecision: true,
      forbidFinalAnswer: mode === "owner-autonomous" || activeBudget,
      finalAnswerPolicy:
        mode === "owner-autonomous" || activeBudget
          ? "Do not send a final answer after this packet; log it, read continuation, and keep the budget moving until a stop condition appears."
          : "Report the pending log decision if the user only asked for state.",
      logThenContinue: true,
      afterLogAction:
        "After the log command succeeds, immediately read the returned continuation and run the next packet when the user asked for an ongoing budget.",
      nextAction: logThenContinue,
      commands,
      stopConditions,
    };
  }
  if (limit.limitReached) {
    return {
      mode,
      stage,
      shouldContinue: false,
      shouldAskUser: false,
      stopReason: limit.stopReason || `maxIterations reached (${limit.maxIterations}).`,
      nextAction:
        limit.budgetStatus?.nextAction ||
        "Export the dashboard and summarize the limit, or extend the session before more experiments.",
      commands,
      stopConditions,
    };
  }
  if (mode === "manual") {
    return {
      mode,
      stage,
      shouldContinue: false,
      shouldAskUser: true,
      stopReason: "autonomy_mode is manual.",
      nextAction: "Return the current state and wait for the operator before the next experiment.",
      commands,
      stopConditions,
    };
  }
  const ownerAutonomous = mode === "owner-autonomous";
  return {
    mode,
    stage,
    activeBudget,
    plateau: memory.plateau,
    lanePortfolio: memory.lanePortfolio,
    shouldContinue: true,
    shouldAskUser: false,
    forbidFinalAnswer: ownerAutonomous || activeBudget,
    finalAnswerPolicy:
      ownerAutonomous || activeBudget
        ? "Do not stop at a status report while iterations remain; continue running packets until the limit, blocker, exhaustion, or user interruption."
        : "A status report is acceptable when the user asked only to inspect state.",
    nextAction: ownerAutonomous
      ? memory.plateau?.detected
        ? `Keep the floor: run the ${topLane?.label || "distant scout"} lane next because the current search is plateauing.`
        : "Keep the floor: choose the next hypothesis from ASI/autoresearch.ideas.md, edit the scoped files, run next_experiment, and log the result without asking the user to invoke another subskill."
      : activeBudget
        ? memory.plateau?.detected
          ? `Keep going: run the ${topLane?.label || "distant scout"} lane next, log it, and continue because ${remainingBudget}.`
          : `Keep going: choose the next hypothesis, run next --compact, log the packet, and continue because ${remainingBudget}.`
        : "Continue the active loop when the current user request asks for iteration; otherwise report the state and next command.",
    commands,
    stopConditions,
  };
}

export function continuationCommands(workDir: string) {
  return buildContinuationCommands({
    researchSlug: activeQualityGapSlugCandidatesSync(workDir)[0]?.slug || "research",
    scriptPath: path.join(resolvePackageRoot(import.meta.url), "scripts", "autoresearch.mjs"),
    shellQuote: (value) => quoteShellArg(value),
    workDir,
  });
}

function loopBudgetActive(limit: UnknownRecord): boolean {
  if (limit.limitReached) return false;
  if (limit.maxIterations != null && Number(limit.remainingIterations) > 0) return true;
  const budget = (limit.budgetStatus || {}) as UnknownRecord;
  if (budget.configured !== true || budget.exhausted === true) return false;
  if (budget.packetsRemaining != null && Number(budget.packetsRemaining) <= 0) return false;
  return !(
    budget.wallClockRemainingSeconds != null && Number(budget.wallClockRemainingSeconds) <= 0
  );
}

function loopBudgetRemainingText(limit: UnknownRecord): string {
  const parts: string[] = [];
  if (limit.maxIterations != null && limit.remainingIterations != null) {
    parts.push(
      `${limit.remainingIterations} iteration${limit.remainingIterations === 1 ? "" : "s"}`,
    );
  }
  const budget = (limit.budgetStatus || {}) as UnknownRecord;
  if (budget.packetsRemaining != null) {
    parts.push(
      `${budget.packetsRemaining} packet${budget.packetsRemaining === 1 ? "" : "s"} in the packet budget`,
    );
  }
  if (budget.wallClockRemainingSeconds != null) {
    parts.push(`${budget.wallClockRemainingSeconds} wall-clock second(s)`);
  }
  return parts.length
    ? `the active budget still has ${parts.join(" and ")} left`
    : "the loop is still active";
}

export function buildContinuationCommands({
  researchSlug = "research",
  scriptPath,
  shellQuote,
  workDir,
}: ContinuationCommandOptions) {
  const cwd = shellQuote(workDir);
  const script = shellQuote(scriptPath);
  const slug = shellQuote(researchSlug);
  return {
    state: `node ${script} state --cwd ${cwd}`,
    stateCompact: `node ${script} state --cwd ${cwd} --compact`,
    doctor: `node ${script} doctor --cwd ${cwd}`,
    doctorExplain: `node ${script} doctor --cwd ${cwd} --explain`,
    next: `node ${script} next --cwd ${cwd} --compact`,
    nextFull: `node ${script} next --cwd ${cwd}`,
    keepLast: `node ${script} log --cwd ${cwd} --from-last --status keep --description "Describe the kept change"`,
    measureLast: `node ${script} log --cwd ${cwd} --from-last --status measure --description "Baseline measurement"`,
    discardLast: `node ${script} log --cwd ${cwd} --from-last --status discard --description "Describe the discarded change"`,
    ledgerDoctor: `node ${script} ledger-doctor --cwd ${cwd} --json`,
    partialResults: `node ${script} partial-results --cwd ${cwd} --from-last`,
    laneRunner: `node ${script} lane-runner --cwd ${cwd} --dry-run`,
    gapCandidates: `node ${script} gap-candidates --cwd ${cwd} --research-slug ${slug}`,
    liveDashboard: `node ${script} serve --cwd ${cwd}`,
    exportDashboard: `node ${script} export --cwd ${cwd}`,
    extendLimit: `node ${script} config --cwd ${cwd} --extend 10`,
    onboardingPacket: `node ${script} onboarding-packet --cwd ${cwd} --compact`,
    recommendNext: `node ${script} recommend-next --cwd ${cwd} --compact`,
    setupPlan: `node ${script} setup-plan --cwd ${cwd}`,
    codexGoalBrief: `node ${script} codex-goal-brief --cwd ${cwd}`,
    benchmarkInspect: `node ${script} benchmark-inspect --cwd ${cwd}`,
    benchmarkLint: `node ${script} benchmark-lint --cwd ${cwd}`,
    checksInspect: `node ${script} checks-inspect --cwd ${cwd} --command "replace with exact checks command"`,
    newSegmentDryRun: `node ${script} new-segment --cwd ${cwd} --dry-run`,
    promoteGateDryRun: `node ${script} promote-gate --cwd ${cwd} --reason "describe promoted measurement" --dry-run`,
    finalizePreview: `node ${script} finalize-preview --cwd ${cwd}`,
    finalizeCurrentTree: `node ${script} finalize-current-tree --cwd ${cwd} --exclude-session-artifacts`,
  };
}
