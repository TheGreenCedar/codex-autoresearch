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
import {
  DECISION_ACTION_KINDS,
  DECISION_CAPABILITIES,
  DECISION_OUTCOME_KINDS,
  decisionDiagnosticRegistry,
  failureLayerPreconditions,
} from "./decision-compiler.js";
import {
  COMMAND_MUTATION_RECEIPT_SCHEMA_VERSION,
  DECISION_COMPILER_SCHEMA_VERSION,
} from "./decision-schema-versions.js";

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

const closedObjectSchema = (
  properties: Record<string, JsonSchema>,
  required = Object.keys(properties),
): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const nullableEnumStringSchema = (values: string[]): JsonSchema => ({
  type: ["string", "null"],
  enum: [...values, null],
});
const enumStringSchema = (values: string[]): JsonSchema => ({ type: "string", enum: values });
const integerSchema = (): JsonSchema => ({ type: "integer" });
const integerLiteralSchema = (value: number): JsonSchema => ({ type: "integer", enum: [value] });
const booleanValueSchema = (): JsonSchema => ({ type: "boolean" });
const stringValueSchema = (): JsonSchema => ({ type: "string" });
const stringListSchema = (items: JsonSchema = stringValueSchema()): JsonSchema => ({
  type: "array",
  items,
});

const DECISION_DIAGNOSTIC_CODES = Object.keys(decisionDiagnosticRegistry).sort();
const FAILURE_LAYERS = Object.keys(failureLayerPreconditions).sort();
const DECISION_PLAN_SCHEMA: JsonSchema = closedObjectSchema({
  kind: enumStringSchema(["decision-plan"]),
  compilerSchemaVersion: integerLiteralSchema(DECISION_COMPILER_SCHEMA_VERSION),
  generationId: stringValueSchema(),
  decisionId: stringValueSchema(),
  phase: enumStringSchema([
    "complete",
    "direct-work",
    "finalization",
    "packet",
    "paused",
    "recovery",
    "setup",
  ]),
  action: closedObjectSchema({
    kind: enumStringSchema([...DECISION_ACTION_KINDS]),
    reason: stringValueSchema(),
    command: stringValueSchema(),
    commandDigest: stringValueSchema(),
    commandSemanticId: stringValueSchema(),
  }),
  primaryBlockerCode: nullableEnumStringSchema(DECISION_DIAGNOSTIC_CODES),
  capabilities: closedObjectSchema(
    Object.fromEntries(
      DECISION_CAPABILITIES.map((capability) => [
        capability,
        enumStringSchema(["allowed", "blocked", "recovery-only"]),
      ]),
    ),
  ),
  loopDisposition: closedObjectSchema({
    kind: enumStringSchema(["blocked", "complete", "continue", "pause"]),
    canRunPacket: booleanValueSchema(),
    shouldContinue: booleanValueSchema(),
  }),
  parentDisposition: closedObjectSchema({
    kind: enumStringSchema(["block-final-answer", "complete", "continue-working", "hand-back"]),
    mayAnswer: booleanValueSchema(),
    mayClaimCompletion: booleanValueSchema(),
  }),
  contractDigest: stringValueSchema(),
  evaluatorIdentity: stringValueSchema(),
  requiredEvidence: closedObjectSchema({
    preconditionEpoch: stringValueSchema(),
    acceptedCheckIdentities: stringListSchema(),
    diagnosticCodes: stringListSchema(enumStringSchema(DECISION_DIAGNOSTIC_CODES)),
    capabilityEffectCodes: stringListSchema(),
    failureLayer: nullableEnumStringSchema(FAILURE_LAYERS),
    failurePreconditions: stringListSchema(),
  }),
  investigation: {
    oneOf: [
      { type: "null" },
      closedObjectSchema({
        id: stringValueSchema(),
        objective: stringValueSchema(),
        status: enumStringSchema(["active", "blocked", "satisfied", "stopped-unmet"]),
        question: { type: ["string", "null"] },
        executionId: { type: ["string", "null"] },
        inputDigest: { type: ["string", "null"] },
        remaining: closedObjectSchema({
          actions: { type: ["integer", "null"], minimum: 0 },
          executionSeconds: { type: ["number", "null"], minimum: 0 },
          deadline: { type: ["string", "null"] },
          unknownExecutions: { type: "integer", minimum: 0 },
        }),
        unresolvedCriteria: stringListSchema(),
        delivery: closedObjectSchema({
          endpoint: enumStringSchema(["answer", "patch", "integrated", "deployed"]),
          status: enumStringSchema(["pending", "ready", "delivered"]),
        }),
      }),
    ],
  },
  outcome: closedObjectSchema({
    kind: enumStringSchema([...DECISION_OUTCOME_KINDS]),
    execution: enumStringSchema(["completed", "failed", "unknown"]),
    validity: enumStringSchema(["valid", "invalid", "unknown"]),
    conclusion: enumStringSchema(["supported", "refuted", "inconclusive"]),
    movement: enumStringSchema(["improved", "regressed", "neutral", "unknown"]),
    attainment: enumStringSchema(["satisfied", "unsatisfied", "unknown", "not-assessed"]),
    codeAcceptance: enumStringSchema(["accepted", "rejected", "unassessed"]),
  }),
  learning: closedObjectSchema({
    latest: {
      oneOf: [
        closedObjectSchema({
          kind: enumStringSchema(["none"]),
          changedBelief: { type: "null" },
          evidence: { ...stringListSchema(), maxItems: 0 },
        }),
        closedObjectSchema({
          kind: enumStringSchema(["causal", "discriminating"]),
          changedBelief: { type: "string", minLength: 1 },
          evidence: {
            ...stringListSchema({ type: "string", minLength: 1 }),
            minItems: 1,
          },
        }),
      ],
    },
    consecutiveNoLearningCandidates: { ...integerSchema(), minimum: 0 },
  }),
  failures: closedObjectSchema({
    layer: nullableEnumStringSchema(FAILURE_LAYERS),
    consecutive: { ...integerSchema(), minimum: 0 },
  }),
});

const COMMAND_MUTATION_RECEIPT_SCHEMA: JsonSchema = closedObjectSchema({
  kind: enumStringSchema(["command-mutation-receipt"]),
  schemaVersion: integerLiteralSchema(COMMAND_MUTATION_RECEIPT_SCHEMA_VERSION),
  receiptId: stringValueSchema(),
  command: stringValueSchema(),
  status: enumStringSchema(["completed", "failed"]),
  startedAt: stringValueSchema(),
  completedAt: stringValueSchema(),
  workDir: stringValueSchema(),
  preconditionGenerationId: stringValueSchema(),
  resultingCaptureStatus: enumStringSchema(["captured", "unavailable"]),
  resultingGenerationId: { type: ["string", "null"] },
  generationChanged: { type: ["boolean", "null"] },
});

const OUTPUT_FIELD_SCHEMAS: Record<string, JsonSchema> = {
  action: stringSchema("Safe next action summary."),
  backupPath: stringSchema("Backup file path written before ledger repair."),
  checkedAt: stringSchema("ISO timestamp for a liveness check."),
  clearingCondition: stringSchema("Condition that clears a canonical decision blocker."),
  code: stringSchema("Machine-readable status or refusal code."),
  commandHint: stringSchema("Copyable command for resolving a blocker or continuing safely."),
  healthUrl: stringSchema("Dashboard health-check URL."),
  lastRunPath: stringSchema("Path to the saved last-run packet."),
  ledgerPath: stringSchema("Autoresearch JSONL ledger path."),
  markerPath: stringSchema("Exact retained process marker removed after dead-process proof."),
  nextAction: stringSchema("Recommended next operator action."),
  output: stringSchema("Output file path or command output."),
  outputPreview: stringSchema("Bounded command output preview."),
  packetFingerprint: stringSchema("Freshness fingerprint from the packet evidence bundle."),
  preconditionDecision: DECISION_PLAN_SCHEMA,
  registryPath: stringSchema("Local dashboard registry path."),
  resultingDecision: DECISION_PLAN_SCHEMA,
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
  recovered: booleanSchema("True when the scoped process-integrity marker was recovered."),
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
  mutation: COMMAND_MUTATION_RECEIPT_SCHEMA,
  openItems: stringArraySchema("Open quality-gap items."),
  plannedFiles: stringArraySchema("Planned file paths."),
  proof: objectSchema("Typed dead-process proof used for scoped marker recovery."),
  provenDeadPids: numberArraySchema("Process identifiers proven absent before marker removal."),
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
  const protocolFields = ["preconditionDecision", "mutation", "resultingDecision"];
  const usesMutationProtocol = command.decisionProtocol === "session-mutation";
  const outputFields = [...command.outputFields, ...(usesMutationProtocol ? protocolFields : [])];
  const properties = Object.fromEntries(
    outputFields.map((field) => [
      field,
      command.outputSchemaOverrides?.[field] || schemaForOutputField(field),
    ]),
  );
  const baseRequired = command.outputFields.filter(
    (field) => field === "ok" || field === "workDir",
  );
  const schema: JsonSchema = {
    type: "object",
    required: [
      ...baseRequired,
      ...(usesMutationProtocol && !command.conditionallyMutating ? protocolFields : []),
    ],
    properties,
    additionalProperties: true,
  };
  if (usesMutationProtocol && command.conditionallyMutating) {
    schema.oneOf = [
      {
        not: {
          anyOf: protocolFields.map((field) => ({ required: [field] })),
        },
      },
      { required: protocolFields },
    ];
  }
  return schema;
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

function numberArraySchema(description: string): JsonSchema {
  return { type: "array", description, items: numberSchema("Item.") };
}
