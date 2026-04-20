<div align="center">
<img height="120" alt="Codex Autoresearch" src="assets/logo.svg" />

# Codex Autoresearch
### Autonomous experiment loops for Codex

**[Quick start](#quick-start)** - **[Usage](#usage)** - **[How it works](#how-it-works)** - **[Dashboard](#dashboard)**
</div>

Try an idea, measure it, keep what works, discard what does not, and leave a trail another Codex session can resume from.

Codex Autoresearch is a plugin for running optimization loops inside a codebase. It is useful when you have a measurable target and many possible changes to try: test runtime, build speed, bundle size, model loss, Lighthouse scores, memory use, query latency, or any other metric you can print from a script.

It is adapted from [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch), which brings the same loop to the Pi terminal agent, and from the broader [karpathy/autoresearch](https://github.com/karpathy/autoresearch) idea.

## Quick Start

Ask Codex:

```text
Start autoresearch to optimize unit test runtime. Keep correctness checks passing.
```

Codex will create the session files, initialize the run log, take a baseline, and start trying measured changes.

For direct CLI use from this plugin folder:

```bash
node scripts/autoresearch.mjs setup --cwd /path/to/project --name "test speed" --metric-name seconds --metric-unit s --direction lower --benchmark-command "npm test -- --runInBand" --checks-command "npm test" --max-iterations 50
node scripts/autoresearch.mjs run --cwd /path/to/project
node scripts/autoresearch.mjs log --cwd /path/to/project --metric 12.3 --status keep --description "Use worker pool"
node scripts/autoresearch.mjs export --cwd /path/to/project
```

## What Is Included

| Part | What it does |
| --- | --- |
| MCP tools | `setup_session`, `init_experiment`, `run_experiment`, `log_experiment`, `read_state`, `export_dashboard`, `clear_session` |
| Skills | Create/resume loops, export dashboards, finalize noisy branches |
| Commands | `/autoresearch` and `/autoresearch-finalize` workflow docs |
| Dashboard | Static HTML report generated from `autoresearch.jsonl` |
| Templates | Starter `autoresearch.md`, shell/PowerShell benchmark scripts, and checks scripts |

## MCP Tools

| Tool | Description |
| --- | --- |
| `setup_session` | Creates `autoresearch.md`, benchmark/check scripts, `autoresearch.ideas.md`, optional max-iteration config, and the initial JSONL config header |
| `init_experiment` | Writes the session config header: name, metric, unit, and direction |
| `run_experiment` | Runs the benchmark command, times it, captures output, and parses `METRIC name=value` lines |
| `log_experiment` | Records the result, commits kept changes, and reverts discarded/crashed changes while preserving session files |
| `read_state` | Summarizes the current baseline, best metric, run count, status counts, confidence score, and iteration limit |
| `export_dashboard` | Writes `autoresearch-dashboard.html` from the run log |
| `clear_session` | Deletes session artifacts after explicit confirmation |

## Commands

| Command | Description |
| --- | --- |
| `/autoresearch <text>` | Start or resume an autoresearch loop using `<text>` as context |
| `/autoresearch status` | Summarize the current run log |
| `/autoresearch export` | Generate the dashboard |
| `/autoresearch off` | Stop continuing the loop in the current conversation without deleting session data |
| `/autoresearch clear` | Clear session artifacts after confirmation |
| `/autoresearch-finalize` | Split kept experiments into reviewable branches |

## Skills

| Skill | Description |
| --- | --- |
| `autoresearch-create` | Sets up `autoresearch.md`, benchmark scripts, checks, baseline, and the loop rules |
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
| `autoresearch.sh` or `autoresearch.ps1` | Benchmark script that prints `METRIC name=value` lines |
| `autoresearch.checks.sh` or `autoresearch.checks.ps1` | Optional correctness checks after a passing benchmark |
| `autoresearch.jsonl` | Append-only run log |
| `autoresearch.ideas.md` | Optional backlog for promising ideas |

The deterministic setup path is available as MCP `setup_session` and CLI `setup`. It is the fastest way to create a fresh, resumable Codex session without hand-copying templates.

### 2. Run the Loop

Each iteration follows the same rhythm:

```text
edit -> run benchmark -> parse metrics -> keep or discard -> log what happened
```

Kept results are committed. Discarded, crashed, or checks-failed results are logged and then reverted, while the autoresearch session files stay intact.

Every run should include ASI, short for actionable side information. This is structured context for the next session: what was tried, what failed, what surprised Codex, and what to try next.

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

## Dashboard

Generate a static dashboard with:

```bash
node scripts/autoresearch.mjs export --cwd /path/to/project
```

The output is:

```text
autoresearch-dashboard.html
```

The dashboard shows:

- baseline vs. best
- improvement percentage
- kept run count
- metric chart
- run table with status, commit, description, confidence, and ASI

The template lives at:

```text
assets/template.html
```

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
  append JSONL records
  commit or revert changes
  enforce maxIterations when configured
  export dashboard HTML
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
  "maxIterations": 50
}
```

`workingDir` lets a wrapper workspace point the loop at a nested project. `maxIterations` gives helper-run benchmarks a hard stop before the next iteration starts.

## License

MIT. Copyright (c) 2026 Albert Najjar.
