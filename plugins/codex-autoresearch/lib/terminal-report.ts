import { readoutFallbackCommand, resolveActionCommand } from "./action-metadata.js";
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
  healthUrl: string;
}

export interface TerminalReportSummary {
  status: "blocked" | "ready" | "complete" | "unknown";
  warningPosture: "warnings" | "clear";
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
    detail: string;
  };
  runtimeAuthority: {
    trustScope: string;
    blocking: boolean;
    blocker: string;
    warning: string;
    detail: string;
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
  commandExecutionBoundary: {
    mode: string;
    detail: string;
  } | null;
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
  lines: string[];
}

export interface TerminalReport {
  text: string;
  json: TerminalReportSummary;
}

export function buildTerminalReport(stateInput: unknown): TerminalReport {
  const state = recordOrNull(stateInput) || {};
  const resolvedDecision = recordOrNull(state.resolvedDecision);
  const commands = recordOrNull(state.commands) || {};
  const preflight = recordOrNull(state.preflight);
  const gateQuality = recordOrNull(state.gateQuality);
  const runtime = recordOrNull(state.runtimeDriftSummary);
  const runtimeAuthority =
    recordOrNull(resolvedDecision?.runtimeAuthority) || recordOrNull(state.runtimeAuthority);
  const packet = recordOrNull(state.packetDiagnostics);
  const portfolio = recordOrNull(state.portfolioRecommendation);
  const envelope = recordOrNull(state.decisionEnvelope);
  const loopContract =
    recordOrNull(resolvedDecision?.loopContract) ||
    recordOrNull(envelope?.loopContract) ||
    recordOrNull(state.loopContract);
  const canonicalNextAction =
    recordOrNull(resolvedDecision?.canonicalNextAction) ||
    recordOrNull(envelope?.canonicalNextAction) ||
    recordOrNull(state.canonicalNextAction);
  const cleanliness = cleanlinessSummary(state);
  const metric = metricSummary(state, envelope);
  const freshness = freshnessSummary(state, envelope);
  const lanes = lanesSummary(state, envelope);
  const asi = asiSummary(state);

  const loopBlockers = objectMessageList(loopContract?.blockers);
  const authoritativeNextAction = loopBlockers.length
    ? firstNonEmpty([
        stringValue(canonicalNextAction?.reason),
        stringValue(recordOrNull(loopContract?.strongestAction)?.reason),
        loopBlockers[0] || "",
      ])
    : "";
  const authorityBlocker =
    runtimeAuthority?.blocking === true
      ? stringValue(runtimeAuthority.blocker) ||
        "Installed plugin runtime verification is blocked by runtime authority."
      : "";
  const blocker = firstNonEmpty([
    stringValue(resolvedDecision?.strongestBlocker),
    ...loopBlockers,
    loopBlockers.length ? stringValue(recordOrNull(loopContract?.strongestAction)?.reason) : "",
    loopBlockers.length ? stringValue(canonicalNextAction?.reason) : "",
    authorityBlocker,
    ...stringList(state.blockers),
    ...stringList(preflight?.blockers),
    ...stringList(gateQuality?.blockers),
  ]);
  const packetRecommendation = stringValue(packet?.recommendation);
  const nextAction =
    stringValue(resolvedDecision?.nextAction) ||
    authoritativeNextAction ||
    blocker ||
    stringValue(canonicalNextAction?.reason) ||
    stringValue(state.nextAction) ||
    packetRecommendation ||
    "Read state and choose the next safe Autoresearch action.";
  const nextCommand =
    readoutFallbackCommand(resolvedDecision?.command) ||
    selectNextCommand({
      blocked: Boolean(blocker),
      preflight,
      commands,
      canonicalNextAction,
      packet,
    });
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
  const runtimeSummary = {
    installedRuntime: stringValue(runtime?.installedRuntime) || "unknown",
    builtRuntime: stringValue(runtime?.builtRuntime) || "unknown",
    detail: stringValue(runtime?.nextActionHint),
  };
  const runtimeAuthoritySummary = {
    trustScope: stringValue(runtimeAuthority?.trustScope) || "source-checkout",
    blocking: runtimeAuthority?.blocking === true,
    blocker: stringValue(runtimeAuthority?.blocker),
    warning: stringValue(runtimeAuthority?.warning),
    detail: runtimeAuthorityDetail(runtimeAuthority),
  };
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
  const warning = hasReadyWarning({
    dashboard,
    gateQuality,
    loopContract,
    preflight,
    runtime,
    runtimeAuthority,
  });
  const resolvedStatus = stringValue(resolvedDecision?.status);
  const status: TerminalReportSummary["status"] = blocker
    ? "blocked"
    : resolvedStatus === "blocked" ||
        resolvedStatus === "ready" ||
        resolvedStatus === "complete" ||
        resolvedStatus === "unknown"
      ? resolvedStatus
      : nextCommand
        ? "ready"
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
    `Runtime authority: ${runtimeAuthoritySummary.trustScope}${
      runtimeAuthoritySummary.blocking
        ? " blocking"
        : runtimeAuthoritySummary.warning
          ? " advisory"
          : " clear"
    }${runtimeAuthoritySummary.detail ? ` - ${runtimeAuthoritySummary.detail}` : ""}`,
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
      status,
      warningPosture: warning ? "warnings" : "clear",
      blocker,
      nextAction,
      nextCommand,
      gate,
      runtime: runtimeSummary,
      runtimeAuthority: runtimeAuthoritySummary,
      dashboard,
      cleanliness,
      packet: packetSummary,
      commandExecutionBoundary,
      metric,
      freshness,
      lanes,
      asi,
      portfolio: portfolioSummary,
      lines,
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
  const cleanliness =
    recordOrNull(state.sourceCleanliness) ||
    recordOrNull(recordOrNull(state.decisionEnvelope)?.sourceCleanliness) ||
    null;
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

function selectNextCommand({
  blocked,
  preflight,
  commands,
  canonicalNextAction,
  packet,
}: {
  blocked: boolean;
  preflight: JsonRecord | null;
  commands: JsonRecord;
  canonicalNextAction: JsonRecord | null;
  packet: JsonRecord | null;
}): string {
  const canonicalCommand = resolveActionCommand(canonicalNextAction?.kind, commands, {
    explicitCommand: canonicalNextAction?.command,
  });
  if (blocked) {
    return (
      canonicalCommand ||
      readoutFallbackCommand(preflight?.nextCommand) ||
      readoutCommandLookup(commands, "doctorExplain") ||
      readoutCommandLookup(commands, "benchmarkLint") ||
      readoutCommandLookup(commands, "state")
    );
  }
  if (canonicalCommand) return canonicalCommand;
  if (packet?.unresolved === true) {
    return (
      readoutFallbackCommand(packet.command) ||
      readoutCommandLookup(commands, "partialResults") ||
      readoutCommandLookup(commands, "state")
    );
  }
  return (
    commandLookup(commands, "next") ||
    commandLookup(commands, "recommendNext") ||
    commandLookup(commands, "state")
  );
}

function metricSummary(state: JsonRecord, envelope: JsonRecord | null) {
  const activeSegment = recordOrNull(envelope?.activeSegment) || recordOrNull(state.activeSegment);
  const historicalBest =
    recordOrNull(envelope?.historicalBest) || recordOrNull(state.historicalBest);
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

function freshnessSummary(state: JsonRecord, envelope: JsonRecord | null) {
  const lastRun = recordOrNull(state.lastRun);
  const freshness =
    recordOrNull(envelope?.latestPacketFreshness) ||
    recordOrNull(state.latestPacketFreshness) ||
    recordOrNull(lastRun?.freshness);
  return {
    fresh: booleanOrNull(freshness?.fresh),
    reason: stringValue(freshness?.reason),
  };
}

function lanesSummary(state: JsonRecord, envelope: JsonRecord | null) {
  const laneLifecycle = recordOrNull(envelope?.laneLifecycle) || recordOrNull(state.laneLifecycle);
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
      healthUrl,
    };
  }
  return {
    status: "not-checked",
    detail: "not checked; verify dashboard health when dashboard evidence matters.",
    command: healthProbeCommand,
    healthUrl,
  };
}

function hasReadyWarning({
  dashboard,
  gateQuality,
  loopContract,
  preflight,
  runtime,
  runtimeAuthority,
}: {
  dashboard: TerminalReportDashboard;
  gateQuality: JsonRecord | null;
  loopContract: JsonRecord | null;
  preflight: JsonRecord | null;
  runtime: JsonRecord | null;
  runtimeAuthority: JsonRecord | null;
}): boolean {
  if (objectMessageList(loopContract?.warnings).length > 0) return true;
  if (stringList(gateQuality?.warnings).length > 0) return true;
  if (stringList(preflight?.warnings).length > 0) return true;
  if (runtimeWarning(runtime)) return true;
  if (runtimeAuthorityWarning(runtimeAuthority)) return true;
  return dashboard.status === "dead" || /\(stale\)/i.test(dashboard.detail);
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

function runtimeAuthorityWarning(runtimeAuthority: JsonRecord | null): boolean {
  if (!runtimeAuthority) return false;
  return runtimeAuthority.blocking === true || Boolean(stringValue(runtimeAuthority.warning));
}

function runtimeWarning(runtime: JsonRecord | null): boolean {
  if (!runtime) return false;
  if (
    runtime.drifted === true ||
    runtime.mismatched === true ||
    runtime.stale === true ||
    runtime.needsInspection === true
  ) {
    return true;
  }
  const installed = stringValue(runtime.installedRuntime);
  const built = stringValue(runtime.builtRuntime);
  const comparableVersion = (value: string) => /^v?\d+(?:\.\d+)+/.test(value);
  return Boolean(comparableVersion(installed) && comparableVersion(built) && installed !== built);
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

function readoutCommandLookup(commands: unknown, key: string): string {
  return readoutFallbackCommand(commandLookup(commands, key));
}

function detailFromParts(parts: string[]): string {
  return firstNonEmpty(parts.map((part) => part.replace(/\s+/g, " ").trim()));
}

function objectMessageList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(describeValue).filter(Boolean);
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
