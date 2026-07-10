import type { ProcessRunOptions, ProcessRunResult, ShellRunResult } from "../runner.js";
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
  commandLooksUnsafeForWriteScope: (command: string) => boolean;
  currentState: (workDir: string) => LooseObject;
  dashboardSettings: (config: LooseObject) => LooseObject;
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
  runProcess: (
    command: string,
    args: string[],
    options: ProcessRunOptions,
  ) => Promise<ProcessRunResult>;
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
        "Implementation lanes require an explicit write boundary: pass --worktree <path> or --write-scope <paths> before running.",
      );
    }
    const scoutCommand =
      mode === "read_only_scout" && command ? strictReadOnlyScoutCommand(command) : null;
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
        ? await hardenedScoutStatus(deps, workDir, timeBudgetSeconds)
        : null;
    let writeScopeBefore: LooseObject | null = null;
    if (mode === "implementation" && !worktreePath && writeScope.length > 0 && command && !dryRun) {
      await deps.assertNoDirtyPathsOutsideWriteScope(workDir, writeScope);
      writeScopeBefore = await deps.writeScopeSnapshot(workDir);
    }
    let commandResult: LooseObject | null = null;
    if (command && !dryRun) {
      const result = scoutCommand
        ? await runHardenedScoutGit(deps, scoutCommand, runCwd, timeBudgetSeconds)
        : await deps.runShell(command, runCwd, timeBudgetSeconds, {
            retainMetricNames: [state.config.metricName || config.metricName || ""],
          });
      commandResult = {
        code: result.exitCode,
        timedOut: result.timedOut,
        durationSeconds: result.durationSeconds,
        output: deps.tailText(
          ("combinedOutput" in result ? result.combinedOutput : result.output) || "",
          20,
          4000,
        ),
      };
      if (beforeStatus != null) {
        const afterStatus = await hardenedScoutStatus(deps, workDir, timeBudgetSeconds);
        if (afterStatus !== beforeStatus) {
          throw new Error(
            "Git porcelain detected a worktree change after the allowlisted scout command. Detection is best-effort, not containment; inspect and restore the repository before continuing.",
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
      executionBoundary: {
        mode,
        worktree: worktreePath,
        writeScope,
        containment: "none",
        commandPolicy:
          mode === "read_only_scout"
            ? "strict_git_read_only_argv_allowlist"
            : mode === "big_idea"
              ? "no_command_execution"
              : "implementation_command_with_declared_write_boundary",
        postRunDetection: beforeStatus == null ? "not_available" : "git_porcelain_best_effort",
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

type ReadOnlyGitPolicy = {
  exact?: readonly string[];
  patterns?: readonly RegExp[];
  prefixes?: readonly string[];
};

const options = (value: string): string[] => value.split(/\s+/);

const READ_ONLY_GIT_POLICIES: Record<string, ReadOnlyGitPolicy> = {
  version: { exact: ["--build-options"] },
  status: {
    exact: options(
      "--short -s --branch -b --show-stash --porcelain --long --ignored --untracked-files -u --no-renames --ahead-behind --no-ahead-behind -z",
    ),
    prefixes: ["--porcelain=", "--ignored=", "--untracked-files="],
  },
  diff: {
    exact: options(
      "--cached --staged --stat --numstat --shortstat --summary --patch -p -u --raw --name-only --name-status --check --quiet --exit-code --no-renames --minimal --patience --histogram --no-ext-diff --no-textconv",
    ),
    patterns: [/^-U\d+$/],
    prefixes: ["--unified=", "--diff-filter=", "--find-renames=", "--relative="],
  },
  log: {
    exact: options(
      "--oneline --graph --decorate --no-decorate --stat --name-only --name-status --all --branches --tags --remotes --first-parent --merges --no-merges --reverse --topo-order --date-order --follow --no-patch -s --patch -p --boundary --left-right --cherry-pick --no-ext-diff --no-textconv",
    ),
    patterns: [/^-\d+$/],
    prefixes: [
      "--format=",
      "--pretty=",
      "--max-count=",
      "--skip=",
      "--since=",
      "--until=",
      "--author=",
      "--committer=",
      "--grep=",
      "--date=",
      "--decorate=",
    ],
  },
  show: {
    exact: options(
      "--oneline --stat --name-only --name-status --no-patch -s --patch -p --raw --no-ext-diff --no-textconv",
    ),
    prefixes: ["--format=", "--pretty=", "--date="],
  },
  grep: {
    exact: options(
      "-n --line-number -H --with-filename -h --no-filename -l --files-with-matches -L --files-without-match -i --ignore-case -w --word-regexp -v --invert-match -E --extended-regexp -G --basic-regexp -F --fixed-strings -P --perl-regexp --cached --break --heading --full-name",
    ),
    patterns: [/^-[ABC]\d+$/],
    prefixes: ["--max-depth=", "--threads="],
  },
  "ls-files": {
    exact: options(
      "--cached -c --deleted -d --modified -m --others -o --ignored -i --stage -s --unmerged -u --killed -k --directory --no-empty-directory --error-unmatch --full-name --exclude-standard",
    ),
    prefixes: ["--format=", "--abbrev=", "--exclude="],
  },
  "rev-parse": {
    exact: options(
      "--verify --quiet -q --short --abbrev-ref --symbolic --symbolic-full-name --revs-only --no-revs --flags --no-flags --show-toplevel --show-prefix --show-cdup --git-dir --absolute-git-dir --git-common-dir --is-inside-git-dir --is-inside-work-tree --is-bare-repository --is-shallow-repository --end-of-options",
    ),
    prefixes: ["--short=", "--abbrev-ref="],
  },
  "merge-base": { exact: ["--all", "-a", "--octopus", "--independent", "--is-ancestor"] },
};

const READ_ONLY_GIT_ENV: NodeJS.ProcessEnv = {
  GIT_NO_LAZY_FETCH: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
};

const hardenedReadOnlyGitArgs = (subcommand: string, args: string[] = []): string[] => [
  "--no-pager",
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=",
  "-c",
  "diff.ignoreSubmodules=all",
  "-c",
  "status.submoduleSummary=false",
  "-c",
  "submodule.recurse=false",
  subcommand,
  ...args,
];

async function runHardenedScoutGit(
  deps: Pick<LaneRunnerCommandDeps, "runProcess">,
  command: { args: string[]; executable: "git" },
  cwd: string,
  timeoutSeconds: number,
): Promise<ProcessRunResult> {
  return await deps.runProcess(command.executable, command.args, {
    cwd,
    env: READ_ONLY_GIT_ENV,
    timeoutSeconds,
  });
}

async function hardenedScoutStatus(
  deps: Pick<LaneRunnerCommandDeps, "runProcess">,
  cwd: string,
  timeoutSeconds: number,
): Promise<string | null> {
  const result = await runHardenedScoutGit(
    deps,
    {
      executable: "git",
      args: hardenedReadOnlyGitArgs("status", ["--porcelain=v1", "-z", "--untracked-files=all"]),
    },
    cwd,
    timeoutSeconds,
  );
  return result.exitCode === 0 ? result.stdout : null;
}

function strictReadOnlyScoutCommand(command: string): {
  args: string[];
  executable: "git";
} {
  const argv = parseStrictArgv(command);
  if (argv[0]?.toLowerCase() !== "git") {
    return refuseScoutCommand("only the Git read-only allowlist is executable");
  }
  const subcommand = String(argv[1] || "").toLowerCase();
  const policy = READ_ONLY_GIT_POLICIES[subcommand];
  if (!policy) {
    return refuseScoutCommand(
      `git ${subcommand || "<missing>"} is not an allowlisted read-only subcommand`,
    );
  }
  let afterDoubleDash = false;
  for (const arg of argv.slice(2)) {
    if (afterDoubleDash) continue;
    if (arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!arg.startsWith("-")) continue;
    const allowed =
      policy.exact?.includes(arg) ||
      policy.prefixes?.some((prefix) => arg.startsWith(prefix)) ||
      policy.patterns?.some((pattern) => pattern.test(arg));
    if (!allowed) return refuseScoutCommand(`git ${subcommand} option ${arg} is not allowlisted`);
    if (["log", "show"].includes(subcommand) && /^(?:--format|--pretty)=.*%G/.test(arg)) {
      return refuseScoutCommand("Git signature formats may start external verification processes");
    }
  }
  const hardened = hardenedReadOnlyGitArgs(subcommand);
  if (["diff", "log", "show"].includes(subcommand)) {
    hardened.push("--no-ext-diff", "--no-textconv");
  }
  return { executable: "git", args: [...hardened, ...argv.slice(2)] };
}

function parseStrictArgv(command: string): string[] {
  const argv: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote = "";
  for (const character of command.trim()) {
    if (quote) {
      if (character === quote) quote = "";
      else if (character === "\n" || character === "\r" || character === "\0") {
        return refuseScoutCommand("command arguments cannot contain control characters");
      } else if (/[;&|<>`$^]/.test(character)) {
        return refuseScoutCommand(`shell syntax ${character} is not accepted`);
      } else token += character;
      tokenStarted = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (tokenStarted) argv.push(token);
      token = "";
      tokenStarted = false;
      continue;
    }
    if (/[;&|<>`$()^]/.test(character)) {
      return refuseScoutCommand(`shell syntax ${character} is not accepted`);
    }
    token += character;
    tokenStarted = true;
  }
  if (quote) return refuseScoutCommand("command contains an unterminated quote");
  if (tokenStarted) argv.push(token);
  if (!argv.length) return refuseScoutCommand("command argv is empty");
  return argv;
}

function refuseScoutCommand(reason: string): never {
  throw new Error(
    `Read-only scout command refused before execution: ${reason}. Use an allowlisted Git read command or an implementation lane with a declared worktree/write boundary.`,
  );
}
