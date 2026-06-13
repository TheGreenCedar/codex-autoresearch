import path from "node:path";
import { readoutFallbackCommand } from "../action-metadata.js";
import { writeContextCapsule } from "../context-capsule.js";
import { parseSessionForensics } from "../session-forensics.js";
import type { SessionDecisionCapsule } from "../session-decision-capsule.js";

type LooseObject = Record<string, any>;

export interface SessionForensicsCommandDeps {
  boolOption: (value: unknown, fallback?: boolean) => boolean;
  pluginRoot: string;
  positiveIntegerOption: (
    value: unknown,
    fallback: number | null,
    optionName: string,
  ) => number | null;
  resolveWorkDir: (value: string) => { workDir: string };
  shellQuote: (value: string) => string;
}

export function createSessionForensicsCommand(deps: SessionForensicsCommandDeps) {
  return async function sessionForensics(args: LooseObject): Promise<LooseObject> {
    const { workDir } = deps.resolveWorkDir(args.working_dir || args.cwd);
    const apply = deps.boolOption(args.apply, false);
    const dryRun = deps.boolOption(args.dryRun, !apply);
    const sessionJsonl = String(args.sessionJsonl || "");
    const resolvedSessionJsonl = path.resolve(workDir, sessionJsonl);
    const sessionPathInsideWorkDir = isPathInside(workDir, resolvedSessionJsonl);
    const allowOutsideWorkdir = deps.boolOption(
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
    const jsonFull = deps.boolOption(
      args.json_full ?? args.jsonFull ?? args.full ?? args.verbose,
      false,
    );
    const parsed = await parseSessionForensics({
      sessionJsonl: resolvedSessionJsonl,
      allowSnippets: deps.boolOption(args.allowSnippets, false),
      maxSnippets: deps.positiveIntegerOption(args.maxSnippets, 8, "--max-snippets") ?? 8,
      maxSnippetChars:
        deps.positiveIntegerOption(args.maxSnippetChars, 320, "--max-snippet-chars") ?? 320,
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
      (signal: any) => signal.kind === "context_distillation_required",
    );
    const decisionCapsule = publicParsed.decisionCapsule;
    const commands = sessionForensicsCommands({
      deps,
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
  };
}

function sessionForensicsCommands({
  deps,
  workDir,
  researchSlug,
  resolvedSessionJsonl,
  displaySessionJsonl,
  sessionPathInsideWorkDir,
}: {
  deps: SessionForensicsCommandDeps;
  workDir: string;
  researchSlug: string;
  resolvedSessionJsonl: string;
  displaySessionJsonl: string;
  sessionPathInsideWorkDir: boolean;
}): Record<string, string> {
  const script = deps.shellQuote(path.join(deps.pluginRoot, "scripts", "autoresearch.mjs"));
  const cwd = deps.shellQuote(workDir);
  const sessionJsonlForCommand = sessionPathInsideWorkDir
    ? displaySessionJsonl
    : resolvedSessionJsonl;
  return {
    state: `node ${script} state --cwd ${cwd} --compact`,
    recommendNext: `node ${script} recommend-next --cwd ${cwd} --compact`,
    benchmarkLint: `node ${script} benchmark-lint --cwd ${cwd}`,
    applyForensics: `node ${script} session-forensics --cwd ${cwd} --session-jsonl ${deps.shellQuote(sessionJsonlForCommand)} --research-slug ${deps.shellQuote(researchSlug)} --apply${sessionPathInsideWorkDir ? "" : " --allow-outside-workdir"}`,
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
  decisionCapsule: LooseObject,
  commands: Record<string, string>,
): string {
  const triggeredBy: string[] = Array.isArray(decisionCapsule?.enforcement?.triggeredBy)
    ? decisionCapsule.enforcement.triggeredBy.map((value: unknown) => String(value))
    : [];
  if (triggeredBy.some((value) => /contextDistillation/i.test(value))) {
    return commands.applyForensics || commands.state;
  }
  const rendered = renderCapsuleCommandHint(
    decisionCapsule?.enforcement?.commandHint,
    commands.state,
  );
  const safeRendered = readoutFallbackCommand(rendered);
  if (safeRendered) return safeRendered;
  if (triggeredBy.some((value) => /benchmarkContract/i.test(value))) return commands.benchmarkLint;
  if (triggeredBy.some((value) => /benchmarkOverfit|product|goal|metric/i.test(value))) {
    return commands.state;
  }
  if (decisionCapsule?.enforcement?.mode === "bounded-next") return commands.state;
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

function compactSignals(signals: unknown, limit = 12): LooseObject[] {
  if (!Array.isArray(signals)) return [];
  const byKind = new Map<string, LooseObject>();
  for (const raw of signals) {
    const signal = raw && typeof raw === "object" ? (raw as LooseObject) : {};
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

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function displayPathForWorkDir(workDir: string, target: string): string {
  const relative = path.relative(path.resolve(workDir), path.resolve(target)).replace(/\\/g, "/");
  if (relative === "") return ".";
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
  return `<outside-workdir>/${path.basename(target)}`;
}
