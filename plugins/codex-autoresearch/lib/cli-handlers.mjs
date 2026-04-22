import path from "node:path";

export function createCliCommandHandlers(deps) {
  return {
    setup: async (args) => {
      if (args.interactive) {
        return {
          result: await deps.interactiveSetup({
            cwd: args.cwd,
            recipe: args.recipe,
            catalog: args.catalog,
            shell: args.shell,
          }),
        };
      }
      return {
        result: await deps.setupSession({
          cwd: args.cwd,
          recipe: args.recipe,
          catalog: args.catalog,
          name: args.name,
          goal: args.goal,
          metricName: args.metricName,
          metricUnit: args.metricUnit,
          direction: args.direction,
          benchmarkCommand: args.benchmarkCommand,
          checksCommand: args.checksCommand,
          shell: args.shell,
          filesInScope: args.filesInScope,
          offLimits: args.offLimits,
          constraints: args.constraints,
          secondaryMetrics: args.secondaryMetrics,
          commitPaths: args.commitPaths,
          maxIterations: args.maxIterations,
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
      result: await deps.setupPlan({
        cwd: args.cwd,
        recipe: args.recipe,
        recipeId: args.recipeId,
        catalog: args.catalog,
        name: args.name,
        metricName: args.metricName,
        benchmarkCommand: args.benchmarkCommand,
      }),
    }),
    guide: async (args) => ({
      result: await deps.guidedSetup({
        cwd: args.cwd,
        recipe: args.recipe,
        recipeId: args.recipeId,
        catalog: args.catalog,
        name: args.name,
        metricName: args.metricName,
        benchmarkCommand: args.benchmarkCommand,
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
        commitPaths: args.commitPaths,
        maxIterations: args.maxIterations,
        autonomyMode: args.autonomyMode,
        checksPolicy: args.checksPolicy,
        keepPolicy: args.keepPolicy,
        dashboardRefreshSeconds: args.dashboardRefreshSeconds,
        overwrite: args.overwrite,
        createChecks: args.createChecks,
        skipInit: args.skipInit,
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
      }),
    }),
    "finalize-preview": async (args) => ({
      result: await deps.finalizePreview({
        cwd: args.cwd,
        trunk: args.trunk,
      }),
    }),
    serve: async (args) => await serveCommand(args, deps),
    integrations: async (args) => ({
      result: await deps.integrationsCommand(args._[1] || "list", args),
    }),
    init: async (args) => ({
      result: await deps.initExperiment({
        cwd: args.cwd,
        name: args.name,
        metricName: args.metricName,
        metricUnit: args.metricUnit,
        direction: args.direction,
      }),
    }),
    run: async (args) => ({
      result: await deps.runExperiment({
        cwd: args.cwd,
        command: args.command,
        timeoutSeconds: args.timeoutSeconds,
        checksCommand: args.checksCommand,
        checksTimeoutSeconds: args.checksTimeoutSeconds,
        checksPolicy: args.checksPolicy,
      }),
    }),
    next: async (args) => ({
      result: await deps.nextExperiment({
        cwd: args.cwd,
        command: args.command,
        timeoutSeconds: args.timeoutSeconds,
        checksCommand: args.checksCommand,
        checksTimeoutSeconds: args.checksTimeoutSeconds,
        checksPolicy: args.checksPolicy,
      }),
    }),
    log: async (args) => ({
      result: await deps.logExperiment({
        cwd: args.cwd,
        commit: args.commit,
        metric: args.metric,
        status: args.status,
        description: args.description,
        metrics: deps.parseJsonOption(args.metrics, null),
        asi: deps.parseJsonOption(args.asi, null),
        commitPaths: args.commitPaths,
        revertPaths: args.revertPaths,
        allowDirtyRevert: args.allowDirtyRevert,
        fromLast: args.fromLast,
      }),
    }),
    state: async (args) => ({
      result: deps.publicState({ cwd: args.cwd }),
    }),
    doctor: async (args) => ({
      result: await deps.doctorSession({
        cwd: args.cwd,
        command: args.command,
        checkBenchmark: args.checkBenchmark,
        checkInstalled: args.checkInstalled,
        timeoutSeconds: args.timeoutSeconds,
      }),
    }),
    export: async (args) => ({
      result: await deps.exportDashboard({ cwd: args.cwd, output: args.output }),
    }),
    clear: async (args) => ({
      result: await deps.clearSession({ cwd: args.cwd, yes: args.yes, confirm: args.confirm }),
    }),
  };
}

export async function runCliCommand(command, args, handlers) {
  const handler = handlers[command];
  if (!handler) throw new Error(`Unknown command: ${command}`);
  return await handler(args);
}

async function serveCommand(args, deps) {
  const serveResult = await deps.serveAutoresearch({
    cwd: args.cwd,
    port: args.port,
    scriptPath: path.join(deps.pluginRoot, "scripts", "autoresearch.mjs"),
    dashboardHtml: async () => {
      const { workDir, config } = deps.resolveWorkDir(args.cwd);
      const entries = deps.readJsonl(workDir);
      const commands = deps.dashboardCommands(workDir);
      return deps.dashboardHtml(entries, {
        workDir,
        generatedAt: new Date().toISOString(),
        jsonlName: "autoresearch.jsonl",
        deliveryMode: "live-server",
        liveActionsAvailable: true,
        modeGuidance: {
          title: "Live dashboard",
          detail: "Live actions available.",
        },
        refreshMs: Math.max(1, Number(config.dashboardRefreshSeconds || 5)) * 1000,
        commands,
        settings: deps.dashboardSettings(config),
        viewModel: await deps.dashboardViewModel(workDir, config),
      });
    },
    viewModel: async () => {
      const { workDir, config } = deps.resolveWorkDir(args.cwd);
      return deps.dashboardViewModel(workDir, config);
    },
  });
  return {
    keepAlive: true,
    result: {
      ok: true,
      workDir: serveResult.workDir,
      port: serveResult.port,
      url: serveResult.url,
      modeGuidance: {
        deliveryMode: "live-server",
        difference: "This served URL can run guarded dashboard actions; exported file:// dashboards are read-only snapshots with copyable commands.",
      },
    },
  };
}
