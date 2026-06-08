export type GatePosture =
  | "missing"
  | "advisory-missing"
  | "smoke"
  | "correctness"
  | "holdout"
  | "promotion"
  | "malformed"
  | "unknown";

export interface GateQualityInput {
  benchmarkCommand?: string;
  checksCommand?: string;
  checksPolicy?: string;
  checksRequired?: boolean;
  qualityConstraints?: Array<Record<string, unknown>> | null;
  promotion?: Record<string, unknown> | null;
  holdout?: Record<string, unknown> | null;
}

export interface GateQualityWarningDetail {
  code: string;
  severity: "warning" | "error";
  message: string;
  domain?: string;
}

export interface GateQualitySummary {
  posture: GatePosture;
  blockers: string[];
  warnings: string[];
  warningDetails: GateQualityWarningDetail[];
  evidence: string[];
  nextActionHint: string;
}

const CHECKS_VERB_PATTERN =
  /(?:^|[\s:._-])(test|check|typecheck|type-check|lint|build)(?:$|[\s:._-])/i;
const DOMAIN_QUALITY_PATTERN =
  /(?:^|[\s:._/@-])(recall|mrr|ranking|quality|accessibility|axe|wcag|security)(?:$|[\s:._/@-])/i;

export function evaluateGateQuality(input: GateQualityInput): GateQualitySummary {
  const malformedFields = malformedCommandFields(input);
  if (malformedFields.length > 0) {
    return {
      posture: "malformed",
      blockers: malformedFields.map((field) => `${field} must be a string when provided.`),
      warnings: [],
      warningDetails: [],
      evidence: [],
      nextActionHint: "Repair the malformed command configuration before judging gate quality.",
    };
  }

  const benchmarkCommand = normalizeCommand(input.benchmarkCommand);
  const checksCommand = normalizeCommand(input.checksCommand);
  const checksPolicy = normalizeCommand(input.checksPolicy) || "unspecified";
  const qualityConstraintWarnings = missingQualityConstraintWarnings(input.qualityConstraints);

  if (!checksCommand) {
    if (input.checksRequired === true || qualityConstraintWarnings.length > 0) {
      return {
        posture: "missing",
        blockers: qualityConstraintWarnings.length
          ? ["No quality gate is configured for a quality-sensitive performance loop."]
          : ["No checks command is configured for an independent gate."],
        warnings: qualityConstraintWarnings.map((warning) => warning.message),
        warningDetails: qualityConstraintWarnings,
        evidence: ["Benchmark command is present, but checks command is empty."],
        nextActionHint: qualityConstraintWarnings.length
          ? "Add recall, ranking, accessibility, security, or equivalent correctness checks before promoting speed wins."
          : "Add a checks command or gate before trusting optimization results.",
      };
    }

    return {
      posture: "advisory-missing",
      blockers: [],
      warnings: [
        `No checks command is configured; checksPolicy is ${checksPolicy}, so the independent gate is advisory.`,
      ],
      warningDetails: [],
      evidence: ["Benchmark command is present, but checks command is empty."],
      nextActionHint:
        "Treat the missing checks gate as advisory unless this loop requires an independent gate.",
    };
  }

  if (benchmarkCommand && checksCommand === benchmarkCommand) {
    return {
      posture: "smoke",
      blockers: [],
      warnings: [
        "Checks command matches the benchmark command, which is weak protection without an independent pass/fail gate.",
      ],
      warningDetails: [],
      evidence: ["Checks command is identical to the benchmark command."],
      nextActionHint:
        "Add a separate correctness gate that can fail independently of the benchmark.",
    };
  }

  if (hasMetadata(input.promotion)) {
    return {
      posture: "promotion",
      blockers: [],
      warnings: [],
      warningDetails: [],
      evidence: ["Promotion metadata is present; this gate can support promotion-grade decisions."],
      nextActionHint:
        "Use the promotion evidence to decide whether the kept result is review-ready.",
    };
  }

  if (hasMetadata(input.holdout)) {
    return {
      posture: "holdout",
      blockers: [],
      warnings: [],
      warningDetails: [],
      evidence: ["Holdout metadata is present without promotion metadata."],
      nextActionHint: "Review holdout evidence before promoting the result.",
    };
  }

  if (CHECKS_VERB_PATTERN.test(checksCommand) || DOMAIN_QUALITY_PATTERN.test(checksCommand)) {
    return {
      posture: "correctness",
      blockers: [],
      warnings: [],
      warningDetails: [],
      evidence: [
        "Checks command contains an obvious verification verb or domain quality gate.",
      ],
      nextActionHint:
        "Run the checks gate and use pass/fail evidence alongside the benchmark metric.",
    };
  }

  if (qualityConstraintWarnings.length > 0) {
    return {
      posture: "unknown",
      blockers: [],
      warnings: qualityConstraintWarnings.map((warning) => warning.message),
      warningDetails: qualityConstraintWarnings,
      evidence: [
        "Checks command is present, but no recognizable quality gate was detected for the quality-sensitive domain.",
      ],
      nextActionHint:
        "Document, classify, or replace the checks command with a recognizable quality gate before promotion.",
    };
  }

  return {
    posture: "unknown",
    blockers: [],
    warnings: ["Checks command is present, but its gate strength is not recognizable."],
    warningDetails: [],
    evidence: ["Checks command does not match known correctness, holdout, or promotion signals."],
    nextActionHint:
      "Document, classify, or replace the checks command so the gate posture is clear.",
  };
}

function malformedCommandFields(input: GateQualityInput): string[] {
  const fields: string[] = [];
  if (input.benchmarkCommand !== undefined && typeof input.benchmarkCommand !== "string") {
    fields.push("benchmarkCommand");
  }
  if (input.checksCommand !== undefined && typeof input.checksCommand !== "string") {
    fields.push("checksCommand");
  }
  return fields;
}

function normalizeCommand(command: string | undefined): string {
  return command?.trim() ?? "";
}

function missingQualityConstraintWarnings(
  qualityConstraints: Array<Record<string, unknown>> | null | undefined,
): GateQualityWarningDetail[] {
  if (!Array.isArray(qualityConstraints)) return [];
  return qualityConstraints
    .filter((constraint) => constraint?.requiredBeforePromotion === true)
    .map((constraint) => {
      const domain = normalizeCommand(String(constraint.domain || "quality"));
      const guidance =
        normalizeCommand(String(constraint.guidance || "")) ||
        "Add or identify a correctness check before promotion.";
      return {
        code: "missing_quality_constraint",
        severity: "warning" as const,
        domain,
        message: `Missing quality constraint for ${domain}: ${guidance}`,
      };
    });
}

function hasMetadata(value: Record<string, unknown> | null | undefined): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).some(([key, fieldValue]) =>
    meaningfulMetadataValue(key, fieldValue),
  );
}

function meaningfulMetadataValue(key: string, value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "boolean") return value === true;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return false;
    if (/^(count|kept|runs?|total)$/i.test(key)) return value > 0;
    return true;
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([childKey, childValue]) =>
      meaningfulMetadataValue(childKey, childValue),
    );
  }
  return false;
}
