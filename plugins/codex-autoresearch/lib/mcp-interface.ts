import {
  mcpToolSchemas,
  normalizeToolArguments,
  requireUnsafeCommandGate,
  validateToolArguments,
} from "./mcp-tool-schemas.js";
import { toolNames } from "./tool-registry.js";

export {
  mcpToolSchemas,
  mcpToolSchemasWithContracts,
  normalizeToolArguments,
  requireUnsafeCommandGate,
  toolSchemas,
  validateToolArguments,
} from "./mcp-tool-schemas.js";

export function createMcpInterface(deps) {
  const toolHandlers = createToolHandlers(deps);
  const callTool = async (name, args) => {
    const normalizedArgs = validateToolArguments(name, args);
    requireUnsafeCommandGate(name, normalizedArgs, deps.boolOption);
    const handler = toolHandlers[name];
    if (handler) return await handler(normalizedArgs);
    throw new Error(`Unknown tool: ${name}`);
  };

  return {
    callTool,
    toolSchemas: mcpToolSchemas,
    validateToolArguments,
  };
}

function createToolHandlers(deps) {
  return ensureToolHandlerCoverage({
    setup_plan: (args) => deps.setupPlan(args),
    guided_setup: (args) => deps.guidedSetup(args),
    prompt_plan: (args) => deps.promptPlan(args),
    onboarding_packet: (args) => deps.onboardingPacket(args),
    recommend_next: (args) => deps.recommendNext(args),
    list_recipes: (args) => deps.recipeCommand(args.recommend ? "recommend" : "list", args),
    setup_session: (args) => deps.setupSession(args),
    setup_research_session: (args) => deps.setupResearchSession(args),
    configure_session: (args) => deps.configureSession(args),
    init_experiment: (args) => deps.initExperiment(args),
    run_experiment: (args) => deps.runExperiment(args),
    next_experiment: (args) => deps.nextExperiment(args),
    log_experiment: (args) =>
      deps.logExperiment({
        ...args,
        metrics: deps.parseJsonOption(args.metrics, null),
        asi: deps.parseJsonOption(args.asi, null),
      }),
    read_state: (args) => deps.publicState(args),
    measure_quality_gap: (args) => deps.measureQualityGap(args),
    gap_candidates: (args) => deps.gapCandidates(args),
    finalize_preview: (args) => deps.finalizePreview(args),
    integrations: (args) => deps.integrationsCommand(args.subcommand || "list", args),
    benchmark_lint: (args) => deps.benchmarkLint(args),
    new_segment: (args) => deps.newSegment(args),
    export_dashboard: (args) => deps.exportDashboard(args),
    serve_dashboard: (args) => deps.serveDashboard(args),
    doctor_session: (args) => (args.hooks ? deps.doctorHooks(args) : deps.doctorSession(args)),
    clear_session: (args) => deps.clearSession(args),
  });
}

function ensureToolHandlerCoverage(handlers) {
  const missing = toolNames.filter((name) => !handlers[name]);
  if (missing.length) throw new Error(`MCP tool handlers missing: ${missing.join(", ")}`);
  return handlers;
}
