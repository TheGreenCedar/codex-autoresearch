import { readoutSafeCommand } from "./dashboard-command-safety.js";

export interface ActionMetadata {
  label: string;
  commandLabel: string;
  safeAction: string;
  packetBrake: boolean;
  fallbackKeys: string[];
}

export const ACTION_METADATA: Record<string, ActionMetadata> = {
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
    safeAction: "inspect",
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

export function isPacketBrakeKind(kind: unknown): boolean {
  return actionMetadataForKind(kind)?.packetBrake === true;
}

export function resolveActionCommand(
  kind: unknown,
  commands: unknown,
  context: { explicitCommand?: unknown } = {},
): string {
  const explicit = concreteCommand(context.explicitCommand);
  if (explicit) {
    const command = fallbackCommandForPolicy(kind, explicit);
    if (command) return command;
  }

  const metadata = actionMetadataForKind(kind);
  const lookup = commandLookup(commands);
  if (metadata) {
    for (const key of metadata.fallbackKeys) {
      const command = fallbackCommandForPolicy(kind, lookup(key));
      if (command) return command;
    }
  }
  if (String(kind || "") === "next-packet") {
    return (
      fallbackCommandForPolicy(kind, lookup("next")) ||
      fallbackCommandForPolicy(kind, lookup("nextRun"))
    );
  }
  return "";
}

export function fallbackCommandForKind(
  kind: unknown,
  lookup: (key: string) => string | undefined,
): string {
  const metadata = actionMetadataForKind(kind);
  if (!metadata) return "";
  for (const key of metadata.fallbackKeys) {
    const command = fallbackCommandForPolicy(
      kind,
      lookup(key) || lookup(spacedKey(key)) || lookup(normalizeActionCommandKey(key)),
    );
    if (command) return command;
  }
  return "";
}

export function readoutFallbackCommand(command: unknown): string {
  return readoutSafeCommand(concreteCommand(command));
}

function fallbackCommandForPolicy(kind: unknown, command: unknown): string {
  const text = concreteCommand(command);
  if (!text) return "";
  return operationalFallbackKinds.has(String(kind || "")) ? text : readoutFallbackCommand(text);
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

function spacedKey(value: string): string {
  return value.replace(/[A-Z]/g, (match) => ` ${match.toLowerCase()}`).toLowerCase();
}

export function normalizeActionCommandKey(value: unknown): string {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function commandLookup(commands: unknown): (key: string) => string {
  const entries = new Map<string, string>();
  const add = (key: unknown, command: unknown) => {
    const normalized = normalizeActionCommandKey(key);
    const text = concreteCommand(command);
    if (normalized && text && !entries.has(normalized)) entries.set(normalized, text);
  };
  if (Array.isArray(commands)) {
    for (const item of commands) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      add(record.key, record.command);
      add(record.name, record.command);
      add(record.label, record.command);
    }
  } else if (commands && typeof commands === "object") {
    for (const [key, command] of Object.entries(commands as Record<string, unknown>)) {
      add(key, command);
    }
  }
  return (key: string) => entries.get(normalizeActionCommandKey(key)) || "";
}

function concreteCommand(command: unknown): string {
  const text = typeof command === "string" ? command.trim() : "";
  if (!text || /<[^>]+>/.test(text)) return "";
  return text;
}
