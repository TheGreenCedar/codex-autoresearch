import type { ShellRunResult } from "../runner.js";
import { normalizeBoundedLaneRecommendation } from "../lane-briefs.js";
import {
  approvalRecordsFromLedger,
  buildApprovalRecord,
  resolveApproval,
} from "../approval-ledger.js";

type LooseObject = Record<string, any>;

export interface LaneRunnerCommandDeps {
  appendJsonl: (workDir: string, entry: LooseObject) => void;
  assertNoDirtyPathsOutsideWriteScope: (workDir: string, writeScope: string[]) => Promise<void>;
  assertWriteScopeIntegrity: (
    workDir: string,
    writeScope: string[],
    before: LooseObject,
  ) => Promise<void>;
  boolOption: (value: unknown, fallback?: boolean) => boolean;
  buildParallelOrchestrationContext: (options: {
    workDir: string;
    state: LooseObject;
    config: LooseObject;
    settings?: LooseObject;
  }) => LooseObject;
  commandLooksMutating: (command: string) => boolean;
  commandLooksUnsafeForWriteScope: (command: string) => boolean;
  currentState: (workDir: string) => LooseObject;
  dashboardSettings: (config: LooseObject) => LooseObject;
  gitStatusPorcelain: (cwd: string) => Promise<string | null>;
  insideGitRepo: (cwd: string) => Promise<boolean>;
  latestLaneResults: (workDir: string, segment?: number | null) => LooseObject[];
  normalizeLaneMode: (value: unknown, fallback: string) => string;
  normalizeParallelLane: (lane: LooseObject, index: number, config: LooseObject) => LooseObject;
  normalizeRelativePaths: (paths: unknown, optionName?: string) => string[];
  positiveIntegerOption: (
    value: unknown,
    fallback: number | null,
    optionName: string,
  ) => number | null;
  readJsonl: (workDir: string) => LooseObject[];
  resolveLaneWorktree: (workDir: string, worktreePath: string) => Promise<string>;
  resolveWorkDir: (value: string) => { workDir: string; config: LooseObject };
  runShell: (
    command: string,
    cwd: string,
    timeoutSeconds: number,
    options?: LooseObject,
  ) => Promise<ShellRunResult>;
  synthesizeLaneDecision: (options: {
    workDir: string;
    laneResults: LooseObject[];
    fallbackLane?: LooseObject | null;
  }) => LooseObject;
  tailText: (text: string, maxLines?: number, maxBytes?: number) => string;
  writeScopeSnapshot: (workDir: string) => Promise<LooseObject>;
}

export function createLaneRunnerCommand(deps: LaneRunnerCommandDeps) {
  return async function laneRunner(args: LooseObject) {
    const { workDir, config } = deps.resolveWorkDir(args.working_dir || args.cwd);
    const state = deps.currentState(workDir);
    const settings = deps.dashboardSettings(config);
    const { parallelLanes: lanes } = deps.buildParallelOrchestrationContext({
      workDir,
      state,
      config,
      settings,
    });
    const laneId = String(
      args.lane_id || args.laneId || args.lane || lanes[0]?.id || "read-only-scout",
    );
    const lane =
      lanes.find(
        (candidate: LooseObject) => candidate.id === laneId || candidate.label === laneId,
      ) || deps.normalizeParallelLane({ id: laneId, label: laneId }, lanes.length, config);
    const mode = deps.normalizeLaneMode(args.mode, lane.mode);
    const dryRun = deps.boolOption(args.dry_run ?? args.dryRun, !deps.boolOption(args.yes, false));
    const command = String(args.command || "").trim();
    const humanApproval = deps.boolOption(
      args.human_approval ?? args.humanApproval ?? args.approved,
      false,
    );
    const approvalGate =
      mode === "big_idea"
        ? {
            gate: "big_idea_architecture",
            scope: String(lane.id || lane.label || laneId),
            action: "Approve big-idea lane before implementation or measured packets.",
          }
        : null;
    const approvalResolution = approvalGate
      ? resolveApproval(approvalRecordsFromLedger(deps.readJsonl(workDir)), approvalGate)
      : null;
    const approvalSatisfied = humanApproval || approvalResolution?.approved === true;
    const timeBudgetSeconds =
      deps.positiveIntegerOption(
        args.time_budget_seconds ??
          args.timeBudgetSeconds ??
          args.timeout_seconds ??
          args.timeoutSeconds,
        300,
        "--time-budget-seconds",
      ) || 300;
    const writeScope = deps.normalizeRelativePaths(
      args.write_scope ?? args.writeScope ?? args.commit_paths ?? args.commitPaths,
      "--write-scope",
    );
    const worktreePath = String(
      args.worktree_path || args.worktreePath || args.worktree || "",
    ).trim();
    if (mode === "big_idea") {
      if (command) {
        throw new Error(
          "Big-idea lanes are read-only advice lanes and cannot run commands. Record summary, evidence, risks, and recommendation instead.",
        );
      }
      if (worktreePath || writeScope.length > 0) {
        throw new Error(
          "Big-idea lanes cannot declare worktrees or write scopes because they cannot mutate source files.",
        );
      }
    }
    if (mode === "implementation" && !worktreePath && writeScope.length === 0) {
      throw new Error(
        "Implementation lanes require explicit isolation: pass --worktree <path> or --write-scope <paths> before running.",
      );
    }
    if (mode === "read_only_scout" && command && deps.commandLooksMutating(command)) {
      throw new Error("Read-only scout lanes cannot run commands that look mutating.");
    }
    const allowNonGitReadOnlyCommand = deps.boolOption(
      args.allow_non_git_command ?? args.allowNonGitCommand,
      false,
    );
    if (mode === "read_only_scout" && command && !dryRun && !(await deps.insideGitRepo(workDir))) {
      if (!allowNonGitReadOnlyCommand) {
        throw new Error(
          "Read-only scout lanes cannot run commands outside a Git worktree without porcelain verification. Use --worktree or implementation mode with --write-scope for isolated edits, or pass --allow-non-git-command only when the command is provably read-only.",
        );
      }
    }
    if (
      mode === "implementation" &&
      !worktreePath &&
      writeScope.length > 0 &&
      command &&
      deps.commandLooksUnsafeForWriteScope(command)
    ) {
      throw new Error(
        "Implementation lane --write-scope cannot run git cleanup, history, or stash commands in the main checkout; use a separate --worktree.",
      );
    }

    const runCwd =
      mode === "implementation" && worktreePath
        ? await deps.resolveLaneWorktree(workDir, worktreePath)
        : workDir;
    const beforeStatus =
      mode === "read_only_scout" && command && !dryRun
        ? await deps.gitStatusPorcelain(workDir)
        : null;
    let writeScopeBefore: LooseObject | null = null;
    if (mode === "implementation" && !worktreePath && writeScope.length > 0 && command && !dryRun) {
      await deps.assertNoDirtyPathsOutsideWriteScope(workDir, writeScope);
      writeScopeBefore = await deps.writeScopeSnapshot(workDir);
    }
    let commandResult: LooseObject | null = null;
    if (command && !dryRun) {
      const result = await deps.runShell(command, runCwd, timeBudgetSeconds, {
        retainMetricNames: [state.config.metricName || config.metricName || ""],
      });
      commandResult = {
        code: result.exitCode,
        timedOut: result.timedOut,
        durationSeconds: result.durationSeconds,
        output: deps.tailText(result.output || "", 20, 4000),
      };
      if (beforeStatus != null) {
        const afterStatus = await deps.gitStatusPorcelain(workDir);
        if (afterStatus !== beforeStatus) {
          throw new Error(
            "Read-only scout lane changed the git working tree; discard or isolate the change before continuing.",
          );
        }
      }
      if (writeScopeBefore) {
        await deps.assertWriteScopeIntegrity(workDir, writeScope, writeScopeBefore);
      }
    }

    const explicitSummary = String(args.summary || "").trim();
    const explicitRecommendation = String(
      args.recommendation || args.next_action || args.nextAction || "",
    ).trim();
    const bigIdeaRecommendation =
      mode === "big_idea"
        ? normalizeBoundedLaneRecommendation({
            summary: explicitSummary,
            recommendation: explicitRecommendation || lane.nextActionHint,
            evidence: args.evidence,
            risks: args.risks,
            fallbackSummary:
              lane.brief?.objective || "Distant architecture hypothesis recorded for human review.",
            fallbackRecommendation:
              lane.nextActionHint ||
              "Ask the operator to approve or reject this architecture direction before implementation.",
          })
        : null;
    const resultStatus =
      args.result_status ||
      args.resultStatus ||
      (approvalSatisfied ? "approved" : "") ||
      (commandResult
        ? commandResult.code === 0 && !commandResult.timedOut
          ? "completed"
          : "failed"
        : explicitSummary || explicitRecommendation || bigIdeaRecommendation
          ? "completed"
          : "planned");
    const commandSucceeded =
      commandResult && Number(commandResult.code) === 0 && commandResult.timedOut !== true;
    const normalizedResultStatus = String(resultStatus).toLowerCase();
    const evidenceAccepted = Boolean(
      (normalizedResultStatus === "completed" || normalizedResultStatus === "approved") &&
      (commandSucceeded || explicitSummary || explicitRecommendation),
    );
    const result = {
      status: resultStatus,
      summary:
        bigIdeaRecommendation?.summary ||
        explicitSummary ||
        (commandResult ? "Lane command completed." : "Lane result recorded."),
      recommendation:
        bigIdeaRecommendation?.recommendation || explicitRecommendation || lane.nextActionHint,
      evidenceAccepted,
      evidence: bigIdeaRecommendation?.evidence || [],
      risks: bigIdeaRecommendation?.risks || [],
      boundedRecommendation: bigIdeaRecommendation,
      approvalRequired: mode === "big_idea" && !approvalSatisfied,
      humanApproval: approvalSatisfied,
      approvalGate:
        mode === "big_idea" && approvalGate
          ? {
              ...approvalGate,
              required: !approvalSatisfied,
              humanApproval: approvalSatisfied,
              requiredBefore: ["implementation_lane", "measured_packet"],
              message:
                bigIdeaRecommendation?.approvalGate ||
                "Human approval is required before implementation or measured packet work.",
              matchedApproval: approvalResolution?.matched || null,
            }
          : null,
      command: command || "",
      timeBudgetSeconds,
      isolation: {
        mode,
        worktree: worktreePath,
        writeScope,
      },
      commandResult,
    };
    const entry = {
      type: "lane_result",
      timestamp: Date.now(),
      segment: state.segment,
      lane: {
        id: lane.id,
        title: lane.title || lane.label,
        mode,
        brief: lane.brief || null,
      },
      result,
    };
    const existingResults = deps.latestLaneResults(workDir, state.segment);
    const laneResults = dryRun ? existingResults : [...existingResults, entry];
    const coordinatorRecommendation = deps.synthesizeLaneDecision({
      workDir,
      laneResults,
      fallbackLane: lane,
    });
    if (mode === "big_idea" && !approvalSatisfied) {
      coordinatorRecommendation.status = "awaiting_human_approval";
      coordinatorRecommendation.nextAction =
        "Ask the operator to approve or reject the big-idea architecture recommendation before starting an implementation lane or measured packet.";
      coordinatorRecommendation.measuredPacket =
        "Blocked until human approval is recorded for this big-idea lane.";
      coordinatorRecommendation.commandHint = "";
      coordinatorRecommendation.approvalRequired = true;
      coordinatorRecommendation.approvalGate = result.approvalGate;
    }
    if (!dryRun) {
      if (approvalGate && humanApproval) {
        deps.appendJsonl(
          workDir,
          buildApprovalRecord({
            gate: approvalGate.gate,
            scope: approvalGate.scope,
            source: "lane-runner --human-approval",
            evidence: [explicitSummary, explicitRecommendation].filter(Boolean),
          }),
        );
      }
      deps.appendJsonl(workDir, entry);
    }
    return {
      ok: true,
      workDir,
      dryRun,
      lane: entry.lane,
      result,
      coordinatorRecommendation,
    };
  };
}
