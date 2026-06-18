import path from "node:path";
import fsp from "node:fs/promises";
import {
  buildServeRegistryHealthInput,
  findReusableServeRegistry,
  readServeRegistry,
  summarizeServeRegistry,
  writeServeRegistry,
} from "../dashboard-server-registry.js";
import { compactDashboardTransportViewModel } from "../dashboard-transport.js";
import { verifyDashboardHealthSummary } from "../dashboard-health.js";

type LooseObject = Record<string, any>;
type DashboardCommandListOptions = {
  researchSlug?: string;
  scriptPath: string;
  shellQuote: (value: string) => string;
  workDir: string;
};

export interface DashboardCommandDeps {
  boolOption: (value: unknown, fallback: boolean) => boolean;
  buildDriftReport: (options: LooseObject) => Promise<LooseObject>;
  createSessionReadCache?: (options?: LooseObject) => LooseObject;
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

export function buildDashboardSettings(config: LooseObject, extra: LooseObject = {}): LooseObject {
  return {
    autonomyMode: config.autonomyMode || "guarded",
    checksPolicy: config.checksPolicy || "always",
    keepPolicy: config.keepPolicy || "primary-only",
    recipeId: config.recipeId || "",
    ...extra,
  };
}

export function operationProgress({
  stage,
  label,
  startedAt,
  status = "completed",
  outputTail = "",
}: LooseObject): LooseObject {
  const durationSeconds = Number(((Date.now() - startedAt) / 1000).toFixed(3));
  return {
    mode: "synchronous",
    status,
    cancellable: false,
    cancelStatus: "not_requested",
    elapsedSeconds: durationSeconds,
    stages: [
      {
        stage,
        label,
        status,
        durationSeconds,
        exitCode: null,
        timedOut: false,
        outputTail,
      },
    ],
    latestOutputTail: outputTail,
  };
}

export function buildDashboardCommands({
  researchSlug = "research",
  scriptPath,
  shellQuote,
  workDir,
}: DashboardCommandListOptions): LooseObject[] {
  const cwd = shellQuote(workDir);
  const script = shellQuote(scriptPath);
  const slug = shellQuote(researchSlug);
  return [
    { label: "State", command: `node ${script} state --cwd ${cwd} --report` },
    {
      label: "Onboarding packet",
      command: `node ${script} onboarding-packet --cwd ${cwd} --compact`,
    },
    { label: "Recommend next", command: `node ${script} recommend-next --cwd ${cwd} --compact` },
    { label: "Codex Goal brief", command: `node ${script} codex-goal-brief --cwd ${cwd}` },
    { label: "Setup plan", command: `node ${script} setup-plan --cwd ${cwd}` },
    {
      label: "Doctor",
      command: `node ${script} doctor --cwd ${cwd} --explain`,
    },
    { label: "Benchmark inspect", command: `node ${script} benchmark-inspect --cwd ${cwd}` },
    { label: "Checks inspect", command: `node ${script} checks-inspect --cwd ${cwd}` },
    {
      label: "Partial results",
      command: `node ${script} partial-results --cwd ${cwd} --from-last`,
    },
    {
      label: "Ledger doctor",
      command: `node ${script} ledger-doctor --cwd ${cwd} --json`,
    },
    {
      label: "Quality gap",
      command: `node ${script} quality-gap --cwd ${cwd} --research-slug ${slug}`,
    },
    {
      label: "Gap candidates",
      command: `node ${script} gap-candidates --cwd ${cwd} --research-slug ${slug}`,
    },
    { label: "Finalize preview", command: `node ${script} finalize-preview --cwd ${cwd}` },
    { label: "New segment", command: `node ${script} new-segment --cwd ${cwd} --dry-run` },
    {
      label: "Promote gate",
      command: `node ${script} promote-gate --cwd ${cwd} --reason "describe promoted measurement" --dry-run`,
    },
  ];
}

export function createDashboardCommands(deps: DashboardCommandDeps) {
  const liveDashboardServers = new Set<LooseObject>();

  async function exportDashboard(args: LooseObject) {
    const startedAt = Date.now();
    const { workDir, config } = deps.resolveWorkDir(args.working_dir || args.cwd);
    emitProgress(args, "export", `reading session ledger from ${workDir}`);
    const entries = deps.readJsonl(workDir);
    if (entries.length === 0) throw new Error(`No autoresearch.jsonl found in ${workDir}`);
    const output = deps.resolveOutputInside(workDir, args.output || "autoresearch-dashboard.html");
    const commands = deps.dashboardCommands(workDir);
    const generatedAt = new Date().toISOString();
    const showcaseExport = deps.boolOption(args.showcase ?? args.showcaseMode, false);
    const deliveryMode = showcaseExport ? "showcase" : "static-export";
    const sourceCwd = showcaseExport
      ? path.relative(deps.pluginRoot, workDir).replaceAll("\\", "/") || "."
      : workDir;
    const runtimeDrift = await deps
      .buildDriftReport({
        pluginRoot: deps.pluginRoot,
        includeInstalled: false,
      })
      .catch(unavailableRuntimeDrift);
    emitProgress(args, "export", "building dashboard view model");
    const dashboardServerRegistry = await dashboardServerRegistryStatus(
      workDir,
      deps.pluginVersion,
    );
    const dashboardContext = {
      deliveryMode,
      generatedAt,
      sourceCwd,
      pluginVersion: deps.pluginVersion,
      runtimeDrift,
      dashboardServerRegistry,
      publicExport: showcaseExport,
      showcaseMode: showcaseExport,
      suppressEnvironmentWarnings: showcaseExport,
    };
    const rawViewModel = await deps.dashboardViewModel(workDir, config, dashboardContext);
    const viewModel = compactDashboardTransportViewModel(
      showcaseExport ? sanitizePublicShowcaseViewModel(rawViewModel) : rawViewModel,
    );
    const html = deps.dashboardHtml(entries, {
      workDir,
      generatedAt,
      jsonlName: "autoresearch.jsonl",
      deliveryMode,
      liveActionsAvailable: false,
      modeGuidance: {
        title: showcaseExport ? "Demo Snapshot" : "Static Snapshot",
        detail: showcaseExport ? "Bundled read-only demo snapshot." : "Read-only snapshot.",
      },
      refreshMs: Math.max(1, Number(config.dashboardRefreshSeconds || 5)) * 1000,
      commands,
      settings: deps.dashboardSettings(config, dashboardContext),
      viewModel,
      publicExport: showcaseExport,
      showcaseMode: showcaseExport,
    });
    emitProgress(args, "export", `writing dashboard snapshot to ${output}`);
    await deps.writeFile(output, html, "utf8");
    const modeGuidance = {
      staticExport: output,
      difference:
        "The exported HTML is a read-only fallback snapshot; start the served dashboard explicitly from the CLI when the operator needs a live link.",
      fullJson:
        "Pass --json-full/--verbose on the CLI to include the full viewModel in the command response.",
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
    const summary = recordOrNull(viewModel.summary);
    const nextBestAction = recordOrNull(viewModel.nextBestAction);
    const readout = recordOrNull(viewModel.readout);
    const result: LooseObject = {
      ok: true,
      workDir,
      output,
      summary,
      decisionEnvelopeSummary: viewModel.decisionEnvelopeSummary || null,
      baseline: summary?.baseline ?? null,
      best: summary?.best ?? null,
      nextAction: nextBestAction?.detail || readout?.nextAction || "",
      modeGuidance,
      progress,
    };
    if (fullJson) result.viewModel = rawViewModel;
    return result;
  }

  async function serveDashboard(args: LooseObject) {
    const startedAt = Date.now();
    const startedAtIso = new Date(startedAt).toISOString();
    const { workDir } = deps.resolveWorkDir(args.working_dir || args.cwd);
    const debugLedger = deps.boolOption(args.debugLedger ?? args.debug_ledger, false);
    const liveReadCache = deps.createSessionReadCache?.({ invalidateOnLedgerChange: true });
    let liveUrl = "";
    let dashboardServerRegistry: LooseObject | null = null;
    if (!args.port && debugLedger !== true) {
      const reusableRegistry = await findReusableServeRegistry(workDir, {
        expectedVersion: deps.pluginVersion,
        timeoutMs: 500,
        debugLedger,
      });
      dashboardServerRegistry = reusableRegistry.available ? reusableRegistry : null;
      if (reusableRegistry.reusable) {
        return reusedServeDashboardResult({
          workDir,
          lookup: reusableRegistry,
          startedAt,
        });
      }
    }

    const runtimeDrift = await deps
      .buildDriftReport({
        pluginRoot: deps.pluginRoot,
        includeInstalled: true,
      })
      .catch(unavailableRuntimeDrift);
    const serveResult = await deps.serveAutoresearch({
      cwd: workDir,
      port: args.port,
      debugLedger,
      pluginVersion: deps.pluginVersion,
      startedAt: startedAtIso,
      scriptPath: path.join(deps.pluginRoot, "scripts", "autoresearch.mjs"),
      dashboardHtml: async () => {
        const { config } = deps.resolveWorkDir(args.working_dir || args.cwd);
        const generatedAt = new Date().toISOString();
        const dashboardContext = {
          deliveryMode: "live-server",
          liveUrl,
          generatedAt,
          sourceCwd: workDir,
          pluginVersion: deps.pluginVersion,
          runtimeDrift,
          activeServerCount: liveDashboardServers.size,
          dashboardServerRegistry,
        };
        return deps.dashboardHtml([], {
          workDir,
          generatedAt,
          jsonlName: "autoresearch.jsonl",
          deliveryMode: "live-server",
          liveRefreshAvailable: true,
          liveActionsAvailable: false,
          modeGuidance: {
            title: "Live Readout",
            detail: "Live refresh is available; actions stay in CLI.",
          },
          refreshMs: Math.max(1, Number(config.dashboardRefreshSeconds || 5)) * 1000,
          commands: deps.dashboardCommands(workDir),
          settings: deps.dashboardSettings(config, dashboardContext),
          viewModel: {},
        });
      },
      viewModel: async () => {
        const { config } = deps.resolveWorkDir(args.working_dir || args.cwd);
        return deps.dashboardViewModel(workDir, config, {
          deliveryMode: "live-server",
          liveUrl,
          generatedAt: new Date().toISOString(),
          sourceCwd: workDir,
          pluginVersion: deps.pluginVersion,
          runtimeDrift,
          activeServerCount: liveDashboardServers.size,
          dashboardServerRegistry,
          readCache: liveReadCache,
        });
      },
    });
    liveUrl = serveResult.url;
    liveDashboardServers.add(serveResult.server);
    const healthUrl = new URL("health", liveUrl).toString();
    const registryWrite = await writeServeRegistry(workDir, {
      pid: process.pid,
      port: Number(serveResult.port),
      cwd: workDir,
      startedAt: startedAtIso,
      version: deps.pluginVersion,
      healthUrl,
      debugLedger,
    });
    const registrySummary = summarizeServeRegistry(registryWrite.record, {
      currentPid: process.pid,
      currentCwd: workDir,
    });
    const dashboardHealth = await verifyDashboardHealthSummary({
      url: serveResult.url,
      port: serveResult.port,
      pid: process.pid,
      registryPath: registryWrite.path,
      cwd: workDir,
      version: deps.pluginVersion,
      startedAt: startedAtIso,
      previous: registrySummary,
      timeoutMs: 1000,
    });
    dashboardServerRegistry = mergeRegistryHealthSummary(registrySummary, dashboardHealth);
    serveResult.server.on("close", () => {
      liveDashboardServers.delete(serveResult.server);
    });
    const dashboardVerified =
      dashboardHealth.liveness === "alive" && dashboardHealth.stale === false;
    return {
      ok: true,
      workDir: serveResult.workDir,
      port: serveResult.port,
      url: serveResult.url,
      dashboardUrl: serveResult.url,
      mode: "live",
      registryReused: false,
      detached: false,
      pid: process.pid,
      cwd: workDir,
      version: deps.pluginVersion,
      startedAt: startedAtIso,
      verified: dashboardVerified,
      healthUrl: dashboardHealth.healthUrl || healthUrl,
      registryPath: registryWrite.path,
      debugLedger: {
        enabled: serveResult.debugLedger === true,
        endpoint: new URL("autoresearch.jsonl", serveResult.url).toString(),
        guidance:
          serveResult.debugLedger === true
            ? "Debug ledger endpoint is enabled and returns redacted ledger lines."
            : "Raw ledger endpoint is disabled by default; restart with --debug-ledger only for local debugging.",
      },
      dashboardHealth,
      checkedAt: new Date().toISOString(),
      registry: {
        path: registryWrite.path,
        status: dashboardServerRegistry,
        previous: registryWrite.previous,
      },
      decisionEnvelopeSummary: null,
      deferredViewModel: {
        availableAt: new URL("view-model.json", serveResult.url).toString(),
        reason:
          "Live dashboard startup returns after health verification; heavier decision diagnostics load from /view-model.json.",
      },
      modeGuidance: {
        deliveryMode: "live-server",
        difference: dashboardVerified
          ? "This dashboard link was liveness-checked and can be handed to the operator; exported HTML is only a read-only fallback snapshot."
          : `Dashboard server started but health verification reported ${dashboardHealth.liveness}. Restart serve before handing this URL to the operator.`,
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

function reusedServeDashboardResult({
  workDir,
  lookup,
  startedAt,
}: {
  workDir: string;
  lookup: LooseObject;
  startedAt: number;
}): LooseObject {
  const url = String(lookup.dashboardUrl || lookup.health?.url || "");
  const healthUrl = String(lookup.healthUrl || lookup.health?.healthUrl || "");
  return {
    ok: true,
    workDir,
    port: lookup.port ?? null,
    url,
    dashboardUrl: url,
    mode: "live",
    registryReused: true,
    detached: true,
    pid: lookup.health?.pid ?? lookup.pid ?? null,
    cwd: lookup.cwd || workDir,
    version: lookup.version || "",
    startedAt: lookup.startedAt || "",
    verified: lookup.liveness === "alive" && lookup.stale === false,
    healthUrl,
    registryPath: lookup.registryPath || "",
    recoveryCommand: lookup.recoveryCommand || "",
    dashboardHealth: lookup.health || null,
    checkedAt: lookup.checkedAt || new Date().toISOString(),
    registry: {
      path: lookup.registryPath || "",
      status: lookup,
      previous: lookup.previous || null,
    },
    debugLedger: {
      enabled:
        lookup.health?.dashboard?.debugLedger === true || lookup.record?.debugLedger === true,
      endpoint: url ? new URL("autoresearch.jsonl", url).toString() : "",
      guidance:
        lookup.record?.debugLedger === true
          ? "Reused dashboard was started with --debug-ledger; raw ledger endpoint is available for local debugging."
          : "Raw ledger endpoint remains disabled on the reused dashboard; restart with --debug-ledger only for local debugging.",
    },
    decisionEnvelopeSummary: null,
    deferredViewModel: {
      availableAt: url ? new URL("view-model.json", url).toString() : "",
      reason:
        "A healthy existing live dashboard was reused; heavier decision diagnostics remain available from /view-model.json.",
    },
    modeGuidance: {
      deliveryMode: "live-server",
      difference:
        "This dashboard link was already live for the same cwd and plugin version; exported HTML is only a read-only fallback snapshot.",
    },
    progress: {
      stage: "serve",
      label: "Reuse live dashboard",
      startedAt,
      status: "completed",
      outputTail: url,
    },
  };
}

function emitProgress(args: LooseObject, stage: string, message: string): void {
  if (args.progress !== true && args.progress_stderr !== true && args.progressStderr !== true) {
    return;
  }
  process.stderr.write(`[autoresearch:${stage}] ${message}\n`);
}

function recordOrNull(value: unknown): LooseObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as LooseObject)
    : null;
}

function sanitizePublicShowcaseViewModel(value: LooseObject): LooseObject {
  return sanitizePublicShowcaseValue(value) as LooseObject;
}

function sanitizePublicShowcaseValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((item) => !containsShowcaseOnlyWarning(item))
      .map((item) => sanitizePublicShowcaseValue(item));
  }
  if (!value || typeof value !== "object") return value;
  const out: LooseObject = {};
  for (const [key, child] of Object.entries(value as LooseObject)) {
    if (containsShowcaseOnlyWarning(child)) continue;
    out[key] = sanitizePublicShowcaseValue(child);
  }
  return out;
}

function containsShowcaseOnlyWarning(value: unknown): boolean {
  if (typeof value === "string") {
    return /Excluded \d+ unkept non-session commit|Final tree coverage is missing/i.test(value);
  }
  if (Array.isArray(value)) return value.some((item) => containsShowcaseOnlyWarning(item));
  if (!value || typeof value !== "object") return false;
  return Object.values(value as LooseObject).some((item) => containsShowcaseOnlyWarning(item));
}

async function dashboardServerRegistryStatus(workDir: string, expectedVersion: string) {
  const record = await readServeRegistry(workDir);
  const previous = summarizeServeRegistry(record, { currentCwd: workDir });
  if (!previous.available) return null;
  const health = await verifyDashboardHealthSummary(
    buildServeRegistryHealthInput(workDir, record, {
      expectedVersion,
      timeoutMs: 500,
    }),
  );
  return mergeRegistryHealthSummary(previous, health);
}

function mergeRegistryHealthSummary(summary: LooseObject, health: LooseObject): LooseObject {
  const liveness = health.liveness === "alive" ? "alive" : health.liveness || "unknown";
  const stale =
    health.stale === false && liveness === "alive"
      ? false
      : health.stale === true
        ? true
        : summary.stale === true
          ? true
          : null;
  return {
    ...summary,
    healthUrl: health.healthUrl || summary.record?.healthUrl || "",
    checkedAt: new Date().toISOString(),
    expectedVersion: health.version || "",
    liveness,
    stale,
    message:
      liveness === "alive" && stale === false
        ? "Dashboard registry HTTP health matched this cwd and plugin version."
        : "Dashboard registry requires matching HTTP health before it can be trusted as live.",
  };
}

function unavailableRuntimeDrift(error: unknown): LooseObject {
  return {
    ok: null,
    status: "unavailable",
    probeFailed: true,
    warnings: [error instanceof Error ? error.message : String(error)],
  };
}
