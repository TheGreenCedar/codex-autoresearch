<div align="center">
<img height="120" alt="Codex Autoresearch" src="plugins/codex-autoresearch/assets/logo.svg" />

# Codex Autoresearch
### Measured improvement loops for Codex

**[Install](#install)** - **[Start With Codex](#start-with-codex)** - **[Demo](#demo)** - **[Docs](#docs)** - **[Changelog](#changelog)**
</div>

Codex Autoresearch helps Codex improve a repo without losing the plot. You give it a goal and a benchmark, it runs measured experiments, keeps or discards changes with evidence, and turns the useful work into reviewable branches.

![Codex Autoresearch dashboard showing a demo runtime improvement](plugins/codex-autoresearch/assets/showcase/dashboard-demo.png)

It is adapted from [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) and the broader [karpathy/autoresearch](https://github.com/karpathy/autoresearch) idea.

## What It Does

1. You ask Codex to improve something measurable.
2. Codex creates or resumes an Autoresearch session with one primary `METRIC name=value`.
3. Each packet is logged as keep, discard, crash, or checks failed, with the reason preserved in the ledger.
4. When the loop has useful kept work, Codex previews and creates clean review branches.

The live dashboard stays beside the loop so you can see whether the session is trustworthy, what the next safe action is, why it is safe, which evidence supports it, and how the metric trend is moving.

## Install

```bash
codex marketplace add TheGreenCedar/codex-autoresearch
```

Then work in the repo you want to improve and ask Codex to use Codex Autoresearch.

## Start With Codex

Copy this into Codex and adjust the benchmark/check commands for your project:

```text
Use Codex Autoresearch for indexing pipeline speed and memory footprint optimization.
Benchmark: npm test -- --runInBand
Metric: seconds, lower is better
Checks: npm test
Scope: test runner config and test helpers only
```

For product or documentation work, use a quality-gap loop:

```text
Use Codex Autoresearch to study this project and improve the dashboard.
Turn accepted findings into a quality_gap loop, implement them, and keep the live dashboard open.
```

Codex should give you a local dashboard URL, run a packet, log the decision, and keep iterating until the stop condition is real.

## Demo

The demo session shows a 100-packet loop for `Indexing Pipeline Speed and Memory Footprint Optimization`.
Its primary dashboard score is a weighted cost:

`0.7 * (seconds / baseline_seconds) + 0.3 * (memory_mb / baseline_memory_mb)`

Lower is better. The chart can switch between score, percent of baseline, raw value, iteration, and timestamp, while the metric details panel shows the full time and memory breakdown for the selected run.

- [Demo tour](plugins/codex-autoresearch/examples/demo-session/demo.md)
- [Demo ledger](plugins/codex-autoresearch/examples/demo-session/autoresearch.jsonl)
- [Dashboard runboard](plugins/codex-autoresearch/examples/demo-session/autoresearch-dashboard.html)
- [Screenshot notes](plugins/codex-autoresearch/assets/showcase/showcase.md)

The checked-in HTML is a portable copy of the demo evidence. The screenshot is captured from an HTTP-served runboard so the showcase reflects the live operator surface.

## Tooling

The authored plugin and dashboard source now live in TypeScript. The package uses `tsdown` for the Node build, `tsgo` for typechecking, `oxlint` for linting, `oxfmt` for formatting, and `npm-run-all2` to keep the verification loop fast.

## Docs

- [Docs index](plugins/codex-autoresearch/docs/index.md)
- [Getting started](plugins/codex-autoresearch/docs/getting-started.md)
- [Operator workflows](plugins/codex-autoresearch/docs/operator-workflows.md)
- [Evidence and safety](plugins/codex-autoresearch/docs/evidence-and-safety.md)
- [MCP tools](plugins/codex-autoresearch/docs/mcp-tools.md)
- [Maintainers](plugins/codex-autoresearch/docs/maintainers.md)

The active package lives under `plugins/codex-autoresearch`. The plugin skill lives at [plugins/codex-autoresearch/skills/codex-autoresearch/SKILL.md](plugins/codex-autoresearch/skills/codex-autoresearch/SKILL.md).

## Changelog

User-facing changes are tracked in [CHANGELOG.md](CHANGELOG.md). Surface removals, prompt changes, dashboard behavior changes, and release migration notes belong there before publishing.

## License

Apache License 2.0. Copyright (c) 2026 Albert Najjar.
