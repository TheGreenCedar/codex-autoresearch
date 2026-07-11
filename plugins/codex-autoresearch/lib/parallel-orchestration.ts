import { buildDashboardSettings } from "./commands/dashboard.js";
import { buildExperimentMemory } from "./experiment-memory.js";
import { normalizeLaneBrief } from "./lane-briefs.js";
import { listOption, readJsonl, safeSlug } from "./session-core.js";
import type { UnknownRecord } from "./types/json.js";
import { buildWatchdogSummary } from "./watchdog-summary.js";

type CommandRecord = UnknownRecord;

export function buildParallelOrchestrationContext({
  workDir,
  state,
  config,
  settings = {},
  memory = null,
  records = null,
}: {
  workDir: string;
  state: CommandRecord;
  config: CommandRecord;
  settings?: CommandRecord;
  memory?: CommandRecord | null;
  records?: CommandRecord[] | null;
}) {
  const resolvedMemory =
    memory ||
    buildExperimentMemory({
      runs: state.current,
      direction: record(state.config).bestDirection,
      settings: Object.keys(settings).length ? settings : buildDashboardSettings(config),
    });
  const { fanoutPlan, fanoutProvenance } = resolveFanoutForSegment(
    workDir,
    Number(state.segment),
    records,
  );
  const laneResults = latestLaneResults(workDir, Number(state.segment), records);
  const baseLanes = buildParallelLanes({
    memory: resolvedMemory,
    fanoutPlan,
    config,
  });
  const parallelLanes = enrichParallelLanesWithLaneResults(baseLanes, laneResults);
  const watchdogSummary = buildWatchdogSummary({
    state,
    settings,
    current: state.current,
    parallelLanes,
    fanoutPlan,
  });
  return {
    memory: resolvedMemory,
    fanoutPlan,
    fanoutProvenance,
    parallelLanes,
    laneResults,
    watchdogSummary,
  };
}

export function buildParallelLanes({
  memory,
  fanoutPlan = null,
  config = {},
}: {
  memory: CommandRecord;
  fanoutPlan?: CommandRecord | null;
  config?: CommandRecord;
}) {
  const planned = Array.isArray(fanoutPlan?.lanes) ? fanoutPlan.lanes : [];
  if (planned.length > 0) {
    return planned.map((lane, index) => normalizeParallelLane(record(lane), index, config));
  }
  const memoryLanes = Array.isArray(memory?.lanePortfolio) ? memory.lanePortfolio : [];
  const lanes = memoryLanes.map((lane, index) =>
    normalizeParallelLane(record(lane), index, config),
  );
  const existingIds = new Set(lanes.map((lane) => lane.id));
  for (const seed of defaultParallelLaneSeeds(config)) {
    const normalized = normalizeParallelLane(seed, lanes.length, config);
    if (existingIds.has(normalized.id)) continue;
    lanes.push(normalized);
    existingIds.add(normalized.id);
  }
  return lanes;
}

export function normalizeParallelLane(lane: CommandRecord, index: number, config: CommandRecord) {
  const rawId = lane.id || lane.label || lane.title || `lane-${index + 1}`;
  const id = safeSlug(String(rawId)) || `lane-${index + 1}`;
  const label = String(lane.label || lane.title || `Lane ${index + 1}`);
  const readOnly =
    !/implementation|edit|candidate|worktree/i.test(String(id)) &&
    !/implementation|edit|candidate|worktree/i.test(String(label));
  const executionBoundary = readOnly
    ? "strict Git read-only argv allowlist before execution; Git porcelain is best-effort detection only"
    : "use a separate worktree or declared write scope; no filesystem or process containment is provided";
  const nextActionHint = String(
    lane.nextActionHint ||
      lane.recommendation ||
      "Return a concise hypothesis, evidence, and next measured action.",
  );
  const brief = normalizeLaneBrief(record(lane.brief || lane), {
    objective: String(lane.objective || nextActionHint),
    evidencePoint: String(
      lane.evidencePoint ||
        lane.evidence ||
        `Current ${config.metricName || "primary metric"} evidence and session memory.`,
    ),
    boundaries: [executionBoundary],
    pointers: ["autoresearch.jsonl", "autoresearch.ideas.md"],
    expectedDecisionOutput: "one recommendation, supporting evidence, and the next measured action",
    lessonsToAvoid: [],
  });
  return {
    id,
    title: label,
    label,
    status: lane.status || "planned",
    priority: lane.priority || (index === 0 ? "high" : "medium"),
    mode: readOnly ? "read_only_scout" : "implementation",
    executionBoundary,
    evidenceStatus: lane.evidenceStatus || "provisional",
    owner: lane.owner || "subagent",
    writeScope: readOnly ? [] : listOption(config.commitPaths || config.commit_paths),
    reason: lane.reason || lane.evidence || "Parallel lane planned from current session memory.",
    nextActionHint,
    brief,
  };
}

export function latestLaneResults(
  workDir: string,
  segment: number | null = null,
  records?: CommandRecord[] | null,
) {
  return recordsOrReadJsonl(workDir, records).filter(
    (entry) =>
      entry?.type === "lane_result" && (segment == null || Number(entry.segment) === segment),
  );
}

function resolveFanoutForSegment(
  workDir: string,
  segment: number,
  records?: CommandRecord[] | null,
) {
  const entry = [...recordsOrReadJsonl(workDir, records)]
    .reverse()
    .find(
      (item) =>
        item?.type === "research_fanout" &&
        item.fanoutPlan &&
        Number(item.segment) === Number(segment),
    );
  if (!entry) {
    return {
      fanoutPlan: null,
      fanoutProvenance: { source: "memory_or_defaults", segment, matchedSegment: false },
    };
  }
  const fanoutPlan = record(entry.fanoutPlan);
  return {
    fanoutPlan,
    fanoutProvenance: {
      source: "segment_plan",
      segment,
      matchedSegment: true,
      planId: fanoutPlan.id || null,
      createdAt: fanoutPlan.createdAt || null,
    },
  };
}

function enrichParallelLanesWithLaneResults(lanes: CommandRecord[], laneResults: CommandRecord[]) {
  const latestByLane = new Map<string, CommandRecord>();
  for (const entry of laneResults) {
    const laneId = record(entry?.lane).id;
    if (!laneId) continue;
    const existing = latestByLane.get(String(laneId));
    if (!existing || Number(entry.timestamp || 0) >= Number(existing.timestamp || 0)) {
      latestByLane.set(String(laneId), entry);
    }
  }
  return lanes.map((lane) => {
    const entry = latestByLane.get(String(lane.id));
    const result = record(entry?.result);
    if (!entry || !Object.keys(result).length) return lane;
    const resultStatus = String(result.status || "").toLowerCase();
    const completed = resultStatus === "completed" || resultStatus === "approved";
    const accepted = completed && result.evidenceAccepted === true;
    return {
      ...lane,
      status: completed ? "completed" : result.status || lane.status,
      evidenceStatus: accepted ? "accepted" : result.evidenceStatus || lane.evidenceStatus,
      completedAt:
        accepted && entry.timestamp
          ? new Date(Number(entry.timestamp)).toISOString()
          : lane.completedAt,
      lastLaneResult: {
        status: result.status,
        summary: result.summary || "",
        recommendation: result.recommendation || "",
      },
    };
  });
}

function defaultParallelLaneSeeds(config: CommandRecord): CommandRecord[] {
  const metricName = config.metricName || "primary metric";
  return [
    {
      id: "read-only-scout",
      label: "Read-only scout",
      priority: "high",
      nextActionHint: `Find one evidence-backed hypothesis that could move ${metricName}.`,
      brief: {
        objective: `Find one evidence-backed hypothesis that could move ${metricName}.`,
        evidencePoint: "Current ledger, ASI memory, and recent packet evidence.",
        boundaries: ["read-only", "do not edit files", "return one candidate next action"],
        pointers: ["autoresearch.jsonl", "autoresearch.ideas.md"],
        expectedDecisionOutput: "one scout recommendation with evidence and a next measured action",
      },
    },
    {
      id: "benchmark-contract",
      label: "Benchmark contract",
      priority: "high",
      nextActionHint:
        "Check whether the benchmark, parsed metric, and checks still measure the intended outcome.",
      brief: {
        objective:
          "Check that benchmark, parsed metric, and checks still measure the intended outcome.",
        evidencePoint:
          "Benchmark contract, METRIC parser output, checks command, and doctor warnings.",
        boundaries: ["read-only", "do not change benchmark code in this lane"],
        pointers: ["autoresearch.config.json", "autoresearch.last-run.json"],
        expectedDecisionOutput: "one benchmark-trust recommendation or repair candidate",
      },
    },
    {
      id: "implementation-candidate",
      label: "Implementation candidate",
      priority: "medium",
      nextActionHint:
        "Prepare one isolated edit lane only after a scout produces a concrete hypothesis.",
      brief: {
        objective:
          "Prepare one isolated edit candidate after a scout produces a concrete hypothesis.",
        evidencePoint: "Accepted scout recommendation and current commit path boundaries.",
        boundaries: ["use a separate worktree or owned write scope", "keep edits scoped"],
        pointers: ["autoresearch.ideas.md", "autoresearch.config.json"],
        expectedDecisionOutput: "one implementation plan with files, risks, and verification",
      },
    },
    {
      id: "promotion-readiness",
      label: "Promotion readiness",
      priority: "medium",
      nextActionHint:
        "Identify repeat, holdout, or finalization evidence still needed before a keep can promote.",
      brief: {
        objective:
          "Identify repeat, holdout, or finalization evidence still needed before promotion.",
        evidencePoint:
          "Kept runs, promotion-grade measurements, finalization preview, and gate quality.",
        boundaries: ["read-only", "do not promote evidence from this lane"],
        pointers: ["autoresearch.jsonl", "autoresearch.research"],
        expectedDecisionOutput: "one promotion-readiness gap or finalization recommendation",
      },
    },
  ];
}

function recordsOrReadJsonl(workDir: string, records?: CommandRecord[] | null): CommandRecord[] {
  return Array.isArray(records) ? records : readJsonl(workDir);
}

function record(value: unknown): CommandRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as CommandRecord)
    : {};
}
