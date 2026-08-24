import path from "node:path";

import { countsTowardPacketBudget } from "./benchmark/budget-contract.js";
import {
  loadCoherentSessionSnapshot,
  type CoherentSessionSnapshot,
  type CoherentSnapshotLoadResult,
} from "./coherent-session-snapshot.js";
import {
  compileDecisionPlan,
  decisionDiagnostic,
  type DecisionDiagnostic,
  type DecisionPlan,
} from "./decision-compiler.js";
import { continuationCommands } from "./commands/continuation.js";
import { analyzeLedgerHealth } from "./ledger-health.js";
import { lastRunConfigSnapshot } from "./last-run-store.js";
import {
  approvalRequirementsFromLaneResults,
  buildApprovalLedgerStatus,
} from "./approval-ledger.js";
import { isUnknownRecord, type UnknownRecord } from "./types/json.js";

export interface SessionDecisionFacts {
  finalization?: UnknownRecord | null;
  finalizationClaimRequired?: boolean;
  diagnostics?: readonly DecisionDiagnostic[];
}

export type CanonicalSessionDecisionResult =
  | {
      ok: true;
      attempts: number;
      snapshot: CoherentSessionSnapshot;
      plan: DecisionPlan;
    }
  | Extract<CoherentSnapshotLoadResult, { ok: false }>;

export async function loadCanonicalSessionDecision({
  requestedCwd,
  allowOutsideWorkdir = false,
  facts = {},
}: {
  requestedCwd: string;
  allowOutsideWorkdir?: boolean;
  facts?: SessionDecisionFacts;
}): Promise<CanonicalSessionDecisionResult> {
  const loaded = await loadCoherentSessionSnapshot({ requestedCwd, allowOutsideWorkdir });
  if (!loaded.ok) return loaded;
  return {
    ...loaded,
    plan: compileSessionDecision(loaded.snapshot, facts),
  };
}

export function compileSessionDecision(
  snapshot: CoherentSessionSnapshot,
  facts: SessionDecisionFacts = {},
): DecisionPlan {
  return compileDecisionPlan(snapshot, [
    ...diagnosticsFromSnapshot(snapshot),
    ...finalizationDecisionDiagnostics(facts),
    ...(facts.diagnostics || []),
  ]);
}

export function packetFreshnessFromSnapshot(
  snapshot: CoherentSessionSnapshot,
): UnknownRecord | null {
  const packet = snapshot.lastRunPacket;
  if (!packet) return null;
  const history = object(packet.history);
  const records = snapshot.records;
  const state = ledgerState(records);
  const expectedWorkDir = stringValue(history.workDir || packet.workDir);
  if (expectedWorkDir && path.resolve(expectedWorkDir) !== path.resolve(snapshot.workDir)) {
    return stale("working directory changed since the packet was created");
  }
  const expectedSegment = finiteInteger(history.segment);
  if (expectedSegment != null && expectedSegment !== state.segment) {
    return stale(`expected segment #${expectedSegment}, but current segment is #${state.segment}`);
  }
  const expectedNextRun = finiteInteger(history.nextRun);
  if (expectedNextRun == null || expectedNextRun !== state.runCount + 1) {
    return stale(
      expectedNextRun == null
        ? "packet history is missing the next run"
        : `expected next run #${expectedNextRun}, but current history would log #${state.runCount + 1}`,
    );
  }
  const expectedConfig = objectOrNull(history.config);
  if (
    !expectedConfig ||
    canonicalJson(expectedConfig) !== canonicalJson(lastRunConfigSnapshot(state.config))
  ) {
    return stale("session config changed since the packet was created");
  }
  const expectedGit = object(history.git);
  if (expectedGit.inside === true) {
    const expectedHead = stringValue(expectedGit.head);
    if (
      expectedHead &&
      snapshot.git.head !== "unborn" &&
      !snapshot.git.head.startsWith(expectedHead)
    ) {
      return stale("Git HEAD changed since the packet was created");
    }
    const expectedStatusHash = stringValue(expectedGit.statusHash);
    if (expectedStatusHash && expectedStatusHash !== snapshot.git.statusHash) {
      return stale("Git dirty state changed since the packet was created");
    }
  }
  return {
    fresh: true,
    expectedNextRun,
    actualNextRun: state.runCount + 1,
    expectedWorkDir: expectedWorkDir || snapshot.workDir,
    reason: "Last-run packet matches the coherent session snapshot.",
  };
}

function diagnosticsFromSnapshot(snapshot: CoherentSessionSnapshot): DecisionDiagnostic[] {
  const diagnostics: DecisionDiagnostic[] = [];
  const commands = continuationCommands(snapshot.workDir);
  const state = ledgerState(snapshot.records);
  const ledgerHealth = analyzeLedgerHealth(snapshot.records, {
    parseErrors: snapshot.sourceDiagnostics.ledgerIssues,
  });
  if (!ledgerHealth.ok) {
    diagnostics.push(
      decisionDiagnostic("ledger-integrity", {
        message: ledgerHealth.warnings[0] || "The session ledger is not structurally sound.",
        command: commands.ledgerDoctor,
      }),
    );
  }
  const approvalLedger = buildApprovalLedgerStatus({
    entries: snapshot.records,
    required: approvalRequirementsFromLaneResults(snapshot.records),
  });
  if (approvalLedger.status === "blocked") {
    diagnostics.push(
      decisionDiagnostic("approval-required", {
        message: approvalLedger.blockers[0] || "A required approval is missing.",
        semantic: {
          requirements: approvalLedger.required
            .map(({ gate, scope }) => ({ gate, scope }))
            .sort((left, right) =>
              `${left.gate}:${left.scope}`.localeCompare(`${right.gate}:${right.scope}`),
            ),
        },
      }),
    );
  }
  if (!state.config.name || !state.config.metricName || !snapshot.semanticFacts.contractDigest) {
    diagnostics.push(
      decisionDiagnostic("setup-required", {
        message:
          "Create or repair a complete accepted experiment contract before running a packet.",
        command: commands.setupPlan,
      }),
    );
  } else if (!state.hasMetricRun) {
    diagnostics.push(
      decisionDiagnostic("needs-baseline", {
        message: "Run and log a baseline under the accepted experiment contract.",
        command: commands.next,
      }),
    );
  }
  const freshness = packetFreshnessFromSnapshot(snapshot);
  if (freshness) {
    diagnostics.push(
      decisionDiagnostic(freshness.fresh === true ? "pending-packet" : "stale-packet", {
        message: stringValue(freshness.reason),
        command: freshness.fresh === true ? commands.keepLast : commands.next,
      }),
    );
  }
  const process = snapshot.processProgress;
  if (process?.exitState === "termination_failed" || process?.terminationFailed === true) {
    diagnostics.push(
      decisionDiagnostic("process-integrity", {
        message: "Process-tree termination is not proven for the latest session process.",
        command: commands.doctorExplain,
      }),
    );
  } else if (process?.exitState === "running") {
    diagnostics.push(
      decisionDiagnostic("active-process", {
        message: "A session process is still running.",
        command: commands.stateCompact,
      }),
    );
  }
  const contract = acceptedContract(snapshot);
  const stopPolicy = object(contract?.stopPolicy);
  const packetPolicy = object(stopPolicy.packets);
  const packetCeiling = finiteInteger(packetPolicy.limit ?? stopPolicy.packets);
  if (
    packetCeiling != null &&
    snapshot.records.filter((record) => record.run != null && countsTowardPacketBudget(record))
      .length >= packetCeiling
  ) {
    diagnostics.push(
      decisionDiagnostic("packet-budget-exhausted", {
        message: `The accepted packet ceiling (${packetCeiling}) is exhausted.`,
        command: commands.stateCompact,
        semantic: { packetCeiling },
      }),
    );
  }
  return diagnostics;
}

export function finalizationDecisionDiagnostics(facts: SessionDecisionFacts): DecisionDiagnostic[] {
  const finalization = facts.finalization;
  if (!finalization) return [];
  if (finalization.ready === true) {
    return [decisionDiagnostic("finalization-ready")];
  }
  const code = facts.finalizationClaimRequired
    ? "finalization-claim-blocked"
    : "finalization-blocked";
  return [decisionDiagnostic(code)];
}

function acceptedContract(snapshot: CoherentSessionSnapshot): UnknownRecord | null {
  const event = [...snapshot.records]
    .reverse()
    .find(
      (record) =>
        record.type === "experiment-contract-accepted" &&
        isUnknownRecord(record.contract) &&
        record.contract.contractDigest === snapshot.semanticFacts.contractDigest,
    );
  return objectOrNull(event?.contract);
}

function ledgerState(records: readonly UnknownRecord[]): {
  config: UnknownRecord;
  hasMetricRun: boolean;
  runCount: number;
  segment: number;
} {
  let config: UnknownRecord = {
    name: null,
    metricName: "metric",
    metricUnit: "",
    bestDirection: "lower",
  };
  let segment = 0;
  let runCount = 0;
  let hasMetricRun = false;
  for (const record of records) {
    if (record.type === "config") {
      if (runCount > 0) segment += 1;
      config = {
        name: record.name || config.name,
        metricName: record.metricName || config.metricName,
        metricUnit: record.metricUnit ?? config.metricUnit,
        bestDirection: record.bestDirection === "higher" ? "higher" : "lower",
      };
    }
    if (record.run != null) {
      runCount += 1;
      if (
        finiteNumber(record.metric) != null &&
        record.status !== "crash" &&
        record.status !== "checks_failed"
      ) {
        hasMetricRun = true;
      }
    }
  }
  return { config, hasMetricRun, runCount, segment };
}

function stale(reason: string): UnknownRecord {
  return { fresh: false, reason: `Last-run packet is stale: ${reason}. Run next again.` };
}

function object(value: unknown): UnknownRecord {
  return objectOrNull(value) || {};
}

function objectOrNull(value: unknown): UnknownRecord | null {
  return isUnknownRecord(value) ? value : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isUnknownRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
