import path from "node:path";
import { quoteShellArg } from "../command-rendering.js";
import { activeQualityGapSlugCandidatesSync } from "../research-gaps.js";
import { resolvePackageRoot } from "../runtime-paths.js";

type ContinuationCommandOptions = {
  researchSlug?: string;
  scriptPath: string;
  shellQuote: (value: string) => string;
  workDir: string;
};

export function continuationCommands(workDir: string) {
  return buildContinuationCommands({
    researchSlug: activeQualityGapSlugCandidatesSync(workDir)[0]?.slug || "research",
    scriptPath: path.join(resolvePackageRoot(import.meta.url), "scripts", "autoresearch.mjs"),
    shellQuote: (value) => quoteShellArg(value),
    workDir,
  });
}

export function buildContinuationCommands({
  researchSlug = "research",
  scriptPath,
  shellQuote,
  workDir,
}: ContinuationCommandOptions) {
  const cwd = shellQuote(workDir);
  const script = shellQuote(scriptPath);
  const slug = shellQuote(researchSlug);
  return {
    state: `node ${script} state --cwd ${cwd}`,
    stateCompact: `node ${script} state --cwd ${cwd} --compact`,
    doctor: `node ${script} doctor --cwd ${cwd}`,
    doctorExplain: `node ${script} doctor --cwd ${cwd} --explain`,
    next: `node ${script} next --cwd ${cwd} --compact`,
    nextFull: `node ${script} next --cwd ${cwd}`,
    keepLast: `node ${script} log --cwd ${cwd} --from-last --status keep --description "Describe the kept change"`,
    measureLast: `node ${script} log --cwd ${cwd} --from-last --status measure --description "Baseline measurement"`,
    discardLast: `node ${script} log --cwd ${cwd} --from-last --status discard --description "Describe the discarded change"`,
    ledgerDoctor: `node ${script} ledger-doctor --cwd ${cwd} --json`,
    processRecover: `node ${script} process-recover --cwd ${cwd}`,
    partialResults: `node ${script} partial-results --cwd ${cwd} --from-last`,
    laneRunner: `node ${script} lane-runner --cwd ${cwd} --dry-run`,
    gapCandidates: `node ${script} gap-candidates --cwd ${cwd} --research-slug ${slug}`,
    liveDashboard: `node ${script} serve --cwd ${cwd}`,
    exportDashboard: `node ${script} export --cwd ${cwd}`,
    extendLimit: `node ${script} config --cwd ${cwd} --extend 10`,
    onboardingPacket: `node ${script} onboarding-packet --cwd ${cwd} --compact`,
    recommendNext: `node ${script} recommend-next --cwd ${cwd} --compact`,
    setupPlan: `node ${script} setup-plan --cwd ${cwd}`,
    codexGoalBrief: `node ${script} codex-goal-brief --cwd ${cwd}`,
    benchmarkInspect: `node ${script} benchmark-inspect --cwd ${cwd}`,
    benchmarkLint: `node ${script} benchmark-lint --cwd ${cwd}`,
    checksInspect: `node ${script} checks-inspect --cwd ${cwd} --command "replace with exact checks command"`,
    newSegmentDryRun: `node ${script} new-segment --cwd ${cwd} --dry-run`,
    promoteGateDryRun: `node ${script} promote-gate --cwd ${cwd} --reason "describe promoted measurement" --dry-run`,
    finalizePreview: `node ${script} finalize-preview --cwd ${cwd}`,
    finalizeCurrentTree: `node ${script} finalize-current-tree --cwd ${cwd} --exclude-session-artifacts`,
  };
}
