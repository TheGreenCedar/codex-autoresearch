export interface HelpOptions {
  all?: boolean;
}

const HAPPY_PATH = "setup -> doctor -> next -> log -> state -> finalize-preview";

const DEFAULT_USAGE_LINES = [
  "  Read-only planning:",
  "  node scripts/autoresearch.mjs setup-plan --cwd <project> [--name <name>] [--metric-name <name>] [--direction lower|higher] [--benchmark-command <cmd>]",
  "  node scripts/autoresearch.mjs prompt-plan --cwd <project> --prompt <text>",
  "  Writes session files:",
  "  node scripts/autoresearch.mjs setup --cwd <project> --name <name> --metric-name <name> [--direction lower|higher] [--benchmark-command <cmd>] [--checks-command <cmd>] [--max-iterations <n>] [--packet-budget <n>] [--wall-clock-budget-seconds <n>]",
  "  node scripts/autoresearch.mjs doctor --cwd <project> [--check-benchmark] [--allow-fixed-control-rerun] [--explain]",
  "  node scripts/autoresearch.mjs next --cwd <project> [--compact] [--timeout-seconds <n>] [--allow-fixed-control-rerun]",
  "  node scripts/autoresearch.mjs log --cwd <project> (--metric <n>|--from-last) --status keep|discard|crash|checks_failed|measure --description <text>",
  "  node scripts/autoresearch.mjs state --cwd <project> [--compact] [--report]",
  "  node scripts/autoresearch.mjs finalize-preview --cwd <project> [--trunk main] [--progress]",
];

const SETUP_GUIDANCE_FLAGS = [
  "[--recipe <id>]",
  "[--catalog <path-or-url>]",
  "[--trust-catalog]",
  "[--name <name>]",
  "[--metric-name <name>]",
  "[--direction lower|higher]",
  "[--benchmark-command <cmd>]",
  "[--checks-command <cmd>]",
  "[--commit-paths <paths>]",
  "[--protected-benchmark-paths <paths>]",
  "[--secondary-metric-constraints <rules>]",
  "[--secondary-metric-constraint-mode advisory|blocking]",
  "[--max-iterations <n>]",
  "[--packet-budget <n>]",
  "[--wall-clock-budget-seconds <n>]",
  "[--budget-note <text>]",
].join(" ");

const FULL_USAGE_LINES = [
  `  node scripts/autoresearch.mjs setup-plan --cwd <project> ${SETUP_GUIDANCE_FLAGS}`,
  "  node scripts/autoresearch.mjs prompt-plan --cwd <project> --prompt <text>",
  "  node scripts/autoresearch.mjs setup --cwd <project> --name <name> --metric-name <name> [--recipe <id>] [--catalog <path-or-url>] [--trust-catalog] [--direction lower|higher] [--benchmark-command <cmd>] [--benchmark-prints-metric true|false] [--checks-command <cmd>] [--shell bash|powershell] [--protected-benchmark-paths <paths>] [--secondary-metric-constraints <rules>] [--secondary-metric-constraint-mode advisory|blocking] [--max-iterations <n>] [--packet-budget <n>] [--wall-clock-budget-seconds <n>] [--budget-note <text>]",
  "  node scripts/autoresearch.mjs setup --cwd <project> --interactive",
  `  node scripts/autoresearch.mjs guide --cwd <project> ${SETUP_GUIDANCE_FLAGS}`,
  "  node scripts/autoresearch.mjs onboarding-packet --cwd <project> [--compact]",
  "  node scripts/autoresearch.mjs recommend-next --cwd <project> [--compact] [--operator-checklist]",
  "  node scripts/autoresearch.mjs codex-goal-brief --cwd <project> [--codex-goal-objective <text>] [--codex-goal-status active|paused|budget_limited|complete]",
  "  node scripts/autoresearch.mjs session-forensics --cwd <project> --session-jsonl <path> --research-slug <slug> [--dry-run|--apply] [--allow-snippets] [--allow-outside-workdir] [--json-full|--verbose]",
  "  node scripts/autoresearch.mjs recipes list|show|recommend [recipe-id] [--cwd <project>] [--catalog <path-or-url>]",
  "  node scripts/autoresearch.mjs init --cwd <project> --name <name> --metric-name <name> [--goal <goal>] [--metric-unit <unit>] [--direction lower|higher]",
  "  node scripts/autoresearch.mjs run --cwd <project> [--command <cmd>|--command-file <path>] [--packet-env-file <path>] [--packet-env-mode inherit|minimal] [--timeout-seconds <n>] [--allow-fixed-control-rerun]",
  "  node scripts/autoresearch.mjs next --cwd <project> [--compact] [--command <cmd>|--command-file <path>] [--packet-env-file <path>] [--packet-env-mode inherit|minimal] [--timeout-seconds <n>] [--allow-fixed-control-rerun]",
  "  node scripts/autoresearch.mjs partial-results --cwd <project> [--from-last|--artifact <path>] [--record <candidate-id>] [--research-slug <slug>]",
  "  node scripts/autoresearch.mjs config --cwd <project> [--autonomy-mode guarded|owner-autonomous|manual] [--checks-policy always|on-improvement|manual] [--extend <n>] [--commit-paths <paths>] [--packet-budget <n>] [--wall-clock-budget-seconds <n>] [--budget-note <text>] [--protected-benchmark-paths <paths>] [--secondary-metric-constraints <rules>] [--secondary-metric-constraint-mode advisory|blocking]",
  "  node scripts/autoresearch.mjs research-setup --cwd <project> --slug <slug> --goal <goal> [--checks-command <cmd>] [--max-iterations <n>] [--packet-budget <n>] [--wall-clock-budget-seconds <n>]",
  "  node scripts/autoresearch.mjs research-start --cwd <project> --slug <slug> --goal <goal> [--dry-run] [--no-baseline-log]",
  "  node scripts/autoresearch.mjs research-fanout --cwd <project> [--lanes <n>] [--dry-run|--yes]",
  "  node scripts/autoresearch.mjs lane-runner --cwd <project> [--lane-id <id>] [--mode read_only_scout|implementation|big_idea] [--command <cmd>] [--worktree <path>|--write-scope <paths>] [--allow-non-git-command] [--summary <text>] [--recommendation <text>] [--evidence <items>] [--risks <items>] [--human-approval] [--time-budget-seconds <n>] [--dry-run|--yes]",
  "  node scripts/autoresearch.mjs quality-gap --cwd <project> [--research-slug <slug>] [--list] [--json]",
  "  node scripts/autoresearch.mjs gap-candidates --cwd <project> --research-slug <slug> [--apply] [--model-command <cmd>] [--model-timeout-seconds <n>]",
  "  node scripts/autoresearch.mjs finalize-preview --cwd <project> [--trunk main] [--progress]",
  "  node scripts/autoresearch.mjs finalize-current-tree --cwd <project> [--trunk main] [--exclude-session-artifacts|--include-session-artifacts] [--progress]",
  "  node scripts/autoresearch.mjs serve --cwd <project> [--port <n>] [--debug-ledger]",
  "  node scripts/autoresearch.mjs integrations list|doctor|sync-recipes [--catalog <path-or-url>]",
  "  node scripts/autoresearch.mjs log --cwd <project> (--metric <n>|--from-last) --status keep|discard|crash|checks_failed|measure --description <text> [--metrics <json>|--metrics-file <path>] [--asi <json>|--asi-json-file <path>] [--evidence-status accepted|rejected|provisional|superseded] [--commit-paths <paths>] [--allow-add-all] [--revert-paths <paths>]",
  "  node scripts/autoresearch.mjs state --cwd <project> [--compact] [--report]",
  "  node scripts/autoresearch.mjs doctor --cwd <project> [--command <cmd>] [--check-benchmark] [--allow-fixed-control-rerun] [--explain]",
  "  node scripts/autoresearch.mjs doctor hooks",
  "  node scripts/autoresearch.mjs benchmark-inspect --cwd <project> [--command <cmd>] [--timeout-seconds <n>] [--allow-fixed-control-rerun]",
  "  node scripts/autoresearch.mjs benchmark-lint --cwd <project> [--metric-name <name>] [--sample <text>|--command <cmd>] [--allow-fixed-control-rerun]",
  "  node scripts/autoresearch.mjs checks-inspect --cwd <project> --command <cmd> [--timeout-seconds <n>]",
  "  node scripts/autoresearch.mjs new-segment --cwd <project> [--reason <text>] [--metric-name <name>] [--metric-unit <unit>] [--direction lower|higher] [--benchmark-command <cmd>] [--checks-command <cmd>] [--dry-run|--yes]",
  "  node scripts/autoresearch.mjs promote-gate --cwd <project> --reason <text> [--gate-name <name>] [--query-count <n>] [--benchmark-command <cmd>] [--checks-command <cmd>] [--dry-run|--yes]",
  "  node scripts/autoresearch.mjs export --cwd <project> [--output <html>] [--showcase] [--json-full|--verbose] [--progress]",
  "  node scripts/autoresearch.mjs clear --cwd <project> [--dry-run|--yes]",
];

const FULL_GUIDANCE_LINES = [
  "",
  "Current-tree finalization:",
  "  finalize-current-tree is for stale or incomplete commit-level kept evidence when the current branch tree is the review unit.",
  "  It writes a plan only from a clean Git-backed non-trunk source branch; session artifacts are excluded by default.",
  "  After reviewing the plan, run the finalizer with that plan file.",
];

export function renderCliHelp({ all = false }: HelpOptions = {}): string {
  const usageLines = all ? FULL_USAGE_LINES : DEFAULT_USAGE_LINES;
  const sections = [
    "Codex Autoresearch",
    "",
    `Happy path: ${HAPPY_PATH}`,
    "",
    "Usage:",
    ...usageLines,
  ];
  if (!all) {
    sections.push("", "Run `--help --all` for advanced diagnostics and maintainer commands.");
  } else {
    sections.push(...FULL_GUIDANCE_LINES);
  }
  sections.push("", "Benchmark output format:", "  METRIC name=value", "  ARTIFACT name=path", "");
  return sections.join("\n");
}
