type LooseObject = Record<string, unknown>;

export interface OperatorChecklist {
  command: string;
  safetyReason: string;
  blocker: string;
  evidenceRole: string;
  source: string;
}

export function buildOperatorChecklist(
  canonicalAction: LooseObject | null | undefined,
  context: LooseObject = {},
): OperatorChecklist {
  const action = objectValue(canonicalAction) || {};
  const command = stringValue(action.command) || inspectCommandForAction(action, context);
  return {
    command,
    safetyReason:
      stringValue(action.reason) || "Decision envelope is the authoritative next-action source.",
    blocker: blockerForAction(action, context),
    evidenceRole: evidenceRoleForAction(stringValue(action.kind)),
    source: stringValue(context.source) || "canonical-next-action",
  };
}

function blockerForAction(action: LooseObject, context: LooseObject): string {
  const blockers = arrayValue(objectValue(context.loopContract)?.blockers);
  const actionKind = stringValue(action.kind);
  const matching = blockers.find((item) => stringValue(objectValue(item)?.kind) === actionKind);
  const first = objectValue(matching || blockers[0]);
  if (first) return stringValue(first.reason);
  if (["next-packet", "finalization"].includes(actionKind)) return "";
  return actionKind ? stringValue(action.reason) : "";
}

function evidenceRoleForAction(kind: string): string {
  switch (kind) {
    case "log-decision":
      return "fresh-packet";
    case "finalization":
      return "accepted-current-keeps";
    case "context-distillation":
      return "context-capsule";
    case "lane-cleanup":
      return "lane-lifecycle";
    case "runtime-provenance":
      return "runtime-truth";
    case "packet-diagnostic":
      return "diagnostic-measure";
    case "next-packet":
      return "new-measurement";
    default:
      return "safety-repair";
  }
}

function inspectCommandForAction(action: LooseObject, context: LooseObject): string {
  const workDir = stringValue(context.workDir || context.cwd);
  if (!workDir) return "";
  const script = scriptCommand(context);
  const cwd = quoteCommandArg(workDir);
  switch (stringValue(action.kind)) {
    case "context-distillation":
      return `${script} session-forensics --cwd ${cwd} --dry-run`;
    case "runtime-provenance":
      return `${script} doctor --cwd ${cwd} --explain`;
    case "packet-diagnostic":
      return `${script} partial-results --cwd ${cwd} --from-last`;
    case "finalization":
      return `${script} finalize-preview --cwd ${cwd} --dry-run`;
    case "lane-cleanup":
      return `${script} state --cwd ${cwd} --compact`;
    default:
      return `${script} state --cwd ${cwd} --compact`;
  }
}

function scriptCommand(context: LooseObject): string {
  const pluginRoot = stringValue(context.pluginRoot);
  if (!pluginRoot) return "node scripts/autoresearch.mjs";
  return `node ${quoteCommandArg(`${pluginRoot.replace(/[\\/]$/, "")}/scripts/autoresearch.mjs`)}`;
}

function objectValue(value: unknown): LooseObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as LooseObject)
    : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return value == null ? "" : String(value);
}

function quoteCommandArg(value: unknown): string {
  return `"${String(value).replace(/[\\"]/g, "\\$&")}"`;
}
