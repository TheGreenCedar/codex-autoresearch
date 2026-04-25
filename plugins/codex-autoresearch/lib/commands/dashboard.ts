import path from "node:path";
import fsp from "node:fs/promises";

type LooseObject = Record<string, any>;

export interface DashboardCommandDeps {
  boolOption: (value: unknown, fallback: boolean) => boolean;
  buildDriftReport: (options: LooseObject) => Promise<LooseObject>;
  dashboardCommands: (workDir: string, ...extra: unknown[]) => LooseObject[];
  dashboardHtml: (entries: LooseObject[], meta: LooseObject) => string;
  dashboardSettings: (config: LooseObject, extra?: LooseObject) => LooseObject;
  dashboardViewModel: (
    workDir: string,
    config: LooseObject,
    context?: LooseObject,
  ) => Promise<LooseObject>;
  operationProgress: (options: LooseObject) => LooseObject;
  pluginRoot: string;
  pluginVersion: string;
  readJsonl: (workDir: string) => LooseObject[];
  resolveOutputInside: (workDir: string, output: string) => string;
  resolveWorkDir: (value: string) => { workDir: string; config: LooseObject; sessionCwd?: string };
  serveAutoresearch: (options: LooseObject) => Promise<LooseObject>;
  shellQuote: (value: string) => string;
  writeFile: typeof fsp.writeFile;
}

export function createDashboardCommands(deps: DashboardCommandDeps) {
  const liveDashboardServers = new Set<LooseObject>();

  async function exportDashboard(args: LooseObject) {
    const startedAt = Date.now();
    const { workDir, config } = deps.resolveWorkDir(args.working_dir || args.cwd);
    const entries = deps.readJsonl(workDir);
    if (entries.length === 0) throw new Error(`No autoresearch.jsonl found in ${workDir}`);
    const output = deps.resolveOutputInside(workDir, args.output || "autoresearch-dashboard.html");
    const commands = deps.dashboardCommands(workDir);
    const generatedAt = new Date().toISOString();
    const showcaseExport = deps.boolOption(args.showcase ?? args.showcaseMode, false);
    const sourceCwd = showcaseExport
      ? path.relative(deps.pluginRoot, workDir).replaceAll("\\", "/") || "."
      : workDir;
    const runtimeDrift = await deps
      .buildDriftReport({
        pluginRoot: deps.pluginRoot,
        includeInstalled: false,
      })
      .catch((error) => ({
        ok: false,
        warnings: [error.message],
      }));
    const dashboardContext = {
      deliveryMode: "static-export",
      generatedAt,
      sourceCwd,
      pluginVersion: deps.pluginVersion,
      runtimeDrift,
      publicExport: showcaseExport,
      suppressEnvironmentWarnings: showcaseExport,
    };
    const viewModel = await deps.dashboardViewModel(workDir, config, dashboardContext);
    const html = deps.dashboardHtml(entries, {
      workDir,
      generatedAt,
      jsonlName: "autoresearch.jsonl",
      deliveryMode: "static-export",
      liveActionsAvailable: false,
      modeGuidance: {
        title: "Static snapshot",
        detail: "Read-only snapshot.",
      },
      refreshMs: Math.max(1, Number(config.dashboardRefreshSeconds || 5)) * 1000,
      commands,
      settings: deps.dashboardSettings(config, dashboardContext),
      viewModel,
      publicExport: showcaseExport,
    });
    await deps.writeFile(output, html, "utf8");
    const modeGuidance = {
      staticExport: output,
      liveDashboardCommand: `node ${deps.shellQuote(path.join(deps.pluginRoot, "scripts", "autoresearch.mjs"))} serve --cwd ${deps.shellQuote(workDir)}`,
      difference:
        "The exported HTML is a read-only fallback snapshot; share the served dashboard URL when the operator needs a live link.",
      fullJson:
        "Pass --json-full/--verbose on the CLI or full=true over MCP to include the full viewModel in the command response.",
    };
    const progress = deps.operationProgress({
      stage: "export",
      label: "Write dashboard HTML",
      startedAt,
      status: "completed",
      outputTail: output,
    });
    const fullJson = deps.boolOption(
      args.json_full ?? args.jsonFull ?? args.full ?? args.verbose,
      false,
    );
    const result: LooseObject = {
      ok: true,
      workDir,
      output,
      summary: viewModel.summary,
      baseline: viewModel.summary?.baseline ?? null,
      best: viewModel.summary?.best ?? null,
      nextAction: viewModel.nextBestAction?.detail || viewModel.readout?.nextAction || "",
      modeGuidance,
      progress,
    };
    if (fullJson) result.viewModel = viewModel;
    return result;
  }

  async function serveDashboard(args: LooseObject) {
    const startedAt = Date.now();
    const { workDir, config } = deps.resolveWorkDir(args.working_dir || args.cwd);
    let liveUrl = "";
    const runtimeDrift = await deps
      .buildDriftReport({
        pluginRoot: deps.pluginRoot,
        includeInstalled: true,
      })
      .catch((error) => ({
        ok: false,
        warnings: [error.message],
      }));
    const serveResult = await deps.serveAutoresearch({
      cwd: workDir,
      port: args.port,
      scriptPath: path.join(deps.pluginRoot, "scripts", "autoresearch.mjs"),
      dashboardHtml: async ({ actionNonce, actionNonceHeader }: LooseObject = {}) => {
        const entries = deps.readJsonl(workDir);
        const generatedAt = new Date().toISOString();
        const dashboardContext = {
          deliveryMode: "live-server",
          liveUrl,
          generatedAt,
          sourceCwd: workDir,
          pluginVersion: deps.pluginVersion,
          runtimeDrift,
        };
        return deps.dashboardHtml(entries, {
          workDir,
          generatedAt,
          jsonlName: "autoresearch.jsonl",
          deliveryMode: "live-server",
          liveRefreshAvailable: true,
          liveActionsAvailable: false,
          actionNonce,
          actionNonceHeader,
          modeGuidance: {
            title: "Live dashboard",
            detail: "Live refresh is available; actions stay in CLI or MCP.",
          },
          refreshMs: Math.max(1, Number(config.dashboardRefreshSeconds || 5)) * 1000,
          commands: deps.dashboardCommands(workDir),
          settings: deps.dashboardSettings(config, dashboardContext),
          viewModel: await deps.dashboardViewModel(workDir, config, dashboardContext),
        });
      },
      viewModel: async () =>
        deps.dashboardViewModel(workDir, config, {
          deliveryMode: "live-server",
          liveUrl,
          generatedAt: new Date().toISOString(),
          sourceCwd: workDir,
          pluginVersion: deps.pluginVersion,
          runtimeDrift,
        }),
    });
    liveUrl = serveResult.url;
    const health = await verifyLiveDashboardUrl(liveUrl);
    liveDashboardServers.add(serveResult.server);
    serveResult.server.on("close", () => {
      liveDashboardServers.delete(serveResult.server);
    });
    return {
      ok: true,
      workDir: serveResult.workDir,
      port: serveResult.port,
      url: serveResult.url,
      verified: health.ok,
      healthUrl: health.url,
      checkedAt: health.checkedAt,
      modeGuidance: {
        deliveryMode: "live-server",
        difference: health.ok
          ? "This dashboard link was liveness-checked and can be handed to the operator; exported HTML is only a read-only fallback snapshot."
          : `Dashboard server started but liveness check failed: ${health.error}. Restart serve before handing this URL to the operator.`,
      },
      progress: deps.operationProgress({
        stage: "serve",
        label: "Start live dashboard",
        startedAt,
        status: "completed",
        outputTail: serveResult.url,
      }),
    };
  }

  return { exportDashboard, serveDashboard };
}

async function verifyLiveDashboardUrl(url: string) {
  const checkedAt = new Date().toISOString();
  const healthUrl = new URL("health", url).toString();
  try {
    const response = await fetch(healthUrl);
    if (!response.ok) {
      return {
        ok: false,
        url: healthUrl,
        checkedAt,
        error: `GET /health returned ${response.status}`,
      };
    }
    const payload = (await response.json().catch(() => null)) as LooseObject | null;
    return {
      ok: payload?.ok === true,
      url: healthUrl,
      checkedAt,
      error: payload?.ok === true ? "" : "GET /health did not return ok=true",
    };
  } catch (error) {
    return {
      ok: false,
      url: healthUrl,
      checkedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
