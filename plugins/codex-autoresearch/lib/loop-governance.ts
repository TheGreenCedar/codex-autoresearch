import { actionMetadataForKind } from "./action-metadata.js";

type LooseObject = Record<string, unknown>;

export interface LoopAction {
  kind: string;
  priority: number;
  reason: string;
  command: string;
  triggeredBy: string[];
  label?: string;
}

export interface LoopContractStatus {
  ok: boolean;
  canRunNextPacket: boolean;
  blockers: LoopAction[];
  warnings: LoopAction[];
  strongestAction: LoopAction | null;
}

const LOOP_PRIORITY = {
  essentialSafety: 1,
  goalContract: 1.25,
  approvalGate: 1.5,
  laneCleanup: 2,
  pendingPacket: 2.5,
  validationGate: 3,
  setupOrDecision: 4,
  boundedDecisionCapsule: 6,
  segmentTransition: 7,
  currentTreeFinalization: 8,
  finalizationReadiness: 9,
  nextPacket: 10,
} as const;

function loopAction(
  kind: string,
  priority: number,
  reason: unknown,
  command: unknown = "",
  triggeredBy: unknown = [kind],
): LoopAction {
  const metadata = actionMetadataForKind(kind);
  const actionCommand = stringValue(command);
  return {
    kind,
    priority,
    reason: stringValue(reason),
    command: actionCommand,
    triggeredBy: stringList(triggeredBy, [kind]),
    ...(metadata?.label ? { label: metadata.label } : {}),
  };
}

export function buildLoopContractStatus(envelope: LooseObject = {}): LoopContractStatus {
  const blockers: LoopAction[] = [];
  const warnings: LoopAction[] = [];
  const goalContract = objectValue(envelope.goalContract);
  if (goalContract?.blocksPacket === true || goalContract?.blocksFinalization === true) {
    const goalBlockers = stringList(goalContract.blockers, []);
    blockers.push(
      loopAction(
        "goal-contract",
        LOOP_PRIORITY.goalContract,
        goalBlockers[0] || "Resolve the goal contract before broad packet or finalization work.",
        goalContract.recoveryCommand || goalContract.command,
        ["goalContract"],
      ),
    );
  }

  const approvalLedger = objectValue(envelope.approvalLedger);
  const approvalBlockers = stringList(approvalLedger?.blockers, []);
  if (approvalBlockers.length > 0 || approvalLedger?.status === "blocked") {
    blockers.push(
      loopAction(
        "approval-gate",
        LOOP_PRIORITY.approvalGate,
        approvalBlockers[0] || "Record the required scoped approval before continuing.",
        approvalLedger?.command,
        ["approvalLedger"],
      ),
    );
  }

  const resourcePreflight = objectValue(envelope.resourcePreflight);
  const resourceBlockers = stringList(resourcePreflight?.blockers, []);
  if (resourcePreflight?.canStart === false || resourceBlockers.length > 0) {
    blockers.push(
      loopAction(
        "resource-governor",
        LOOP_PRIORITY.essentialSafety,
        resourceBlockers[0] ||
          resourcePreflight?.nextAction ||
          "Resolve resource preflight blockers.",
        resourcePreflight?.command,
        ["resourcePreflight"],
      ),
    );
  } else if (resourcePreflight?.status === "warning") {
    const resourceWarnings = stringList(resourcePreflight.warnings, []);
    warnings.push(
      loopAction(
        "resource-governor",
        LOOP_PRIORITY.validationGate,
        resourceWarnings[0] ||
          resourcePreflight.nextAction ||
          "Review resource preflight warnings.",
        resourcePreflight.command,
        ["resourcePreflight"],
      ),
    );
  }

  const evidenceMaturity = objectValue(envelope.evidenceMaturity);
  const evidenceBlockers = stringList(evidenceMaturity?.blockers, []);
  if (
    evidenceMaturity?.blocksPacket === true ||
    evidenceMaturity?.blocksFinalization === true ||
    evidenceBlockers.length > 0
  ) {
    blockers.push(
      loopAction(
        "evidence-maturity",
        LOOP_PRIORITY.validationGate,
        evidenceBlockers[0] ||
          evidenceMaturity?.weakerClaim ||
          "Evidence maturity does not support the requested claim.",
        evidenceMaturity?.command,
        ["evidenceMaturity"],
      ),
    );
  }

  const contextDistillation = objectValue(envelope.contextDistillation);
  if (contextDistillation?.required === true) {
    blockers.push(
      loopAction(
        "context-distillation",
        LOOP_PRIORITY.essentialSafety,
        contextDistillation.reason || "Refresh a context capsule before more packets.",
        contextDistillation.command,
        contextDistillation.triggeredBy || ["contextDistillation"],
      ),
    );
  }

  const laneLifecycle = objectValue(envelope.laneLifecycle);
  const staleLanes = arrayValue(laneLifecycle?.staleLanes);
  const laneCleanupRequired =
    staleLanes.length > 0 ||
    laneLifecycle?.stale === true ||
    laneLifecycle?.cleanupRequired === true ||
    laneLifecycle?.unclosed === true;
  if (laneCleanupRequired) {
    const staleLane = objectValue(staleLanes[0]);
    blockers.push(
      loopAction(
        "lane-cleanup",
        LOOP_PRIORITY.laneCleanup,
        laneLifecycle?.recommendation ||
          laneLifecycle?.reason ||
          `Close or refresh stale lane ${laneLabel(staleLane)} before another packet.`,
        laneLifecycle?.command,
        ["laneLifecycle"],
      ),
    );
  }

  const scaffoldHealth = objectValue(envelope.scaffoldHealth);
  const scaffoldBlockers = stringList(scaffoldHealth?.blockers, []);
  const scaffoldChecks = arrayValue(scaffoldHealth?.checks);
  const scaffoldBlockerCheck = objectValue(
    scaffoldChecks.find((check) => objectValue(check)?.severity === "blocker"),
  );
  if (scaffoldBlockers.length > 0 || scaffoldBlockerCheck) {
    blockers.push(
      loopAction(
        "safety-blocker",
        LOOP_PRIORITY.essentialSafety,
        scaffoldBlockers[0] ||
          scaffoldBlockerCheck?.message ||
          scaffoldBlockerCheck?.code ||
          "Resolve scaffold blockers before another packet.",
        scaffoldBlockerCheck?.command,
        ["scaffoldHealth"],
      ),
    );
  }

  const runtimeProvenance = objectValue(envelope.runtimeProvenance);
  if (runtimeNeedsInspection(runtimeProvenance)) {
    blockers.push(
      loopAction(
        "runtime-provenance",
        LOOP_PRIORITY.validationGate,
        runtimeProvenance?.reason ||
          runtimeProvenance?.message ||
          "Inspect runtime/source drift before continuing.",
        runtimeProvenance?.inspectCommand || runtimeProvenance?.command,
        ["runtimeProvenance"],
      ),
    );
  }

  const salvageCandidate = objectValue(
    arrayValue(envelope.salvageCandidates).find(isDiagnosticSalvage),
  );
  if (salvageCandidate) {
    blockers.push(
      loopAction(
        "partial-salvage",
        LOOP_PRIORITY.pendingPacket,
        `Review partial result ${stringValue(
          salvageCandidate.id || salvageCandidate.artifactName || "packet",
        )} before rerunning an expensive packet.`,
        salvageCandidate.command,
        ["partialResults"],
      ),
    );
  }

  const latestPacketFreshness = objectValue(envelope.latestPacketFreshness);
  if (latestPacketFreshness?.fresh === false) {
    blockers.push(
      loopAction(
        "stale-packet",
        LOOP_PRIORITY.setupOrDecision,
        latestPacketFreshness.reason || "Last-run packet is stale.",
        latestPacketFreshness.command,
        ["latestPacketFreshness"],
      ),
    );
  }

  const setupState = objectValue(envelope.setupState);
  const setupBlockers = stringList(setupState?.blockers, []);
  if (setupBlockers.length > 0 || setupState?.stage === "needs-setup") {
    blockers.push(
      loopAction(
        "setup",
        LOOP_PRIORITY.setupOrDecision,
        setupBlockers[0] ||
          setupState?.nextAction ||
          "Complete setup blockers before trusting another packet.",
        setupState?.command,
        ["setup"],
      ),
    );
  } else if (setupState?.stage === "needs-benchmark-command") {
    blockers.push(
      loopAction(
        "benchmark-command",
        LOOP_PRIORITY.setupOrDecision,
        setupState?.nextAction || "Add a repeatable benchmark command.",
        setupState?.command,
        ["setup", "benchmarkCommand"],
      ),
    );
  }

  const gateQuality = objectValue(envelope.gateQuality);
  const preflight = objectValue(envelope.preflight);
  if (!hasSharperPreflightAction(envelope)) {
    const gateBlockers = stringList(gateQuality?.blockers, []);
    const unsuppressedGateBlockers = nonDuplicateBlockers(envelope, gateBlockers, "gateQuality");
    for (const gateBlocker of unsuppressedGateBlockers) {
      blockers.push(
        loopAction(
          "gate-quality",
          LOOP_PRIORITY.validationGate,
          gateBlocker,
          preflight?.nextCommand || gateQuality?.command,
          ["gateQuality"],
        ),
      );
    }

    const preflightStatus = stringValue(preflight?.status).toLowerCase();
    const rawPreflightBlockers = stringList(preflight?.blockers, []);
    const preflightBlockers = nonDuplicateBlockers(
      envelope,
      rawPreflightBlockers.filter(
        (blocker) =>
          !gateBlockers.includes(blocker) &&
          !shouldSuppressPacketFreshnessPreflightBlocker(envelope, blocker),
      ),
      "preflight",
    );
    if (
      preflightBlockers.length > 0 ||
      (preflightStatus === "blocked" &&
        unsuppressedGateBlockers.length === 0 &&
        rawPreflightBlockers.length === 0)
    ) {
      for (const preflightBlocker of preflightBlockers.length
        ? preflightBlockers
        : ["Resolve preflight blockers before another packet."]) {
        blockers.push(
          loopAction(
            "preflight",
            LOOP_PRIORITY.validationGate,
            preflightBlocker,
            preflight?.nextCommand,
            ["preflight"],
          ),
        );
      }
    }
  }

  const packetDiagnostics = objectValue(envelope.packetDiagnostics);
  if (packetDiagnostics?.unresolved === true) {
    blockers.push(
      loopAction(
        "packet-diagnostic",
        LOOP_PRIORITY.pendingPacket,
        packetDiagnostics.recommendation ||
          packetDiagnostics.reason ||
          "Inspect unresolved packet diagnostics before another packet.",
        packetDiagnostics.command,
        ["packetDiagnostics"],
      ),
    );
  }

  if (latestPacketFreshness?.fresh === true) {
    blockers.push(
      loopAction(
        "log-decision",
        LOOP_PRIORITY.pendingPacket,
        latestPacketFreshness.reason ||
          "Record the fresh last-run packet before starting another packet.",
        latestPacketFreshness.command,
        ["latestPacketFreshness"],
      ),
    );
  }

  const segmentTransition = objectValue(envelope.segmentTransition);
  if (segmentTransition?.required === true) {
    const action = loopAction(
      "segment-transition",
      LOOP_PRIORITY.segmentTransition,
      segmentTransition.nextAction ||
        segmentTransition.reason ||
        "Resolve the active segment transition before another packet.",
      segmentTransition.command,
      segmentTransition.triggeredBy || ["segmentTransition"],
    );
    if (action.triggeredBy.includes("qualityRound")) action.label = "Review completion state";
    blockers.push(action);
  }

  const metricSaturation = firstWorkflowFrictionByKind(
    arrayValue(envelope.workflowFriction),
    "metric_saturated_not_promotable",
  );
  if (metricSaturation) {
    const suggestedAction = objectValue(metricSaturation.suggestedAction);
    blockers.push(
      loopAction(
        "metric-saturation",
        LOOP_PRIORITY.validationGate,
        suggestedAction?.reason ||
          metricSaturation.reason ||
          "Metric is saturated but not promotion-ready.",
        suggestedAction?.command,
        suggestedAction?.triggeredBy || [
          metricSaturation.kind || "metric_saturated_not_promotable",
        ],
      ),
    );
  }

  const sessionDecisionCapsule = objectValue(envelope.sessionDecisionCapsule);
  const capsuleEnforcement = objectValue(sessionDecisionCapsule?.enforcement);
  if (capsuleEnforcement) {
    const capsuleAction = loopAction(
      "decision-capsule",
      capsuleEnforcement.mode === "hard-block"
        ? LOOP_PRIORITY.setupOrDecision
        : LOOP_PRIORITY.boundedDecisionCapsule,
      sessionDecisionCapsule?.nextExperiment ||
        sessionDecisionCapsule?.bottleneck ||
        capsuleEnforcement.clearingCondition ||
        "Resolve the active session decision capsule before another packet.",
      capsuleEnforcement.commandHint,
      capsuleEnforcement.triggeredBy || ["sessionDecisionCapsule"],
    );
    if (capsuleEnforcement.mode === "hard-block") {
      blockers.push(capsuleAction);
    } else if (capsuleEnforcement.canRunNextPacket === false) {
      warnings.push(capsuleAction);
    }
  }

  const finalizationReadiness = objectValue(envelope.finalizationReadiness);
  const currentTreeFinalization = currentTreeFinalizationAction(finalizationReadiness);
  if (currentTreeFinalization) {
    blockers.push(currentTreeFinalization);
  }
  const finalizationRunway = objectValue(envelope.finalizationRunway);
  const runwayBlockers = stringList(finalizationRunway?.blockers, []);
  if (runwayBlockers.length > 0 || finalizationRunway?.stage === "unsafe") {
    blockers.push(
      loopAction(
        "finalization-runway",
        LOOP_PRIORITY.currentTreeFinalization,
        runwayBlockers[0] ||
          finalizationRunway?.nextAction ||
          "Resolve finalization branch runway before merge or cleanup claims.",
        finalizationRunway?.command,
        ["finalizationRunway"],
      ),
    );
  } else if (
    ["local-only", "equivalent", "pr-open"].includes(stringValue(finalizationRunway?.status))
  ) {
    warnings.push(
      loopAction(
        "finalization-runway",
        LOOP_PRIORITY.finalizationReadiness,
        finalizationRunway?.nextAction ||
          "Publish or verify the review branch before calling finalization complete.",
        finalizationRunway?.command,
        ["finalizationRunway"],
      ),
    );
  }
  const portfolioRecommendation = objectValue(envelope.portfolioRecommendation);
  if (blockers.length === 0 && portfolioRecommendation?.kind === "trust-blocker") {
    blockers.push(
      loopAction(
        "portfolio-trust-blocker",
        LOOP_PRIORITY.validationGate,
        portfolioRecommendation.reason ||
          portfolioRecommendation.nextActionHint ||
          "Resolve the portfolio trust blocker before continuing.",
        preflight?.nextCommand,
        ["portfolioRecommendation"],
      ),
    );
  }
  if (finalizationPressure(finalizationReadiness)) {
    warnings.push(
      loopAction(
        "finalization",
        LOOP_PRIORITY.finalizationReadiness,
        finalizationReadiness?.nextAction ||
          finalizationReadiness?.recommendation ||
          "Finalize reviewable kept work.",
        finalizationReadiness?.command,
        ["finalizationReadiness"],
      ),
    );
  }

  const orderedBlockers = orderLoopActions(blockers);
  const orderedWarnings = orderLoopActions(warnings);

  return {
    ok: blockers.length === 0,
    canRunNextPacket: blockers.length === 0 && warnings.length === 0,
    blockers: orderedBlockers,
    warnings: orderedWarnings,
    strongestAction: orderedBlockers[0] || orderedWarnings[0] || null,
  };
}

export function canonicalNextActionForLoop(envelope: LooseObject = {}): LoopAction {
  const contract = buildLoopContractStatus(envelope);
  if (contract.strongestAction) return contract.strongestAction;
  return loopAction(
    "next-packet",
    LOOP_PRIORITY.nextPacket,
    envelope.nextAction || "Run the next measured packet.",
    envelope.nextCommand,
    ["continuation"],
  );
}

function currentTreeFinalizationAction(
  finalizationReadiness: LooseObject | null,
): LoopAction | null {
  if (!finalizationReadiness) return null;
  const actionCode = stringValue(finalizationReadiness.actionCode);
  const warnings = stringList(finalizationReadiness.warnings, []);
  const nextAction = stringValue(finalizationReadiness.nextAction);
  if (
    actionCode !== "current-tree-finalization" &&
    !/finalize-current-tree/i.test(nextAction) &&
    !warnings.some((warning) =>
      /Final tree coverage is missing|Excluded commits touch planned files/i.test(warning),
    )
  ) {
    return null;
  }
  return loopAction(
    "current-tree-finalization",
    LOOP_PRIORITY.currentTreeFinalization,
    nextAction ||
      "Use current-tree finalization because commit-level kept evidence does not describe the current branch tree cleanly.",
    finalizationReadiness.command,
    ["finalizationReadiness", "currentTree"],
  );
}

function firstWorkflowFrictionByKind(signals: unknown[], kind: string): LooseObject | null {
  for (const signal of signals) {
    const record = objectValue(signal);
    if (stringValue(record?.kind) === kind) return record;
  }
  return null;
}

function runtimeNeedsInspection(runtimeProvenance: LooseObject | null): boolean {
  if (!runtimeProvenance) return false;
  if (
    runtimeProvenance.drifted === true ||
    runtimeProvenance.mismatched === true ||
    runtimeProvenance.stale === true ||
    runtimeProvenance.needsInspection === true
  ) {
    return true;
  }
  const driftStatus = stringValue(
    runtimeProvenance.driftStatus || runtimeProvenance.status || runtimeProvenance.freshness,
  ).toLowerCase();
  if (!driftStatus) return false;
  return ![
    "ok",
    "fresh",
    "matched",
    "current",
    "checked",
    "source-only",
    "not-applicable",
    "unavailable",
    "unknown",
    "probe-failed",
    "probe_failed",
    "error",
  ].includes(driftStatus);
}

function finalizationPressure(finalizationReadiness: LooseObject | null): boolean {
  if (!finalizationReadiness) return false;
  if (finalizationReadiness.ready === true || finalizationReadiness.pressure === true) return true;
  const pressure = stringValue(finalizationReadiness.pressure || finalizationReadiness.status);
  if (/^(high|ready|review|finalize|finalization)$/i.test(pressure)) return true;
  const pressureScore = numberValue(finalizationReadiness.pressureScore);
  return pressureScore != null && pressureScore >= 1;
}

function hasSharperPreflightAction(envelope: LooseObject): boolean {
  const scaffoldHealth = objectValue(envelope.scaffoldHealth);
  const scaffoldBlockers = arrayValue(scaffoldHealth?.blockers);
  const scaffoldChecks = arrayValue(scaffoldHealth?.checks);
  if (
    scaffoldBlockers.length > 0 ||
    scaffoldChecks.some((check) => objectValue(check)?.severity === "blocker")
  ) {
    return true;
  }

  if (arrayValue(envelope.salvageCandidates).some(isDiagnosticSalvage)) return true;

  const setupState = objectValue(envelope.setupState);
  const setupBlockers = arrayValue(setupState?.blockers);
  return (
    setupBlockers.length > 0 ||
    setupState?.stage === "needs-setup" ||
    setupState?.stage === "needs-benchmark-command"
  );
}

function shouldSuppressPacketFreshnessPreflightBlocker(
  envelope: LooseObject,
  blocker: string,
): boolean {
  const freshness = objectValue(envelope.latestPacketFreshness);
  return (
    typeof freshness?.fresh === "boolean" &&
    /No benchmark command is available/i.test(String(blocker || ""))
  );
}

function orderLoopActions(actions: LoopAction[]): LoopAction[] {
  return actions
    .map((action, index) => ({ action, index }))
    .sort((left, right) => left.action.priority - right.action.priority || left.index - right.index)
    .map((entry) => entry.action);
}

function nonDuplicateBlockers(envelope: LooseObject, blockers: string[], source: string): string[] {
  return uniqueStrings(
    blockers.filter(
      (blocker) => !shouldSuppressPreflightGateBlockerForCapsule(envelope, blocker, source),
    ),
  );
}

export function shouldSuppressPreflightGateBlockerForCapsule(
  envelope: LooseObject = {},
  blocker: unknown,
  source: unknown = "",
): boolean {
  const sessionDecisionCapsule = objectValue(envelope.sessionDecisionCapsule);
  const capsuleEnforcement = objectValue(sessionDecisionCapsule?.enforcement);
  if (!capsuleEnforcement || stringValue(capsuleEnforcement.mode) !== "hard-block") {
    return false;
  }
  const structuredCapsuleCauses = structuredCauseKeys(capsuleEnforcement.triggeredBy);
  const capsuleCauses =
    structuredCapsuleCauses.length > 0
      ? structuredCapsuleCauses
      : capsuleCauseKeys([
          sessionDecisionCapsule?.kind,
          sessionDecisionCapsule?.bottleneck,
          sessionDecisionCapsule?.nextExperiment,
          sessionDecisionCapsule?.message,
          capsuleEnforcement.clearingCondition,
          capsuleEnforcement.commandHint,
        ]);
  const blockerCauses = blockerCauseKeys(blocker, source);
  if (capsuleCauses.length === 0 || blockerCauses.length === 0) return false;
  return blockerCauses.some((cause) => capsuleCauses.includes(cause));
}

function structuredCauseKeys(value: unknown): string[] {
  return uniqueStrings(flattenText(value).map(structuredCauseKey).filter(Boolean));
}

function structuredCauseKey(value: string): string {
  const key = value.replace(/[^a-z0-9]+/gi, "").toLowerCase();
  const aliases: Record<string, string> = {
    benchmarkcontract: "benchmark-contract",
    benchmarklint: "benchmark-contract",
    benchmarkcommand: "benchmark-contract",
    metriccontract: "benchmark-contract",
    checksgate: "checks-gate",
    independentchecksgate: "checks-gate",
    holdoutgate: "holdout-gate",
    promotiongate: "promotion-gate",
    promotegate: "promotion-gate",
  };
  return aliases[key] || "";
}

function capsuleCauseKeys(values: unknown[]): string[] {
  return causeKeysFromText(values.flatMap(flattenText).join(" "));
}

function blockerCauseKeys(blocker: unknown, source: unknown): string[] {
  const blockerCauses = causeKeysFromText(flattenText(blocker).join(" "));
  if (blockerCauses.length > 0) return blockerCauses;
  return causeKeysFromText(flattenText(source).join(" "));
}

function causeKeysFromText(value: string): string[] {
  const text = value.toLowerCase();
  const compact = text.replace(/[^a-z0-9]+/g, "");
  const causes: string[] = [];
  if (
    /\bbenchmark[-\s]*(lint|contract|command|wrapper)\b/.test(text) ||
    /\bprimary\s+metric\b/.test(text) ||
    /\bmetric\s+contract\b/.test(text) ||
    compact.includes("benchmarkcontract") ||
    compact.includes("benchmarklint") ||
    compact.includes("benchmarkcommand")
  ) {
    causes.push("benchmark-contract");
  }
  if (
    /\bindependent\s+checks?\s+gate\b/.test(text) ||
    /\bchecks?\s+gate\b/.test(text) ||
    compact.includes("checksgate") ||
    compact.includes("independentchecksgate")
  ) {
    causes.push("checks-gate");
  }
  if (
    /\bholdout[-\s]*(gate|command|check|benchmark)?\b/.test(text) ||
    compact.includes("holdoutgate")
  ) {
    causes.push("holdout-gate");
  }
  if (
    /\bpromotion[-\s]*(gate|grade|benchmark|command)\b/.test(text) ||
    /\bpromote[-\s]*gate\b/.test(text) ||
    compact.includes("promotiongate") ||
    compact.includes("promotegate")
  ) {
    causes.push("promotion-gate");
  }
  return uniqueStrings(causes);
}

function flattenText(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(flattenText);
  const record = objectValue(value);
  if (record) {
    return [
      record.kind,
      record.code,
      record.message,
      record.reason,
      record.summary,
      record.nextActionHint,
    ].flatMap(flattenText);
  }
  const text = stringValue(value);
  return text ? [text] : [];
}

function isDiagnosticSalvage(value: unknown): boolean {
  const candidate = objectValue(value);
  return ["scored", "manual_review", "diagnostic"].includes(stringValue(candidate?.status));
}

function laneLabel(lane: LooseObject | null): string {
  return stringValue(lane?.id || lane?.label || lane?.title || "unknown");
}

function objectValue(value: unknown): LooseObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as LooseObject)
    : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringList(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    const items = value.map((item) => stringValue(item)).filter(Boolean);
    return items.length ? items : fallback;
  }
  const text = stringValue(value);
  return text ? [text] : fallback;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function stringValue(value: unknown): string {
  return value == null ? "" : String(value);
}

function numberValue(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
