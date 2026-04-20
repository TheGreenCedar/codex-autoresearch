---
name: autoresearch-create
description: Set up, resume, and run autonomous autoresearch optimization loops in Codex. Use when the user asks to start autoresearch, optimize something in a loop, repeatedly benchmark changes, run experiments, or continue an existing autoresearch.md/autoresearch.jsonl session.
---

# Autoresearch Create

Use this skill to run a measured optimization loop:

1. Create a durable session document.
2. Create a benchmark script that prints `METRIC name=value` lines.
3. Record every run in `autoresearch.jsonl`.
4. Keep measured wins and discard regressions.
5. Update the session document so a fresh Codex run can continue.

## Required Files

- `autoresearch.md`: objective, metrics, scope, constraints, and what has been tried.
- `autoresearch.sh` or `autoresearch.ps1`: benchmark entrypoint.
- `autoresearch.checks.sh` or `autoresearch.checks.ps1`: optional correctness checks.
- `autoresearch.jsonl`: append-only run log.
- `autoresearch.ideas.md`: optional backlog for promising ideas not tried yet.

Starter templates live in the plugin `assets/` directory:

- `autoresearch.md.template`
- `autoresearch.sh.template`
- `autoresearch.ps1.template`
- `autoresearch.checks.sh.template`
- `autoresearch.checks.ps1.template`

## Setup Workflow

1. Infer or ask for only the missing essentials: goal, benchmark command, primary metric, direction, files in scope, and correctness constraints.
2. Require a clean git worktree before the first experiment. If the repo is not under git, still run the loop but say commits/reverts will be unavailable.
3. Create a branch named `autoresearch/<short-goal>-<date>`.
4. Read the files in scope before editing. Understand the workload before trying changes.
5. Create the session with MCP `setup_session` when available:

```json
{
  "working_dir": "/absolute/project/path",
  "name": "short session name",
  "goal": "what is being optimized",
  "metric_name": "seconds",
  "metric_unit": "s",
  "direction": "lower",
  "benchmark_command": "command that prints or can be wrapped into METRIC output",
  "checks_command": "optional correctness command",
  "commit_paths": ["src", "tests"],
  "max_iterations": 50
}
```

If MCP tools are not loaded, use the CLI from the plugin root:

```bash
node scripts/autoresearch.mjs setup --cwd /absolute/project/path --name "short session name" --goal "what is being optimized" --metric-name seconds --metric-unit s --direction lower --benchmark-command "benchmark command" --checks-command "optional correctness command" --commit-paths "src,tests" --max-iterations 50
```

6. Review generated files and tighten `autoresearch.md`, the benchmark script, and checks before the first run. The benchmark must print the primary metric as `METRIC <name>=<number>`.
7. Run `node scripts/autoresearch.mjs doctor --cwd /absolute/project/path --check-benchmark` or MCP `doctor_session` to catch missing metric output before the loop starts.
8. Run the baseline immediately.

## Broad Research Loops

For broad or qualitative work, use `autoresearch-deep-research` instead of hand-rolling a rubric in this skill. It creates `autoresearch.research/<slug>/`, initializes a `quality_gap` session, and turns source-backed findings into checklist gaps that `/autoresearch next` can measure and close.

When improving this plugin itself, use the repo-local plugin script before a globally installed or marketplace-cache copy:

```bash
node plugins/codex-autoresearch/scripts/autoresearch.mjs research-setup --cwd . --slug plugin-research --goal "Improve the autoresearch plugin with source-backed gaps"
```

## Loop Workflow

Use MCP `next_experiment` when available because it returns preflight, benchmark, allowed log decisions, and a next-run notes template in one packet. If passing a custom shell command through MCP, include `allow_unsafe_command: true`; otherwise prefer the configured autoresearch script. If MCP is not available, run:

```bash
node scripts/autoresearch.mjs next --cwd /absolute/project/path
```

Then log the result every time with MCP `log_experiment` or:

```bash
node scripts/autoresearch.mjs log --cwd /absolute/project/path --metric 12.3 --status keep --description "Short description" --metrics "{}" --asi "{\"hypothesis\":\"what changed\"}"
```

Rules:

- Primary metric decides keep/discard. Lower or higher depends on the active session config.
- Keep improvements, especially simple improvements.
- Use scoped `commit_paths` for kept commits when a narrow experiment surface is known; otherwise inspect staged files carefully before trusting broad staging.
- Use scoped `commit_paths` or `revert_paths` for discard/crash/checks-failed cleanup. Do not use broad dirty-tree cleanup unless the user explicitly accepts it.
- Discard worse or equal results.
- Log benchmark failures as `crash`.
- Log failed correctness checks as `checks_failed`.
- Always include next-run notes as ASI. At minimum use `hypothesis`; for discard/crash also include `rollback_reason` and `next_action_hint`.
- Update `autoresearch.md` after meaningful results so future agents do not repeat stale ideas.
- Append deferred ideas to `autoresearch.ideas.md`.
- Stop when `read_state` or `run_experiment` reports `limit.limitReached`.

## Benchmark Script Guidance

For fast noisy workloads, run the workload multiple times inside the script and report the median. For slow workloads, one run is acceptable.

Good output:

```text
METRIC seconds=12.304
METRIC failures=0
```

Keep success output compact. The helper returns only a tail of output to preserve context.

## Resume

If `autoresearch.md` and `autoresearch.jsonl` already exist:

1. Read both files.
2. Run `node scripts/autoresearch.mjs state --cwd /absolute/project/path` or MCP `read_state`.
3. Continue from the latest kept baseline and avoid repeated dead ends.

Do not ask whether to continue after every run. Continue until the user interrupts, the max iteration limit is reached, or the task is genuinely exhausted.
