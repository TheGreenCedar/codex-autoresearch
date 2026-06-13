export type GoalObjectiveRole =
  | "missing"
  | "matching_research_goal"
  | "operator_instruction"
  | "different_research_goal";

export interface GoalFrameInput {
  autoresearchGoal?: unknown;
  codexGoalObjective?: unknown;
}

export interface GoalContractInput extends GoalFrameInput {
  benchmarkGoal?: unknown;
  finalizationClaim?: unknown;
  recoveryCommand?: unknown;
}

export interface GoalFrame {
  authoritativeGoal: string;
  codexGoalObjective: string;
  codexObjectiveRole: GoalObjectiveRole;
  mismatch: boolean;
  warning: string;
  operatorLine: string;
}

export interface GoalContract extends GoalFrame {
  benchmarkGoal: string;
  finalizationClaim: string;
  status: "ok" | "warning" | "blocked";
  blockers: string[];
  warnings: string[];
  recoveryCommand: string;
  blocksPacket: boolean;
  blocksFinalization: boolean;
}

export function buildGoalFrame({
  autoresearchGoal,
  codexGoalObjective,
}: GoalFrameInput = {}): GoalFrame {
  const authoritativeGoal = cleanGoal(autoresearchGoal);
  const codexObjective = cleanGoal(codexGoalObjective);
  const role = classifyCodexObjective(authoritativeGoal, codexObjective);
  const mismatch = role === "operator_instruction" || role === "different_research_goal";
  const warning = mismatch
    ? "Codex prompt is not the research goal; continue from the durable Autoresearch goal."
    : "";

  return {
    authoritativeGoal,
    codexGoalObjective: codexObjective,
    codexObjectiveRole: role,
    mismatch,
    warning,
    operatorLine: authoritativeGoal
      ? `Research goal: ${authoritativeGoal}`
      : "Research goal is not configured; run setup-plan or prompt-plan before packet work.",
  };
}

export function buildGoalContract({
  autoresearchGoal,
  codexGoalObjective,
  benchmarkGoal,
  finalizationClaim,
  recoveryCommand,
}: GoalContractInput = {}): GoalContract {
  const frame = buildGoalFrame({ autoresearchGoal, codexGoalObjective });
  const normalizedBenchmarkGoal = cleanGoal(benchmarkGoal);
  const normalizedFinalizationClaim = cleanGoal(finalizationClaim);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const command =
    cleanGoal(recoveryCommand) || "node scripts/autoresearch.mjs codex-goal-brief --cwd <project>";

  if (!frame.authoritativeGoal) {
    warnings.push(
      "Autoresearch has no durable goal; run setup-plan or prompt-plan before packet work.",
    );
  }
  if (frame.codexObjectiveRole === "missing") {
    warnings.push(
      "No live Codex goal objective was provided; refresh the Codex goal brief before broad work.",
    );
  }
  if (frame.mismatch && frame.authoritativeGoal) {
    blockers.push(frame.warning || "Codex prompt does not match the durable Autoresearch goal.");
  } else if (frame.mismatch) {
    warnings.push(frame.warning || "Codex prompt is an operator instruction, not a durable goal.");
  }
  if (
    normalizedBenchmarkGoal &&
    frame.authoritativeGoal &&
    !sameGoal(frame.authoritativeGoal, normalizedBenchmarkGoal)
  ) {
    blockers.push("Benchmark goal differs from the durable Autoresearch goal.");
  }
  if (
    normalizedFinalizationClaim &&
    frame.authoritativeGoal &&
    !sameGoal(frame.authoritativeGoal, normalizedFinalizationClaim)
  ) {
    blockers.push("Finalization claim differs from the durable Autoresearch goal.");
  }

  const blocksPacket = blockers.length > 0;
  const blocksFinalization = blocksPacket || Boolean(normalizedFinalizationClaim && frame.mismatch);
  const status = blockers.length > 0 ? "blocked" : warnings.length > 0 ? "warning" : "ok";

  return {
    ...frame,
    benchmarkGoal: normalizedBenchmarkGoal,
    finalizationClaim: normalizedFinalizationClaim,
    status,
    blockers,
    warnings,
    recoveryCommand: command,
    blocksPacket,
    blocksFinalization,
  };
}

function classifyCodexObjective(
  autoresearchGoal: string,
  codexObjective: string,
): GoalObjectiveRole {
  if (!codexObjective) return "missing";
  if (sameGoal(autoresearchGoal, codexObjective)) return "matching_research_goal";
  if (looksLikeOperatorInstruction(codexObjective)) return "operator_instruction";
  return "different_research_goal";
}

function cleanGoal(value: unknown): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function sameGoal(left: string, right: string): boolean {
  const normalizedLeft = normalizeGoal(left);
  return normalizedLeft !== "" && normalizedLeft === normalizeGoal(right);
}

function normalizeGoal(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeOperatorInstruction(value: string): boolean {
  return /\b(continue|resume|start by|state|starting the goal|where we left off|please)\b/i.test(
    value,
  );
}
