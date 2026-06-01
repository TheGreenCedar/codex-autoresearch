export type GoalObjectiveRole =
  | "missing"
  | "matching_research_goal"
  | "operator_instruction"
  | "different_research_goal";

export interface GoalFrameInput {
  autoresearchGoal?: unknown;
  codexGoalObjective?: unknown;
}

export interface GoalFrame {
  authoritativeGoal: string;
  codexGoalObjective: string;
  codexObjectiveRole: GoalObjectiveRole;
  mismatch: boolean;
  warning: string;
  operatorLine: string;
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
