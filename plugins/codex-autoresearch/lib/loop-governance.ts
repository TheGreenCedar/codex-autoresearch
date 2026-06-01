type LooseObject = Record<string, unknown>;

export interface LoopAction {
  kind: string;
  priority: number;
  reason: string;
  command: string;
  triggeredBy: string[];
}

export interface LoopContractStatus {
  ok: boolean;
  canRunNextPacket: boolean;
  blockers: LoopAction[];
  warnings: LoopAction[];
  strongestAction: LoopAction | null;
}

function loopAction(
  kind: string,
  priority: number,
  reason: unknown,
  command: unknown = "",
  triggeredBy: unknown = [kind],
): LoopAction {
  return {
    kind,
    priority,
    reason: stringValue(reason),
    command: stringValue(command),
    triggeredBy: stringList(triggeredBy, [kind]),
  };
}

export function buildLoopContractStatus(envelope: LooseObject = {}): LoopContractStatus {
  const blockers: LoopAction[] = [];
  const warnings: LoopAction[] = [];
  const contextDistillation = objectValue(envelope.contextDistillation);
  if (contextDistillation?.required === true) {
    blockers.push(
      loopAction(
        "context-distillation",
        1,
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
        2,
        laneLifecycle?.recommendation ||
          laneLifecycle?.reason ||
          `Close or refresh stale lane ${laneLabel(staleLane)} before another packet.`,
        laneLifecycle?.command,
        ["laneLifecycle"],
      ),
    );
  }

  const runtimeProvenance = objectValue(envelope.runtimeProvenance);
  if (runtimeNeedsInspection(runtimeProvenance)) {
    blockers.push(
      loopAction(
        "runtime-provenance",
        3,
        runtimeProvenance?.reason ||
          runtimeProvenance?.message ||
          "Inspect runtime/source drift before continuing.",
        runtimeProvenance?.inspectCommand || runtimeProvenance?.command,
        ["runtimeProvenance"],
      ),
    );
  }

  const packetDiagnostics = objectValue(envelope.packetDiagnostics);
  if (packetDiagnostics?.unresolved === true) {
    blockers.push(
      loopAction(
        "packet-diagnostic",
        4,
        packetDiagnostics.recommendation ||
          packetDiagnostics.reason ||
          "Inspect unresolved packet diagnostics before another packet.",
        packetDiagnostics.command,
        ["packetDiagnostics"],
      ),
    );
  }

  const sessionDecisionCapsule = objectValue(envelope.sessionDecisionCapsule);
  const capsuleEnforcement = objectValue(sessionDecisionCapsule?.enforcement);
  if (capsuleEnforcement) {
    const capsuleAction = loopAction(
      "decision-capsule",
      capsuleEnforcement.mode === "hard-block" ? 4 : 6,
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
  if (finalizationPressure(finalizationReadiness)) {
    warnings.push(
      loopAction(
        "finalization",
        9,
        finalizationReadiness?.nextAction ||
          finalizationReadiness?.recommendation ||
          "Finalize reviewable kept work.",
        finalizationReadiness?.command,
        ["finalizationReadiness"],
      ),
    );
  }

  return {
    ok: blockers.length === 0,
    canRunNextPacket: blockers.length === 0 && warnings.length === 0,
    blockers,
    warnings,
    strongestAction: blockers[0] || warnings[0] || null,
  };
}

export function canonicalNextActionForLoop(envelope: LooseObject = {}): LoopAction {
  const contract = buildLoopContractStatus(envelope);
  if (contract.strongestAction) return contract.strongestAction;
  return loopAction(
    "next-packet",
    10,
    envelope.nextAction || "Run the next measured packet.",
    envelope.nextCommand,
    ["continuation"],
  );
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

function stringValue(value: unknown): string {
  return value == null ? "" : String(value);
}

function numberValue(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
