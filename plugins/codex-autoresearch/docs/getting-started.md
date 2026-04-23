# Getting Started

Codex Autoresearch turns an open improvement goal into a measured loop: define one primary metric, run a repeatable benchmark, keep or discard each packet with evidence, and preserve the trail in project files.

## Install

Install the plugin from the marketplace:

```bash
codex marketplace add TheGreenCedar/codex-autoresearch
```

When working inside this repository, use the local plugin source instead of any installed cache copy. From the wrapper root:

```bash
node plugins/codex-autoresearch/scripts/autoresearch.mjs mcp-smoke
```

## Start With Codex

In the repo you want to improve, ask Codex for the outcome and give the measurement shape:

```text
Use Codex Autoresearch for indexing pipeline speed and memory footprint optimization.
Benchmark: npm test -- --runInBand
Metric: seconds, lower is better
Checks: npm test
Scope: test runner config and test helpers only
```

Codex should identify the owning repo, check Git state, create or resume the session, start the live dashboard, run the first measured packet, log the decision, and continue until there is a real stop condition.

## Create A Session Manually

From `plugins/codex-autoresearch`, the CLI setup path is:

```bash
node scripts/autoresearch.mjs setup-plan --cwd <project> --name "Test runtime" --metric-name seconds
node scripts/autoresearch.mjs setup --cwd <project> --name "Test runtime" --metric-name seconds --direction lower --benchmark-command "npm test -- --runInBand"
node scripts/autoresearch.mjs doctor --cwd <project> --check-benchmark
```

The benchmark must print the primary metric as:

```text
METRIC seconds=12.34
```

Secondary `METRIC` lines can explain tradeoffs, but the primary metric drives keep/discard decisions.

## Session Files

Autoresearch writes durable state into the target project:

| File | Purpose |
| --- | --- |
| `autoresearch.md` | Goal, metric, scope, constraints, decisions, and stop conditions. |
| `autoresearch.jsonl` | Append-only setup, packet, metric, status, commit, and ASI history. |
| `autoresearch.sh` or `autoresearch.ps1` | Repeatable benchmark entrypoint. |
| `autoresearch.checks.sh` or `autoresearch.checks.ps1` | Optional correctness gate. |
| `autoresearch.ideas.md` | Deferred hypotheses, rejected lanes, and next-action notes. |
| `autoresearch.last-run.json` | Fallback last-packet record when Git metadata is unavailable. |

## First Normal Loop

Run a packet:

```bash
node scripts/autoresearch.mjs next --cwd <project>
```

Log from the last packet instead of retyping parsed metrics:

```bash
node scripts/autoresearch.mjs log --cwd <project> --from-last --status keep --description "Describe the kept change"
```

Use `discard`, `crash`, or `checks_failed` when the packet does not produce a safe improvement. Include ASI in normal Codex operation: hypothesis, evidence, rollback reason for rejected paths, and the next-action hint.

## Dashboard

Prefer the live local dashboard while operating:

```bash
node scripts/autoresearch.mjs serve --cwd <project>
```

Codex should give the served URL, usually `http://127.0.0.1:<port>/`. Static exports are for offline review:

```bash
node scripts/autoresearch.mjs export --cwd <project>
```

See [Operator workflows](operator-workflows.md) for dashboard use and [Evidence and safety](evidence-and-safety.md) for trust rules.
