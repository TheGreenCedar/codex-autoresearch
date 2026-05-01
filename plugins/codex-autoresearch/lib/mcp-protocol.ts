type LooseObject = Record<string, any>;
type McpResourceList = { resources: LooseObject[] };

export const MCP_PROTOCOL_METHODS = [
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "prompts/list",
  "prompts/get",
];

const RESOURCE_DEFINITIONS = [
  {
    uri: "autoresearch://state",
    name: "Autoresearch state",
    description: "Read-only compact session state for a target working directory.",
    mimeType: "application/json",
  },
  {
    uri: "autoresearch://last-run",
    name: "Autoresearch last run",
    description: "Read-only last-run decision packet summary from guided setup state.",
    mimeType: "application/json",
  },
  {
    uri: "autoresearch://quality-gaps",
    name: "Autoresearch quality gaps",
    description:
      "Read-only quality-gap checklist summary for the active or requested research slug.",
    mimeType: "application/json",
  },
  {
    uri: "autoresearch://dashboard-summary",
    name: "Autoresearch dashboard summary",
    description:
      "Read-only dashboard-style operator summary without exporting or starting a server.",
    mimeType: "application/json",
  },
];

const RESOURCE_TEMPLATES = [
  {
    uriTemplate: "autoresearch://state{?working_dir}",
    name: "Autoresearch state",
    description: "Read-only compact session state for a target working directory.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "autoresearch://last-run{?working_dir}",
    name: "Autoresearch last run",
    description: "Read-only last-run decision packet summary from guided setup state.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "autoresearch://quality-gaps{?working_dir,research_slug}",
    name: "Autoresearch quality gaps",
    description:
      "Read-only quality-gap checklist summary for the active or requested research slug.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "autoresearch://dashboard-summary{?working_dir}",
    name: "Autoresearch dashboard summary",
    description:
      "Read-only dashboard-style operator summary without exporting or starting a server.",
    mimeType: "application/json",
  },
];

const PROMPT_DEFINITIONS = [
  {
    name: "continue-loop",
    description: "Continue an existing Autoresearch loop from current state and last-run evidence.",
    arguments: [{ name: "working_dir", description: "Target project directory.", required: true }],
  },
  {
    name: "review-last-packet",
    description: "Review the last packet before logging keep, discard, crash, or checks_failed.",
    arguments: [{ name: "working_dir", description: "Target project directory.", required: true }],
  },
  {
    name: "first-valid-loop",
    description: "Run the first valid loop path with guided setup and an explicit live dashboard.",
    arguments: [{ name: "working_dir", description: "Target project directory.", required: true }],
  },
];

export function listMcpResources(): McpResourceList {
  return { resources: [] };
}

export function listMcpResourceTemplates() {
  return { resourceTemplates: RESOURCE_TEMPLATES.map((resource) => ({ ...resource })) };
}

export function listMcpPrompts() {
  return { prompts: PROMPT_DEFINITIONS.map((prompt) => ({ ...prompt })) };
}

export async function readMcpResource(
  uri: string,
  callTool: (name: string, args: LooseObject) => Promise<LooseObject>,
) {
  const request = parseAutoresearchResourceUri(uri);
  const baseArgs = {
    working_dir: request.workingDir,
    ...(request.researchSlug ? { research_slug: request.researchSlug } : {}),
  };
  const stateArgs = { working_dir: request.workingDir, compact: true };

  if (request.kind === "state") {
    return resourceResponse(uri, await callTool("read_state", stateArgs));
  }

  if (request.kind === "last-run") {
    const guide = await callTool("guided_setup", { working_dir: request.workingDir });
    return resourceResponse(uri, {
      ok: guide.ok !== false,
      workDir: guide.workDir,
      stage: guide.stage,
      nextAction: guide.nextAction,
      lastRun: guide.lastRun ?? null,
    });
  }

  if (request.kind === "quality-gaps") {
    return resourceResponse(uri, await callTool("measure_quality_gap", baseArgs));
  }

  if (request.kind === "dashboard-summary") {
    const [state, guide] = await Promise.all([
      callTool("read_state", stateArgs),
      callTool("guided_setup", { working_dir: request.workingDir }),
    ]);
    return resourceResponse(uri, {
      ok: state.ok !== false && guide.ok !== false,
      workDir: request.workingDir,
      stage: guide.stage,
      nextAction: guide.nextAction,
      dashboardCommand: guide.commands?.dashboard || "",
      runs: state.runs,
      best: state.best,
      warnings: [...(state.warnings || []), ...(guide.doctor?.warnings || [])],
      memory: state.memory || null,
      scaffoldHealth: state.scaffoldHealth || guide.scaffoldHealth || null,
      researchIntegrity: state.researchIntegrity || guide.researchIntegrity || null,
    });
  }

  throw new Error(`Unknown autoresearch resource: ${request.kind}`);
}

export function getMcpPrompt(name: string, args: LooseObject = {}) {
  const definition = PROMPT_DEFINITIONS.find((prompt) => prompt.name === name);
  if (!definition) throw new Error(`Unknown prompt: ${name}`);
  const workingDir = stringArg(args.working_dir ?? args.workingDir ?? args.cwd);
  if (!workingDir) throw new Error(`${name} requires working_dir.`);
  const stateUri = resourceUri("state", workingDir);
  const lastRunUri = resourceUri("last-run", workingDir);
  const dashboardUri = resourceUri("dashboard-summary", workingDir);
  const qualityGapsUri = resourceUri("quality-gaps", workingDir);
  const text = promptText(name, { workingDir, stateUri, lastRunUri, dashboardUri, qualityGapsUri });
  return {
    description: definition.description,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text,
        },
      },
    ],
  };
}

function promptText(name: string, context: LooseObject) {
  if (name === "continue-loop") {
    return [
      "Continue the Codex Autoresearch loop without relying on stale chat memory.",
      `Target: ${context.workingDir}`,
      `Read current state from ${context.stateUri}.`,
      `Read last-run evidence from ${context.lastRunUri}.`,
      "Then use recommend_next, guided_setup, next_experiment, and log_experiment as appropriate.",
      "Do not run another packet until any fresh last-run packet is logged or intentionally replaced.",
    ].join("\n");
  }
  if (name === "review-last-packet") {
    return [
      "Review the latest Autoresearch packet before making a log decision.",
      `Target: ${context.workingDir}`,
      `Read ${context.lastRunUri} and ${context.dashboardUri}.`,
      "Decide only among keep, discard, crash, or checks_failed, and preserve ASI evidence.",
      "If the packet is stale, replace it with guided_setup guidance instead of logging it.",
    ].join("\n");
  }
  return [
    "Run the first valid Codex Autoresearch loop path.",
    `Target: ${context.workingDir}`,
    `Read ${context.stateUri}, ${context.dashboardUri}, and ${context.qualityGapsUri} when relevant.`,
    "Call guided_setup with start_dashboard=true so the operator receives a verified live dashboard URL.",
    "Then complete setup/checks/doctor, run the baseline packet, log the result, and continue or finalize.",
  ].join("\n");
}

function parseAutoresearchResourceUri(uri: string) {
  if (!uri) throw new Error("resources/read requires uri.");
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`Invalid resource URI: ${uri}`);
  }
  if (parsed.protocol !== "autoresearch:") {
    throw new Error(`Unsupported resource URI scheme: ${parsed.protocol}`);
  }
  const kind = parsed.hostname || parsed.pathname.replace(/^\/+/, "");
  const known = RESOURCE_DEFINITIONS.some((resource) => resource.uri === `autoresearch://${kind}`);
  if (!known) throw new Error(`Unknown autoresearch resource: ${kind}`);
  const workingDir = stringArg(
    parsed.searchParams.get("working_dir") ||
      parsed.searchParams.get("workingDir") ||
      parsed.searchParams.get("cwd"),
  );
  if (!workingDir) throw new Error(`${uri} requires working_dir query parameter.`);
  return {
    kind,
    workingDir,
    researchSlug: stringArg(
      parsed.searchParams.get("research_slug") || parsed.searchParams.get("researchSlug"),
    ),
  };
}

function resourceResponse(uri: string, body: LooseObject) {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(body, null, 2),
      },
    ],
  };
}

function resourceUri(kind: string, workingDir: string) {
  return `autoresearch://${kind}?working_dir=${encodeURIComponent(workingDir)}`;
}

function stringArg(value: unknown) {
  return value == null ? "" : String(value).trim();
}
