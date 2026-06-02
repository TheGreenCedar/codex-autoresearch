export interface ActionMetadata {
  command: string;
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
    fallbackKeys: ["doctorExplain", "doctor", "benchmarkLint", "state"],
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
    label: "Preview finalization",
    commandLabel: "Preview",
    safeAction: "finalize-preview",
    fallbackKeys: ["finalizePreview", "state"],
  }),
  "safety-blocker": actionMetadata({
    command: "",
    label: "Resolve safety blocker",
    commandLabel: "Doctor",
    safeAction: "doctor",
    fallbackKeys: ["doctorExplain", "doctor", "state"],
  }),
  "workflow-friction": actionMetadata({
    command: "",
    label: "Remove workflow friction",
    commandLabel: "Doctor",
    safeAction: "doctor",
    fallbackKeys: ["doctorExplain", "doctor", "state"],
  }),
  "benchmark-mismatch": actionMetadata({
    command: "",
    label: "Repair benchmark mismatch",
    commandLabel: "Lint",
    safeAction: "benchmark-lint",
    fallbackKeys: ["benchmarkLint", "doctorExplain", "doctor", "state"],
  }),
  "runtime-provenance": actionMetadata({
    command: "",
    label: "Inspect runtime provenance",
    commandLabel: "Doctor",
    safeAction: "doctor",
    fallbackKeys: ["doctorExplain", "doctor", "state"],
  }),
  "packet-diagnostic": actionMetadata({
    command: "",
    label: "Inspect packet diagnostics",
    commandLabel: "Partial",
    safeAction: "partial-results",
    fallbackKeys: ["partialResults", "state"],
  }),
  "decision-capsule": actionMetadata({
    command: "",
    label: "Resolve decision capsule",
    commandLabel: "Capsule",
    safeAction: "decision-capsule",
    fallbackKeys: ["benchmarkLint", "recommendNext", "state"],
  }),
  "context-distillation": actionMetadata({
    command: "",
    label: "Refresh context",
    commandLabel: "Context",
    safeAction: "session-forensics",
    fallbackKeys: ["onboardingPacket", "state"],
  }),
  "lane-cleanup": actionMetadata({
    command: "",
    label: "Clean up stale lanes",
    commandLabel: "State",
    safeAction: "state",
    fallbackKeys: ["state", "laneRunner"],
  }),
  "stale-packet": actionMetadata({
    command: "",
    label: "Replace stale packet",
    commandLabel: "Setup",
    safeAction: "setup-plan",
    fallbackKeys: ["replaceLast", "setup", "setupPlan", "state"],
  }),
  "partial-salvage": actionMetadata({
    command: "",
    label: "Review partial results",
    commandLabel: "Partial",
    safeAction: "partial-results",
    fallbackKeys: ["partialResults", "state"],
  }),
  setup: actionMetadata({
    command: "",
    label: "Complete setup",
    commandLabel: "Setup",
    safeAction: "setup-plan",
    fallbackKeys: ["setup", "setupPlan", "state"],
  }),
  "benchmark-command": actionMetadata({
    command: "",
    label: "Add benchmark command",
    commandLabel: "Setup",
    safeAction: "setup-plan",
    fallbackKeys: ["setup", "setupPlan", "benchmarkLint", "state"],
  }),
  "log-decision": actionMetadata({
    command: "",
    label: "Log last packet",
    commandLabel: "Log",
    safeAction: "log",
    fallbackKeys: ["logLast", "keepLast", "discardLast", "state"],
  }),
  "segment-transition": actionMetadata({
    command: "",
    label: "Start new segment",
    commandLabel: "Review",
    safeAction: "new-segment",
    fallbackKeys: ["newSegmentDryRun", "gapCandidates", "finalizePreview", "state"],
  }),
  watchdog: actionMetadata({
    command: "",
    label: "Inspect quiet window",
    commandLabel: "Inspect",
    safeAction: "inspect",
    fallbackKeys: ["finalizePreview", "liveDashboard", "doctor", "state"],
  }),
  finalization: actionMetadata({
    command: "",
    label: "Preview finalization",
    commandLabel: "Preview",
    safeAction: "finalize-preview",
    fallbackKeys: ["finalizePreview", "state"],
  }),
  "finalize-preview": actionMetadata({
    command: "",
    label: "Preview finalization",
    commandLabel: "Preview",
    safeAction: "finalize-preview",
    fallbackKeys: ["finalizePreview", "state"],
  }),
  "next-packet": actionMetadata({
    command: "",
    label: "Run next packet",
    commandLabel: "Next",
    safeAction: "next",
    packetBrake: false,
    fallbackKeys: ["next", "nextRun"],
  }),
  baseline: actionMetadata({
    command: "",
    label: "Run baseline",
    commandLabel: "Next",
    safeAction: "next",
    packetBrake: false,
    fallbackKeys: ["baseline", "next", "nextRun"],
  }),
  plateau: actionMetadata({
    command: "",
    label: "Pivot plateau",
    commandLabel: "Next",
    safeAction: "next",
    packetBrake: false,
    fallbackKeys: ["next", "nextRun"],
  }),
  "plateau-pivot": actionMetadata({
    command: "",
    label: "Pivot plateau",
    commandLabel: "Next",
    safeAction: "next",
    packetBrake: false,
    fallbackKeys: ["next", "nextRun"],
  }),
  "quality-gap": actionMetadata({
    command: "",
    label: "Close quality gaps",
    commandLabel: "Gaps",
    safeAction: "gap-candidates",
    packetBrake: false,
    fallbackKeys: ["gapCandidates"],
  }),
};

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
  if (explicit) return explicit;

  const metadata = actionMetadataForKind(kind);
  const lookup = commandLookup(commands);
  if (metadata) {
    for (const key of metadata.fallbackKeys) {
      const command = lookup(key);
      if (command) return command;
    }
  }
  if (String(kind || "") === "next-packet") {
    return lookup("next") || lookup("nextRun");
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
    const command = lookup(key) || lookup(spacedKey(key)) || lookup(normalizeActionCommandKey(key));
    if (command) return command;
  }
  return "";
}

function actionMetadata({
  command,
  label,
  commandLabel,
  safeAction,
  packetBrake = true,
  fallbackKeys,
}: Omit<ActionMetadata, "command" | "packetBrake"> & {
  command?: string;
  packetBrake?: boolean;
}): ActionMetadata {
  return { command: command || "", label, commandLabel, safeAction, packetBrake, fallbackKeys };
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
