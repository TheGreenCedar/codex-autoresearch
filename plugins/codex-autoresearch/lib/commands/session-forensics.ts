import path from "node:path";
import { writeContextCapsule } from "../context-capsule.js";
import { parseSessionForensics } from "../session-forensics.js";

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
    const capsule = await writeContextCapsule({
      cwd: workDir,
      researchSlug,
      summary: publicParsed,
      apply: apply && !dryRun,
    });
    const contextSignal = publicParsed.productSignals.find(
      (signal: any) => signal.kind === "context_distillation_required",
    );
    const decisionCapsule = publicParsed.decisionCapsule;
    const canonicalNextAction =
      decisionCapsule?.enforcement?.canRunNextPacket === false
        ? {
            kind: "decision-capsule",
            priority: decisionCapsule.enforcement.mode === "hard-block" ? 4 : 6,
            reason: decisionCapsule.nextExperiment || decisionCapsule.bottleneck,
            command: decisionCapsule.enforcement.commandHint || "",
            triggeredBy: decisionCapsule.enforcement.triggeredBy || ["sessionForensics"],
          }
        : contextSignal
          ? {
              kind: "context-distillation",
              priority: 6,
              reason: contextSignal.message,
              command: `node ${deps.shellQuote(path.join(deps.pluginRoot, "scripts", "autoresearch.mjs"))} session-forensics --cwd ${deps.shellQuote(workDir)} --session-jsonl ${deps.shellQuote(displaySessionJsonl)} --research-slug ${deps.shellQuote(researchSlug)} --apply${sessionPathInsideWorkDir ? "" : " --allow-outside-workdir"}`,
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
    return {
      ok: true,
      workDir,
      dryRun: capsule.dryRun,
      wrote: !capsule.dryRun,
      outputDir: capsule.outputDir,
      plannedFiles: capsule.files,
      sourcePath: publicParsed.sourcePath,
      timeWindow: publicParsed.timeWindow,
      counts: publicParsed.counts,
      responseCounts: publicParsed.responseCounts,
      toolCounts: publicParsed.toolCounts,
      commandClasses: publicParsed.commandClasses,
      compactions: publicParsed.compactions,
      goal: publicParsed.goal,
      userCorrections: publicParsed.userCorrections,
      productSignals: publicParsed.productSignals,
      workflowWaste: publicParsed.workflowWaste,
      blockers: publicParsed.blockers,
      decisionCapsule: publicParsed.decisionCapsule,
      snippets: publicParsed.snippets,
      evidenceClaims: capsule.evidenceIndex?.claims.length ?? null,
      nextAction: canonicalNextAction.reason,
      canonicalNextAction,
    };
  };
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
