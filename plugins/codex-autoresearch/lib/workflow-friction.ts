import { resolveDecisionThresholds, type DecisionThresholdConfig } from "./decision-thresholds.js";

type LooseObject = Record<string, any>;

export type WorkflowFrictionKind =
  | "output_budget_exceeded"
  | "verification_churn"
  | "dirty_tree_recovery"
  | "unknown_recipe"
  | "quality_gap_wording"
  | "metric_saturated_not_promotable"
  | "product_bar_rejection"
  | "false_done_admission"
  | "benchmark_overfit_steering"
  | "oversized_tool_output"
  | "closed_stdin_poll";

export interface WorkflowFrictionSignal {
  kind: WorkflowFrictionKind;
  severity: "info" | "warning" | "blocker";
  reason: string;
  commandHead?: string;
  count?: number;
  reportedSize?: { tokens?: number; lines?: number };
  affectedFiles?: string[];
  suggestedAction: {
    kind: "workflow-friction";
    priority: number;
    reason: string;
    command?: string;
    triggeredBy?: string[];
  };
}

export function analyzeWorkflowFriction({
  state = {},
  forensics = null,
  lastRun = null,
  thresholds: thresholdConfig = {},
  warningDetails = [],
  recipes = [],
}: LooseObject = {}): WorkflowFrictionSignal[] {
  const thresholds = resolveThresholds(thresholdConfig);
  const signals: WorkflowFrictionSignal[] = [];
  signals.push(...outputBudgetSignals({ forensics, lastRun, thresholds }));
  signals.push(...forensicsFrictionSignals({ forensics }));
  signals.push(...verificationChurnSignals({ state, thresholds }));
  signals.push(...dirtyTreeSignals({ state, warningDetails }));
  const unknown = unknownRecipeSignal({ state, recipes });
  if (unknown) signals.push(unknown);
  const qualityGap = qualityGapWordingSignal({ state });
  if (qualityGap) signals.push(qualityGap);
  const saturation = metricSaturationSignal({ state });
  if (saturation) signals.push(saturation);
  return dedupeSignals(signals);
}

function forensicsFrictionSignals({
  forensics,
}: {
  forensics: LooseObject | null;
}): WorkflowFrictionSignal[] {
  const signals: WorkflowFrictionSignal[] = [];
  const sourceSignals = [
    ...arrayValue(forensics?.productSignals),
    ...arrayValue(forensics?.workflowWaste),
  ];
  for (const signal of sourceSignals) {
    const kind = String(signal?.kind || "");
    if (
      ![
        "product_bar_rejection",
        "false_done_admission",
        "benchmark_overfit_steering",
        "oversized_tool_output",
        "closed_stdin_poll",
      ].includes(kind)
    ) {
      continue;
    }
    signals.push(
      workflowSignal({
        kind: kind as WorkflowFrictionKind,
        severity:
          kind === "product_bar_rejection" || kind === "benchmark_overfit_steering"
            ? "blocker"
            : "warning",
        reason: signal?.message || forensicsSignalReason(kind),
        reportedSize: {
          tokens: finitePositive(signal?.size?.tokens),
          lines: finitePositive(signal?.size?.lines),
        },
        actionReason: forensicsSignalAction(kind),
      }),
    );
  }
  return signals;
}

function outputBudgetSignals({
  forensics,
  lastRun,
  thresholds,
}: {
  forensics: LooseObject | null;
  lastRun: LooseObject | null;
  thresholds: DecisionThresholdConfig;
}): WorkflowFrictionSignal[] {
  const signals: WorkflowFrictionSignal[] = [];
  for (const signal of forensics?.workflowWaste || forensics?.signals || []) {
    if (signal?.kind !== "output_budget_exceeded") continue;
    const detail = signal.details || signal.size || {};
    signals.push(
      workflowSignal({
        kind: "output_budget_exceeded",
        severity: "warning",
        reason: signal.message || "A command exceeded the output budget.",
        reportedSize: {
          tokens: finitePositive(detail.tokenCount),
          lines: finitePositive(detail.lines),
        },
        commandHead: detail.commandHead || detail.commandClass || "unknown",
        actionReason:
          "Use a bounded summary command or write large output to an artifact before continuing.",
      }),
    );
  }
  const stdoutTailLines = String(lastRun?.packetEvidence?.stdoutTail || "")
    .split(/\r?\n/)
    .filter(Boolean).length;
  if (
    lastRun?.run?.outputTruncated ||
    lastRun?.run?.metricsTruncated ||
    stdoutTailLines >= thresholds.outputCommandLineBudget
  ) {
    signals.push(
      workflowSignal({
        kind: "output_budget_exceeded",
        severity: "warning",
        reason:
          "The last packet output was truncated; inspect the saved packet or artifact summary instead of rerunning a noisy command.",
        reportedSize: {
          lines: stdoutTailLines,
        },
        commandHead: commandHead(lastRun?.packetEvidence?.commandIdentity?.command || ""),
        actionReason: "Switch to a bounded command or artifact summary before another packet.",
      }),
    );
  }
  return signals;
}

function verificationChurnSignals({
  state,
  thresholds,
}: {
  state: LooseObject;
  thresholds: DecisionThresholdConfig;
}): WorkflowFrictionSignal[] {
  const runs = Array.isArray(state.current) ? state.current : [];
  const commandCounts = countCommandHeads(
    runs.map((run) => run?.benchmarkContract?.command || run?.command || run?.description || ""),
  );
  const checksCounts = countCommandHeads(
    runs.map((run) => run?.benchmarkContract?.checksCommand || ""),
  );
  const signals: WorkflowFrictionSignal[] = [];
  for (const [head, count] of commandCounts) {
    if (count >= thresholds.repeatedCommandHeadCount) {
      signals.push(
        workflowSignal({
          kind: "verification_churn",
          severity: "warning",
          reason: `Command head '${head}' ran ${count} times in this segment.`,
          commandHead: head,
          count,
          actionReason:
            "Checkpoint the evidence, batch verification, or pivot lanes before repeating it.",
        }),
      );
    }
  }
  for (const [head, count] of checksCounts) {
    if (count >= thresholds.repeatedCheckHeadCount) {
      signals.push(
        workflowSignal({
          kind: "verification_churn",
          severity: "warning",
          reason: `Check command '${head}' ran ${count} times without a clear source checkpoint.`,
          commandHead: head,
          count,
          actionReason:
            "Checkpoint source changes or run a narrower targeted check before another broad check.",
        }),
      );
    }
  }
  return signals;
}

function dirtyTreeSignals({
  state,
  warningDetails,
}: {
  state: LooseObject;
  warningDetails: LooseObject[];
}): WorkflowFrictionSignal[] {
  const warnings = Array.isArray(warningDetails)
    ? warningDetails.filter((warning) =>
        ["git_dirty", "missing_commit_paths"].includes(String(warning?.code || "")),
      )
    : [];
  if (warnings.length === 0) return [];
  const commitPaths = Array.isArray(state.config?.commitPaths) ? state.config.commitPaths : [];
  const revertPaths = Array.isArray(state.config?.revertPaths) ? state.config.revertPaths : [];
  const affectedFiles = [...new Set([...commitPaths, ...revertPaths])];
  return [
    workflowSignal({
      kind: "dirty_tree_recovery",
      severity: "blocker",
      reason: warnings[0]?.message || "Dirty source state blocks safe logging or cleanup.",
      affectedFiles,
      actionReason: affectedFiles.length
        ? `Use scoped commit/revert paths (${affectedFiles.slice(0, 4).join(", ")}) before continuing.`
        : "Group the dirty files and set commitPaths or revertPaths before continuing.",
    }),
  ];
}

function unknownRecipeSignal({
  state,
  recipes,
}: {
  state: LooseObject;
  recipes: LooseObject[];
}): WorkflowFrictionSignal | null {
  const recipe = String(state.config?.recipeId || state.config?.recipe || "");
  if (!recipe) return null;
  const known = new Set((recipes || []).map((item) => String(item.id || item.recipeId || "")));
  if (known.size === 0 || known.has(recipe)) return null;
  const closest = [...known].filter(Boolean).slice(0, 3).join(", ");
  return workflowSignal({
    kind: "unknown_recipe",
    severity: "warning",
    reason: `Configured recipe '${recipe}' is not in the available recipe catalog.`,
    actionReason: closest
      ? `Use one of the nearest known recipes (${closest}) or pass the trusted catalog again.`
      : "List recipes or provide custom recipe catalog metadata before setup.",
  });
}

function qualityGapWordingSignal({ state }: { state: LooseObject }): WorkflowFrictionSignal | null {
  if (state.config?.metricName !== "quality_gap") return null;
  const open = Number(state.qualityGap?.open);
  if (!Number.isFinite(open) || open <= 0) return null;
  return workflowSignal({
    kind: "quality_gap_wording",
    severity: "info",
    reason: `${open} accepted quality-gap checklist item${open === 1 ? "" : "s"} remain open.`,
    actionReason:
      "Describe quality_gap as accepted checklist count, not as a perfect score or universal quality benchmark.",
  });
}

function metricSaturationSignal({ state }: { state: LooseObject }): WorkflowFrictionSignal | null {
  const metricName = String(state.config?.metricName || "");
  const direction = String(state.config?.bestDirection || "lower");
  const best = Number(state.best ?? state.development?.best);
  const qualityRoundClosed =
    Number(state.qualityGap?.open) === 0 && Number(state.qualityGap?.total) > 0;
  const gapMetricSaturated =
    direction !== "higher" &&
    Number.isFinite(best) &&
    best === 0 &&
    /gap|debt|risk|issue|bug|fail|loss/i.test(metricName);
  if (!qualityRoundClosed && !gapMetricSaturated) return null;

  const evidenceLabels = Array.isArray(state.researchIntegrity?.evidenceLabels)
    ? state.researchIntegrity.evidenceLabels.map(String)
    : [];
  const notPromotableBecause = Array.isArray(state.researchIntegrity?.notPromotableBecause)
    ? state.researchIntegrity.notPromotableBecause.map(String).filter(Boolean)
    : [];
  const promotionEligible =
    evidenceLabels.includes("promotion_eligible") ||
    state.promotion?.eligible === true ||
    Number(state.promotion?.kept ?? 0) > 0;
  if (promotionEligible) return null;

  return workflowSignal({
    kind: "metric_saturated_not_promotable",
    severity: "warning",
    reason:
      notPromotableBecause[0] ||
      `${metricName || "Primary metric"} is saturated, but promotion-grade evidence is still missing.`,
    actionReason:
      "Treat metric saturation as a review/rescope checkpoint: check promotion evidence, run finalize-preview/current-tree, or start a new segment instead of spending another same-metric packet.",
    commandHead: metricName || "primary metric",
  });
}

function workflowSignal({
  kind,
  severity,
  reason,
  actionReason,
  commandHead,
  count,
  reportedSize,
  affectedFiles,
}: Omit<WorkflowFrictionSignal, "suggestedAction"> & {
  actionReason: string;
}): WorkflowFrictionSignal {
  return {
    kind,
    severity,
    reason,
    ...(commandHead ? { commandHead } : {}),
    ...(count != null ? { count } : {}),
    ...(reportedSize ? { reportedSize } : {}),
    ...(affectedFiles?.length ? { affectedFiles } : {}),
    suggestedAction: {
      kind: "workflow-friction",
      priority: severity === "blocker" ? 2 : 3,
      reason: actionReason,
      triggeredBy: [kind],
    },
  };
}

function countCommandHeads(commands: unknown[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const command of commands) {
    const head = commandHead(command);
    if (!head) continue;
    counts.set(head, (counts.get(head) || 0) + 1);
  }
  return counts;
}

function commandHead(command: unknown): string {
  const parts = String(command || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return parts.slice(0, 3).join(" ");
}

function finitePositive(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function arrayValue(value: unknown): LooseObject[] {
  return Array.isArray(value)
    ? value.map((item) => (item && typeof item === "object" ? (item as LooseObject) : {}))
    : [];
}

function forensicsSignalReason(kind: string): string {
  switch (kind) {
    case "product_bar_rejection":
      return "The session rejected a done claim because product-grade proof was missing.";
    case "false_done_admission":
      return "The assistant admitted loop completion was mistaken for product proof.";
    case "benchmark_overfit_steering":
      return "The session flagged benchmark-specific steering or overfit row wins.";
    case "oversized_tool_output":
      return "A tool output exceeded the compact handoff budget.";
    case "closed_stdin_poll":
      return "A completed foreground session was polled after stdin closed.";
    default:
      return "Session forensics found workflow friction.";
  }
}

function forensicsSignalAction(kind: string): string {
  switch (kind) {
    case "product_bar_rejection":
      return "Add claim coverage before finalization.";
    case "false_done_admission":
      return "Downgrade evidence maturity or restart with product-grade acceptance.";
    case "benchmark_overfit_steering":
      return "Separate row-specific repairs from product proof and pass a blind holdout or breadth gate.";
    case "oversized_tool_output":
      return "Use bounded mapping commands, file-specific reads, or CodeStory search packets.";
    case "closed_stdin_poll":
      return "Stop polling completed foreground sessions and restart only after a changed precondition.";
    default:
      return "Use a bounded next action before spending another packet.";
  }
}

function resolveThresholds(value: unknown): DecisionThresholdConfig {
  return resolveDecisionThresholds(
    value && typeof value === "object" ? { decisionThresholds: value as LooseObject } : {},
  );
}

function dedupeSignals(signals: WorkflowFrictionSignal[]): WorkflowFrictionSignal[] {
  const seen = new Set<string>();
  const result: WorkflowFrictionSignal[] = [];
  for (const signal of signals) {
    const key = `${signal.kind}:${signal.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(signal);
  }
  return result;
}
