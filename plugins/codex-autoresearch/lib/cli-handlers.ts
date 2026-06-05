import { normalizeCliCommandArguments } from "./tool-schemas.js";

type LooseObject = Record<string, any>;
type CliHandler = (args: LooseObject) => Promise<LooseObject>;

export function createCliCommandHandlers(deps: LooseObject): Record<string, CliHandler> {
  return normalizeCliHandlers({
    setup: async (args) => {
      if (args.interactive) {
        return {
          result: await deps.interactiveSetup({
            cwd: args.cwd,
            recipe: args.recipe,
            catalog: args.catalog,
            trustCatalog: args.trustCatalog,
            shell: args.shell,
          }),
        };
      }
      return {
        result: await deps.setupSession({
          cwd: args.cwd,
          recipe: args.recipe,
          recipeId: args.recipeId,
          catalog: args.catalog,
          trustCatalog: args.trustCatalog,
          name: args.name,
          goal: args.goal,
          metricName: args.metricName,
          metricUnit: args.metricUnit,
          direction: args.direction,
          benchmarkCommand: args.benchmarkCommand,
          benchmarkPrintsMetric: args.benchmarkPrintsMetric,
          checksCommand: args.checksCommand,
          shell: args.shell,
          filesInScope: args.filesInScope,
          offLimits: args.offLimits,
          constraints: args.constraints,
          secondaryMetrics: args.secondaryMetrics,
          secondaryMetricConstraints: args.secondaryMetricConstraints,
          secondaryMetricConstraintMode: args.secondaryMetricConstraintMode,
          protectedBenchmarkPaths: args.protectedBenchmarkPaths,
          commitPaths: args.commitPaths,
          maxIterations: args.maxIterations,
          packetBudget: args.packetBudget,
          wallClockBudgetSeconds: args.wallClockBudgetSeconds,
          budgetNote: args.budgetNote,
          autonomyMode: args.autonomyMode,
          checksPolicy: args.checksPolicy,
          keepPolicy: args.keepPolicy,
          dashboardRefreshSeconds: args.dashboardRefreshSeconds,
          overwrite: args.overwrite,
          createChecks: args.createChecks,
          skipInit: args.skipInit,
        }),
      };
    },
    "setup-plan": async (args) => ({
      result: await deps.setupPlan(setupArgs(args)),
    }),
    guide: async (args) => ({
      result: await deps.guidedSetup(setupArgs(args)),
    }),
    "prompt-plan": async (args) => ({
      result: await deps.promptPlan({
        prompt: args.prompt,
        ...setupArgs(args),
      }),
    }),
    "onboarding-packet": async (args) => ({
      result: await deps.onboardingPacket({
        cwd: args.cwd,
        compact: args.compact,
      }),
    }),
    "recommend-next": async (args) => ({
      result: await deps.recommendNext({
        cwd: args.cwd,
        compact: args.compact,
        operatorChecklist: args.operatorChecklist,
        codexGoalObjective: args.codexGoalObjective,
      }),
    }),
    "codex-goal-brief": async (args) => ({
      result: await deps.codexGoalBrief({
        cwd: args.cwd,
        codexGoalObjective: args.codexGoalObjective,
        codexGoalStatus: args.codexGoalStatus,
        codexGoalTokenBudget: args.codexGoalTokenBudget,
        codexGoalTokensUsed: args.codexGoalTokensUsed,
        codexGoalTimeUsedSeconds: args.codexGoalTimeUsedSeconds,
        completionEvidence: args.completionEvidence,
        completionConfirmed: args.completionConfirmed,
      }),
    }),
    "session-forensics": async (args) => ({
      result: await deps.sessionForensics({
        cwd: args.cwd,
        sessionJsonl: args.sessionJsonl,
        researchSlug: args.researchSlug,
        dryRun: args.dryRun,
        apply: args.apply,
        allowSnippets: args.allowSnippets,
        allowOutsideWorkdir: args.allowOutsideWorkdir,
        maxSnippets: args.maxSnippets,
        maxSnippetChars: args.maxSnippetChars,
      }),
    }),
    recipes: async (args) => ({
      result: await deps.recipeCommand(args._[1] || "list", args),
    }),
    "research-setup": async (args) => ({
      result: await deps.setupResearchSession({
        cwd: args.cwd,
        slug: args.slug,
        goal: args.goal,
        name: args.name,
        checksCommand: args.checksCommand,
        shell: args.shell,
        filesInScope: args.filesInScope,
        constraints: args.constraints,
        secondaryMetricConstraints: args.secondaryMetricConstraints,
        secondaryMetricConstraintMode: args.secondaryMetricConstraintMode,
        protectedBenchmarkPaths: args.protectedBenchmarkPaths,
        commitPaths: args.commitPaths,
        maxIterations: args.maxIterations,
        packetBudget: args.packetBudget,
        wallClockBudgetSeconds: args.wallClockBudgetSeconds,
        budgetNote: args.budgetNote,
        autonomyMode: args.autonomyMode,
        checksPolicy: args.checksPolicy,
        keepPolicy: args.keepPolicy,
        dashboardRefreshSeconds: args.dashboardRefreshSeconds,
        overwrite: args.overwrite,
        createChecks: args.createChecks,
        skipInit: args.skipInit,
      }),
    }),
    "research-fanout": async (args) => ({
      result: await deps.researchFanout({
        cwd: args.cwd,
        lanes: args.lanes,
        laneCount: args.laneCount,
        dryRun: args.dryRun,
        yes: args.yes,
      }),
    }),
    "lane-runner": async (args) => ({
      result: await deps.laneRunner({
        cwd: args.cwd,
        laneId: args.laneId,
        lane: args.lane,
        mode: args.mode,
        command: args.command,
        worktree: args.worktree,
        worktreePath: args.worktreePath,
        writeScope: args.writeScope,
        commitPaths: args.commitPaths,
        resultStatus: args.resultStatus,
        summary: args.summary,
        recommendation: args.recommendation,
        nextAction: args.nextAction,
        timeBudgetSeconds: args.timeBudgetSeconds,
        timeoutSeconds: args.timeoutSeconds,
        dryRun: args.dryRun,
        yes: args.yes,
        allowNonGitCommand: args.allowNonGitCommand,
        approved: args.approved,
        evidence: args.evidence,
        humanApproval: args.humanApproval,
        risks: args.risks,
      }),
    }),
    config: async (args) => ({
      result: await deps.configureSession({
        cwd: args.cwd,
        autonomyMode: args.autonomyMode,
        checksPolicy: args.checksPolicy,
        keepPolicy: args.keepPolicy,
        dashboardRefreshSeconds: args.dashboardRefreshSeconds,
        maxIterations: args.maxIterations,
        extend: args.extend,
        commitPaths: args.commitPaths,
        packetBudget: args.packetBudget,
        wallClockBudgetSeconds: args.wallClockBudgetSeconds,
        budgetNote: args.budgetNote,
        protectedBenchmarkPaths: args.protectedBenchmarkPaths,
        secondaryMetricConstraints: args.secondaryMetricConstraints,
        secondaryMetricConstraintMode: args.secondaryMetricConstraintMode,
      }),
    }),
    "quality-gap": async (args) => {
      const result = await deps.measureQualityGap({
        cwd: args.cwd,
        researchSlug: args.researchSlug,
        slug: args.slug,
      });
      if (args.list || args.json) return { result };
      return { text: result.metricOutput };
    },
    "gap-candidates": async (args) => ({
      result: await deps.gapCandidates({
        cwd: args.cwd,
        researchSlug: args.researchSlug,
        slug: args.slug,
        apply: args.apply,
        modelCommand: args.modelCommand,
        modelTimeoutSeconds: args.modelTimeoutSeconds,
      }),
    }),
    "finalize-preview": async (args) => ({
      result: await deps.finalizePreview({
        cwd: args.cwd,
        trunk: args.trunk,
        progress: args.progress,
      }),
    }),
    "finalize-current-tree": async (args) => ({
      result: await deps.finalizeCurrentTree({
        cwd: args.cwd,
        trunk: args.trunk,
        excludeSessionArtifacts: args.excludeSessionArtifacts,
        includeSessionArtifacts: args.includeSessionArtifacts,
        progress: args.progress,
      }),
    }),
    serve: async (args) => ({
      keepAlive: true,
      result: await deps.serveDashboard({
        cwd: args.cwd,
        port: args.port,
        debugLedger: args.debugLedger,
      }),
    }),
    integrations: async (args) => ({
      result: await deps.integrationsCommand(args.subcommand || args._?.[1] || "list", args),
    }),
    init: async (args) => ({
      result: await deps.initExperiment({
        cwd: args.cwd,
        name: args.name,
        goal: args.goal,
        metricName: args.metricName,
        metricUnit: args.metricUnit,
        direction: args.direction,
      }),
    }),
    run: async (args) => ({
      result: await deps.runExperiment({
        _: args._,
        cwd: args.cwd,
        command: args.command,
        commandFile: args.commandFile,
        envFile: args.envFile,
        packetEnvFile: args.packetEnvFile,
        packetEnvMode: args.packetEnvMode,
        timeoutSeconds: args.timeoutSeconds,
        checksCommand: args.checksCommand,
        checksTimeoutSeconds: args.checksTimeoutSeconds,
        checksPolicy: args.checksPolicy,
      }),
    }),
    next: async (args) => ({
      result: await deps.nextExperiment({
        _: args._,
        cwd: args.cwd,
        command: args.command,
        commandFile: args.commandFile,
        envFile: args.envFile,
        packetEnvFile: args.packetEnvFile,
        packetEnvMode: args.packetEnvMode,
        compact: args.compact,
        timeoutSeconds: args.timeoutSeconds,
        checksCommand: args.checksCommand,
        checksTimeoutSeconds: args.checksTimeoutSeconds,
        checksPolicy: args.checksPolicy,
      }),
    }),
    "partial-results": async (args) => ({
      result: await deps.partialResultsCommand({
        cwd: args.cwd,
        fromLast: args.fromLast,
        artifact: args.artifact,
        record: args.record,
        researchSlug: args.researchSlug,
        commandHash: args.commandHash,
        description: args.description,
      }),
    }),
    log: async (args) => ({
      result: await deps.logExperiment({
        cwd: args.cwd,
        commit: args.commit,
        metric: args.metric,
        status: args.status,
        description: args.description,
        metrics: args.metricsFile ? args.metrics : deps.parseJsonOption(args.metrics, null),
        metricsFile: args.metricsFile,
        asi: args.asiFile || args.asiJsonFile ? args.asi : deps.parseJsonOption(args.asi, null),
        asiFile: args.asiFile,
        asiJsonFile: args.asiJsonFile,
        evidenceStatus: args.evidenceStatus,
        commitPaths: args.commitPaths,
        revertPaths: args.revertPaths,
        allowAddAll: args.allowAddAll,
        allowDirtyRevert: args.allowDirtyRevert,
        fromLast: args.fromLast,
      }),
    }),
    state: async (args) => ({
      result: await deps.publicState({
        cwd: args.cwd,
        compact: args.compact,
        report: args.report,
        codexGoalObjective: args.codexGoalObjective,
      }),
    }),
    doctor: async (args) => ({
      result: await (args._[1] === "hooks" || args.hooks
        ? deps.doctorHooks({
            cwd: args.cwd,
          })
        : deps.doctorSession({
            cwd: args.cwd,
            command: args.command,
            checkBenchmark: args.checkBenchmark,
            checkInstalled: args.checkInstalled,
            explain: args.explain,
            timeoutSeconds: args.timeoutSeconds,
          })),
    }),
    "benchmark-lint": async (args) => ({
      result: await deps.benchmarkLint({
        _: args._,
        cwd: args.cwd,
        metricName: args.metricName,
        sample: args.sample,
        command: args.command,
        timeoutSeconds: args.timeoutSeconds,
      }),
    }),
    "benchmark-inspect": async (args) => ({
      result: await deps.benchmarkInspect({
        cwd: args.cwd,
        command: args.command,
        timeoutSeconds: args.timeoutSeconds,
      }),
    }),
    "checks-inspect": async (args) => ({
      result: await deps.checksInspect({
        cwd: args.cwd,
        command: args.command || args.checksCommand,
        timeoutSeconds: args.timeoutSeconds,
      }),
    }),
    "new-segment": async (args) => ({
      result: await deps.newSegment({
        cwd: args.cwd,
        reason: args.reason,
        dryRun: args.dryRun,
        yes: args.yes,
        confirm: args.confirm,
      }),
    }),
    "promote-gate": async (args) => ({
      result: await deps.promoteGate({
        cwd: args.cwd,
        reason: args.reason,
        gateName: args.gateName,
        queryCount: args.queryCount,
        benchmarkCommand: args.benchmarkCommand,
        checksCommand: args.checksCommand,
        notes: args.notes,
        dryRun: args.dryRun,
        yes: args.yes,
        confirm: args.confirm,
      }),
    }),
    export: async (args) => ({
      result: await deps.exportDashboard({
        cwd: args.cwd,
        output: args.output,
        showcase: args.showcase,
        showcaseMode: args.showcaseMode,
        jsonFull: args.jsonFull,
        verbose: args.verbose,
        progress: args.progress || args.progressStderr || args.progress_stderr,
      }),
    }),
    clear: async (args) => ({
      result: await deps.clearSession({
        cwd: args.cwd,
        yes: args.yes,
        confirm: args.confirm,
        dryRun: args.dryRun,
      }),
    }),
  });
}

function setupArgs(args: LooseObject): LooseObject {
  return {
    cwd: args.cwd,
    recipe: args.recipe,
    recipeId: args.recipeId,
    catalog: args.catalog,
    trustCatalog: args.trustCatalog,
    name: args.name,
    goal: args.goal,
    metricName: args.metricName,
    metricUnit: args.metricUnit,
    direction: args.direction,
    benchmarkCommand: args.benchmarkCommand,
    benchmarkPrintsMetric: args.benchmarkPrintsMetric,
    checksCommand: args.checksCommand,
    filesInScope: args.filesInScope,
    offLimits: args.offLimits,
    constraints: args.constraints,
    secondaryMetrics: args.secondaryMetrics,
    secondaryMetricConstraints: args.secondaryMetricConstraints,
    secondaryMetricConstraintMode: args.secondaryMetricConstraintMode,
    protectedBenchmarkPaths: args.protectedBenchmarkPaths,
    commitPaths: args.commitPaths,
    maxIterations: args.maxIterations,
    packetBudget: args.packetBudget,
    wallClockBudgetSeconds: args.wallClockBudgetSeconds,
    budgetNote: args.budgetNote,
  };
}

function normalizeCliHandlers(handlers: Record<string, CliHandler>): Record<string, CliHandler> {
  return Object.fromEntries(
    Object.entries(handlers).map(([command, handler]) => [
      command,
      (args: LooseObject) => handler(normalizeCliCommandArguments(command, args) as LooseObject),
    ]),
  );
}

export async function runCliCommand(
  command: string,
  args: LooseObject,
  handlers: Record<string, CliHandler>,
) {
  const handler = handlers[command];
  if (!handler) throw new Error(`Unknown command: ${command}`);
  return await handler(args);
}
