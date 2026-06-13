import { isUnknownRecord } from "./types/json.js";

export interface RecoveryLane {
  budget: string;
  mergeCriteria: string[];
  owner: string;
  scope: string;
  title: string;
  type: "scout" | "implementation" | "review" | "finalization";
  writeScopeRequired: boolean;
}

export interface LaneOrchestrationPlan {
  blockers: string[];
  lanes: RecoveryLane[];
  parentRecommendation: string;
  status: "not-needed" | "planned" | "blocked";
}

export function planFailureRecoveryLanes({
  signals = [],
  writeScope = [],
}: {
  signals?: unknown[];
  writeScope?: unknown[];
} = {}): LaneOrchestrationPlan {
  const broadFailure = signals.some(isBroadFailureSignal);
  if (!broadFailure) {
    return {
      status: "not-needed",
      lanes: [],
      blockers: [],
      parentRecommendation: "No broad recovery lane split is required.",
    };
  }

  const lanes: RecoveryLane[] = [
    {
      type: "scout",
      title: "Failure map scout",
      owner: "code-mapper",
      scope: "Map failure modes and evidence gaps without editing source.",
      budget: "read-only, 20-30 minutes",
      mergeCriteria: [
        "Failure modes are grouped by product contract",
        "Next implementation scope is explicit",
      ],
      writeScopeRequired: false,
    },
    {
      type: "implementation",
      title: "Scoped implementation lane",
      owner: "framework specialist",
      scope: "Implement one bounded contract with explicit worktree or write scope.",
      budget: "one contract per lane",
      mergeCriteria: ["Tests pin the contract", "Write scope is respected", "No unrelated cleanup"],
      writeScopeRequired: true,
    },
    {
      type: "review",
      title: "Independent review lane",
      owner: "reviewer",
      scope: "Review behavioral regressions, missing tests, and overclaim risk.",
      budget: "focused PR-style review",
      mergeCriteria: ["Findings are resolved or explicitly accepted"],
      writeScopeRequired: false,
    },
    {
      type: "finalization",
      title: "Publication runway lane",
      owner: "finalizer",
      scope: "Separate local commit, push or PR, CI, merge, and cleanup decisions.",
      budget: "until publication state is explicit",
      mergeCriteria: [
        "Local-only state is not called final",
        "Cleanup waits for merge verification",
      ],
      writeScopeRequired: false,
    },
  ];
  const hasIsolation = Array.isArray(writeScope) && writeScope.length > 0;
  const blockers = hasIsolation
    ? []
    : ["Implementation recovery lane requires a worktree or explicit write scope."];

  return {
    status: blockers.length > 0 ? "blocked" : "planned",
    lanes,
    blockers,
    parentRecommendation:
      "Run scout, implementation, review, and finalization lanes as separate accountable owners; synthesize only after each lane returns evidence.",
  };
}

function isBroadFailureSignal(value: unknown): boolean {
  const text = signalText(value);
  return /\b(broad|failed|failure|false done|approval stall|resource interruption|local-only|cleanup afterthought|overfit)\b/i.test(
    text,
  );
}

function signalText(value: unknown): string {
  if (!isUnknownRecord(value)) return String(value ?? "");
  return [value.kind, value.message, value.reason, value.summary]
    .map((part) => String(part ?? ""))
    .join(" ");
}
