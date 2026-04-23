import { mcpToolSchemas, normalizeToolArguments, requireUnsafeCommandGate, validateToolArguments } from "./mcp-tool-schemas.mjs";

export { mcpToolSchemas, normalizeToolArguments, requireUnsafeCommandGate, toolSchemas, validateToolArguments } from "./mcp-tool-schemas.mjs";

export function createMcpInterface(deps) {
  const callTool = async (name, args) => {
    const normalizedArgs = validateToolArguments(name, args);
    requireUnsafeCommandGate(name, normalizedArgs, deps.boolOption);
    args = normalizedArgs;
    if (name === "setup_plan") return await deps.setupPlan(args);
    if (name === "guided_setup") return await deps.guidedSetup(args);
    if (name === "list_recipes") return await deps.recipeCommand("list", args);
    if (name === "setup_session") return await deps.setupSession(args);
    if (name === "setup_research_session") return await deps.setupResearchSession(args);
    if (name === "configure_session") return await deps.configureSession(args);
    if (name === "init_experiment") return await deps.initExperiment(args);
    if (name === "run_experiment") {
      return await deps.runExperiment(args);
    }
    if (name === "next_experiment") {
      return await deps.nextExperiment(args);
    }
    if (name === "log_experiment") return await deps.logExperiment({
      ...args,
      metrics: deps.parseJsonOption(args.metrics, null),
      asi: deps.parseJsonOption(args.asi, null),
    });
    if (name === "export_dashboard") return await deps.exportDashboard(args);
    if (name === "serve_dashboard") return await deps.serveDashboard(args);
    if (name === "clear_session") return await deps.clearSession(args);
    if (name === "read_state") return await deps.publicState(args);
    if (name === "measure_quality_gap") return await deps.measureQualityGap(args);
    if (name === "gap_candidates") {
      return await deps.gapCandidates(args);
    }
    if (name === "finalize_preview") return await deps.finalizePreview(args);
    if (name === "integrations") return await deps.integrationsCommand(args.subcommand || "list", args);
    if (name === "doctor_session") {
      return await deps.doctorSession(args);
    }
    throw new Error(`Unknown tool: ${name}`);
  };

  return {
    callTool,
    toolSchemas: mcpToolSchemas,
    validateToolArguments,
  };
}
