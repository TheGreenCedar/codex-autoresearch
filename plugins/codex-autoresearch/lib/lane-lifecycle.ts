import { summarizeLaneLessons } from "./lane-briefs.js";

type LooseObject = Record<string, unknown>;

export type LaneStatus = "planned" | "running" | "result" | "stale";

export interface LaneLifecycleSummary {
  stale: boolean;
  lanes: LooseObject[];
  plannedLanes: LooseObject[];
  runningLanes: LooseObject[];
  resultLanes: LooseObject[];
  staleLanes: LooseObject[];
  latestResults: LooseObject[];
  lessonsToAvoid: string[];
  recommendation: string;
  command: string;
}

export function buildLaneLifecycle({
  state = {},
  records = null,
  fanoutPlan = null,
  parallelLanes = null,
  laneResults = null,
  nowMs = Date.now(),
  staleAfterMs = 2 * 60 * 60 * 1000,
  workDir = "",
  pluginRoot = "",
}: LooseObject = {}): LaneLifecycleSummary {
  const explicitRecords = arrayValue(records);
  const stateRecords = arrayValue(objectValue(state)?.records);
  const stateCurrent = arrayValue(objectValue(state)?.current);
  const recordList =
    explicitRecords.length > 0
      ? explicitRecords
      : stateRecords.length > 0
        ? stateRecords
        : stateCurrent;
  const activeSegment = numberValue(objectValue(state)?.segment);
  const resultRecords =
    activeSegment == null ? recordList : recordsForSegment(recordList, activeSegment);
  const resultLaneResults =
    activeSegment == null
      ? arrayValue(laneResults)
      : recordsForSegment(arrayValue(laneResults), activeSegment);
  const plan = objectValue(fanoutPlan) || latestFanoutPlan(recordList) || objectValue(state);
  const planned = normalizePlannedLanes({
    parallelLanes,
    fanoutPlan: plan,
    state: objectValue(state),
    records: recordList,
  });
  const results = latestResultsByLane([...resultRecords, ...resultLaneResults]);
  const plannedWithResults = includeResultOnlyLanes(planned, results);
  const staleThreshold = Math.max(0, numberValue(staleAfterMs) ?? 2 * 60 * 60 * 1000);
  const lanes = plannedWithResults.map((lane, index) =>
    summarizeLane({
      lane,
      index,
      plan,
      result: results.get(stringValue(lane.id)),
      nowMs: numberValue(nowMs) ?? Date.now(),
      staleAfterMs: staleThreshold,
    }),
  );

  const plannedLanes = lanes.filter((lane) => lane.status === "planned");
  const runningLanes = lanes.filter((lane) => lane.status === "running");
  const resultLanes = lanes.filter((lane) => lane.status === "result");
  const staleLanes = lanes.filter((lane) => lane.status === "stale");
  const lessonsToAvoid = summarizeLaneLessons([...results.values()]);
  const recommendation = recommendationForLaneState(staleLanes, runningLanes, plannedLanes);
  return {
    stale: staleLanes.length > 0,
    lanes,
    plannedLanes,
    runningLanes,
    resultLanes,
    staleLanes,
    latestResults: [...results.values()],
    lessonsToAvoid,
    recommendation,
    command: commandForRecommendation({
      lane: staleLanes[0] || runningLanes[0] || plannedLanes[0] || null,
      workDir,
      pluginRoot,
    }),
  };
}

export function summarizeLaneRecords(records: unknown[], options: LooseObject = {}) {
  return buildLaneLifecycle({ ...options, records });
}

function recordsForSegment(records: unknown[], segment: number): unknown[] {
  return records.filter((record) => {
    const value = objectValue(record);
    if (!value || value.segment == null) return true;
    return numberValue(value.segment) === segment;
  });
}

function normalizePlannedLanes({
  parallelLanes,
  fanoutPlan,
  state,
  records,
}: {
  parallelLanes: unknown;
  fanoutPlan: LooseObject | null;
  state: LooseObject | null;
  records: unknown[];
}): LooseObject[] {
  const stateLifecycle = objectValue(state?.laneLifecycle);
  const recordPlanLanes = records
    .map((record) => arrayValue(objectValue(objectValue(record)?.fanoutPlan)?.lanes))
    .find((items) => items.length > 0);
  const candidates = [
    arrayValue(parallelLanes),
    arrayValue(fanoutPlan?.lanes),
    arrayValue(state?.parallelLanes),
    arrayValue(stateLifecycle?.lanes),
    recordPlanLanes || [],
  ].find((items) => items && items.length > 0);
  const lanes = candidates || [];
  return lanes.map((lane, index) => normalizeLane(lane, index));
}

function includeResultOnlyLanes(
  planned: LooseObject[],
  results: Map<string, LooseObject>,
): LooseObject[] {
  const lanes = [...planned];
  const plannedIds = new Set(lanes.map((lane) => stringValue(lane.id)));
  for (const [laneId, result] of results) {
    if (plannedIds.has(laneId)) continue;
    const lane = objectValue(result.lane);
    lanes.push(
      normalizeLane(
        {
          id: laneId,
          label: lane?.title || lane?.label || laneId,
          status: "result",
          brief: lane?.brief,
        },
        lanes.length,
      ),
    );
    plannedIds.add(laneId);
  }
  return lanes;
}

function summarizeLane({
  lane,
  index,
  plan,
  result,
  nowMs,
  staleAfterMs,
}: {
  lane: LooseObject;
  index: number;
  plan: LooseObject | null;
  result: LooseObject | undefined;
  nowMs: number;
  staleAfterMs: number;
}): LooseObject {
  if (result) {
    return {
      ...lane,
      status: "result",
      latestResult: result,
      resultStatus: stringValue(objectValue(result.result)?.status || result.status || "completed"),
      lessonsToAvoid: summarizeLaneLessons([result]),
    };
  }
  const rawStatus = stringValue(lane.status || lane.evidenceStatus).toLowerCase();
  const running = /running|in[-_ ]?progress|active|dispatched/.test(rawStatus);
  const completed = /accepted|completed|done|closed|cancelled|canceled/.test(rawStatus);
  const ageMs = laneAgeMs({ lane, plan, nowMs });
  if (!completed && ageMs != null && ageMs > staleAfterMs) {
    return {
      ...lane,
      status: "stale",
      ageMs,
      staleReason: `Lane ${lane.id || index + 1} has no result after ${staleAfterMs}ms.`,
    };
  }
  return {
    ...lane,
    status: running ? "running" : "planned",
    ageMs,
  };
}

function normalizeLane(value: unknown, index: number): LooseObject {
  const lane = objectValue(value) || {};
  const id = stringValue(lane.id || lane.laneId || lane.label || lane.title || `lane-${index + 1}`);
  return {
    ...lane,
    id,
    label: stringValue(lane.label || lane.title || id),
    status: stringValue(lane.status || "planned"),
  };
}

function latestResultsByLane(records: unknown[]): Map<string, LooseObject> {
  const latest = new Map<string, LooseObject>();
  for (const record of records) {
    const item = objectValue(record);
    if (!item) continue;
    const result = laneResultRecord(item);
    if (!result) continue;
    const laneId = stringValue(result.laneId);
    if (!laneId) continue;
    const current = latest.get(laneId);
    if (!current || timestampMs(result.record) >= timestampMs(current)) {
      latest.set(laneId, result.record);
    }
  }
  return latest;
}

function laneResultRecord(record: LooseObject): { laneId: string; record: LooseObject } | null {
  const lane = objectValue(record.lane);
  const result = objectValue(record.result);
  const laneId = stringValue(
    record.laneId || record.lane_id || lane?.id || lane?.label || result?.laneId || result?.lane_id,
  );
  if (!laneId) return null;
  const type = stringValue(record.type);
  if (type && type !== "lane_result" && !result && !record.status) return null;
  if (!result && !record.status && type !== "lane_result") return null;
  return { laneId, record };
}

function latestFanoutPlan(records: unknown[]): LooseObject | null {
  let latest: LooseObject | null = null;
  for (const record of records) {
    const item = objectValue(record);
    const plan = objectValue(item?.fanoutPlan);
    if (!plan) continue;
    if (!latest || timestampMs(plan) >= timestampMs(latest)) latest = plan;
  }
  return latest;
}

function laneAgeMs({
  lane,
  plan,
  nowMs,
}: {
  lane: LooseObject;
  plan: LooseObject | null;
  nowMs: number;
}): number | null {
  const startedAt = timestampMs(lane) || timestampMs(plan);
  if (!startedAt) return null;
  return Math.max(0, nowMs - startedAt);
}

function timestampMs(value: unknown): number {
  const object = objectValue(value);
  const raw =
    object?.timestamp ||
    object?.createdAt ||
    object?.created_at ||
    object?.startedAt ||
    object?.time;
  const numeric = numberValue(raw);
  if (numeric != null) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  const parsed = Date.parse(stringValue(raw));
  return Number.isFinite(parsed) ? parsed : 0;
}

function recommendationForLaneState(
  staleLanes: LooseObject[],
  runningLanes: LooseObject[],
  plannedLanes: LooseObject[],
): string {
  if (staleLanes.length > 0) {
    const lane = staleLanes[0];
    return `Close or refresh stale lane ${lane.id || lane.label || "unknown"} before another packet.`;
  }
  if (runningLanes.length > 0) {
    const lane = runningLanes[0];
    return `Collect or record the result for running lane ${lane.id || lane.label || "unknown"}.`;
  }
  if (plannedLanes.length > 0) {
    const lane = plannedLanes[0];
    return `Run or record planned lane ${lane.id || lane.label || "unknown"} before choosing a packet.`;
  }
  return "";
}

function commandForRecommendation({
  lane,
  workDir,
  pluginRoot,
}: {
  lane: LooseObject | null;
  workDir: unknown;
  pluginRoot: unknown;
}): string {
  const cwd = stringValue(workDir);
  if (!cwd || !lane) return "";
  const script = scriptCommand(pluginRoot);
  return `${script} lane-runner --cwd ${quoteCommandArg(cwd)} --lane-id ${quoteCommandArg(
    lane.id || lane.label || "read-only-scout",
  )}`;
}

function scriptCommand(pluginRoot: unknown): string {
  const root = stringValue(pluginRoot);
  if (!root) return "node scripts/autoresearch.mjs";
  return `node ${quoteCommandArg(`${root.replace(/[\\/]$/, "")}/scripts/autoresearch.mjs`)}`;
}

function objectValue(value: unknown): LooseObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as LooseObject)
    : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return value == null ? "" : String(value);
}

function numberValue(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function quoteCommandArg(value: unknown): string {
  return `"${String(value).replace(/[\\"]/g, "\\$&")}"`;
}
