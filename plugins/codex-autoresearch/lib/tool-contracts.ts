import {
  commandDefinitionForTool,
  commandTable,
  type CommandDefinition,
  type JsonSchema as CommandJsonSchema,
} from "./command-table.js";
import { actionPolicyForTool, toolMetadata } from "./tool-registry.js";
import {
  TOOL_STYLE_UNSAFE_COMMAND_GATE,
  toolSchemaRequiresUnsafeCommandGate,
} from "./tool-unsafe-command-gate.js";

type JsonSchema = CommandJsonSchema & {
  description?: string;
  additionalProperties?: boolean | JsonSchema;
};

type ToolSchema = {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: Record<string, unknown>;
  [key: string]: unknown;
};

const OUTPUT_FIELD_SCHEMAS: Record<string, JsonSchema> = {
  action: stringSchema("Safe next action summary."),
  backupPath: stringSchema("Backup file path written before ledger repair."),
  checkedAt: stringSchema("ISO timestamp for a liveness check."),
  clearingCondition: stringSchema("Condition that clears a refused loop-governance blocker."),
  code: stringSchema("Machine-readable status or refusal code."),
  commandHint: stringSchema("Copyable command for resolving a blocker or continuing safely."),
  healthUrl: stringSchema("Dashboard health-check URL."),
  lastRunPath: stringSchema("Path to the saved last-run packet."),
  ledgerPath: stringSchema("Autoresearch JSONL ledger path."),
  nextAction: stringSchema("Recommended next operator action."),
  output: stringSchema("Output file path or command output."),
  outputPreview: stringSchema("Bounded command output preview."),
  packetFingerprint: stringSchema("Freshness fingerprint from the packet evidence bundle."),
  registryPath: stringSchema("Local dashboard registry path."),
  slug: stringSchema("Research slug."),
  stage: stringSchema("Setup or resume stage."),
  startedAt: stringSchema("ISO timestamp for when the process started."),
  state: objectSchema("Session state detail; pass json_full for the complete machine diagnostic."),
  stopStatus: stringSchema("Recommended stop status."),
  url: stringSchema("Served local dashboard URL."),
  version: stringSchema("Version string."),
  whySafe: stringSchema("Evidence explaining why the next action is safe."),
  workDir: stringSchema("Resolved project working directory."),
  closed: numberSchema("Closed quality-gap item count."),
  open: numberSchema("Open quality-gap item count."),
  pid: numberSchema("Local process identifier."),
  port: numberSchema("Local dashboard port."),
  baselineLogged: booleanSchema("Whether a baseline measure was logged."),
  dryRun: booleanSchema("Whether the mutation was previewed only."),
  ok: booleanSchema("True when the tool completed successfully."),
  readOnly: booleanSchema("True when the command made no file changes."),
  ready: booleanSchema("True when the preview is ready to apply."),
  stopRecommended: booleanSchema("True when candidate extraction recommends stopping."),
  verified: booleanSchema("True when the dashboard health check passed."),
  candidates: objectArraySchema("Candidate items."),
  commands: stringArraySchema("Copyable command list."),
  deleted: stringArraySchema("Deleted artifact paths."),
  failedTests: stringArraySchema("Failed tests or checks."),
  files: stringArraySchema("Created or touched files."),
  guidedFlow: objectArraySchema("Guided workflow steps."),
  hints: stringArraySchema("Operator hints."),
  issues: stringArraySchema("Validation or readiness issues."),
  missing: stringArraySchema("Missing setup fields."),
  missingEssentials: stringArraySchema("Missing essentials for the first valid loop."),
  openItems: stringArraySchema("Open quality-gap items."),
  plannedFiles: stringArraySchema("Planned file paths."),
  recipes: objectArraySchema("Available recipes."),
  templates: objectArraySchema("Report templates."),
  updates: stringArraySchema("Applied config updates."),
  warnings: stringArraySchema("Warning messages."),
  warningDetails: objectArraySchema("Structured warnings."),
  wouldDelete: stringArraySchema("Previewed deletion targets."),
};

function contractFor(name: string) {
  const command = commandDefinitionForTool(name);
  if (!command) return null;
  const compatibility = command.compatibility;
  return {
    purpose: compatibility ? compatibility.error : command.description,
    whenToUse: compatibility
      ? `Do not execute this retained alias; migrate to ${compatibility.replacement}.`
      : `Use through the ${command.cliCommand} command.`,
    contrast: compatibility
      ? `${command.cliCommand} is retained only for migration to ${compatibility.replacement}.`
      : `This is the ${command.category} command for ${command.name}.`,
    safety: commandSafety(command),
    outputSchema: outputSchemaFor(command),
  };
}

export function applyToolContracts(toolSchemas: ToolSchema[]): ToolSchema[] {
  return toolSchemas.map((tool) => {
    const contract = contractFor(tool.name);
    if (!contract) return tool;
    return {
      ...tool,
      description: contract.purpose,
      outputSchema: contract.outputSchema,
      annotations: {
        ...tool.annotations,
        ...toolHintAnnotations(tool.name, tool.inputSchema),
        safety: contract.safety,
      },
    };
  });
}

export function validateToolContracts(toolSchemas: ToolSchema[]) {
  const issues: string[] = [];
  const schemasByName = new Map(toolSchemas.map((tool) => [tool.name, tool]));
  for (const command of commandTable) {
    const tool = schemasByName.get(command.name);
    const contract = contractFor(command.name);
    if (!tool || !contract) {
      issues.push(`${command.name}: missing derived contract`);
      continue;
    }
    if (tool.description !== contract.purpose) issues.push(`${command.name}: stale description`);
    if (JSON.stringify(tool.outputSchema) !== JSON.stringify(contract.outputSchema)) {
      issues.push(`${command.name}: stale output schema`);
    }
    if (tool.annotations?.safety !== contract.safety) {
      issues.push(`${command.name}: stale safety annotation`);
    }
    if (command.compatibility) {
      if (command.outputFields.length !== 0) {
        issues.push(`${command.name}: compatibility aliases cannot advertise successful output`);
      }
      for (const expected of [
        command.compatibility.replacement,
        command.compatibility.removeAfter,
      ]) {
        if (!contract.purpose.includes(expected)) {
          issues.push(`${command.name}: compatibility guidance omits ${expected}`);
        }
      }
    }
  }
  for (const tool of toolSchemas) {
    if (!commandDefinitionForTool(tool.name))
      issues.push(`${tool.name}: missing command definition`);
  }
  return { ok: issues.length === 0, issues };
}

export function toolGuidanceFor(name: string) {
  return contractFor(name);
}

export function outputContractFor(name: string) {
  return contractFor(name)?.outputSchema || null;
}

function commandSafety(command: CommandDefinition): string {
  if (command.compatibility) {
    return `Fails before dispatch, locking, or mutation; migrate to ${command.compatibility.replacement}.`;
  }
  if (command.sessionLock === "none" && command.actionPolicy === "process_start") {
    return "Starts a local readout process without mutating session state.";
  }
  if (command.conditionallyMutating) {
    if (command.sessionLock === "none") {
      return "Read-only by default; process-starting options are explicit and do not mutate or lock session state.";
    }
    return "Read-only by default; mutating or process-starting options are explicit and session-locked.";
  }
  switch (command.actionPolicy) {
    case "read":
    case "preview":
      return "Read-only.";
    case "artifact_write":
      return command.sessionLock === "none"
        ? "Writes a bounded output artifact without mutating session state."
        : "Writes bounded session artifacts under the session mutation lock.";
    case "state_mutation":
      return "Mutates session state under the session mutation lock.";
    case "git_mutation":
      return "May mutate Git and session state under the session mutation lock.";
    case "process_start":
      return "Runs a local process under the session mutation lock.";
    case "destructive":
      return "Destructive mutation requires confirmation and the session mutation lock.";
    case "unsafe_open_world":
      return "May run open-world operations and requires explicit authorization.";
  }
}

function outputSchemaFor(command: CommandDefinition): JsonSchema {
  const properties = Object.fromEntries(
    command.outputFields.map((field) => [
      field,
      command.outputSchemaOverrides?.[field] || schemaForOutputField(field),
    ]),
  );
  return {
    type: "object",
    required: command.outputFields.filter((field) => field === "ok" || field === "workDir"),
    properties,
    additionalProperties: true,
  };
}

function toolHintAnnotations(name: string, inputSchema: JsonSchema) {
  const policy = actionPolicyForTool(name);
  const metadata = toolMetadata(name);
  const readOnly =
    (policy === "read" || policy === "preview") && metadata?.conditionallyMutating !== true;
  const destructive = policy === "git_mutation" || policy === "destructive";
  const openWorld = policy === "process_start" || metadata?.openWorld === true;
  const unsafeCommandGate = toolSchemaRequiresUnsafeCommandGate(name, inputSchema);
  return {
    title: humanizeToolName(name),
    readOnlyHint: readOnly,
    destructiveHint: destructive,
    idempotentHint: readOnly,
    openWorldHint: openWorld,
    unsafeCommandGate: unsafeCommandGate ? TOOL_STYLE_UNSAFE_COMMAND_GATE : undefined,
  };
}

function schemaForOutputField(field: string): JsonSchema {
  return OUTPUT_FIELD_SCHEMAS[field] || objectSchema(`${field} value.`);
}

function humanizeToolName(name: string) {
  return String(name)
    .split("_")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function stringSchema(description: string): JsonSchema {
  return { type: "string", description };
}

function numberSchema(description: string): JsonSchema {
  return { type: "number", description };
}

function booleanSchema(description: string): JsonSchema {
  return { type: "boolean", description };
}

function objectSchema(description: string): JsonSchema {
  return { type: "object", description, additionalProperties: true };
}

function stringArraySchema(description: string): JsonSchema {
  return { type: "array", description, items: stringSchema("Item.") };
}

function objectArraySchema(description: string): JsonSchema {
  return { type: "array", description, items: objectSchema("Item.") };
}
