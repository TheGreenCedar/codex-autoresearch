<div align="center">

# Codex Autoresearch

### Measured improvement loops for Codex

**[Try it](#try-it)** - **[Install](#install)** - **[How it works](#how-it-works)** - **[Dashboard](#dashboard)** - **[Docs](#docs)** - **[Changelog](#changelog)**
</div>

Codex Autoresearch helps Codex turn "make this better" into a measured loop.

Give Codex a goal, a benchmark, and the files it may edit. Codex Autoresearch runs bounded benchmark experiments, keeps a local evidence trail, preserves context-resumable state, and creates reviewable branch previews for useful changes.

![Codex Autoresearch live dashboard showing a demo runtime improvement](plugins/codex-autoresearch/assets/showcase/dashboard-demo.png)

Inspired by the AI-focused [karpathy/autoresearch](https://github.com/karpathy/autoresearch) and [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch). Codex Autoresearch adapts measured improvement loops for Codex: local benchmarks, durable state, live readouts, and reviewable branch previews.

## Try it

Ask Codex to use Codex Autoresearch.

Broad prompts work, with a caveat: they are discovery mode, not the ideal way to fly the whole loop. Autoresearch can turn fuzzy work into a measured path, but you should still be the master of what is happening: tighten the goal, evidence bar, budget, benchmark, and scope as soon as you can.

```text
/goal @Codex Autoresearch improve the speed of my indexer's pipeline, while keeping it memory efficient.
```

```text
/goal @Codex Autoresearch keep reducing bugs in the codebase, starting with
the most obvious low hanging fruits. Run at most 5 attempts or 30 minutes,
stop if checks fail twice, and report the best kept change.
```

You can also hand it a sharper investigation:

```text
/goal @Codex Autoresearch figure out why my graphql service's p99 latency is so much higher
than its p90 latency at 1 minute metric resolution. I suspect: DNS lookup, event loop throttling,
memory spike, CPU spike. For each, run the 4-5 appropriate experiments @experiments.md and if the
results are promising keep iterating, otherwise stop and report back.
```

Or be exact about the benchmark and scope:

```text
/goal @Codex Autoresearch optimize my unit tests' speed. different libraries are allowed, but try to avoid it.
Benchmark: npm test -- --runInBand
Metric: seconds, lower is better
Checks: npm test
Scope: test runner config and test helpers only
```

Codex should start by checking Git state, identifying the target package, creating or resuming the session, verifying the benchmark, running one measured benchmark experiment, and recording the evidence. Ask for the live dashboard when you want a visual readout or need fresh run state in the browser.

Autoresearch stores its loop evidence in local project files and runs approved benchmark/check commands with local process permissions. Read [Privacy](plugins/codex-autoresearch/docs/privacy.md), [Terms](plugins/codex-autoresearch/docs/terms.md), and [Trust](plugins/codex-autoresearch/docs/trust.md) before using it on repos with secrets, sensitive data, external APIs, or expensive commands.

## Install

For normal Codex use, install the plugin through the Codex plugin flow for your workspace. Open Codex in the repo you want to improve, then use:

```text
/plugins
```

Choose:

```text
TheGreenCedar Autoresearch -> codex-autoresearch -> Install plugin
```

If your Codex build exposes terminal marketplace management for source marketplaces, add or refresh this marketplace first:

```bash
codex plugin marketplace add TheGreenCedar/codex-autoresearch
```

Some workspace plugin settings are managed from the Codex Apps/Plugins UI rather than the terminal. Use the UI path when the CLI marketplace command is unavailable.

Start a new Codex thread after installation or refresh.

## How it works

A normal session follows this shape:

```text
setup -> doctor -> next -> log -> state -> finalize-preview
```

When the goal, benchmark, metric, or scope is still fuzzy, start with one of the read-only planning
surfaces before creating files:

```bash
node plugins/codex-autoresearch/scripts/autoresearch.mjs setup-plan --cwd <project>
node plugins/codex-autoresearch/scripts/autoresearch.mjs prompt-plan --cwd <project> --prompt "<plain-language goal>"
```

Codex Autoresearch helps Codex:

1. set up the target repo, goal, primary metric, benchmark, checks, and scoped edit surface
2. verify the benchmark contract and optional checks with `doctor`
3. run one measured benchmark experiment with `next`
4. record the result and evidence for the next decision
5. inspect the compact state before spending another run
6. preview finalization into reviewable branches when the kept evidence is ready

That happy path is the default help surface. `serve` is an optional live dashboard handoff and is listed in the full help. Advanced diagnostics such as `prompt-plan`, `onboarding-packet`, `recommend-next`, `benchmark-inspect`, `partial-results`, `session-forensics`, and `export` are still available with `--help --all` when a run needs deeper repair, dashboard inspection, forensics, or recovery.

When you use Codex Goal mode, `codex-goal-brief` turns Autoresearch state into a Goal objective draft and completion audit. It does not mutate Codex Goal state.

A benchmark experiment is one measured cycle: make a scoped change, run the benchmark, inspect the metric, and record the evidence.

Autoresearch keeps structured session context with the hypothesis, evidence, next action hint, and relevant risk notes. It tells the next Codex session what happened, what was learned, and which path deserves the next attempt.

For terminal-first resumes, ask for the compact report:

```bash
node plugins/codex-autoresearch/scripts/autoresearch.mjs state --cwd <project> --report
```

From inside `plugins/codex-autoresearch`, the shorter `node scripts/autoresearch.mjs ...` form is equivalent.

It returns `report.text` for a one-screen readout and `report.json` for automation. Blockers outrank run recommendations, and missing dashboard liveness includes the command to serve or verify the dashboard instead of pretending a stale view is live.

## When to use it

Use Codex Autoresearch when:

* the goal can be measured
* the benchmark is repeatable
* benchmark-contract files can be protected from quiet drift
* known tradeoffs can be expressed as secondary metric constraints
* correctness checks exist or can be added
* the editable scope is small enough to review
* kept work should become reviewable commits or branches

Use Autoresearch for qualitative work when it can be turned into a qualitative but checklist-measured loop: study the surface, accept evidence-backed gaps, close them, and verify `quality_gap`.

```text
research-setup -> quality-gap -> gap-candidates
```

Use a regular Codex task when:

* the work needs one careful edit
* the goal is mainly taste or judgment
* the benchmark is flaky or very expensive
* the metric can improve by weakening the benchmark
* secrets, deployment paths, or unrelated dirty files are in scope

Protected benchmark folders use bounded recursive snapshots, not unbounded hashing. Keep them small, or point Autoresearch at a compact manifest/contract file instead of a large generated, cache, fixture, or data directory; large or deep folders can make `next` refuse until the benchmark surface is narrowed.

## Dashboard

Ask Codex to serve the dashboard when you want a live visual readout, run freshness matters, or a stale/static export is confusing the decision.

The dashboard answers three questions:

1. Is this live or a static snapshot?
2. What is the next safe action?
3. What blocks trust?

Audit view includes the deeper trace: metric formulas, lane state, watchdog quiet windows, runtime provenance, run diagnostics, finalization readiness, evidence history, and handoff details.

Readout only. Use the CLI to do the work; the dashboard is a visual aid, not a control surface.

## Quality-gap loops

For product, docs, UX, or broad research, ask for a quality-gap loop:

```text
/goal @Codex Autoresearch study this project and improve the dashboard.
Turn accepted findings into a quality-gap loop, implement them, and keep the live dashboard open.
```

`quality_gap=0` means the accepted checklist for that round is closed. It does not mean discovery is complete. Start another round if the question is still alive.

## Finalization

Ask the plugin to finalize once a loop has useful kept work mixed with exploratory history.

Finalization should:

1. select only approved current evidence
2. exclude session artifacts from review branches unless requested
3. keep exploratory or superseded evidence audit-visible but out of review branches
4. block evidence that was later invalidated or reverted
5. show dirty-tree, overlap, semantic-safety, and final-tree coverage warnings
6. prepare clean review branches or a current-final-tree plan
7. preserve metric evidence and verification commands
8. leave cleanup until review branches are verified

## Docs

Start and operate:

* [Docs index](plugins/codex-autoresearch/docs/index.md)
* [Start](plugins/codex-autoresearch/docs/start.md)
* [Walkthrough](plugins/codex-autoresearch/docs/walkthrough.md)
* [Operate](plugins/codex-autoresearch/docs/operate.md)
* [Finish](plugins/codex-autoresearch/docs/finish.md)

Trust and troubleshooting:

* [Concepts glossary](plugins/codex-autoresearch/docs/concepts.md)
* [Trust](plugins/codex-autoresearch/docs/trust.md)
* [Privacy](plugins/codex-autoresearch/docs/privacy.md)
* [Terms](plugins/codex-autoresearch/docs/terms.md)
* [Troubleshooting](plugins/codex-autoresearch/docs/troubleshooting.md)

Architecture and maintenance:

* [Workflow diagrams](plugins/codex-autoresearch/docs/workflows.md)
* [Architecture diagrams](plugins/codex-autoresearch/docs/architecture.md)
* [Control plane contracts](plugins/codex-autoresearch/docs/control-plane.md)
* [Recipes](plugins/codex-autoresearch/docs/recipes.md)
* [Hooks](plugins/codex-autoresearch/docs/hooks.md)
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

The plugin and dashboard source are written in TypeScript and developed on Node.js 24 or newer.

The package uses `tsdown` for Node builds, `tsgo` for typechecking, `oxlint` for linting, `oxfmt` for formatting, Vite for the dashboard, and `npm-run-all2` for combined gates.

From `plugins/codex-autoresearch`:

```bash
npm install
npm run check
npm test
node scripts/autoresearch.mjs --help
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

For normal Codex use, refresh or uninstall the plugin from the Codex plugin surface:

```text
/plugins
```

Then choose the installed `codex-autoresearch` plugin and use the available refresh or uninstall action.

If your Codex build exposes terminal marketplace management for source marketplaces, these commands may be available:

```bash
codex plugin marketplace upgrade thegreencedar-autoresearch
codex plugin marketplace remove thegreencedar-autoresearch
```

`marketplace remove` removes the source marketplace registration. It may not uninstall an already installed workspace plugin. Prefer the plugin UI for installed-plugin refresh/uninstall actions, and use terminal marketplace commands only for source registration when your Codex build supports them.

## Changelog

User-facing changes are tracked in [CHANGELOG.md](CHANGELOG.md).

## License

This project is licensed under the terms of the [Apache License 2.0](./LICENSE). Copyright (c) 2026 Albert Najjar.
