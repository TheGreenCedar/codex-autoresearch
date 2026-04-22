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
node plugins/codex-autoresearch/scripts/autoresearch.mjs mcp-smoke
```

Marketplace installs are versioned. If Codex still shows an older version, bump or refresh the installed plugin cache before testing new tools. `mcp-smoke` validates the plugin's lightweight stdio MCP entrypoint directly; the MCP process only imports the static tool schema at startup and defers the full CLI load until an actual tool call.

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
node plugins/codex-autoresearch/scripts/autoresearch.mjs mcp-smoke
```

It reports `METRIC quality_gap=<n>`, where zero means the local plugin has the current guidance, prompts, tests, and session hygiene expected for Codex autoresearch work.

## Codex + GPT-5.4 Operating Profile

GPT-5.4 is useful for long, tool-heavy professional work because it has a 1.05M context window, supports reasoning effort, and supports tools such as MCP, shell, apply patch, skills, tool search, web search, and file search through the Responses API. That power is best used with narrow, durable loop state instead of one giant conversation.

For Codex + GPT-5.4, treat autoresearch as the operating rail:

- Keep the measured target explicit: `quality_gap`, runtime, cost, failures, Lighthouse score, or another primary metric.
- Use `next_experiment` or `/autoresearch next` for one preflight, benchmark, decision, and ASI packet at a time.
- Treat the returned `continuation` object as the active-loop contract: after `log_experiment`, keep iterating in the same conversation when `shouldContinue` is true.
- Store qualitative findings in `autoresearch.md`, `autoresearch.ideas.md`, and ASI instead of relying on context memory.
- Use `autoresearch-deep-research` for broad project-study prompts, then convert recommendations into a qualitative gap benchmark or a small set of measurable acceptance checks.
- Stop only after a fresh research round yields no credible high-impact candidates, accepted gaps are closed or explicitly rejected, checks pass, and the latest synthesis has no remaining high-impact product gaps.

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

For repeated project-study work, count one full prompt pass as one research round. In every round, rerun the study prompt against the current branch, refresh `sources.md` and `synthesis.md`, preview `gap-candidates`, filter hallucinations, and apply only credible high-impact gaps. Treat all implementation from that accepted set as the same round. `quality_gap=0` closes the accepted checklist for the current round; put another way, quality_gap=0 closes the accepted checklist, not the discovery process.

The generic benchmark counts unchecked items:

```text
METRIC quality_gap=<open>
METRIC quality_total=<all checklist items>
METRIC quality_closed=<checked items>
```

Stop when a fresh research round produces no credible high-impact candidates, `quality_gap=0`, checks pass, and high-impact findings are implemented or explicitly rejected with evidence. Small QoL fixes should stay separate from the high-impact gap list unless they are part of the agreed goal.

For direct CLI use, follow the canonical [`/autoresearch` command walkthrough](plugins/codex-autoresearch/commands/autoresearch.md#local-plugin-routing). The essential sequence is setup, doctor, next, log with `--from-last`, and export.

Tiny worked story:

```text
setup   Create autoresearch.md for "reduce unit test runtime"; metric seconds, direction lower.
doctor  Confirm the benchmark emits METRIC seconds=<number> and the worktree is ready.
next    Run preflight + benchmark and return allowed log decisions plus a next-run notes template.
log     Record baseline with status keep.
next    Try reusing a test database fixture; benchmark prints METRIC seconds=13.7; checks pass.
log     Record status keep with ASI: {"hypothesis":"fixture reuse removes setup cost","next_action_hint":"measure worker count next"}.
serve   Keep the live dashboard open for the run history.
finalize Split the kept fixture change into a review branch when the noisy loop is done.
```

## What Is Included

| Part | What it does |
| --- | --- |
| MCP tools | `setup_plan`, `list_recipes`, `setup_session`, `setup_research_session`, `configure_session`, `init_experiment`, `run_experiment`, `next_experiment`, `log_experiment`, `read_state`, `measure_quality_gap`, `gap_candidates`, `finalize_preview`, `integrations`, `doctor_session`, `serve_dashboard`, `export_dashboard`, `clear_session` |
| Skills | Create/resume loops, turn deep research into quality gaps, open live dashboards, finalize noisy branches |
| Commands | `/autoresearch` and `/autoresearch-finalize` workflow docs |
| Dashboard | Live operator cockpit generated from `autoresearch.jsonl`, with a compact top metric trajectory, experiment-family and lane-portfolio panels, setup/readiness/gap/finalization panels, and safe local refresh/actions |
| Templates | Starter `autoresearch.md`, shell/PowerShell benchmark scripts, and checks scripts |
| Recipes and integrations | Built-in benchmark recipes, local/remote recipe catalogs, model-command gap candidates, and live dashboard action providers |

## MCP Tools

| Tool | Description |
| --- | --- |
| `setup_plan` | Returns a read-only first-run setup plan with missing fields, recipe suggestion, and exact next commands |
| `list_recipes` | Lists built-in recipes and optional local/remote catalog recipes |
| `setup_session` | Creates `autoresearch.md`, benchmark/check scripts, `autoresearch.ideas.md`, optional recipe/catalog defaults, max-iteration config, and the initial JSONL config header |
| `setup_research_session` | Creates `autoresearch.research/<slug>/`, initializes a `quality_gap` session, and writes a benchmark script that measures open gaps |
| `configure_session` | Updates runtime config such as autonomy mode, checks policy, keep policy, dashboard refresh, scoped paths, and max iterations |
| `init_experiment` | Writes the session config header: name, metric, unit, and direction |
| `run_experiment` | Runs the benchmark command, times it, captures output, and parses `METRIC name=value` lines |
| `next_experiment` | Runs preflight and benchmark in one packet, then returns allowed log decisions, a next-run notes template, and a continuation contract |
| `log_experiment` | Records the result, commits kept changes, reverts discarded/crashed changes with scoped cleanup, and returns whether the active loop should immediately continue |
| `read_state` | Summarizes the current baseline, best metric, run count, status counts, confidence score, and iteration limit |
| `measure_quality_gap` | Counts open and closed checklist items in `autoresearch.research/<slug>/quality-gaps.md` |
| `gap_candidates` | Extracts validated deep-research gap candidates from synthesis and optional model-command JSON; optional apply mode appends checklist items |
| `finalize_preview` | Previews kept-run grouping, touched files, warnings, and review readiness without creating branches |
| `integrations` | Lists, doctors, or loads additive integrations such as recipe catalogs and model commands |
| `doctor_session` | Checks session readiness, Git state, and optionally whether the benchmark emits the configured primary metric |
| `serve_dashboard` | Starts the local live dashboard and returns the operator URL |
| `export_dashboard` | Writes a read-only fallback `autoresearch-dashboard.html` snapshot from the run log |
| `clear_session` | Deletes session artifacts after explicit confirmation |

For MCP calls, custom shell commands require `allow_unsafe_command: true`. Prefer configured `autoresearch.sh` or `autoresearch.ps1` scripts when possible.

## Commands

| Command | Description |
| --- | --- |
| `/autoresearch <text>` | Start or resume an autoresearch loop using `<text>` as context |
| `/autoresearch setup-plan` | Produce a read-only guided setup plan and recipe recommendation, including catalog recipes when a catalog is supplied |
| `/autoresearch recipes` | Inspect built-in or catalog recipes |
| `/autoresearch research <text>` | Create a deep-research scratchpad and `quality_gap` loop |
| `/autoresearch gap-candidates` | Convert synthesis and optional model-command output into validated quality-gap candidates |
| `/autoresearch finalize-preview` | Preview finalization readiness without creating branches |
| `/autoresearch serve` | Start a local live dashboard with safe action endpoints |
| `/autoresearch integrations` | Inspect or load additive integration surfaces |
| `/autoresearch status` | Summarize the current run log |
| `/autoresearch doctor` | Run the preflight/operator readout before the next experiment |
| `/autoresearch next` | Run preflight + benchmark and prepare the keep/discard decision packet |
| `/autoresearch export` | Generate a read-only fallback dashboard snapshot |
| `/autoresearch off` | Stop continuing the loop in the current conversation without deleting session data |
| `/autoresearch clear` | Clear session artifacts after confirmation |
| `/autoresearch-finalize` | Split kept experiments into reviewable branches |

## Skills

| Skill | Description |
| --- | --- |
| `autoresearch-create` | Sets up `autoresearch.md`, benchmark scripts, checks, baseline, and the loop rules |
| `autoresearch-deep-research` | Turns broad research into source-backed scratchpads and measurable `quality_gap` loops |
| `autoresearch-dashboard` | Opens and summarizes the live dashboard for `autoresearch.jsonl` |
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
| live dashboard URL | Served operator dashboard that Codex links directly when the workflow starts or resumes |
| `autoresearch-dashboard.html` | Optional read-only fallback snapshot for offline review |
| last-run packet | Latest `next` packet for quick keep/discard logging with `--from-last`; stored in Git metadata when possible and otherwise as `autoresearch.last-run.json`, then cleared after a successful `log --from-last` |
| `autoresearch.ideas.md` | Optional backlog for promising ideas |

The deterministic setup path is available as MCP `setup_session` and CLI `setup`. It is the fastest way to create a fresh, resumable Codex session without hand-copying templates.

When Codex starts or resumes a workflow, it starts or reuses the live dashboard and directly provides the served `http://127.0.0.1:<port>/` URL before continuing with experiments or status narration.

### 2. Run the Loop

Each iteration follows the same rhythm:

```text
edit -> run benchmark -> parse metrics -> keep or discard -> log what happened
```

The CLI and MCP responses include `continuation`. When `continuation.shouldContinue` is true, Codex should keep the loop in the same conversation by choosing the next hypothesis, editing, running `next`, and logging again. When `continuation.forbidFinalAnswer` is true, a completed run is only a checkpoint, not a reason to return control to the user.

Kept results are committed. If Git cannot add or commit the kept change, logging fails instead of recording a false win.

For tighter keep commits and safer discard cleanup, pass `--commit-paths "src,test"` or configure `commitPaths` through setup. Discarded, crashed, or checks-failed results use those paths as the cleanup boundary. Without scoped paths, the helper refuses broad discard cleanup in a dirty Git tree unless `--allow-dirty-revert` is passed explicitly.

Every run should include next-run notes, stored as ASI (actionable side information). This is structured context for the next session: what was tried, what failed, what surprised Codex, and what to try next.

After `next`, the helper persists a last-run packet. Use `log --from-last` to reuse the parsed primary metric, secondary metrics, and ASI template instead of retyping them:

```bash
node plugins/codex-autoresearch/scripts/autoresearch.mjs log --cwd /path/to/project --from-last --status keep --description "Use worker pool"
```

Successful packets still require an explicit `--status keep` or `--status discard`; failed benchmark/check packets can suggest the forced status. A consumed packet is cleared after logging, and stale packets are rejected if another run was logged after the packet was produced.

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

On resume, Codex starts or reuses the live dashboard URL before running the next experiment.

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

Start the live dashboard with:

```bash
node plugins/codex-autoresearch/scripts/autoresearch.mjs serve --cwd /path/to/project
```

The command prints a local URL such as:

```text
http://127.0.0.1:49152/
```

The `serve` process stays open to keep that URL alive. This served URL is the dashboard link to provide by default. It refreshes from the run log and exposes guarded local actions. A static fallback snapshot is still available for offline review:

```bash
node plugins/codex-autoresearch/scripts/autoresearch.mjs export --cwd /path/to/project
```

When reporting a dashboard to a user, give the served URL unless live serving is unavailable or the user explicitly asks for a static file.

The dashboard shows:

- baseline vs. best
- improvement percentage
- kept run count
- compact metric trajectory in the top cockpit
- a generated Codex brief with what happened and what Codex plans next
- experiment families, plateau risk, novelty signal, and lane-portfolio guidance
- served live status with guarded action buttons, plus a static snapshot fallback when exported
- operator readout with best kept change, recent failures, next action, and confidence explanation
- segment selector for multi-phase sessions
- ready-to-finalize readout
- metric chart with the virtualized newest-first run log directly underneath
- run log with status, commit, description, confidence, and compact ASI

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
  serve the live dashboard
  export fallback dashboard HTML
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
