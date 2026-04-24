<div align="center">
<img height="120" alt="Codex Autoresearch" src="plugins/codex-autoresearch/assets/logo.svg" />

# Codex Autoresearch
### Measured improvement loops for Codex

**[Install](#install)** - **[First Five Minutes](#first-five-minutes)** - **[Dashboard](#dashboard)** - **[Docs](#docs)** - **[Changelog](#changelog)**
</div>

Codex Autoresearch helps Codex improve a repository without losing the plot. You give Codex one goal and one benchmark contract (or talk to it and it figures it out by itself), the plugin helps it run measured packets, keep or discard changes with evidence, preserve ASI and metrics across context loss, and package useful kept work for review.

It is designed for two onboarding paths at once: a human should know what is safe to do next, and a future AI should be able to resume from durable state instead of guessing from chat memory.

![Codex Autoresearch live dashboard showing a demo runtime improvement](plugins/codex-autoresearch/assets/showcase/dashboard-demo.png)

Inspired by [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch), generalized so that it can work for any research task, and the AI-focused [karpathy/autoresearch](https://github.com/karpathy/autoresearch).

## What It Does

1. Codex identifies the target repo/package and checks whether a session already exists.
2. A benchmark prints one primary metric as `METRIC name=value`.
3. Codex runs one packet, then logs it as `keep`, `discard`, `crash`, or `checks_failed` with ASI.
4. The dashboard explains the current trust state, next safe action, blockers, best kept evidence, and metric trend.
5. When the loop has useful kept work, Codex previews finalization into reviewable branches.

The important product contract is evidence, not automation spectacle: no invented zeroes, no stale packets, no broad cleanup without consent, and no final claims without verification.

## Install

```bash
codex marketplace add TheGreenCedar/codex-autoresearch
```

Then open the repo you want to improve and ask Codex to use Codex Autoresearch.

## Start With Codex

Use Codex Autoresearch by giving Codex a goal, a benchmark command, a primary metric, and the scope it is allowed to change. Codex should open with an onboarding packet, explain the next safe action, and keep the live dashboard available while it works.

## First Five Minutes

Just ask Codex.

It can be really broad, and codex will either find really good candidates directly or ask you. ie:

```text
Use $Codex Autoresearch to improve the speed of my indexer's pipeline, while keeping it memory efficient.
```

```text
Use $Codex Autoresearch to keep reducing bugs in the codebase, starting with the most obvious low hanging fruits. Keep doing this 100 times.
```

Or you could be more specific, and tell it exactly what to experiment. It will start with a few, and based on the results, optimize which experiments to prioritize. It keeps track of all the different experiments and tells you what won and what didn't, why or why not, etc. ie:

```text
Use $Codex Autoresearch to figure out why my graphql service's p99 latency is so much higher than its p90 latency at 1 minute metric resolution. I suspect: DNS lookup, event loop throttling, memory spike, CPU spike. For each, run the 4-5 appropriate experiments @experiments.md and if the results are promising keep iterating, otherwise stop and report back.
```

You can trust codex (especially since gpt 5.5) to know that "optimize my unit tests' speed" doesn't mean "delete my unit tests":

```text
Use $Codex Autoresearch to optimize my unit tests' speed. different libraries are allowed, but try to avoid it.
Benchmark: npm test -- --runInBand
Metric: seconds, lower is better
Checks: npm test
Scope: test runner config and test helpers only
```

Codex should:

1. Check Git state and identify the owning package.
2. Run an onboarding packet or setup plan.
3. Verify the benchmark prints `METRIC seconds=<number>`.
4. Start the live dashboard and give you a local URL.
5. Run one packet.
6. Log the decision with ASI.
7. Continue only when the continuation state says it is safe.

For product, docs, UX, or broad research, ask for a quality-gap loop:

```text
Use Codex Autoresearch to study this project and improve the dashboard.
Turn accepted findings into a quality-gap loop, implement them, and keep the live dashboard open.
```

## Docs

- [Docs index](plugins/codex-autoresearch/docs/index.md)
- [Workflow diagrams](plugins/codex-autoresearch/docs/workflows.md)
- [Architecture diagrams](plugins/codex-autoresearch/docs/architecture.md)

## Live Demo

The demo session shows a 100-packet loop for `Indexing Pipeline Speed and Memory Footprint Optimization`.
Its primary dashboard score is a weighted cost:

`0.7 * (seconds / baseline_seconds) + 0.3 * (memory_mb / baseline_memory_mb)`

Lower is better. The chart can switch between score, percent of baseline, raw value, iteration, and timestamp, while the metric details panel shows the full time and memory breakdown for the selected run.

Serve the live demo locally:

```bash
cd plugins/codex-autoresearch
node scripts/autoresearch.mjs serve --cwd examples/demo-session
```

- [Demo tour](plugins/codex-autoresearch/examples/demo-session/demo.md)
- [Demo ledger](plugins/codex-autoresearch/examples/demo-session/autoresearch.jsonl)

The active package lives under `plugins/codex-autoresearch`. The plugin skill lives at [plugins/codex-autoresearch/skills/codex-autoresearch/SKILL.md](plugins/codex-autoresearch/skills/codex-autoresearch/SKILL.md).

## Useful Commands

From `plugins/codex-autoresearch`:

```bash
node scripts/autoresearch.mjs onboarding-packet --cwd <project> --compact
node scripts/autoresearch.mjs prompt-plan --cwd <project> --prompt "Use Codex Autoresearch to improve test speed without deleting tests"
node scripts/autoresearch.mjs recommend-next --cwd <project> --compact
node scripts/autoresearch.mjs setup-plan --cwd <project>
node scripts/autoresearch.mjs benchmark-lint --cwd <project> --sample "METRIC seconds=1.23"
node scripts/autoresearch.mjs doctor --cwd <project> --check-benchmark --explain
node scripts/autoresearch.mjs serve --cwd <project>
node scripts/autoresearch.mjs next --cwd <project>
node scripts/autoresearch.mjs log --cwd <project> --from-last --status keep --description "Describe the kept change"
node scripts/autoresearch.mjs state --cwd <project> --compact
node scripts/autoresearch.mjs new-segment --cwd <project> --dry-run
```

MCP exposes the same workflow behind the skill, including `onboarding_packet`, `prompt_plan`, `recommend_next`, `benchmark_lint`, `new_segment`, `serve_dashboard`, `next_experiment`, and `log_experiment`.

## Dashboard

The live dashboard is the normal operator surface:

```bash
node scripts/autoresearch.mjs serve --cwd <project>
```

It shows:

- the next safe action and why it is safe
- trust blockers such as stale packets, dirty Git, runtime drift, missing paths, and static-export mode
- baseline, latest, best, confidence, and weighted metric formulas
- best kept change, recent failures, strategy lanes, and finalization readiness
- copyable status reports and agent handoff packets

Static exports are portable review snapshots:

```bash
node scripts/autoresearch.mjs export --cwd <project>
```

Static exports are read-only. Serve a fresh dashboard when you need live actions or current packet freshness.
Use `--showcase` only for checked-in public demo snapshots that must not embed local absolute paths.

## Tooling

The plugin and dashboard source are authored in TypeScript. The package uses `tsdown` for Node builds, `tsgo` for typechecking, `oxlint` for linting, `oxfmt` for formatting, Vite for the dashboard, and `npm-run-all2` for fast gates.

From `plugins/codex-autoresearch`:

```bash
npm run check
npm test
node scripts/autoresearch.mjs mcp-smoke
```

## Changelog

User-facing changes are tracked in [CHANGELOG.md](CHANGELOG.md). Surface removals, prompt changes, dashboard behavior changes, MCP behavior, migration notes, and release notes belong there before publishing.

## License

Apache License 2.0. Copyright (c) 2026 Albert Najjar.
