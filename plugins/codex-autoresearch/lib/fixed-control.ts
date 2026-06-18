import { redactCommandDisplay } from "./evidence-redaction.js";

type LooseObject = Record<string, unknown>;
const STATE_STRING_LIMIT = 240;
const STATE_ARRAY_LIMIT = 10;
const SECRET_LIKE_TOKEN = /\b(?:sk|ghp|github_pat|xoxb|xoxp)[A-Za-z0-9_.-]{8,}\b/g;

export interface FixedControlConfig {
  artifact: string;
  reason: string;
  validUntilChanged: string[];
  forbiddenCommandPatterns: string[];
  reuseCommandHint: string;
}

export interface FixedControlViolation {
  code: "fixed_control_rerun_blocked";
  message: string;
  pattern: string;
  artifact: string;
  reuseCommandHint: string;
}

export interface FixedControlStateSummary extends FixedControlConfig {
  truncated: boolean;
  truncation: {
    artifactChars: number;
    reasonChars: number;
    validUntilChanged: number;
    validUntilChangedChars: number;
    forbiddenCommandPatterns: number;
    forbiddenCommandPatternChars: number;
    reuseCommandHintChars: number;
  };
}

export interface FixedControlViolationSummary extends FixedControlViolation {
  truncated: boolean;
  truncation: {
    artifactChars: number;
    messageChars: number;
    patternChars: number;
    reuseCommandHintChars: number;
  };
}

export function normalizeFixedControlConfig(value: unknown): FixedControlConfig | null {
  if (!value || typeof value !== "object") return null;
  const record = value as LooseObject;
  const artifact = stringValue(record.artifact);
  const reason = stringValue(record.reason);
  const forbiddenCommandPatterns = stringArray(record.forbiddenCommandPatterns);
  if (!artifact || !reason || forbiddenCommandPatterns.length === 0) return null;
  return {
    artifact,
    reason,
    validUntilChanged: stringArray(record.validUntilChanged),
    forbiddenCommandPatterns,
    reuseCommandHint: stringValue(record.reuseCommandHint),
  };
}

export function fixedControlViolationForCommand(
  command: unknown,
  fixedControl: FixedControlConfig | null,
): FixedControlViolation | null {
  const text = stringValue(command);
  if (!text || !fixedControl) return null;
  for (const pattern of fixedControl.forbiddenCommandPatterns) {
    if (text.includes(pattern)) {
      return {
        code: "fixed_control_rerun_blocked",
        message: `Fixed control ${fixedControl.artifact} is active: ${fixedControl.reason}. Reuse the artifact instead of rerunning a forbidden control command.`,
        pattern,
        artifact: fixedControl.artifact,
        reuseCommandHint: fixedControl.reuseCommandHint,
      };
    }
  }
  return null;
}

export function fixedControlStateSummary(value: unknown): FixedControlStateSummary | null {
  const fixedControl = normalizeFixedControlConfig(value);
  if (!fixedControl) return null;
  const artifact = cappedString(redactFixedControlText(fixedControl.artifact));
  const reason = cappedString(redactFixedControlText(fixedControl.reason));
  const validUntilChanged = cappedStringArray(
    fixedControl.validUntilChanged,
    redactFixedControlText,
  );
  const forbiddenCommandPatterns = cappedStringArray(
    fixedControl.forbiddenCommandPatterns,
    redactFixedControlText,
  );
  const reuseCommandHint = cappedString(redactFixedControlText(fixedControl.reuseCommandHint));
  const truncation = {
    artifactChars: artifact.truncatedChars,
    reasonChars: reason.truncatedChars,
    validUntilChanged: validUntilChanged.truncatedItems,
    validUntilChangedChars: validUntilChanged.truncatedChars,
    forbiddenCommandPatterns: forbiddenCommandPatterns.truncatedItems,
    forbiddenCommandPatternChars: forbiddenCommandPatterns.truncatedChars,
    reuseCommandHintChars: reuseCommandHint.truncatedChars,
  };
  return {
    artifact: artifact.value,
    reason: reason.value,
    validUntilChanged: validUntilChanged.values,
    forbiddenCommandPatterns: forbiddenCommandPatterns.values,
    reuseCommandHint: reuseCommandHint.value,
    truncated: Object.values(truncation).some((count) => count > 0),
    truncation,
  };
}

export function fixedControlViolationSummary(
  value: FixedControlViolation | null,
): FixedControlViolationSummary | null {
  if (!value) return null;
  const artifact = cappedString(redactFixedControlText(value.artifact));
  const message = cappedString(redactFixedControlText(value.message));
  const pattern = cappedString(redactFixedControlText(value.pattern));
  const reuseCommandHint = cappedString(redactFixedControlText(value.reuseCommandHint));
  const truncation = {
    artifactChars: artifact.truncatedChars,
    messageChars: message.truncatedChars,
    patternChars: pattern.truncatedChars,
    reuseCommandHintChars: reuseCommandHint.truncatedChars,
  };
  return {
    code: value.code,
    message: message.value,
    pattern: pattern.value,
    artifact: artifact.value,
    reuseCommandHint: reuseCommandHint.value,
    truncated: Object.values(truncation).some((count) => count > 0),
    truncation,
  };
}

export function redactFixedControlViolation(
  value: FixedControlViolation | null,
): FixedControlViolationSummary | null {
  return fixedControlViolationSummary(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(stringValue).filter(Boolean);
}

function cappedString(value: string): { value: string; truncatedChars: number } {
  if (value.length <= STATE_STRING_LIMIT) return { value, truncatedChars: 0 };
  return {
    value: value.slice(0, STATE_STRING_LIMIT),
    truncatedChars: value.length - STATE_STRING_LIMIT,
  };
}

function cappedStringArray(
  value: string[],
  prepare: (value: string) => string = (item) => item,
): {
  values: string[];
  truncatedChars: number;
  truncatedItems: number;
} {
  const prepared = value.map(prepare);
  let truncatedChars = prepared
    .slice(STATE_ARRAY_LIMIT)
    .reduce((total, item) => total + item.length, 0);
  const values = prepared.slice(0, STATE_ARRAY_LIMIT).map((item) => {
    const capped = cappedString(item);
    truncatedChars += capped.truncatedChars;
    return capped.value;
  });
  return {
    values,
    truncatedChars,
    truncatedItems: Math.max(0, prepared.length - STATE_ARRAY_LIMIT),
  };
}

function redactFixedControlText(value: string): string {
  return redactCommandDisplay(value).replace(SECRET_LIKE_TOKEN, "<redacted>");
}
