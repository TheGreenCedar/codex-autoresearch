import type { UnknownRecord } from "../types/json.js";
import path from "node:path";
import { readoutFallbackCommand } from "../action-metadata.js";
import { boolOption, positiveIntegerOption } from "../cli/args.js";
import { resolveAuthorizedWorkDir } from "../cli/workdir-context.js";
import { quoteShellArg } from "../command-rendering.js";
import { writeContextCapsule } from "../context-capsule.js";
import { isPathInside } from "../path-containment.js";
import { resolvePackageRoot } from "../runtime-paths.js";
import { parseSessionForensics } from "../session-forensics.js";
import type { SessionDecisionCapsule } from "../session-decision-capsule.js";

const PLUGIN_ROOT = resolvePackageRoot(import.meta.url);

export async function sessionForensics(args: UnknownRecord): Promise<UnknownRecord> {
  const { workDir } = resolveAuthorizedWorkDir(args.working_dir || args.cwd);
  const apply = boolOption(args.apply, false);
  const dryRun = boolOption(args.dryRun, !apply);
  const sessionJsonl = String(args.sessionJsonl || "");
  const resolvedSessionJsonl = path.resolve(workDir, sessionJsonl);
  const sessionPathInsideWorkDir = isPathInside(workDir, resolvedSessionJsonl);
  const allowOutsideWorkdir = boolOption(
    args.allow_outside_workdir ?? args.allowOutsideWorkdir,
    false,
  );
  if (!sessionPathInsideWorkDir && !allowOutsideWorkdir) {
    throw new Error(
      "session-forensics refuses to read session JSONL outside --cwd without --allow-outside-workdir.",
    );
  }
  const displaySessionJsonl = displayPathForWorkDir(workDir, resolvedSessionJsonl);
  const researchSlug = String(args.researchSlug || "");
  const jsonFull = boolOption(args.json_full ?? args.jsonFull ?? args.full ?? args.verbose, false);
  const parsed = await parseSessionForensics({
    sessionJsonl: resolvedSessionJsonl,
    allowSnippets: boolOption(args.allowSnippets, false),
    maxSnippets: positiveIntegerOption(args.maxSnippets, 8, "--max-snippets") ?? 8,
    maxSnippetChars: positiveIntegerOption(args.maxSnippetChars, 320, "--max-snippet-chars") ?? 320,
  });
  if (!parsed.ok) {
    return {
      ...parsed,
      path: displaySessionJsonl,
      wrote: false,
    };
  }
  const publicParsed = {
    ...parsed,
    sourcePath: displaySessionJsonl,
  };
  const contextSignal = publicParsed.productSignals.find(
    (signal) => signal.kind === "context_distillation_required",
  );
  const decisionCapsule = publicParsed.decisionCapsule;
  const commands = sessionForensicsCommands({
    workDir,
    researchSlug,
    resolvedSessionJsonl,
    displaySessionJsonl,
    sessionPathInsideWorkDir,
  });
  const canonicalNextAction =
    decisionCapsule?.enforcement?.canRunNextPacket === false
      ? {
          kind: "decision-capsule",
          priority: decisionCapsule.enforcement.mode === "hard-block" ? 4 : 6,
          reason: decisionCapsule.nextExperiment || decisionCapsule.bottleneck,
          command: commandForDecisionCapsule(decisionCapsule, commands),
          triggeredBy: decisionCapsule.enforcement.triggeredBy || ["sessionForensics"],
        }
      : contextSignal
        ? {
            kind: "context-distillation",
            priority: 6,
            reason: contextSignal.message,
            command: commands.applyForensics,
            triggeredBy: ["sessionForensics"],
          }
        : {
            kind: "next-packet",
            priority: 10,
            reason:
              "Review imported signals, then continue with the safest next Autoresearch action.",
            command: "",
            triggeredBy: ["sessionForensics"],
          };
  const decisionCapsuleCommandHint =
    canonicalNextAction.command ||
    (decisionCapsule ? commandForDecisionCapsule(decisionCapsule, commands) : "");
  const responseDecisionCapsule = renderDecisionCapsuleCommandHint(
    decisionCapsule,
    decisionCapsuleCommandHint,
  );
  const responseSummary = {
    ...publicParsed,
    decisionCapsule: responseDecisionCapsule,
  };
  const capsule = await writeContextCapsule({
    cwd: workDir,
    researchSlug,
    summary: responseSummary,
    apply: apply && !dryRun,
  });
  const signalPayload = jsonFull
    ? {
        commandClasses: publicParsed.commandClasses,
        userCorrections: publicParsed.userCorrections,
        productSignals: publicParsed.productSignals,
        workflowWaste: publicParsed.workflowWaste,
        blockers: publicParsed.blockers,
      }
    : {
        commandClassCount: Object.keys(publicParsed.commandClasses || {}).length,
        topCommandHeads: responseDecisionCapsule?.generatedFrom?.topCommandHeads || [],
        userCorrections: compactSignals(publicParsed.userCorrections),
        productSignals: compactSignals(publicParsed.productSignals),
        workflowWaste: compactSignals(publicParsed.workflowWaste),
        blockers: compactSignals(publicParsed.blockers),
      };
  return {
    ok: true,
    workDir,
    compact: !jsonFull,
    dryRun: capsule.dryRun,
    wrote: !capsule.dryRun,
    outputDir: capsule.outputDir,
    plannedFiles: capsule.files,
    sourcePath: publicParsed.sourcePath,
    timeWindow: publicParsed.timeWindow,
    counts: publicParsed.counts,
    responseCounts: publicParsed.responseCounts,
    toolCounts: publicParsed.toolCounts,
    compactions: publicParsed.compactions,
    goal: publicParsed.goal,
    ...signalPayload,
    decisionCapsule: responseDecisionCapsule,
    snippets: publicParsed.snippets,
    evidenceClaims: capsule.evidenceIndex?.claims.length ?? null,
    nextAction: canonicalNextAction.reason,
    canonicalNextAction,
  };
}

function sessionForensicsCommands({
  workDir,
  researchSlug,
  resolvedSessionJsonl,
  displaySessionJsonl,
  sessionPathInsideWorkDir,
}: {
  workDir: string;
  researchSlug: string;
  resolvedSessionJsonl: string;
  displaySessionJsonl: string;
  sessionPathInsideWorkDir: boolean;
}): Record<string, string> {
  const script = quoteShellArg(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"));
  const cwd = quoteShellArg(workDir);
  const sessionJsonlForCommand = sessionPathInsideWorkDir
    ? displaySessionJsonl
    : resolvedSessionJsonl;
  return {
    state: `node ${script} state --cwd ${cwd} --compact`,
    recommendNext: `node ${script} recommend-next --cwd ${cwd} --compact`,
    benchmarkLint: `node ${script} benchmark-lint --cwd ${cwd}`,
    applyForensics: `node ${script} session-forensics --cwd ${cwd} --session-jsonl ${quoteShellArg(sessionJsonlForCommand)} --research-slug ${quoteShellArg(researchSlug)} --apply${sessionPathInsideWorkDir ? "" : " --allow-outside-workdir"}`,
  };
}

function renderDecisionCapsuleCommandHint(
  decisionCapsule: SessionDecisionCapsule,
  commandHint: string,
): SessionDecisionCapsule {
  return {
    ...decisionCapsule,
    enforcement: {
      ...decisionCapsule.enforcement,
      commandHint: commandHint || "",
    },
  };
}

export function commandForDecisionCapsule(
  decisionCapsule: SessionDecisionCapsule | UnknownRecord,
  commands: Record<string, string>,
): string {
  const capsule = decisionCapsule as unknown as UnknownRecord;
  const enforcement = capsule.enforcement as UnknownRecord | undefined;
  const triggeredBy: string[] = Array.isArray(enforcement?.triggeredBy)
    ? enforcement.triggeredBy.map((value: unknown) => String(value))
    : [];
  if (triggeredBy.some((value) => /contextDistillation/i.test(value))) {
    return commands.applyForensics || commands.state;
  }
  const rendered = renderCapsuleCommandHint(enforcement?.commandHint, commands.state);
  const safeRendered = readoutFallbackCommand(rendered);
  if (safeRendered) return safeRendered;
  if (triggeredBy.some((value) => /benchmarkContract/i.test(value))) return commands.benchmarkLint;
  if (triggeredBy.some((value) => /benchmarkOverfit|product|goal|metric/i.test(value))) {
    return commands.state;
  }
  if (enforcement?.mode === "bounded-next") return commands.state;
  return commands.recommendNext || commands.state;
}

function renderCapsuleCommandHint(commandHint: unknown, stateCommand: string): string {
  const text = String(commandHint || "").trim();
  if (!text) return "";
  if (/^node\s+(?:\.\/)?(?:dist\/)?scripts[\\/]autoresearch\.mjs\b/i.test(text)) {
    const statePrefix = stateCommand.replace(/\s+state\s+--cwd\s+.+?(?:\s+--compact)?$/i, "");
    const cwdValue = stateCommand.match(/\s--cwd\s+(.+?)(?:\s+--compact)?$/i)?.[1];
    if (!cwdValue) return "";
    const rendered = text
      .replace(/^node\s+(?:\.\/)?(?:dist\/)?scripts[\\/]autoresearch\.mjs\b/i, statePrefix)
      .replace(/--cwd\s+<project>/gi, `--cwd ${cwdValue}`);
    return /<[^>]+>/.test(rendered) ? "" : rendered;
  }
  return /<[^>]+>/.test(text) ? "" : text;
}

function compactSignals(signals: unknown, limit = 12): UnknownRecord[] {
  if (!Array.isArray(signals)) return [];
  const byKind = new Map<string, UnknownRecord>();
  for (const raw of signals) {
    const signal = raw && typeof raw === "object" ? (raw as UnknownRecord) : {};
    const kind = String(signal.kind || "unknown");
    const existing = byKind.get(kind);
    if (existing) {
      existing.count = Number(existing.count || 1) + 1;
      continue;
    }
    byKind.set(kind, {
      kind,
      severity: signal.severity || "info",
      message: signal.message || "",
      source: signal.source || "",
      count: 1,
    });
  }
  return [...byKind.values()].slice(0, limit);
}

function displayPathForWorkDir(workDir: string, target: string): string {
  const relative = path.relative(path.resolve(workDir), path.resolve(target)).replace(/\\/g, "/");
  if (relative === "") return ".";
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
  return `<outside-workdir>/${path.basename(target)}`;
}
