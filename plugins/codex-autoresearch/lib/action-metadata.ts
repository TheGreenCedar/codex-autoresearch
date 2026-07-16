import {
  createCommandLookup,
  resolveCommandByKeys,
  resolveSafeCommand,
} from "./safe-command-resolver.js";

export interface ActionMetadata {
  label: string;
  commandLabel: string;
  safeAction: string;
  packetBrake: boolean;
  fallbackKeys: string[];
}

export const ACTION_METADATA: Record<string, ActionMetadata> = {
  "termination-failed": actionMetadata({
    label: "Verify process termination",
    commandLabel: "State",
    safeAction: "state",
    fallbackKeys: ["state", "doctor"],
    packetBrake: true,
  }),
  "gate-quality": actionMetadata({
    label: "Repair gate quality",
    commandLabel: "Doctor",
    safeAction: "doctor",
    fallbackKeys: ["doctorExplain", "doctor", "benchmarkLint", "state"],
  }),
  preflight: actionMetadata({
    label: "Resolve preflight",
    commandLabel: "Doctor",
    safeAction: "doctor",
    fallbackKeys: [
      "setupPlan",
      "benchmarkLint",
      "stateCompact",
      "state",
      "doctor",
      "doctorExplain",
    ],
  }),
  "portfolio-trust-blocker": actionMetadata({
    label: "Inspect portfolio trust",
    commandLabel: "State",
    safeAction: "state",
    fallbackKeys: ["state", "recommendNext", "doctor"],
  }),
  "metric-saturation": actionMetadata({
    label: "Inspect metric saturation",
    commandLabel: "Inspect",
    safeAction: "state",
    fallbackKeys: ["finalizePreview", "newSegmentDryRun", "state"],
  }),
  "needs-baseline": actionMetadata({
    label: "Run baseline",
    commandLabel: "Next",
    safeAction: "next",
    packetBrake: false,
    fallbackKeys: ["next", "nextRun", "baseline"],
  }),
  "needs-evidence": actionMetadata({
    label: "Record gap evidence",
    commandLabel: "Gap decision",
    safeAction: "gap-decide",
    packetBrake: true,
    fallbackKeys: ["gapDecide", "gapCandidates", "state"],
  }),
  "current-tree-finalization": actionMetadata({
    label: "Finalize current tree",
    commandLabel: "Preview current-tree finalization",
    safeAction: "finalize-current-tree",
    fallbackKeys: ["finalizeCurrentTree", "finalizePreview", "state"],
    packetBrake: true,
  }),
  "finalization-runway": actionMetadata({
    label: "Inspect finalization runway",
    commandLabel: "Preview",
    safeAction: "finalize-preview",
    fallbackKeys: ["finalizePreview", "state"],
  }),
  "safety-blocker": actionMetadata({
    label: "Resolve safety blocker",
    commandLabel: "Doctor",
    safeAction: "doctor",
    fallbackKeys: ["doctorExplain", "doctor", "state"],
  }),
  "goal-contract": actionMetadata({
    label: "Resolve goal contract",
    commandLabel: "Goal",
    safeAction: "codex-goal-brief",
    fallbackKeys: ["codexGoalBrief", "state", "recommendNext"],
  }),
  "approval-gate": actionMetadata({
    label: "Record scoped approval",
    commandLabel: "Approval",
    safeAction: "lane-runner",
    fallbackKeys: ["laneRunner", "state"],
  }),
  "resource-governor": actionMetadata({
    label: "Resolve resource preflight",
    commandLabel: "State",
    safeAction: "state",
    fallbackKeys: ["state", "recommendNext", "doctor"],
  }),
  "evidence-maturity": actionMetadata({
    label: "Inspect evidence maturity",
    commandLabel: "Preview",
    safeAction: "finalize-preview",
    fallbackKeys: ["finalizePreview", "state"],
  }),
  "workflow-friction": actionMetadata({
    label: "Remove workflow friction",
    commandLabel: "Doctor",
    safeAction: "doctor",
    fallbackKeys: ["doctorExplain", "doctor", "state"],
  }),
  "benchmark-mismatch": actionMetadata({
    label: "Repair benchmark mismatch",
    commandLabel: "Lint",
    safeAction: "benchmark-lint",
    fallbackKeys: ["benchmarkLint", "doctorExplain", "doctor", "state"],
  }),
  "runtime-provenance": actionMetadata({
    label: "Inspect runtime provenance",
    commandLabel: "Doctor",
    safeAction: "doctor",
    fallbackKeys: ["doctorExplain", "doctor", "state"],
  }),
  "runtime-authority": actionMetadata({
    label: "Inspect runtime authority",
    commandLabel: "Doctor",
    safeAction: "doctor",
    fallbackKeys: ["doctorExplain", "doctor", "state"],
  }),
  "ledger-integrity": actionMetadata({
    label: "Inspect ledger integrity",
    commandLabel: "Ledger",
    safeAction: "ledger-doctor",
    fallbackKeys: ["ledgerDoctor", "state"],
  }),
  "packet-diagnostic": actionMetadata({
    label: "Inspect packet diagnostics",
    commandLabel: "Partial",
    safeAction: "partial-results",
    fallbackKeys: ["partialResults", "state"],
  }),
  "decision-capsule": actionMetadata({
    label: "Resolve decision capsule",
    commandLabel: "Recommend",
    safeAction: "recommend-next",
    fallbackKeys: ["benchmarkLint", "recommendNext", "state"],
  }),
  "context-distillation": actionMetadata({
    label: "Refresh context",
    commandLabel: "Context",
    safeAction: "session-forensics",
    fallbackKeys: ["onboardingPacket", "state"],
  }),
  "lane-cleanup": actionMetadata({
    label: "Clean up stale lanes",
    commandLabel: "State",
    safeAction: "state",
    fallbackKeys: ["state", "laneRunner"],
  }),
  "lane-orchestration": actionMetadata({
    label: "Resolve lane orchestration",
    commandLabel: "State",
    safeAction: "state",
    fallbackKeys: ["state", "recommendNext", "doctor"],
  }),
  "stale-packet": actionMetadata({
    label: "Replace stale packet",
    commandLabel: "Setup",
    safeAction: "setup-plan",
    fallbackKeys: ["replaceLast", "setup", "setupPlan", "state"],
  }),
  "active-progress": actionMetadata({
    label: "Inspect active progress",
    commandLabel: "State",
    safeAction: "state",
    fallbackKeys: ["stateCompact", "state", "partialResults"],
  }),
  "partial-salvage": actionMetadata({
    label: "Review partial results",
    commandLabel: "Partial",
    safeAction: "partial-results",
    fallbackKeys: ["partialResults", "state"],
  }),
  setup: actionMetadata({
    label: "Complete setup",
    commandLabel: "Setup",
    safeAction: "setup-plan",
    fallbackKeys: ["setupPlan", "stateCompact", "state", "setup"],
  }),
  "benchmark-command": actionMetadata({
    label: "Add benchmark command",
    commandLabel: "Setup",
    safeAction: "setup-plan",
    fallbackKeys: ["setupPlan", "benchmarkLint", "stateCompact", "state", "setup"],
  }),
  "log-decision": actionMetadata({
    label: "Log last packet",
    commandLabel: "Log",
    safeAction: "log",
    fallbackKeys: ["logLast", "keepLast", "discardLast", "state"],
  }),
  "segment-transition": actionMetadata({
    label: "Start new segment",
    commandLabel: "Review",
    safeAction: "new-segment",
    fallbackKeys: ["newSegmentDryRun", "gapCandidates", "finalizePreview", "state"],
  }),
  watchdog: actionMetadata({
    label: "Inspect quiet window",
    commandLabel: "Inspect",
    safeAction: "state",
    fallbackKeys: ["finalizePreview", "liveDashboard", "doctor", "state"],
  }),
  finalization: actionMetadata({
    label: "Preview finalization",
    commandLabel: "Preview",
    safeAction: "finalize-preview",
    fallbackKeys: ["finalizePreview", "state"],
  }),
  "finalize-preview": actionMetadata({
    label: "Preview finalization",
    commandLabel: "Preview",
    safeAction: "finalize-preview",
    fallbackKeys: ["finalizePreview", "state"],
  }),
  "next-packet": actionMetadata({
    label: "Run next packet",
    commandLabel: "Next",
    safeAction: "next",
    packetBrake: false,
    fallbackKeys: ["next", "nextRun"],
  }),
  baseline: actionMetadata({
    label: "Run baseline",
    commandLabel: "Next",
    safeAction: "next",
    packetBrake: false,
    fallbackKeys: ["baseline", "next", "nextRun"],
  }),
  plateau: actionMetadata({
    label: "Pivot plateau",
    commandLabel: "Next",
    safeAction: "next",
    packetBrake: false,
    fallbackKeys: ["next", "nextRun"],
  }),
  "plateau-pivot": actionMetadata({
    label: "Pivot plateau",
    commandLabel: "Scout",
    safeAction: "lane-runner",
    packetBrake: true,
    fallbackKeys: [
      "laneRunner",
      "newSegmentDryRun",
      "promoteGateDryRun",
      "benchmarkInspect",
      "state",
    ],
  }),
  "quality-gap": actionMetadata({
    label: "Close quality gaps",
    commandLabel: "Gaps",
    safeAction: "gap-candidates",
    packetBrake: false,
    fallbackKeys: ["gapCandidates"],
  }),
};

const operationalFallbackKinds = new Set([
  "baseline",
  "current-tree-finalization",
  "log-decision",
  "needs-baseline",
  "next-packet",
  "plateau",
  "stale-packet",
]);

export function actionMetadataForKind(kind: unknown): ActionMetadata | null {
  return ACTION_METADATA[String(kind || "")] || null;
}

export function actionTitleForKind(kind: unknown, fallback = "Next action"): string {
  return actionMetadataForKind(kind)?.label || fallback;
}

export function actionCommandLabelForKind(kind: unknown, fallback = "Run"): string {
  return actionMetadataForKind(kind)?.commandLabel || fallback;
}

export function actionSafeActionForKind(kind: unknown, fallback = ""): string {
  return actionMetadataForKind(kind)?.safeAction || fallback;
}

export function actionToolNameForKind(kind: unknown): string {
  const value = String(kind || "");
  if (value === "setup" || value === "benchmark-command") return "setup_session";
  if (value === "decision-capsule") return "recommend_next";
  if (value === "partial-salvage" || value === "packet-diagnostic") return "partial_results";
  if (value === "segment-transition") return "new_segment";
  if (value === "finalization" || value === "finalize-preview") return "finalize_preview";
  if (value === "context-distillation") return "session_forensics";
  return actionSafeActionForKind(value, value).replace(/-/g, "_");
}

export function withCanonicalActionCommand(
  envelope: Record<string, unknown>,
  commands: unknown,
): Record<string, unknown> {
  const action = record(envelope.canonicalNextAction);
  if (!Object.keys(action).length) return envelope;
  const kind = String(action.kind || "");
  return {
    ...envelope,
    canonicalNextAction: {
      ...action,
      command: resolveActionCommand(kind, commands, { explicitCommand: action.command }),
      safeAction: action.safeAction || actionSafeActionForKind(kind, kind),
      toolName: action.toolName || actionToolNameForKind(kind),
    },
  };
}

export function isPacketBrakeKind(kind: unknown): boolean {
  return actionMetadataForKind(kind)?.packetBrake === true;
}

export function resolveActionCommand(
  kind: unknown,
  commands: unknown,
  context: { explicitCommand?: unknown } = {},
): string {
  const explicit = resolveSafeCommand(context.explicitCommand, fallbackCommandMode(kind));
  if (explicit) return explicit;

  const metadata = actionMetadataForKind(kind);
  const lookup = createCommandLookup(commands);
  if (metadata) {
    const command = fallbackCommandForPolicy(kind, lookup, metadata.fallbackKeys);
    if (command) return command;
  }
  if (String(kind || "") === "next-packet") {
    return fallbackCommandForPolicy(kind, lookup, ["next", "nextRun"]);
  }
  return "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function fallbackCommandForKind(
  kind: unknown,
  lookup: (key: string) => string | undefined,
): string {
  const metadata = actionMetadataForKind(kind);
  if (!metadata) return "";
  return fallbackCommandForPolicy(kind, lookup, metadata.fallbackKeys);
}

export function readoutFallbackCommand(command: unknown): string {
  return resolveSafeCommand(command);
}

function fallbackCommandForPolicy(
  kind: unknown,
  lookup: (key: string) => unknown,
  keys: Iterable<string>,
): string {
  return resolveCommandByKeys(lookup, keys, {
    mode: fallbackCommandMode(kind),
  });
}

function fallbackCommandMode(kind: unknown): "operational" | "readout" {
  return operationalFallbackKinds.has(String(kind || "")) ? "operational" : "readout";
}

function actionMetadata({
  label,
  commandLabel,
  safeAction,
  packetBrake = true,
  fallbackKeys,
}: Omit<ActionMetadata, "packetBrake"> & {
  packetBrake?: boolean;
}): ActionMetadata {
  return { label, commandLabel, safeAction, packetBrake, fallbackKeys };
}

export { normalizeActionCommandKey } from "./safe-command-resolver.js";
