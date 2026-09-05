<div align="center">

# Codex Autoresearch

### Give Codex a benchmark, a boundary, and a memory.

**[Install](#install)** - **[Try it](#try-it)** - **[How it works](#how-it-works)** - **[Dashboard](#dashboard)** - **[Docs](#docs)**
</div>

Codex Autoresearch helps improve local code against a repeatable benchmark. Give it a workload, correctness checks, an edit boundary, and a time budget. It records the baseline, evaluates small changes, and leaves a reviewable patch with the evidence behind it.

Use it for bounded performance or resource-use experiments: faster tests, lower build time, less memory, or higher throughput on a defined workload. Reviews, documentation, product research, and one-off fixes stay ordinary Codex work.

![Codex Autoresearch dashboard with synthetic example measurements](plugins/codex-autoresearch/assets/showcase/dashboard-demo.png)

The screenshot uses synthetic example data.

The loop is inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch) and [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch). This version is built around Codex, local repositories, and ordinary reviewable Git work.

## Install

Open the plugin picker in Codex:

```text
/plugins
```

Choose `TheGreenCedar -> codex-autoresearch -> Install plugin`, then start a new Codex task in the repository you want to improve.

If your Codex build supports marketplace management from the terminal, you can register the source marketplace first:

```bash
codex plugin marketplace add TheGreenCedar/AgentPluginMarketplace --ref main
```

The marketplace lives in `TheGreenCedar/AgentPluginMarketplace`; this repository is the plugin source.

## Try it

After installing the plugin, open Codex in the repository you want to improve and give it a goal, a benchmark, and a boundary. Use this as a starting point for the contract:

```text
/goal @Codex Autoresearch run a measured loop to reduce parser runtime.
Benchmark: node bench/parser.mjs
Metric: seconds (s), lower is better
Checks: node --test tests/parser.test.mjs
Scope: src/parser.mjs
Protect bench/parser.mjs and tests/parser.test.mjs.
Measure two baselines and repeat each candidate before a keep.
Stop after 5 packets or 30 minutes; repeat measurements count toward that limit.
Propose the complete contract for approval before setup or execution.
```

Codex first presents the workload, checks, scope, and budget for review. After you accept the contract, Autoresearch measures the baseline before any candidate change. Commands and paths in the example must match your project.

If you do not know what the benchmark should be, say what outcome you want and ask Codex to propose one:

```text
/goal @Codex Autoresearch help me design a trustworthy benchmark for my indexer's speed and memory use.
Do this as a direct review first. Do not create a session until I approve a complete repeated experiment contract.
```

Codex can inspect a few relevant project files to propose commands and paths, citing where each came from. Those proposals are unaccepted until you review the complete contract. Missing goals, metric meaning, budgets, and product tradeoffs remain decisions to make before a run.

## How it works

The normal route starts with fit:

```text
fit -> continue directly | ask for contract input | run accepted loop
```

Architecture reviews, documentation, UX, product study, open-ended research, taste, and one-shot fixes normally continue directly. In direct mode Codex states the outcome and uncertainty, gathers the cheapest useful evidence, does the task, verifies it, and bounds the claim. Autoresearch creates no session files or other state in that path, and an unrelated existing session remains untouched.

When repeated measurement does fit, the loop is short:

```text
setup -> accept contract -> state -> next -> log -> state -> finalize-preview
```

Setup prepares an experiment contract for explicit acceptance: goal, repository and checkout, typed metric semantics, evaluator, independent checks, scope, noise, keep and stop rules, and budgets. `state` compiles the current files and Git state into one decision. `next` may run only the evaluator and checks accepted by that contract. `log` records whether the result was a baseline, a keep, a discard, or a failure, then returns the resulting decision. When there is useful work to review, `finalize-preview` supplies the current accepted changes, exclusions, and blockers for a compact evidence receipt. A single coherent change can be handed off on the existing branch; separating mixed experiment history into new branches is an advanced step.

The benchmark must print at least one line in this form:

```text
METRIC seconds=12.34
```

The primary metric decides whether the result moved in the right direction. Checks protect correctness. Secondary metrics can catch known tradeoffs such as lower runtime with much higher memory use.

Autoresearch stores the durable session record in the target project. In a Git repository, transient packet state lives under `.git/autoresearch/`; outside Git it falls back to local worktree files. Read surfaces load those sources coherently, and state, doctor, recommendations, finalization, and the dashboard project the same decision rather than recomputing policy independently.

Some commands can change Git state. Keeping a result can create a commit limited to configured paths. Discards, crashes, and failed checks can clean up the configured or explicitly supplied experiment paths. A plain measurement never stages, commits, or reverts anything. Finalization begins with a read-only preview, and review branches are created only after approval. The details are in [Trust](plugins/codex-autoresearch/docs/trust.md).

## When it helps

Autoresearch is a good fit when you can measure the outcome repeatedly, keep the benchmark reasonably stable, protect correctness with checks, and name the part of the repository Codex is allowed to change. It is especially useful when several small attempts are more likely to teach you something than one large rewrite.

It is probably the wrong tool for a one-off edit, a result that is mostly a matter of taste, or a benchmark so slow and noisy that another measurement adds little information.

## Dashboard

The optional dashboard shows what improved, what passed, what is blocked, and the next action. Audit details are available when you need to trace a result. It is read-only; commands still run through Codex and the CLI.

Ask Codex to serve it for a live readout or export a snapshot for review.

## Safety and privacy

Autoresearch does not have a hosted backend of its own, but it runs inside a Codex session. The Codex service or model provider is a separate data path governed by its own settings and terms. Commands you approve run with your local permissions: a benchmark can read files, start processes, use credentials available through explicit packet variables or operating-system stores, contact external services, and cost money if those services charge for use. Packet processes receive a minimal environment by default; inheriting the caller's full environment requires `--packet-env-mode inherit`.

Keep secrets out of command lines, output, experiment notes, and artifacts. Redaction is best-effort, not a security boundary. Treat ledgers and dashboard exports as project records that may contain paths, command names, output excerpts, and notes about what Codex tried.

Read [Trust](plugins/codex-autoresearch/docs/trust.md), [Privacy](plugins/codex-autoresearch/docs/privacy.md), and [Terms](plugins/codex-autoresearch/docs/terms.md) before using the plugin on sensitive repositories or expensive workloads.

## Docs

- [Start](plugins/codex-autoresearch/docs/start.md) gets the first baseline measured and logged.
- [Walkthrough](plugins/codex-autoresearch/docs/walkthrough.md) follows one session from prompt to finalization preview.
- [Operate](plugins/codex-autoresearch/docs/operate.md) covers running, resuming, and repairing a session.
- [Finish](plugins/codex-autoresearch/docs/finish.md) explains the patch and evidence handoff, with branch reconstruction when needed.
- [Troubleshooting](plugins/codex-autoresearch/docs/troubleshooting.md) starts from the symptom when something goes wrong.

The [Docs index](plugins/codex-autoresearch/docs/index.md) has the rest, including [workflow diagrams](plugins/codex-autoresearch/docs/workflows.md) and the [architecture](plugins/codex-autoresearch/docs/architecture.md).

## Update or uninstall

Use `/plugins` to refresh or uninstall the workspace plugin. Where terminal marketplace management is available, these commands manage the source registration:

```bash
codex plugin marketplace add TheGreenCedar/AgentPluginMarketplace --ref main
codex plugin marketplace upgrade TheGreenCedar
codex plugin marketplace remove TheGreenCedar
```

Removing a marketplace registration may not uninstall a plugin that is already installed in a workspace. Use the plugin UI for that.

## Development

Source development requires Node.js 24 or newer, npm, and Git. See [Contributing](CONTRIBUTING.md) for local setup and verification. Packaging and release work is covered in [Maintainers](plugins/codex-autoresearch/docs/maintainers.md), and user-facing changes are recorded in [CHANGELOG.md](CHANGELOG.md).

## License

[Apache License 2.0](./LICENSE). Copyright (c) 2026 Albert Najjar.
