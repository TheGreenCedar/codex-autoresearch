import assert from "node:assert/strict";
import test from "node:test";

import {
  commandRequiresSessionMutationLock,
  commandTable,
  type JsonSchema,
} from "../lib/command-table.js";
import {
  DECISION_ACTION_KINDS,
  DECISION_CAPABILITIES,
  DECISION_OUTCOME_KINDS,
  compileDecisionPlan,
  decisionDiagnosticRegistry,
  failureLayerPreconditions,
} from "../lib/decision-compiler.js";
import type { CoherentSessionSnapshot } from "../lib/coherent-session-snapshot.js";
import {
  COMMAND_MUTATION_RECEIPT_SCHEMA_VERSION,
  DECISION_COMPILER_SCHEMA_VERSION,
} from "../lib/decision-schema-versions.js";
import { toolSchemas } from "../lib/tool-schemas.js";

const DECISION_PLAN_FIELDS = [
  "kind",
  "compilerSchemaVersion",
  "generationId",
  "decisionId",
  "phase",
  "action",
  "primaryBlockerCode",
  "capabilities",
  "loopDisposition",
  "parentDisposition",
  "contractDigest",
  "evaluatorIdentity",
  "requiredEvidence",
  "outcome",
  "learning",
  "failures",
] as const;

const MUTATION_RECEIPT_FIELDS = [
  "kind",
  "schemaVersion",
  "receiptId",
  "command",
  "status",
  "startedAt",
  "completedAt",
  "workDir",
  "preconditionGenerationId",
  "resultingCaptureStatus",
  "resultingGenerationId",
  "generationChanged",
] as const;

type Schema = JsonSchema & {
  maxItems?: number;
  minLength?: number;
  properties?: Record<string, Schema | undefined>;
};

test("every session-mutation success schema requires exhaustive decision plans and receipt", () => {
  const protocolCommands = commandTable.filter(
    (command) => command.decisionProtocol === "session-mutation",
  );
  const schemasByName = new Map(toolSchemas.map((schema) => [schema.name, schema.outputSchema]));
  const violations: string[] = [];
  const protocolSchemas = protocolCommands.map((command) => {
    const schema = schemasByName.get(command.name) as Schema | undefined;
    if (!schema) {
      violations.push(`${command.name}: missing public output schema`);
      return null;
    }
    const required = new Set(schema.required || []);
    const protocolFields = ["preconditionDecision", "mutation", "resultingDecision"];
    if (command.conditionallyMutating) {
      if (protocolFields.some((field) => required.has(field)) || schema.oneOf?.length !== 2) {
        violations.push(
          `${command.name}: conditional protocol schema is not a read/mutation union`,
        );
      }
    } else {
      const missingEnvelopes = protocolFields.filter((field) => !required.has(field));
      if (missingEnvelopes.length > 0) {
        violations.push(
          `${command.name}: protocol fields are optional (${missingEnvelopes.join(", ")})`,
        );
      }
    }
    return {
      command: command.name,
      preconditionDecision: schema.properties?.preconditionDecision as Schema | undefined,
      mutation: schema.properties?.mutation as Schema | undefined,
      resultingDecision: schema.properties?.resultingDecision as Schema | undefined,
    };
  });

  const representative = protocolSchemas.find((schema) => schema !== null);
  assert.ok(representative, "command table must expose at least one session-mutation schema");
  for (const schema of protocolSchemas) {
    if (!schema) continue;
    for (const field of ["preconditionDecision", "mutation", "resultingDecision"] as const) {
      if (JSON.stringify(schema[field]) !== JSON.stringify(representative[field])) {
        violations.push(
          `${schema.command}: ${field} differs from the shared ${field} protocol schema`,
        );
      }
    }
  }

  checkDecisionPlanSchema(representative.preconditionDecision, "preconditionDecision", violations);
  checkMutationReceiptSchema(representative.mutation, "mutation", violations);
  checkDecisionPlanSchema(representative.resultingDecision, "resultingDecision", violations);

  assert.deepEqual(violations, [], violations.join("\n"));
});

test("the public DecisionPlan schema accepts an actual default runnable plan", () => {
  const outputSchema = toolSchemas.find((schema) => schema.name === "setup_research_session")
    ?.outputSchema as Schema | undefined;
  const decisionSchema = outputSchema?.properties?.preconditionDecision as Schema | undefined;
  assert.ok(decisionSchema, "a mutation schema must expose preconditionDecision");

  const plan = compileDecisionPlan(snapshotFixture(), []);
  assert.equal(plan.action.kind, "run-packet");
  const violations: string[] = [];
  validateValueAgainstSchema(plan, decisionSchema, "DecisionPlan", violations);
  assert.deepEqual(violations, [], violations.join("\n"));
});

test("the public DecisionPlan schema accepts compiled learning variants and rejects impossible variants", () => {
  const outputSchema = toolSchemas.find((schema) => schema.name === "setup_research_session")
    ?.outputSchema as Schema | undefined;
  const decisionSchema = outputSchema?.properties?.preconditionDecision as Schema | undefined;
  assert.ok(decisionSchema, "a mutation schema must expose preconditionDecision");

  const nonePlan = compileDecisionPlan(snapshotFixture(), []);
  const causalPlan = compileDecisionPlan(
    snapshotFixture({
      records: [
        {
          type: "run",
          run: 1,
          runPurpose: "candidate",
          evaluationAuthority: "accepted-contract",
          candidateOrigin: { kind: "working-tree" },
          experimentContractDigest: "contract-default",
          preconditionEpoch: "epoch-default",
          learning: {
            kind: "causal",
            changedBelief: "The trace identifies the cache key as the causal boundary.",
            evidence: ["trace:accepted-candidate"],
          },
        },
      ],
    }),
    [],
  );
  assert.equal(nonePlan.learning.latest.kind, "none");
  assert.equal(causalPlan.learning.latest.kind, "causal");

  for (const [name, plan] of [
    ["none", nonePlan],
    ["causal", causalPlan],
  ] as const) {
    const violations: string[] = [];
    validateValueAgainstSchema(plan, decisionSchema, `DecisionPlan.${name}`, violations);
    assert.deepEqual(violations, [], `${name}: ${violations.join("\n")}`);
  }

  const impossiblePlans = [
    {
      name: "none with a learning claim",
      plan: {
        ...nonePlan,
        learning: {
          ...nonePlan.learning,
          latest: {
            kind: "none",
            changedBelief: "A none claim cannot change belief.",
            evidence: ["trace:impossible-none"],
          },
        },
      },
    },
    {
      name: "causal without evidence",
      plan: {
        ...causalPlan,
        learning: {
          ...causalPlan.learning,
          latest: { ...causalPlan.learning.latest, evidence: [] },
        },
      },
    },
    {
      name: "causal without a concrete belief",
      plan: {
        ...causalPlan,
        learning: {
          ...causalPlan.learning,
          latest: { ...causalPlan.learning.latest, changedBelief: "" },
        },
      },
    },
  ];
  for (const { name, plan } of impossiblePlans) {
    const violations: string[] = [];
    validateValueAgainstSchema(plan, decisionSchema, `DecisionPlan.${name}`, violations);
    assert.notDeepEqual(violations, [], `${name}: impossible state matched the public schema`);
  }
});

test("commands with dry-run mutation bypasses expose conditional protocol schemas", () => {
  const schemasByName = new Map(toolSchemas.map((schema) => [schema.name, schema.outputSchema]));
  for (const name of ["start_research_loop", "new_segment", "promote_gate", "clear_session"]) {
    const command = commandTable.find((candidate) => candidate.name === name);
    assert.ok(command, name);
    assert.equal(command.conditionallyMutating, true, `${name}: conditional mutation metadata`);
    assert.equal(
      commandRequiresSessionMutationLock(command.cliCommand, { dry_run: true }),
      false,
      `${name}: dry run stays outside the mutation protocol`,
    );
    assert.equal(
      commandRequiresSessionMutationLock(command.cliCommand, {}),
      true,
      `${name}: real execution stays mutation locked`,
    );
    const schema = schemasByName.get(name) as Schema | undefined;
    assert.equal(schema?.oneOf?.length, 2, `${name}: read/mutation output union`);
  }
});

function checkDecisionPlanSchema(
  schema: Schema | undefined,
  path: string,
  violations: string[],
): void {
  const properties = checkClosedObject(schema, path, DECISION_PLAN_FIELDS, violations);
  if (!properties) return;

  checkString(properties.kind, `${path}.kind`, violations, ["decision-plan"]);
  checkInteger(
    properties.compilerSchemaVersion,
    `${path}.compilerSchemaVersion`,
    violations,
    DECISION_COMPILER_SCHEMA_VERSION,
  );
  checkString(properties.generationId, `${path}.generationId`, violations);
  checkString(properties.decisionId, `${path}.decisionId`, violations);
  checkString(properties.phase, `${path}.phase`, violations, [
    "complete",
    "direct-work",
    "finalization",
    "packet",
    "paused",
    "recovery",
    "setup",
  ]);
  checkNullableString(
    properties.primaryBlockerCode,
    `${path}.primaryBlockerCode`,
    violations,
    Object.keys(decisionDiagnosticRegistry),
  );
  checkString(properties.contractDigest, `${path}.contractDigest`, violations);
  checkString(properties.evaluatorIdentity, `${path}.evaluatorIdentity`, violations);

  const action = checkClosedObject(
    properties.action,
    `${path}.action`,
    ["kind", "reason", "command", "commandDigest", "commandSemanticId"],
    violations,
  );
  if (action) {
    for (const field of [
      "kind",
      "reason",
      "command",
      "commandDigest",
      "commandSemanticId",
    ] as const) {
      checkString(
        action[field],
        `${path}.action.${field}`,
        violations,
        field === "kind" ? DECISION_ACTION_KINDS : undefined,
      );
    }
  }

  const capabilities = checkClosedObject(
    properties.capabilities,
    `${path}.capabilities`,
    DECISION_CAPABILITIES,
    violations,
  );
  if (capabilities) {
    for (const capability of DECISION_CAPABILITIES) {
      checkString(capabilities[capability], `${path}.capabilities.${capability}`, violations, [
        "allowed",
        "blocked",
        "recovery-only",
      ]);
    }
  }

  const loop = checkClosedObject(
    properties.loopDisposition,
    `${path}.loopDisposition`,
    ["kind", "canRunPacket", "shouldContinue"],
    violations,
  );
  if (loop) {
    checkString(loop.kind, `${path}.loopDisposition.kind`, violations, [
      "blocked",
      "complete",
      "continue",
      "pause",
    ]);
    checkType(loop.canRunPacket, `${path}.loopDisposition.canRunPacket`, "boolean", violations);
    checkType(loop.shouldContinue, `${path}.loopDisposition.shouldContinue`, "boolean", violations);
  }

  const parent = checkClosedObject(
    properties.parentDisposition,
    `${path}.parentDisposition`,
    ["kind", "mayAnswer", "mayClaimCompletion"],
    violations,
  );
  if (parent) {
    checkString(parent.kind, `${path}.parentDisposition.kind`, violations, [
      "block-final-answer",
      "complete",
      "continue-working",
      "hand-back",
    ]);
    checkType(parent.mayAnswer, `${path}.parentDisposition.mayAnswer`, "boolean", violations);
    checkType(
      parent.mayClaimCompletion,
      `${path}.parentDisposition.mayClaimCompletion`,
      "boolean",
      violations,
    );
  }

  const evidence = checkClosedObject(
    properties.requiredEvidence,
    `${path}.requiredEvidence`,
    [
      "preconditionEpoch",
      "acceptedCheckIdentities",
      "diagnosticCodes",
      "capabilityEffectCodes",
      "failureLayer",
      "failurePreconditions",
    ],
    violations,
  );
  if (evidence) {
    checkString(
      evidence.preconditionEpoch,
      `${path}.requiredEvidence.preconditionEpoch`,
      violations,
    );
    for (const field of [
      "acceptedCheckIdentities",
      "diagnosticCodes",
      "capabilityEffectCodes",
      "failurePreconditions",
    ] as const) {
      checkStringArray(
        evidence[field],
        `${path}.requiredEvidence.${field}`,
        violations,
        field === "diagnosticCodes" ? Object.keys(decisionDiagnosticRegistry) : undefined,
      );
    }
    checkNullableString(
      evidence.failureLayer,
      `${path}.requiredEvidence.failureLayer`,
      violations,
      Object.keys(failureLayerPreconditions),
    );
  }

  const outcome = checkClosedObject(
    properties.outcome,
    `${path}.outcome`,
    ["kind", "execution", "validity", "conclusion", "movement", "attainment", "codeAcceptance"],
    violations,
  );
  if (outcome) {
    checkString(outcome.kind, `${path}.outcome.kind`, violations, DECISION_OUTCOME_KINDS);
  }

  const learning = checkClosedObject(
    properties.learning,
    `${path}.learning`,
    ["latest", "consecutiveNoLearningCandidates"],
    violations,
  );
  if (learning) {
    const latestVariants = learning.latest?.oneOf;
    if (latestVariants?.length !== 2) {
      violations.push(`${path}.learning.latest: expected a two-variant oneOf schema`);
    } else {
      const none = checkClosedObject(
        latestVariants[0] as Schema,
        `${path}.learning.latest.none`,
        ["kind", "changedBelief", "evidence"],
        violations,
      );
      if (none) {
        checkString(none.kind, `${path}.learning.latest.none.kind`, violations, ["none"]);
        checkType(
          none.changedBelief,
          `${path}.learning.latest.none.changedBelief`,
          "null",
          violations,
        );
        checkStringArray(none.evidence, `${path}.learning.latest.none.evidence`, violations);
        if (none.evidence?.maxItems !== 0) {
          violations.push(`${path}.learning.latest.none.evidence: expected maxItems 0`);
        }
      }
      const learned = checkClosedObject(
        latestVariants[1] as Schema,
        `${path}.learning.latest.learned`,
        ["kind", "changedBelief", "evidence"],
        violations,
      );
      if (learned) {
        checkString(learned.kind, `${path}.learning.latest.learned.kind`, violations, [
          "causal",
          "discriminating",
        ]);
        checkString(
          learned.changedBelief,
          `${path}.learning.latest.learned.changedBelief`,
          violations,
        );
        if (learned.changedBelief?.minLength !== 1) {
          violations.push(`${path}.learning.latest.learned.changedBelief: expected minLength 1`);
        }
        checkStringArray(learned.evidence, `${path}.learning.latest.learned.evidence`, violations);
        if (learned.evidence?.minItems !== 1) {
          violations.push(`${path}.learning.latest.learned.evidence: expected minItems 1`);
        }
      }
    }
    checkInteger(
      learning.consecutiveNoLearningCandidates,
      `${path}.learning.consecutiveNoLearningCandidates`,
      violations,
    );
  }

  const failures = checkClosedObject(
    properties.failures,
    `${path}.failures`,
    ["layer", "consecutive"],
    violations,
  );
  if (failures) {
    checkNullableString(
      failures.layer,
      `${path}.failures.layer`,
      violations,
      Object.keys(failureLayerPreconditions),
    );
    checkInteger(failures.consecutive, `${path}.failures.consecutive`, violations);
  }
}

function checkMutationReceiptSchema(
  schema: Schema | undefined,
  path: string,
  violations: string[],
): void {
  const properties = checkClosedObject(schema, path, MUTATION_RECEIPT_FIELDS, violations);
  if (!properties) return;
  checkString(properties.kind, `${path}.kind`, violations, ["command-mutation-receipt"]);
  checkInteger(
    properties.schemaVersion,
    `${path}.schemaVersion`,
    violations,
    COMMAND_MUTATION_RECEIPT_SCHEMA_VERSION,
  );
  for (const field of [
    "receiptId",
    "command",
    "startedAt",
    "completedAt",
    "workDir",
    "preconditionGenerationId",
  ] as const) {
    checkString(properties[field], `${path}.${field}`, violations);
  }
  checkString(properties.status, `${path}.status`, violations, ["completed", "failed"]);
  checkString(properties.resultingCaptureStatus, `${path}.resultingCaptureStatus`, violations, [
    "captured",
    "unavailable",
  ]);
  checkNullableString(
    properties.resultingGenerationId,
    `${path}.resultingGenerationId`,
    violations,
  );
  checkNullableBoolean(properties.generationChanged, `${path}.generationChanged`, violations);
}

function checkClosedObject(
  schema: Schema | undefined,
  path: string,
  fields: readonly string[],
  violations: string[],
): Record<string, Schema | undefined> | null {
  if (schema?.type !== "object") {
    violations.push(`${path}: expected object schema`);
    return null;
  }
  if (schema.additionalProperties !== false) {
    violations.push(`${path}: object schema must be closed`);
  }
  const properties = schema.properties || {};
  const missingProperties = fields.filter((field) => !properties[field]);
  const extraProperties = Object.keys(properties).filter((field) => !fields.includes(field));
  if (missingProperties.length > 0 || extraProperties.length > 0) {
    violations.push(
      `${path}: properties mismatch (missing: ${missingProperties.join(", ") || "none"}; extra: ${extraProperties.join(", ") || "none"})`,
    );
  }
  const required = new Set(schema.required || []);
  const optional = fields.filter((field) => !required.has(field));
  if (optional.length > 0 || required.size !== fields.length) {
    violations.push(`${path}: required fields mismatch (${optional.join(", ") || "extra fields"})`);
  }
  return properties;
}

function checkString(
  schema: Schema | undefined,
  path: string,
  violations: string[],
  values?: readonly string[],
): void {
  checkType(schema, path, "string", violations);
  if (values && !sameMembers(schema?.enum || [], values)) {
    violations.push(`${path}: enum mismatch`);
  }
}

function checkNullableString(
  schema: Schema | undefined,
  path: string,
  violations: string[],
  values?: readonly string[],
): void {
  if (!Array.isArray(schema?.type) || !sameMembers(schema.type, ["string", "null"])) {
    violations.push(`${path}: expected nullable string schema`);
  }
  if (values && !sameMembers(schema?.enum || [], [...values, null])) {
    violations.push(`${path}: nullable enum mismatch`);
  }
}

function checkNullableBoolean(
  schema: Schema | undefined,
  path: string,
  violations: string[],
): void {
  if (!Array.isArray(schema?.type) || !sameMembers(schema.type, ["boolean", "null"])) {
    violations.push(`${path}: expected nullable boolean schema`);
  }
}

function checkInteger(
  schema: Schema | undefined,
  path: string,
  violations: string[],
  literal?: number,
): void {
  checkType(schema, path, "integer", violations);
  if (literal != null && !sameMembers(schema?.enum || [], [literal])) {
    violations.push(`${path}: integer literal mismatch`);
  }
}

function checkStringArray(
  schema: Schema | undefined,
  path: string,
  violations: string[],
  values?: readonly string[],
): void {
  checkType(schema, path, "array", violations);
  checkType(schema?.items as Schema | undefined, `${path}[]`, "string", violations);
  if (values && !sameMembers(schema?.items?.enum || [], values)) {
    violations.push(`${path}[]: enum mismatch`);
  }
}

function checkType(
  schema: Schema | undefined,
  path: string,
  expected: string,
  violations: string[],
): void {
  if (schema?.type !== expected) violations.push(`${path}: expected ${expected} schema`);
}

function sameMembers(left: readonly unknown[], right: readonly unknown[]): boolean {
  return [...left].map(String).sort().join("\0") === [...right].map(String).sort().join("\0");
}

function validateValueAgainstSchema(
  value: unknown,
  schema: Schema | undefined,
  path: string,
  violations: string[],
): void {
  if (!schema) {
    violations.push(`${path}: missing schema`);
    return;
  }
  if (schema.oneOf) {
    const matchingBranches = schema.oneOf.filter((branch) => {
      const branchViolations: string[] = [];
      validateValueAgainstSchema(value, branch as Schema, path, branchViolations);
      return branchViolations.length === 0;
    });
    if (matchingBranches.length !== 1) {
      violations.push(`${path}: matched ${matchingBranches.length} oneOf branches instead of 1`);
      return;
    }
  }
  const actualType =
    value === null
      ? "null"
      : Array.isArray(value)
        ? "array"
        : typeof value === "number" && Number.isInteger(value)
          ? "integer"
          : typeof value;
  if (schema.type) {
    const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowedTypes.includes(actualType)) {
      violations.push(`${path}: ${actualType} is not one of ${allowedTypes.join(", ")}`);
      return;
    }
  }
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    violations.push(`${path}: ${JSON.stringify(value)} is outside the enum`);
  }
  if (actualType === "array") {
    if (schema.minItems != null && (value as unknown[]).length < schema.minItems) {
      violations.push(`${path}: fewer than ${schema.minItems} items`);
    }
    if (schema.maxItems != null && (value as unknown[]).length > schema.maxItems) {
      violations.push(`${path}: more than ${schema.maxItems} items`);
    }
    for (const [index, item] of (value as unknown[]).entries()) {
      validateValueAgainstSchema(
        item,
        schema.items as Schema | undefined,
        `${path}[${index}]`,
        violations,
      );
    }
    return;
  }
  if (
    actualType === "string" &&
    schema.minLength != null &&
    String(value).length < schema.minLength
  ) {
    violations.push(`${path}: shorter than ${schema.minLength} characters`);
  }
  if (actualType !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  const properties = schema.properties || {};
  for (const required of schema.required || []) {
    if (!Object.hasOwn(record, required))
      violations.push(`${path}.${required}: missing required value`);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(record)) {
      if (!Object.hasOwn(properties, key)) violations.push(`${path}.${key}: unexpected value`);
    }
  }
  for (const [key, item] of Object.entries(record)) {
    if (properties[key]) {
      validateValueAgainstSchema(item, properties[key], `${path}.${key}`, violations);
    }
  }
}

function snapshotFixture(
  overrides: { records?: Record<string, unknown>[] } = {},
): CoherentSessionSnapshot {
  return {
    kind: "coherent-session-snapshot",
    schemaVersion: 1,
    generationId: "generation-default-plan",
    sessionCwd: "/session",
    workDir: "/worktree",
    vector: {
      ledger: { size: 0, mtimeNs: "0", tailHash: "missing" },
      config: { storage: "session", hash: "config" },
      packet: { storage: "git-private", hash: "missing" },
      receipt: { storage: "git-private", hash: "missing" },
      process: { storage: "git-private", hash: "missing" },
      git: { head: "head", indexTree: "index", statusHash: "status" },
    },
    records: overrides.records || [],
    config: {},
    lastRunPacket: null,
    pendingTransaction: null,
    processProgress: null,
    git: { head: "head", indexTree: "index", statusHash: "status" },
    gitTrust: null,
    completionAudit: null,
    sourceDiagnostics: { ledgerIssues: [] },
    semanticFacts: {
      contractDigest: "contract-default",
      evaluatorIdentity: "evaluator-default",
      acceptedCheckIdentities: [],
      preconditionEpoch: "epoch-default",
    },
  };
}
