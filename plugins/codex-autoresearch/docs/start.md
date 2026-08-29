# Start with fit, then a baseline

A good Autoresearch session begins only after the request fits repeated measurement. Ask Codex to run the read-only `prompt-plan` fit check before it scans the repository or proposes setup. Architecture, documentation, UX, product study, open research, taste, and one-shot fixes normally continue directly with no Autoresearch state.

An accepted session then begins with a result you can reproduce before any code changes. You need a goal, repository and checkout identity, typed metric semantics, an evaluator, independent correctness checks, editable and protected scope, a noise model, keep and stop rules, and real budgets. An explicit loop request that lacks those essentials returns `needs-user`; the plugin does not search for plausible defaults and silently accept them.

The benchmark must print the primary metric in this form:

```text
METRIC seconds=12.34
```

It may print other metrics too. If runtime is the primary metric, memory or coverage can still be recorded as guardrails, but they do not replace the number the loop is trying to improve.

## Start from Codex

This prompt contains enough information to run without a long setup conversation:

```text
/goal @Codex Autoresearch make the unit tests faster.
Benchmark: npm test -- --runInBand
Wrap that raw command so the benchmark prints METRIC seconds=<number>.
Metric: seconds, lower is better
Checks: npm test
Scope: test runner config and test helpers only
Measure a baseline before changing code. Stop after 5 attempts or 30 minutes.
```

If the benchmark is not obvious, ask Codex to design it as direct work first. `prompt-plan` returns the missing contract fields without writing session files; `setup-plan` can inspect a loop candidate only after fit selects `run-loop`. Read and approve the complete contract before setup. A command that is easy to measure but unrelated to the actual goal is worse than no benchmark at all.

## Start from the CLI

These commands are for a source checkout. If you installed the plugin through Codex, ask `@Codex Autoresearch` to perform this step. To run the commands yourself, clone this repository and change into `plugins/codex-autoresearch`. The `--cwd` value points at the project being improved; it does not have to be the plugin directory. A configured `workingDir` stays inside that project unless the command explicitly includes `--allow-outside-workdir`.

```bash
git -C <project> status --short --branch
node scripts/autoresearch.mjs setup --cwd <project> --name "Test runtime" --metric-name seconds --direction lower --benchmark-command "npm test -- --runInBand" --benchmark-prints-metric false --checks-command "npm test"
node scripts/autoresearch.mjs doctor --cwd <project> --check-benchmark --explain
node scripts/autoresearch.mjs state --cwd <project> --report
node scripts/autoresearch.mjs next --cwd <project>
node scripts/autoresearch.mjs log --cwd <project> --from-last --status measure --description "Baseline measurement"
node scripts/autoresearch.mjs state --cwd <project> --report
```

Check the status before setup. Unrelated dirty files need to stay outside the experiment's commit and cleanup paths. Setup establishes the accepted experiment contract. `--benchmark-prints-metric false` tells Autoresearch to time a raw command that does not print its own `METRIC` line. Doctor runs the accepted evaluator as a checked process. Read `state --report` before `next`; its `DecisionPlan` is the authority for whether a packet may run. The first log uses `measure` because nothing has improved yet; it is only the baseline.

## Keep Git and the benchmark honest

Before a later result can be kept, tell Autoresearch which files it may commit:

```bash
node scripts/autoresearch.mjs config --cwd <project> --commit-paths "vitest.config.ts,tests/helpers/"
```

Cleanup after `discard`, `crash`, or `checks_failed` should receive explicit `--revert-paths`; otherwise configured keep paths may define the experiment scope. Do not use `--allow-add-all` unless every dirty file belongs to the experiment.

If the benchmark depends on fixtures or a small contract file, protect those paths so a code change cannot quietly make the test easier:

```bash
node scripts/autoresearch.mjs config --cwd <project> --protected-benchmark-paths "bench.mjs,fixtures/"
```

Secondary constraints are useful when the obvious improvement can hide a known cost:

```bash
node scripts/autoresearch.mjs config --cwd <project> --secondary-metric-constraints "memory_mb <= baseline * 1.05,coverage >= baseline" --secondary-metric-constraint-mode blocking
```

A result that violates a blocking constraint stays provisional even if the primary metric improved.

## Explicit qualitative loops

Docs, UX, architecture, and product research stay direct unless you explicitly want repeated evaluation against a stable accepted checklist. Only in that case, after fit returns `run-loop`, start a research session:

```bash
node scripts/autoresearch.mjs research-start --cwd <project> --slug docs-pass --goal "Make the setup docs clear to a first-time user." --checks-command "npm run docs:check" --commit-paths "docs/"
```

`research-start` creates a scratchpad under `autoresearch.research/<slug>/`, validates the benchmark, and normally records the first baseline as `measure`. When no executable metric exists, `quality_gap` is primary. When the project already has an executable outcome metric, that metric stays primary and `quality_gap` becomes secondary acceptance evidence. Pass `--no-baseline-log` if you want to inspect the first checklist before it enters the ledger.

The accepted checks and edit scope are part of the loop contract; replace the example values with commands and paths that represent the project before starting.

The scratchpad keeps sources, judgment, gap candidates, decisions, and deliverables separate. Checking a box does not accept it. Use `gap-decide` with the gap ID, an implemented or rejected decision, evidence, and validation. When the accepted metric reaches zero, that round is closed; the subject may still need another discovery round.

Setup creates several local files and, in Git repositories, transient state under `.git/autoresearch/`. [Concepts](concepts.md#session-files) lists them. The [Walkthrough](walkthrough.md) continues from here with a full measured change.
