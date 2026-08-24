import assert from "node:assert/strict";
import { collectDashboardCommandFields } from "../../lib/dashboard-command-safety.js";

export function dashboardDecisionPlanProjection({
  actionKind = "run-packet",
  actionReason = "Run the next accepted packet.",
  blockerCode = null,
  capabilityStatuses = {},
  loopKind,
  parentKind = "hand-back",
  phase = "packet",
}: {
  actionKind?: string;
  actionReason?: string;
  blockerCode?: string | null;
  capabilityStatuses?: Record<string, "allowed" | "blocked" | "recovery-only">;
  loopKind?: "blocked" | "complete" | "continue" | "pause";
  parentKind?: "block-final-answer" | "complete" | "hand-back";
  phase?: string;
} = {}) {
  const capabilities = {
    "mutate-session": "allowed",
    "run-packet": "allowed",
    "authorize-keep": "allowed",
    "transition-segment": "allowed",
    finalize: "allowed",
    "parent-final-answer": "allowed",
    ...capabilityStatuses,
  };
  const disposition =
    loopKind || (capabilities["run-packet"] === "allowed" ? "continue" : "blocked");
  return {
    kind: "dashboard-decision-plan-projection",
    projection: "dashboard",
    compilerSchemaVersion: 1,
    generationId: `generation-${actionKind}`,
    decisionId: `decision-${actionKind}-${blockerCode || "clear"}`,
    phase,
    action: {
      kind: actionKind,
      command: "",
      commandDigest: "redacted-command-digest",
    },
    primaryBlockerCode: blockerCode,
    capabilities,
    requiredEvidence: {
      preconditionEpoch: "accepted-contract:fixture",
      acceptedCheckIdentities: ["checks@fixture"],
      diagnosticCodes: blockerCode ? [blockerCode] : [],
      capabilityEffectCodes: Object.entries(capabilityStatuses).map(
        ([capability, status]) => `${blockerCode || "fixture"}:${capability}:${status}`,
      ),
    },
    loopDisposition: {
      kind: disposition,
      canRunPacket: capabilities["run-packet"] === "allowed",
      shouldContinue: disposition === "continue",
    },
    parentDisposition: {
      kind: parentKind,
      mayAnswer: parentKind !== "block-final-answer",
      mayClaimCompletion: parentKind === "complete",
    },
    contractDigest: "contract-fixture",
    evaluatorIdentity: "evaluator@fixture",
    outcome: "unknown",
    learning: { kind: "none", consecutiveNoLearningCandidates: 0 },
    display: { actionReason },
  };
}

export function assertNoMutatingDashboardCommands(value: unknown) {
  const commands = collectDashboardCommandFields(value).join("\n");
  assert.doesNotMatch(commands, /(?:^|\s)(?:next|log)(?:\s|$)/i);
  assert.doesNotMatch(commands, /--status\s+(?:keep|discard)\b/i);
  assert.doesNotMatch(commands, /\b(?:serve|export|benchmark-lint)\b/i);
  assert.doesNotMatch(commands, /--check-benchmark\b/i);
  assert.doesNotMatch(commands, /\s--\s+\S/i);
}

export function chartLayoutOptions() {
  return {
    beforeParse(window: Window) {
      window.ResizeObserver = class {
        callback: ResizeObserverCallback;

        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
        }

        observe(target: Element) {
          this.callback(
            [
              {
                target,
                contentRect: {
                  width: 960,
                  height: 350,
                  top: 0,
                  left: 0,
                  bottom: 350,
                  right: 960,
                  x: 0,
                  y: 0,
                },
              } as ResizeObserverEntry,
            ],
            this as unknown as ResizeObserver,
          );
        }

        disconnect() {}
        unobserve() {}
      } as unknown as typeof ResizeObserver;

      window.HTMLElement.prototype.getBoundingClientRect = function () {
        return {
          width: 960,
          height: 350,
          top: 0,
          left: 0,
          bottom: 350,
          right: 960,
          x: 0,
          y: 0,
          toJSON() {
            return this;
          },
        };
      };
    },
  };
}

export function cssHexVariables(css: string) {
  const root = extractCssBlock(css, ":root");
  const variables = new Map<string, string>();
  for (const match of root.matchAll(/(--[\w-]+):\s*(#[\da-fA-F]{6})\s*;/g)) {
    variables.set(match[1]!, match[2]!);
  }
  return variables;
}

export function requiredCssVariable(variables: ReadonlyMap<string, string>, name: string) {
  const value = variables.get(name);
  assert.ok(value, `Missing CSS variable ${name}`);
  return value;
}

export function assertContrastAtLeast(
  foreground: string,
  background: string,
  minimum: number,
  label: string,
) {
  const ratio = contrastRatio(foreground, background);
  assert.ok(ratio >= minimum, `${label} contrast ${ratio.toFixed(2)} is below ${minimum}`);
}

export function contrastRatio(foreground: string, background: string) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

export function relativeLuminance(hex: string) {
  const [redChannel, greenChannel, blueChannel] = hexToRgb(hex);
  const red = relativeColorChannel(redChannel);
  const green = relativeColorChannel(greenChannel);
  const blue = relativeColorChannel(blueChannel);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function relativeColorChannel(channel: number) {
  const normalized = channel / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

export function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  assert.match(value, /^[\da-fA-F]{6}$/);
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

export function extractCssBlock(css: string, marker: string) {
  const start = css.indexOf(marker);
  assert.notEqual(start, -1, `Missing CSS marker: ${marker}`);
  const open = css.indexOf("{", start);
  assert.notEqual(open, -1, `Missing CSS block for marker: ${marker}`);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    const char = css[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, index);
    }
  }
  throw new Error(`Unclosed CSS block for marker: ${marker}`);
}
