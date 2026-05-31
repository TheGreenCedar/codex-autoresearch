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
    const researchSlug = String(args.researchSlug || "");
    const parsed = await parseSessionForensics({
      sessionJsonl,
      allowSnippets: deps.boolOption(args.allowSnippets, false),
      maxSnippets: deps.positiveIntegerOption(args.maxSnippets, 8, "--max-snippets") ?? 8,
      maxSnippetChars:
        deps.positiveIntegerOption(args.maxSnippetChars, 320, "--max-snippet-chars") ?? 320,
    });
    if (!parsed.ok) {
      return {
        ...parsed,
        wrote: false,
      };
    }
    const capsule = await writeContextCapsule({
      cwd: workDir,
      researchSlug,
      summary: parsed,
      apply: apply && !dryRun,
    });
    const contextSignal = parsed.productSignals.find(
      (signal: any) => signal.kind === "context_distillation_required",
    );
    const canonicalNextAction = contextSignal
      ? {
          kind: "context-distillation",
          priority: 6,
          reason: contextSignal.message,
          command: `node ${deps.shellQuote(path.join(deps.pluginRoot, "scripts", "autoresearch.mjs"))} session-forensics --cwd ${deps.shellQuote(workDir)} --session-jsonl ${deps.shellQuote(sessionJsonl)} --research-slug ${deps.shellQuote(researchSlug)} --apply`,
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
      sourcePath: parsed.sourcePath,
      timeWindow: parsed.timeWindow,
      counts: parsed.counts,
      responseCounts: parsed.responseCounts,
      toolCounts: parsed.toolCounts,
      commandClasses: parsed.commandClasses,
      compactions: parsed.compactions,
      goal: parsed.goal,
      userCorrections: parsed.userCorrections,
      productSignals: parsed.productSignals,
      workflowWaste: parsed.workflowWaste,
      blockers: parsed.blockers,
      snippets: parsed.snippets,
      evidenceClaims: capsule.evidenceIndex?.claims.length ?? null,
      nextAction: canonicalNextAction.reason,
      canonicalNextAction,
    };
  };
}
