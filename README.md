<div align="center">
<img height="120" alt="Codex Autoresearch" src="plugins/codex-autoresearch/assets/logo.svg" />

# Codex Autoresearch
### Autonomous experiment loops for Codex

**[Quick start](#quick-start)** - **[Usage](#usage)** - **[Dashboard](#dashboard)** - **[Demo](#demo)**
</div>

Try an idea, measure it, keep what works, discard what does not, and leave a trail another Codex session can resume from.

Codex Autoresearch is a plugin for running optimization loops inside a codebase. It is useful when you have a measurable target and many possible changes to try: test runtime, build speed, bundle size, model loss, Lighthouse scores, memory use, query latency, or any other metric you can print from a script.

It is adapted from [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch), which brings the same loop to the Pi terminal agent, and from the broader [karpathy/autoresearch](https://github.com/karpathy/autoresearch) idea.

## Quick Start

Install or refresh the plugin, then verify the MCP server before the first loop:

```bash
codex marketplace add TheGreenCedar/codex-autoresearch
codex mcp get codex-autoresearch
```

Marketplace installs are versioned. If Codex still shows an older version, bump or refresh the installed plugin cache before testing new tools.

Ask Codex:

```text
Start autoresearch to reduce unit test runtime.
Benchmark: npm test -- --runInBand
Metric: seconds, lower is better
Checks: npm test
Scope: test runner config and test helpers only
```

Codex will create the session files, initialize the run log, take a baseline, and start trying measured changes.

Minimum viable loop:

1. Choose one primary metric.
2. Use one benchmark command that prints `METRIC name=value`.
3. Use one correctness check when regressions are possible.
4. Run a baseline, try one change, log keep/discard with ASI, then repeat.

## Local Plugin Iteration

When improving this plugin itself, use the repo-local plugin before any globally installed or marketplace-cache copy. The canonical local routing and CLI walkthrough lives in the [`/autoresearch` command doc](plugins/codex-autoresearch/commands/autoresearch.md#local-plugin-routing).

The plugin self-check is:

```bash
node plugins/codex-autoresearch/scripts/perfection-benchmark.mjs --fail-on-gap
```

It reports `METRIC quality_gap=<n>`, where zero means the local plugin has the current guidance, prompts, tests, and session hygiene expected for Codex autoresearch work.

## Codex + GPT-5.4 Operating Profile

GPT-5.4 is useful for long, tool-heavy professional work because it has a 1.05M context window, supports reasoning effort, and supports tools such as MCP, shell, apply patch, skills, tool search, web search, and file search through the Responses API. That power is best used with narrow, durable loop state instead of one giant conversation.

For Codex + GPT-5.4, treat autoresearch as the operating rail:

- Keep the measured target explicit: `quality_gap`, runtime, cost, failures, Lighthouse score, or another primary metric.
- Use `next_experiment` or `/autoresearch next` for one preflight, benchmark, decision, and ASI packet at a time.
- Store qualitative findings in `autoresearch.md`, `autoresearch.ideas.md`, and ASI instead of relying on context memory.
- Use `autoresearch-deep-research` for broad project-study prompts, then convert recommendations into a qualitative gap benchmark or a small set of measurable acceptance checks.
- Stop only when the benchmark reaches `quality_gap=0`, checks pass, and the latest synthesis has no remaining high-impact product gaps.

## Deep Research Autoresearch

Research-heavy prompts can still be measured. For example:

```text
Study my project and write a paragraph describing the essence of what it strives to do.
Then create a deep-research autoresearch loop and suggest high impact changes that would make the project delightful.
You may also suggest small qol changes or bug fixes in separate sections.
```

Start the loop with:

```bash
node plugins/codex-autoresearch/scripts/autoresearch.mjs research-setup --cwd /path/to/project --slug project-study --goal "Study the project and turn high-impact recommendations into measurable gaps"
node plugins/codex-autoresearch/scripts/autoresearch.mjs quality-gap --cwd /path/to/project --research-slug project-study
```

This creates `autoresearch.research/<slug>/` with `brief.md`, `plan.md`, `tasks.md`, `sources.md`, `synthesis.md`, `quality-gaps.md`, `notes/`, and `deliverables/`. Use `sources.md` as the source ledger with dates, claims, and confidence. Keep `synthesis.md` as the live merged answer, then turn each actionable recommendation into a checklist item in `quality-gaps.md`.

The generic benchmark counts unchecked items:

```text
METRIC quality_gap=<open>
METRIC quality_total=<all checklist items>
METRIC quality_closed=<checked items>
```

Stop when `quality_gap=0`, checks pass, and high-impact findings are implemented or explicitly rejected with evidence. Small QoL fixes should stay separate from the high-impact gap list unless they are part of the agreed goal.

For direct CLI use, follow the canonical [`/autoresearch` command walkthrough](plugins/codex-autoresearch/commands/autoresearch.md#local-plugin-routing). The essential sequence is setup, doctor, next, log with `--from-last`, and export.

Tiny worked story:

```text
setup   Create autoresearch.md for "reduce unit test runtime"; metric seconds, direction lower.
doctor  Confirm the benchmark emits METRIC seconds=<number> and the worktree is ready.
next    Run preflight + benchmark and return allowed log decisions plus a next-run notes template.
log     Record baseline with status keep.
next    Try reusing a test database fixture; benchmark prints METRIC seconds=13.7; checks pass.
log     Record status keep with ASI: {"hypothesis":"fixture reuse removes setup cost","next_action_hint":"measure worker count next"}.
export  Generate autoresearch-dashboard.html for the run history.
finalize Split the kept fixture change into a review branch when the noisy loop is done.
```

## What Is Included

| Part | What it does |
| --- | --- |
| MCP tools | `setup_session`, `setup_research_session`, `configure_session`, `init_experiment`, `run_experiment`, `next_experiment`, `log_experiment`, `read_state`, `measure_quality_gap`, `doctor_session`, `export_dashboard`, `clear_session` |
| Skills | Create/resume loops, turn deep research into quality gaps, export dashboards, finalize noisy branches |
| Commands | `/autoresearch` and `/autoresearch-finalize` workflow docs |
| Dashboard | HTML operator cockpit generated from `autoresearch.jsonl`, with embedded snapshot data, live refresh, and copyable commands |
| Templates | Starter `autoresearch.md`, shell/PowerShell benchmark scripts, and checks scripts |

## MCP Tools

| Tool | Description |
| --- | --- |
| `setup_session` | Creates `autoresearch.md`, benchmark/check scripts, `autoresearch.ideas.md`, optional max-iteration config, and the initial JSONL config header |
| `setup_research_session` | Creates `autoresearch.research/<slug>/`, initializes a `quality_gap` session, and writes a benchmark script that measures open gaps |
| `configure_session` | Updates runtime config such as autonomy mode, checks policy, keep policy, dashboard refresh, scoped paths, and max iterations |
| `init_experiment` | Writes the session config header: name, metric, unit, and direction |
| `run_experiment` | Runs the benchmark command, times it, captures output, and parses `METRIC name=value` lines |
| `next_experiment` | Runs preflight and benchmark in one packet, then returns allowed log decisions and a next-run notes template |
| `log_experiment` | Records the result, commits kept changes, and reverts discarded/crashed changes with scoped cleanup when paths are configured |
| `read_state` | Summarizes the current baseline, best metric, run count, status counts, confidence score, and iteration limit |
| `measure_quality_gap` | Counts open and closed checklist items in `autoresearch.research/<slug>/quality-gaps.md` |
| `doctor_session` | Checks session readiness, Git state, and optionally whether the benchmark emits the configured primary metric |
| `export_dashboard` | Writes `autoresearch-dashboard.html` from the run log |
| `clear_session` | Deletes session artifacts after explicit confirmation |

For MCP calls, custom shell commands require `allow_unsafe_command: true`. Prefer configured `autoresearch.sh` or `autoresearch.ps1` scripts when possible.

## Commands

| Command | Description |
| --- | --- |
| `/autoresearch <text>` | Start or resume an autoresearch loop using `<text>` as context |
| `/autoresearch research <text>` | Create a deep-research scratchpad and `quality_gap` loop |
| `/autoresearch status` | Summarize the current run log |
| `/autoresearch doctor` | Run the preflight/operator readout before the next experiment |
| `/autoresearch next` | Run preflight + benchmark and prepare the keep/discard decision packet |
| `/autoresearch export` | Generate the dashboard |
| `/autoresearch off` | Stop continuing the loop in the current conversation without deleting session data |
| `/autoresearch clear` | Clear session artifacts after confirmation |
| `/autoresearch-finalize` | Split kept experiments into reviewable branches |

## Skills

| Skill | Description |
| --- | --- |
| `autoresearch-create` | Sets up `autoresearch.md`, benchmark scripts, checks, baseline, and the loop rules |
| `autoresearch-deep-research` | Turns broad research into source-backed scratchpads and measurable `quality_gap` loops |
| `autoresearch-dashboard` | Exports and summarizes `autoresearch.jsonl` |
| `autoresearch-finalize` | Turns a noisy experiment branch into independent review branches |

## Usage

### 1. Start a Session

Codex gathers or infers:

- the goal
- the command to run
- the primary metric and whether lower or higher is better
- files in scope
- correctness constraints

Then it creates:

| File | Purpose |
| --- | --- |
| `autoresearch.md` | Living session document: objective, metrics, scope, constraints, and what has been tried |
| `autoresearch.research/<slug>/` | Optional deep-research scratchpad with sources, synthesis, notes, deliverables, and quality gaps |
| `autoresearch.sh` or `autoresearch.ps1` | Benchmark script that prints `METRIC name=value` lines |
| `autoresearch.checks.sh` or `autoresearch.checks.ps1` | Optional correctness checks after a passing benchmark |
| `autoresearch.jsonl` | Append-only run log |
| last-run packet | Latest `next` packet for quick keep/discard logging with `--from-last`; stored in Git metadata when possible and otherwise as `autoresearch.last-run.json` |
| `autoresearch.ideas.md` | Optional backlog for promising ideas |

The deterministic setup path is available as MCP `setup_session` and CLI `setup`. It is the fastest way to create a fresh, resumable Codex session without hand-copying templates.

### 2. Run the Loop

Each iteration follows the same rhythm:

```text
edit -> run benchmark -> parse metrics -> keep or discard -> log what happened
```

Kept results are committed. If Git cannot add or commit the kept change, logging fails instead of recording a false win.

For tighter keep commits and safer discard cleanup, pass `--commit-paths "src,test"` or configure `commitPaths` through setup. Discarded, crashed, or checks-failed results use those paths as the cleanup boundary. Without scoped paths, the helper refuses broad discard cleanup in a dirty Git tree unless `--allow-dirty-revert` is passed explicitly.

Every run should include next-run notes, stored as ASI (actionable side information). This is structured context for the next session: what was tried, what failed, what surprised Codex, and what to try next.

After `next`, the helper persists a last-run packet. Use `log --from-last` to reuse the parsed primary metric, secondary metrics, and ASI template instead of retyping them:

```bash
node plugins/codex-autoresearch/scripts/autoresearch.mjs log --cwd /path/to/project --from-last --status keep --description "Use worker pool"
```

Minimum useful ASI is one compact JSON object:

```json
{
  "hypothesis": "Memoizing package metadata avoids repeated filesystem scans",
  "evidence": "seconds improved from 11.8 to 9.6 and checks passed",
  "rollback_reason": "",
  "next_action_hint": "Try caching parsed manifests, but watch memory"
}
```

For discarded or crashed runs, fill `rollback_reason` and make `next_action_hint` specific enough that the next Codex session avoids the same dead end.

### 3. Resume Later

The session is designed to survive interruptions and context resets. A fresh Codex session can read:

- `autoresearch.md`
- `autoresearch.jsonl`
- `autoresearch.ideas.md`

and continue without rediscovering the same dead ends.

### 4. Finalize for Review

When the noisy experiment branch has useful kept commits, run:

```text
/autoresearch-finalize
```

Codex groups kept experiments into focused changesets, asks for approval, then creates independent branches under:

```text
autoresearch-review/<goal>/<number>-<slug>
```

The finalizer verifies that the union of review branches matches the autoresearch branch, excluding session artifacts.

To draft the grouping file first:

```bash
node plugins/codex-autoresearch/scripts/finalize-autoresearch.mjs plan --output groups.json --goal short-goal
```

Use `--collapse-overlap` when overlapping draft groups should become one review branch automatically.

Finalization writes a local review packet under `.git/autoresearch-finalize/` with branch stats, suggested PR titles/bodies, review commands, verification status, and cleanup notes.

## Dashboard

Generate the dashboard with:

```bash
node plugins/codex-autoresearch/scripts/autoresearch.mjs export --cwd /path/to/project
```

The output is:

```text
autoresearch-dashboard.html
```

The dashboard shows:

- baseline vs. best
- improvement percentage
- kept run count
- live refresh status plus `Refresh` and `Live on` controls that try to read the adjacent `autoresearch.jsonl`
- copyable operator commands for doctor, next, keep/discard last packet, export, and extend
- operator readout with best kept change, recent failures, next action, and confidence explanation
- segment selector for multi-phase sessions
- ready-to-finalize readout
- metric chart
- run table with status, commit, description, confidence, and ASI

The template lives at:

```text
plugins/codex-autoresearch/assets/template.html
```

## Demo

A tiny static demo lives in:

```text
plugins/codex-autoresearch/examples/demo-session/
```

Regenerate it with:

```bash
node plugins/codex-autoresearch/scripts/autoresearch.mjs export --cwd plugins/codex-autoresearch/examples/demo-session
```

The plugin manifest uses `plugins/codex-autoresearch/assets/demo-dashboard.svg` as the marketplace preview image.

## How It Works

The plugin is split into workflow guidance and deterministic helpers:

```text
Codex skills
  decide what to optimize
  write the benchmark
  choose the next experiment
  interpret the result

MCP/CLI helpers
  create session files from templates
  run timed commands
  parse METRIC lines
  prepare /next decision packets
  append JSONL records
  commit kept changes or scoped-revert discarded ones
  enforce maxIterations when configured
  export dashboard HTML
  draft finalization groups
  clear session artifacts after confirmation
  finalize review branches
```

The key contract is the benchmark output:

```text
METRIC seconds=12.304
METRIC failures=0
```

The primary metric drives the keep/discard decision. Secondary metrics are tradeoff monitors.

## Configuration

Optional `autoresearch.config.json` in the project can set:

```json
{
  "workingDir": "relative/or/absolute/project/path",
  "maxIterations": 50,
  "commitPaths": ["src", "tests"]
}
```

`workingDir` lets a wrapper workspace point the loop at a nested project. `maxIterations` gives helper-run benchmarks a hard stop before the next iteration starts. `commitPaths` narrows keep commits to the experiment surface.

## License

MIT. Copyright (c) 2026 Albert Najjar.
