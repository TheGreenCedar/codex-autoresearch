import type { UnknownRecord } from "../types/json.js";
import path from "node:path";
import type { ProcessRunResult } from "../runner.js";
import { runProcess, runShell, tailText } from "../runner.js";
import { normalizeBoundedLaneRecommendation, summarizeLaneLessons } from "../lane-briefs.js";
import {
  approvalRecordsFromLedger,
  buildApprovalRecord,
  resolveApproval,
} from "../approval-ledger.js";
import { boolOption, positiveIntegerOption } from "../cli/args.js";
import { resolveAuthorizedWorkDir } from "../cli/workdir-context.js";
import { defaultCommandShell, quoteShellArg } from "../command-rendering.js";
import { displayGitPath } from "../git-paths.js";
import { gitDirtyPathDetails, gitOutput, insideGitRepo, runGit } from "../git-private-state.js";
import { normalizeRelativePaths } from "../literal-paths.js";
import {
  buildParallelOrchestrationContext,
  latestLaneResults,
  normalizeParallelLane,
} from "../parallel-orchestration.js";
import { resolvePackageRoot } from "../runtime-paths.js";
import { buildDashboardSettings } from "./dashboard.js";
import { currentState } from "../session-core.js";
import { appendJsonl, readJsonl } from "../session-records.js";

export interface LaneRunnerRuntime {
  runShell?: typeof runShell;
}

const PLUGIN_ROOT = resolvePackageRoot(import.meta.url);

export async function laneRunner(args: UnknownRecord, runtime: LaneRunnerRuntime = {}) {
  const { workDir, config } = resolveAuthorizedWorkDir(String(args.working_dir || args.cwd || ""));
  const state = currentState(workDir);
  const settings = buildDashboardSettings(config);
  const { parallelLanes: lanes } = buildParallelOrchestrationContext({
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
      (candidate: UnknownRecord) => candidate.id === laneId || candidate.label === laneId,
    ) || normalizeParallelLane({ id: laneId, label: laneId }, lanes.length, config);
  const mode = normalizeLaneMode(args.mode, String(lane.mode || "read_only_scout"));
  const dryRun = boolOption(args.dry_run ?? args.dryRun, !boolOption(args.yes, false));
  const command = String(args.command || "").trim();
  const humanApproval = boolOption(
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
    ? resolveApproval(approvalRecordsFromLedger(readJsonl(workDir)), approvalGate)
    : null;
  const approvalSatisfied = humanApproval || approvalResolution?.approved === true;
  const timeBudgetSeconds =
    positiveIntegerOption(
      args.time_budget_seconds ??
        args.timeBudgetSeconds ??
        args.timeout_seconds ??
        args.timeoutSeconds,
      300,
      "--time-budget-seconds",
    ) || 300;
  const writeScope = normalizeRelativePaths(
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
    commandLooksUnsafeForWriteScope(command)
  ) {
    throw new Error(
      "Implementation lane --write-scope cannot run git cleanup, history, or stash commands in the main checkout; use a separate --worktree.",
    );
  }

  const runCwd =
    mode === "implementation" && worktreePath
      ? await resolveLaneWorktree(workDir, worktreePath)
      : workDir;
  const beforeStatus =
    mode === "read_only_scout" && command && !dryRun
      ? await hardenedScoutStatus(workDir, timeBudgetSeconds)
      : null;
  let writeScopeBefore: UnknownRecord | null = null;
  if (mode === "implementation" && !worktreePath && writeScope.length > 0 && command && !dryRun) {
    await assertNoDirtyPathsOutsideWriteScope(workDir, writeScope);
    writeScopeBefore = await writeScopeSnapshot(workDir);
  }
  let commandResult: UnknownRecord | null = null;
  if (command && !dryRun) {
    const result = scoutCommand
      ? await runHardenedScoutGit(scoutCommand, runCwd, timeBudgetSeconds)
      : await (runtime.runShell || runShell)(command, runCwd, timeBudgetSeconds, {
          retainMetricNames: [state.config.metricName || config.metricName || ""],
        });
    commandResult = {
      code: result.exitCode,
      timedOut: result.timedOut,
      termination: result.termination,
      terminationFailed: result.terminationFailed,
      durationSeconds: result.durationSeconds,
      output: tailText(
        ("combinedOutput" in result ? result.combinedOutput : result.output) || "",
        20,
        4000,
      ),
    };
    if (commandResult.terminationFailed) {
      const pid = (commandResult.termination as UnknownRecord | null)?.pid;
      const recovery = `Verify PID ${pid || "unknown"} and its descendants are absent, then remove only the retained progress marker before running another command.`;
      return {
        ok: false,
        code: "termination_failed",
        workDir,
        dryRun,
        lane: { id: lane.id, title: lane.title || lane.label, mode },
        result: {
          status: "termination_failed",
          summary: "Lane process-tree termination could not be proven.",
          recommendation: recovery,
          evidenceAccepted: false,
          command: command || "",
          commandResult,
        },
        coordinatorRecommendation: {
          status: "blocked",
          nextAction: recovery,
          measuredPacket: "Blocked while the prior lane process tree may still be alive.",
          commandHint: "",
        },
      };
    }
    if (beforeStatus != null) {
      const afterStatus = await hardenedScoutStatus(workDir, timeBudgetSeconds);
      if (afterStatus !== beforeStatus) {
        throw new Error(
          "Git porcelain detected a worktree change after the allowlisted scout command. Detection is best-effort, not containment; inspect and restore the repository before continuing.",
        );
      }
    }
    if (writeScopeBefore) {
      await assertWriteScopeIntegrity(workDir, writeScope, writeScopeBefore);
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
          recommendation: explicitRecommendation || String(lane.nextActionHint || ""),
          evidence: args.evidence,
          risks: args.risks,
          fallbackSummary:
            String((lane.brief as UnknownRecord | undefined)?.objective || "") ||
            "Distant architecture hypothesis recorded for human review.",
          fallbackRecommendation:
            String(lane.nextActionHint || "") ||
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
  const existingResults = latestLaneResults(workDir, state.segment);
  const laneResults = dryRun ? existingResults : [...existingResults, entry];
  const coordinatorRecommendation = synthesizeLaneDecision({
    workDir,
    laneResults,
    fallbackLane: lane,
  });
  if (mode === "big_idea" && !approvalSatisfied) {
    Object.assign(coordinatorRecommendation, {
      status: "awaiting_human_approval",
      nextAction:
        "Ask the operator to approve or reject the big-idea architecture recommendation before starting an implementation lane or measured packet.",
      measuredPacket: "Blocked until human approval is recorded for this big-idea lane.",
      commandHint: "",
      approvalRequired: true,
      approvalGate: result.approvalGate,
    });
  }
  if (!dryRun) {
    if (approvalGate && humanApproval) {
      appendJsonl(workDir, {
        ...buildApprovalRecord({
          gate: approvalGate.gate,
          scope: approvalGate.scope,
          source: "lane-runner --human-approval",
          evidence: [explicitSummary, explicitRecommendation].filter(Boolean),
        }),
      });
    }
    appendJsonl(workDir, entry);
  }
  return {
    ok: true,
    workDir,
    dryRun,
    lane: entry.lane,
    result,
    coordinatorRecommendation,
  };
}

function normalizeLaneMode(value: unknown, fallback: string) {
  const raw = String(value || fallback || "read_only_scout")
    .toLowerCase()
    .replace(/-/g, "_");
  if (["read_only", "readonly", "scout", "read_only_scout"].includes(raw)) {
    return "read_only_scout";
  }
  if (["implementation", "isolated_worktree", "mutating"].includes(raw)) return "implementation";
  if (["big_idea", "bigidea", "architecture", "distant"].includes(raw)) return "big_idea";
  throw new Error("--mode must be read_only_scout, implementation, or big_idea.");
}

const LANE_GIT_WRITE_SCOPE_UNSAFE =
  "am|apply|bisect|checkout|cherry-pick|clean|commit|merge|pull|push|rebase|reset|restore|revert|stash|switch|tag|worktree";
const LANE_PACKAGE_MANAGER_MUTATING =
  "(?:npm\\s+(?:ci|install|i|update|uninstall|remove|add)|pnpm\\s+(?:add|install|remove|update|uninstall)|yarn\\s+(?:add|install|remove|upgrade|uninstall)|bun\\s+(?:add|install|remove))";

function commandLooksUnsafeForWriteScope(command: string) {
  const packageMutating = new RegExp(
    `(^|[\\s;&|])${LANE_PACKAGE_MANAGER_MUTATING}(\\s|$)`,
    "i",
  ).test(command);
  const gitUnsafeForWriteScope = new RegExp(
    `(^|[\\s;&|])git\\b[^\\r\\n;&|]*\\b(${LANE_GIT_WRITE_SCOPE_UNSAFE})\\b`,
    "i",
  ).test(command);
  return gitUnsafeForWriteScope || packageMutating;
}

async function gitTopLevel(cwd: string) {
  const result = await runGit(["rev-parse", "--show-toplevel"], cwd);
  if (result.code !== 0) throw new Error(`Git worktree lookup failed: ${gitOutput(result, cwd)}`);
  return path.resolve(cwd, result.stdout.trim());
}

async function gitCommonDirectory(cwd: string) {
  const result = await runGit(["rev-parse", "--git-common-dir"], cwd);
  if (result.code !== 0) throw new Error(`Git common-dir lookup failed: ${gitOutput(result, cwd)}`);
  return path.resolve(cwd, result.stdout.trim());
}

async function gitRef(cwd: string, ref: string) {
  const result = await runGit(["rev-parse", "--verify", ref], cwd);
  return result.code === 0 ? result.stdout.trim() : "";
}

async function resolveLaneWorktree(workDir: string, worktreePath: string) {
  const runCwd = path.resolve(workDir, worktreePath);
  const [baseTopLevel, laneInsideGit] = await Promise.all([
    gitTopLevel(workDir),
    insideGitRepo(runCwd).catch(() => false),
  ]);
  if (!laneInsideGit) {
    throw new Error(`Implementation lane worktree must be an existing Git worktree: ${runCwd}`);
  }
  const laneTopLevel = await gitTopLevel(runCwd);
  if (path.resolve(baseTopLevel) === path.resolve(laneTopLevel)) {
    throw new Error("Implementation lane --worktree must point at a separate Git worktree.");
  }
  const [baseCommonDir, laneCommonDir] = await Promise.all([
    gitCommonDirectory(baseTopLevel),
    gitCommonDirectory(laneTopLevel),
  ]);
  if (path.resolve(baseCommonDir) !== path.resolve(laneCommonDir)) {
    throw new Error("Implementation lane --worktree must belong to the same Git repository.");
  }
  return laneTopLevel;
}

function dirtyPathWithinScope(relativePath: string, writeScope: string[]) {
  return writeScope.some((scope) => relativePath === scope || relativePath.startsWith(`${scope}/`));
}

async function dirtyPathsOutsideWriteScope(workDir: string, writeScope: string[]) {
  if (!(await insideGitRepo(workDir).catch(() => false))) {
    throw new Error("Implementation lane --write-scope verification requires a Git worktree.");
  }
  return (await gitDirtyPathDetails(workDir))
    .map((entry) => entry.path)
    .filter((relativePath) => !dirtyPathWithinScope(relativePath, writeScope));
}

async function assertNoDirtyPathsOutsideWriteScope(workDir: string, writeScope: string[]) {
  const outside = await dirtyPathsOutsideWriteScope(workDir, writeScope);
  if (outside.length) {
    throw new Error(
      `Implementation lane --write-scope cannot start with dirty files outside scope: ${outside
        .slice(0, 8)
        .map(displayGitPath)
        .join(", ")}`,
    );
  }
}

async function writeScopeSnapshot(workDir: string) {
  if (!(await insideGitRepo(workDir).catch(() => false))) {
    throw new Error("Implementation lane --write-scope verification requires a Git worktree.");
  }
  return {
    head: await gitRef(workDir, "HEAD"),
    stash: await gitRef(workDir, "refs/stash"),
  };
}

async function assertWriteScopeIntegrity(
  workDir: string,
  writeScope: string[],
  before: UnknownRecord,
) {
  const after = await writeScopeSnapshot(workDir);
  if (before.head !== after.head) {
    throw new Error(
      "Implementation lane --write-scope cannot move HEAD; use a separate --worktree for commits or history changes.",
    );
  }
  if (before.stash !== after.stash) {
    throw new Error(
      "Implementation lane --write-scope cannot create or change git stash entries; use a separate --worktree for hidden cleanup.",
    );
  }
  const outside = await dirtyPathsOutsideWriteScope(workDir, writeScope);
  if (outside.length) {
    throw new Error(
      `Implementation lane changed files outside --write-scope: ${outside
        .slice(0, 8)
        .map(displayGitPath)
        .join(", ")}`,
    );
  }
}

function synthesizeLaneDecision({
  workDir,
  laneResults,
  fallbackLane,
}: {
  workDir: string;
  laneResults: UnknownRecord[];
  fallbackLane?: UnknownRecord | null;
}) {
  const completed = laneResults
    .filter((entry) => selectableLaneResult(entry.result as UnknownRecord | null | undefined))
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
  const selected = completed.find((entry) => {
    const result = entry.result as UnknownRecord | undefined;
    return Boolean(result?.recommendation || result?.summary);
  });
  const selectedResult = selected?.result as UnknownRecord | undefined;
  const nextAction =
    selectedResult?.recommendation ||
    selectedResult?.summary ||
    fallbackLane?.nextActionHint ||
    "Run one read-only scout lane, then choose one isolated implementation candidate for the next measured packet.";
  const shell = defaultCommandShell();
  return {
    status: selected ? "ready" : "needs_lane_result",
    sourceLane: (selected?.lane as UnknownRecord | undefined)?.id || fallbackLane?.id || "",
    nextAction,
    lessonsToAvoid: summarizeLaneLessons(laneResults),
    measuredPacket:
      "Run exactly one next measured packet for the selected action, then log keep/discard/crash with ASI.",
    commandHint: `node ${quoteShellArg(
      path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"),
      shell,
    )} next --cwd ${quoteShellArg(workDir, shell)} --compact`,
  };
}

function selectableLaneResult(result: UnknownRecord | null | undefined): boolean {
  const status = String(result?.status || "").toLowerCase();
  return (
    (status === "completed" || status === "approved") &&
    (result?.evidenceAccepted === true || Boolean(result?.recommendation || result?.summary))
  );
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
  command: { args: string[]; executable: "git" },
  cwd: string,
  timeoutSeconds: number,
): Promise<ProcessRunResult> {
  return await runProcess(command.executable, command.args, {
    cwd,
    env: READ_ONLY_GIT_ENV,
    timeoutSeconds,
  });
}

async function hardenedScoutStatus(cwd: string, timeoutSeconds: number): Promise<string | null> {
  const result = await runHardenedScoutGit(
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
