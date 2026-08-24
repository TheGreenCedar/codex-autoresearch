import { readoutFallbackCommand } from "./action-metadata.js";
import { projectCompactDecisionPlan } from "./decision-projection.js";
import type { DecisionPlan } from "./decision-compiler.js";
import { unknownRecordOrNull as recordOrNull } from "./types/json.js";
import {
  assertProjectionBudget,
  TERMINAL_REPORT_MAX_BYTES,
  TERMINAL_REPORT_MAX_LINES,
  TERMINAL_REPORT_MAX_TOKENS,
} from "./session-read-model.js";

type JsonRecord = Record<string, unknown>;

export interface TerminalReportDashboard {
  status: string;
  detail: string;
  command: string;
}

export interface TerminalReportSummary {
  decisionPlanProjection: unknown;
  status: "blocked" | "ready" | "complete" | "unknown";
  blocker: string;
  nextAction: string;
  nextCommand: string;
  gate: {
    posture: string;
    detail: string;
  };
  runtime: {
    installedRuntime: string;
    builtRuntime: string;
    detail?: string;
  };
  runtimeAuthority?: {
    trustScope: string;
    blocking: boolean;
    blocker?: string;
    warning?: string;
    detail?: string;
  };
  dashboard: TerminalReportDashboard;
  cleanliness: {
    status: string;
    detail: string;
    cleanupCommand: string;
  };
  packet: {
    status: string;
    recommendation: string;
    command: string;
  };
  metric: {
    name: string;
    best: number | null;
    developmentBest: number | null;
    historicalBest: {
      run: number | null;
      metric: number | null;
    };
  };
  freshness: {
    fresh: boolean | null;
    reason: string;
  };
  lanes: {
    planned: number;
    stale: number;
  };
  asi: {
    risk: string;
  };
  portfolio: {
    kind: string;
    confidence: string;
    recommendation: string;
  };
}

export interface TerminalReport {
  text: string;
  json: TerminalReportSummary;
}

export function buildTerminalReport(stateInput: unknown): TerminalReport {
  const state = recordOrNull(stateInput) || {};
  const decisionPlanRecord = recordOrNull(state.decisionPlan);
  const decisionPlan =
    decisionPlanRecord?.kind === "decision-plan"
      ? (decisionPlanRecord as unknown as DecisionPlan)
      : null;
  const decisionPlanProjection = recordOrNull(state.decisionPlanProjection);
  const planAction = decisionPlan
    ? (decisionPlan.action as JsonRecord)
    : recordOrNull(decisionPlanProjection?.action);
  const planLoopDisposition = decisionPlan
    ? (decisionPlan.loopDisposition as unknown as JsonRecord)
    : recordOrNull(decisionPlanProjection?.loopDisposition);
  const planParentDisposition = decisionPlan
    ? (decisionPlan.parentDisposition as unknown as JsonRecord)
    : recordOrNull(decisionPlanProjection?.parentDisposition);
  const hasPlanAuthority = decisionPlan != null || decisionPlanProjection != null;
  const commands = recordOrNull(state.commands) || {};
  const gateQuality = recordOrNull(state.gateQuality);
  const runtime = recordOrNull(state.runtimeDriftSummary);
  const runtimeAuthority = recordOrNull(state.runtimeAuthority);
  const packet = recordOrNull(state.packetDiagnostics);
  const portfolio = recordOrNull(state.portfolioRecommendation);
  const cleanliness = cleanlinessSummary(state);
  const metric = metricSummary(state);
  const freshness = freshnessSummary(state);
  const lanes = lanesSummary(state);
  const asi = asiSummary(state);

  const blocker = hasPlanAuthority
    ? planLoopDisposition?.kind === "blocked" ||
      planParentDisposition?.kind === "block-final-answer"
      ? decisionPlan
        ? decisionPlan.primaryBlockerCode || ""
        : stringValue(decisionPlanProjection?.primaryBlockerCode)
      : ""
    : "";
  const packetRecommendation = stringValue(packet?.recommendation);
  const nextAction =
    stringValue(planAction?.reason) ||
    (hasPlanAuthority ? stringValue(state.nextAction) : "") ||
    "Canonical decision unavailable; refresh state.";
  const nextCommand = hasPlanAuthority ? stringValue(planAction?.command) : "";
  const dashboard = dashboardSummary(state, commands);
  const commandExecutionBoundary = commandExecutionBoundarySummary(state);
  const gate = {
    posture: stringValue(gateQuality?.posture) || "unknown",
    detail: detailFromParts([
      ...stringList(gateQuality?.blockers),
      ...stringList(gateQuality?.warnings),
      stringValue(gateQuality?.nextActionHint),
    ]),
  };
  const runtimeDetail = stringValue(runtime?.nextActionHint);
  const runtimeSummary = {
    installedRuntime: stringValue(runtime?.installedRuntime) || "unknown",
    builtRuntime: stringValue(runtime?.builtRuntime) || "unknown",
    ...(runtimeDetail ? { detail: runtimeDetail } : {}),
  };
  const runtimeAuthorityBlocker = stringValue(runtimeAuthority?.blocker);
  const runtimeAuthorityWarning = stringValue(runtimeAuthority?.warning);
  const runtimeAuthorityDetailText = runtimeAuthorityDetail(runtimeAuthority);
  const runtimeAuthoritySummary =
    runtimeAuthorityBlocker ||
    runtimeAuthorityWarning ||
    runtimeAuthorityDetailText ||
    runtimeAuthority?.blocking === true
      ? {
          trustScope: stringValue(runtimeAuthority?.trustScope) || "source-checkout",
          blocking: runtimeAuthority?.blocking === true,
          ...(runtimeAuthorityBlocker ? { blocker: runtimeAuthorityBlocker } : {}),
          ...(runtimeAuthorityWarning ? { warning: runtimeAuthorityWarning } : {}),
          ...(runtimeAuthorityDetailText ? { detail: runtimeAuthorityDetailText } : {}),
        }
      : null;
  const packetSummary = {
    status:
      packet?.unresolved === true ? stringValue(packet.primaryStage) || "unresolved" : "clear",
    recommendation: packetRecommendation,
    command: readoutFallbackCommand(packet?.command),
  };
  const portfolioSummary = {
    kind: stringValue(portfolio?.kind) || "insufficient-evidence",
    confidence: stringValue(portfolio?.confidence) || "low",
    recommendation: stringValue(portfolio?.nextActionHint) || stringValue(portfolio?.reason),
  };
  const status: TerminalReportSummary["status"] = hasPlanAuthority
    ? planLoopDisposition?.kind === "blocked" ||
      planParentDisposition?.kind === "block-final-answer"
      ? "blocked"
      : planLoopDisposition?.kind === "complete"
        ? "complete"
        : "ready"
    : "unknown";
  const workDir = stringValue(state.workDir);

  const lines = [
    "Codex Autoresearch report",
    workDir ? `Workdir: ${workDir}` : "",
    `Status: ${status}${blocker ? ` - ${blocker}` : ""}`,
    `Next action: ${nextAction}`,
    nextCommand ? `Next command: ${nextCommand}` : "Next command: unavailable",
    `Gate: ${gate.posture}${gate.detail ? ` - ${gate.detail}` : ""}`,
    `Runtime: installed ${runtimeSummary.installedRuntime}, build ${runtimeSummary.builtRuntime}${
      runtimeSummary.detail ? ` - ${runtimeSummary.detail}` : ""
    }`,
    runtimeAuthoritySummary
      ? `Runtime authority: ${runtimeAuthoritySummary.trustScope}${
          runtimeAuthoritySummary.blocking
            ? " blocking"
            : runtimeAuthoritySummary.warning
              ? " advisory"
              : " clear"
        }${runtimeAuthoritySummary.detail ? ` - ${runtimeAuthoritySummary.detail}` : ""}`
      : "",
    `Metric: ${metric.name}, active segment best ${formatMetricValue(metric.best)}, development best ${formatMetricValue(metric.developmentBest)}, historical best ${formatHistoricalBest(metric)}`,
    `Freshness: ${freshnessLabel(freshness.fresh)}${
      freshness.reason ? ` - ${freshness.reason}` : ""
    }`,
    `Lanes: planned ${lanes.planned}, stale ${lanes.stale}`,
    `ASI: ${asi.risk ? `risk ${asi.risk}` : "risk unknown"}`,
    `Dashboard: ${dashboard.detail}${dashboard.command ? ` Command: ${dashboard.command}` : ""}`,
    `Cleanliness: ${cleanliness.detail}${
      cleanliness.cleanupCommand ? ` Cleanup: ${cleanliness.cleanupCommand}` : ""
    }`,
    `Packet: ${packetSummary.status}${
      packetSummary.recommendation ? ` - ${packetSummary.recommendation}` : ""
    }`,
    commandExecutionBoundary
      ? `Command boundary: ${commandExecutionBoundary.mode} - ${commandExecutionBoundary.detail}`
      : "",
    `Portfolio: ${portfolioSummary.kind} (${portfolioSummary.confidence})${
      portfolioSummary.recommendation ? ` - ${portfolioSummary.recommendation}` : ""
    }`,
  ].filter(Boolean);

  const report: TerminalReport = {
    text: lines.join("\n"),
    json: {
      decisionPlanProjection:
        recordOrNull(state.decisionPlan)?.kind === "decision-plan"
          ? projectCompactDecisionPlan(state.decisionPlan as DecisionPlan)
          : state.decisionPlanProjection || null,
      status,
      blocker,
      nextAction,
      nextCommand,
      gate,
      runtime: runtimeSummary,
      ...(runtimeAuthoritySummary ? { runtimeAuthority: runtimeAuthoritySummary } : {}),
      dashboard,
      cleanliness,
      packet: packetSummary,
      metric,
      freshness,
      lanes,
      asi,
      portfolio: portfolioSummary,
    },
  };
  assertProjectionBudget(
    report,
    {
      bytes: TERMINAL_REPORT_MAX_BYTES,
      lines: TERMINAL_REPORT_MAX_LINES,
      tokens: TERMINAL_REPORT_MAX_TOKENS,
    },
    "terminal report",
  );
  return report;
}

function commandExecutionBoundarySummary(state: JsonRecord) {
  const boundary = recordOrNull(state.commandExecutionBoundary);
  if (!boundary) return null;
  const mode = stringValue(boundary.mode);
  if (!mode) return null;
  return {
    mode,
    detail:
      stringValue(boundary.note) ||
      "Benchmark and checks commands run with the current user's local permissions.",
  };
}

function cleanlinessSummary(state: JsonRecord) {
  const cleanliness = recordOrNull(state.sourceCleanliness) || null;
  const status = stringValue(cleanliness?.status) || "unknown";
  const message = stringValue(cleanliness?.message);
  const nextAction = stringValue(cleanliness?.nextAction);
  const rawCleanupCommand = stringValue(cleanliness?.cleanupCommand);
  const cleanupCommand = readoutFallbackCommand(rawCleanupCommand);
  const detail = message || nextAction || "not checked";
  return {
    status,
    detail:
      rawCleanupCommand && !cleanupCommand
        ? `${detail} Cleanup requires an explicit Git action outside report command fields.`
        : detail,
    cleanupCommand,
  };
}

function metricSummary(state: JsonRecord) {
  const activeSegment = recordOrNull(state.activeSegment);
  const historicalBest = recordOrNull(state.historicalBest);
  const config = recordOrNull(state.config);
  const stateMetric = recordOrNull(state.metric);
  const stateMetricName =
    typeof state.metric === "string" ? stringValue(state.metric) : stringValue(stateMetric?.name);
  const development = recordOrNull(state.development);
  return {
    name:
      stateMetricName ||
      stringValue(config?.metricName) ||
      stringValue(state.metricName) ||
      "metric",
    best: numberOrNull(activeSegment?.best) ?? numberOrNull(state.best),
    developmentBest:
      numberOrNull(activeSegment?.developmentBest) ?? numberOrNull(development?.best),
    historicalBest: {
      run: numberOrNull(historicalBest?.run),
      metric: numberOrNull(historicalBest?.metric),
    },
  };
}

function freshnessSummary(state: JsonRecord) {
  const lastRun = recordOrNull(state.lastRun);
  const freshness = recordOrNull(state.latestPacketFreshness) || recordOrNull(lastRun?.freshness);
  return {
    fresh: booleanOrNull(freshness?.fresh),
    reason: stringValue(freshness?.reason),
  };
}

function lanesSummary(state: JsonRecord) {
  const laneLifecycle = recordOrNull(state.laneLifecycle);
  const parallelLanes = arrayValue(state.parallelLanes).map(recordOrNull).filter(Boolean);
  const planned =
    arrayValue(laneLifecycle?.plannedLanes).length ||
    parallelLanes.filter((lane) => stringValue(lane?.status) === "planned").length;
  const stale =
    arrayValue(laneLifecycle?.staleLanes).length ||
    parallelLanes.filter((lane) => stringValue(lane?.status) === "stale").length ||
    (laneLifecycle?.stale === true ? 1 : 0);
  return { planned, stale };
}

function asiSummary(state: JsonRecord) {
  const asi = recordOrNull(state.asi);
  const experimentMemory = recordOrNull(state.experimentMemory);
  const firstMissingAsi = recordOrNull(arrayValue(experimentMemory?.missingAsiDetails)[0]);
  return {
    risk:
      stringValue(asi?.risk) ||
      stringValue(firstMissingAsi?.risk) ||
      stringValue(arrayValue(experimentMemory?.warnings)[0]),
  };
}

function dashboardSummary(state: JsonRecord, commands: JsonRecord): TerminalReportDashboard {
  const health = recordOrNull(state.dashboardHealth);
  const liveness = stringValue(health?.liveness);
  const healthUrl = stringValue(health?.healthUrl);
  const healthProbeCommand = httpHealthProbeCommand(healthUrl);
  const workDir = stringValue(state.workDir);
  if (liveness && liveness !== "unknown") {
    const stale = health?.stale === true ? "stale" : health?.stale === false ? "fresh" : "unknown";
    const shouldRestart = liveness === "dead" || health?.stale === true;
    const serveCommand =
      commandLookup(commands, "liveDashboard") ||
      commandLookup(commands, "serve") ||
      localServeCommand(workDir);
    return {
      status: liveness,
      detail: `${liveness} (${stale})${
        shouldRestart ? "; serve a fresh dashboard before using dashboard evidence" : ""
      }`,
      command: shouldRestart ? serveCommand : healthProbeCommand,
    };
  }
  return {
    status: "not-checked",
    detail: "not checked; verify dashboard health when dashboard evidence matters.",
    command: healthProbeCommand,
  };
}

function runtimeAuthorityDetail(runtimeAuthority: JsonRecord | null): string {
  if (!runtimeAuthority) return "";
  if (runtimeAuthority.blocking === true) {
    return (
      stringValue(runtimeAuthority.blocker) ||
      "Installed runtime verification must refresh stale installed plugin runtime first."
    );
  }
  return stringValue(runtimeAuthority.warning);
}

function commandLookup(commands: unknown, key: string): string {
  const record = recordOrNull(commands);
  if (record) return stringValue(record[key]);
  if (!Array.isArray(commands)) return "";
  const pattern = new RegExp(
    key.replace(/[A-Z]/g, (match) => `\\s*${match.toLowerCase()}`),
    "i",
  );
  const entry = commands
    .map(recordOrNull)
    .find((item) => pattern.test(stringValue(item?.label || item?.name)));
  return stringValue(entry?.command);
}

function detailFromParts(parts: string[]): string {
  return firstNonEmpty(parts.map((part) => part.replace(/\s+/g, " ").trim()));
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(describeValue).filter(Boolean);
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const record = recordOrNull(value);
  if (!record) return "";
  return firstNonEmpty([
    stringValue(record.message),
    stringValue(record.reason),
    stringValue(record.code),
    stringValue(record.kind),
    stringValue(record.title),
    stringValue(record.summary),
    stringValue(record.nextActionHint),
  ]);
}

function firstNonEmpty(values: string[]): string {
  return values.find((value) => value.trim())?.trim() || "";
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberOrNull(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatMetricValue(value: number | null): string {
  return value == null ? "unknown" : String(value);
}

function formatHistoricalBest(metric: TerminalReportSummary["metric"]): string {
  if (metric.historicalBest.metric == null) return "unknown";
  return metric.historicalBest.run == null
    ? String(metric.historicalBest.metric)
    : `#${metric.historicalBest.run} = ${metric.historicalBest.metric}`;
}

function freshnessLabel(value: boolean | null): string {
  if (value === true) return "fresh";
  if (value === false) return "stale";
  return "unknown";
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function quoteForDisplay(value: string): string {
  return JSON.stringify(value);
}

function httpHealthProbeCommand(healthUrl: string): string {
  return /^https?:\/\//i.test(healthUrl) ? `curl ${quoteForDisplay(healthUrl)}` : "";
}

function localServeCommand(workDir: string): string {
  return workDir ? `node scripts/autoresearch.mjs serve --cwd ${quoteCommandArg(workDir)}` : "";
}

function quoteCommandArg(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : quoteForDisplay(value);
}
