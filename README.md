<div align="center">
# Codex Autoresearch

### Measured improvement loops for Codex

**[Try it](#try-it)** - **[Install](#install)** - **[How it works](#how-it-works)** - **[Dashboard](#dashboard)** - **[Docs](#docs)** - **[Changelog](#changelog)**
</div>

Codex Autoresearch helps Codex turn "make this better" into a measured loop.

Give Codex a goal, a benchmark contract, and a safe edit scope. Codex can run small experiment packets, keep or discard changes with evidence, preserve ASI and metrics across context loss, and package useful work for review.

![Codex Autoresearch live dashboard showing a demo runtime improvement](plugins/codex-autoresearch/assets/showcase/dashboard-demo.png)

Inspired by the AI-focused [karpathy/autoresearch](https://github.com/karpathy/autoresearch) and [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch). Codex Autoresearch adapts the measured-loop idea for Codex plugin workflows, repo-local benchmarks, durable session files, an evidence trail, live dashboards, and reviewable finalization.

## Try it

Ask Codex to use Codex Autoresearch.

Broad prompts work:

```text
Use $Codex Autoresearch to improve the speed of my indexer's pipeline, while keeping it memory efficient.
````

```text
Use $Codex Autoresearch to keep reducing bugs in the codebase, starting with
the most obvious low hanging fruits. Keep doing this 100 times.
```

You can also hand it a sharper investigation:

```text
Use $Codex Autoresearch to figure out why my graphql service's p99 latency is so much higher
than its p90 latency at 1 minute metric resolution. I suspect: DNS lookup, event loop throttling,
memory spike, CPU spike. For each, run the 4-5 appropriate experiments @experiments.md and if the
results are promising keep iterating, otherwise stop and report back.
```

Or be exact about the benchmark and scope:

```text
Use $Codex Autoresearch to optimize my unit tests' speed. different libraries are allowed, but try to avoid it.
Benchmark: npm test -- --runInBand
Metric: seconds, lower is better
Checks: npm test
Scope: test runner config and test helpers only
```

Codex should start by checking Git state, identifying the target package, creating or resuming the session, verifying the benchmark, starting the dashboard, running one packet, and logging the result with experiment details.

## Install

This repository is a Codex plugin marketplace. Add the marketplace:

```bash
codex plugin marketplace add TheGreenCedar/codex-autoresearch
```

Then open Codex in the repo you want to improve:

```text
/plugins
```

Choose:

```text
TheGreenCedar Autoresearch -> codex-autoresearch -> Install plugin
```

Start a new Codex thread after installation.

## How it works

A normal session follows this shape:

```text
Target -> Onboard -> Setup -> Doctor -> Dashboard -> Packet -> Log -> Continue or Finalize
```

Codex Autoresearch helps Codex:

1. identify the target repo or child package
2. check for an existing session
3. verify the benchmark contract
4. run a measured packet
5. log the result as `keep`, `discard`, `crash`, or `checks_failed`
6. preserve ASI and metrics in durable files
7. continue safely or preview finalization into reviewable branches

A packet is one measured experiment cycle: make a scoped change, run the benchmark, inspect the metric, and log the decision.

ASI means Accumulated Structured Intelligence. It is the structured memory attached to each packet decision: hypothesis, evidence, rollback reason, next action hint, and optional lane, family, or risk metadata. It tells the next Codex session what happened, what was learned, and which path deserves the next attempt.

## When to use it

Use Codex Autoresearch when:

* the goal can be measured
* the benchmark is repeatable
* correctness checks exist or can be added
* the editable scope is small enough to review
* kept work should become reviewable commits or branches

Use a regular Codex task when:

* the work needs one careful edit
* the goal is mainly taste or judgment
* the benchmark is flaky or very expensive
* the metric can improve by weakening the benchmark
* secrets, deployment paths, or unrelated dirty files are in scope

## Dashboard

Ask codex to boot up the dashboard if it hasn't already.

The dashboard shows:

* baseline, latest, best, confidence, and weighted metric formulas
* Codex brief and session memory
* next safe action and why it is safe
* ledger entries, ASI, and handoff context
* best kept change and recent failures
* strategy lanes, runtime drift, and finalization readiness
* copyable status reports and agent handoff packets

Use the dashboard to inspect state. Talk to Codex for everything else.

## Quality-gap loops

For product, docs, UX, or broad research, ask for a quality-gap loop:

```text
Use Codex Autoresearch to study this project and improve the dashboard.
Turn accepted findings into a quality-gap loop, implement them, and keep the live dashboard open.
```

`quality_gap=0` means the accepted checklist for that round is closed. It does not mean discovery is complete. Start another round if the question is still alive.

## Finalization

Ask the plugin to finalize once a loop has useful kept work mixed with exploratory history.

Finalization should:

1. select kept evidence
2. exclude session artifacts from review branches unless requested
3. show dirty-tree and overlap warnings
4. prepare clean review branches
5. preserve metric evidence and verification commands
6. leave cleanup until review branches are verified

## Docs

* [Docs index](plugins/codex-autoresearch/docs/index.md)
* [Concepts glossary](plugins/codex-autoresearch/docs/concepts.md)
* [Start](plugins/codex-autoresearch/docs/start.md)
* [Workflow diagrams](plugins/codex-autoresearch/docs/workflows.md)
* [Architecture diagrams](plugins/codex-autoresearch/docs/architecture.md)
* [Operate](plugins/codex-autoresearch/docs/operate.md)
* [Trust](plugins/codex-autoresearch/docs/trust.md)
* [Finish](plugins/codex-autoresearch/docs/finish.md)
* [Recipes](plugins/codex-autoresearch/docs/recipes.md)
* [Troubleshooting](plugins/codex-autoresearch/docs/troubleshooting.md)
* [Hooks](plugins/codex-autoresearch/docs/hooks.md)
* [MCP tools](plugins/codex-autoresearch/docs/mcp-tools.md)
* [Maintainers](plugins/codex-autoresearch/docs/maintainers.md)

The active package lives under:

```text
plugins/codex-autoresearch
```

The plugin skill lives at:

```text
plugins/codex-autoresearch/skills/codex-autoresearch/SKILL.md
```

## Development

The plugin and dashboard source are written in TypeScript.

The package uses `tsdown` for Node builds, `tsgo` for typechecking, `oxlint` for linting, `oxfmt` for formatting, Vite for the dashboard, and `npm-run-all2` for combined gates.

From `plugins/codex-autoresearch`:

```bash
npm install
npm run check
npm test
node scripts/autoresearch.mjs mcp-smoke
```

Targeted checks:

```bash
npm run typecheck
npm run lint
npm run format:check
node scripts/autoresearch.mjs doctor --cwd . --check-benchmark --explain
git diff --check
```

## Update or remove

Refresh the marketplace:

```bash
codex plugin marketplace upgrade thegreencedar-autoresearch
```

Remove the marketplace:

```bash
codex plugin marketplace remove thegreencedar-autoresearch
```

To uninstall the plugin, open Codex:

```text
/plugins
```

Then choose:

```text
codex-autoresearch -> Uninstall plugin
```

## Changelog

User-facing changes are tracked in [CHANGELOG.md](CHANGELOG.md).

## License

This project is licensed under the terms of the [Apache License 2.0](./LICENSE). Copyright (c) 2026 Albert Najjar.
