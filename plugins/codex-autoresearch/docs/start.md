# Start with a baseline

A good Autoresearch session begins with a result you can reproduce before any code changes. You need a goal, a benchmark, one primary metric, a correctness check, and a sensible boundary around the files Codex may edit. The plugin can help fill in missing details, but it cannot decide what "better" means for your product.

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

If the benchmark is not obvious, describe the outcome and ask Codex to propose a measurement first. It can use `prompt-plan` or `setup-plan` to do that without writing session files. Read the proposal before setup. A command that is easy to measure but unrelated to the actual goal is worse than no benchmark at all.

## Start from the CLI

These commands are for a source checkout. If you installed the plugin through Codex, ask `@Codex Autoresearch` to perform this step. To run the commands yourself, clone this repository and change into `plugins/codex-autoresearch`. The `--cwd` value points at the project being improved; it does not have to be the plugin directory. A configured `workingDir` stays inside that project unless the command explicitly includes `--allow-outside-workdir`.

```bash
git -C <project> status --short --branch
node scripts/autoresearch.mjs setup --cwd <project> --name "Test runtime" --metric-name seconds --direction lower --benchmark-command "npm test -- --runInBand" --benchmark-prints-metric false --checks-command "npm test"
node scripts/autoresearch.mjs doctor --cwd <project> --check-benchmark --explain
node scripts/autoresearch.mjs next --cwd <project>
node scripts/autoresearch.mjs log --cwd <project> --from-last --status measure --description "Baseline measurement"
node scripts/autoresearch.mjs state --cwd <project> --report
```

Check the status before setup. Unrelated dirty files need to stay outside the experiment's commit and cleanup paths. Setup then writes the session contract. `--benchmark-prints-metric false` tells Autoresearch to time a raw command that does not print its own `METRIC` line. Doctor runs the cheap trust checks and verifies the resulting metric. `next` records a fresh packet, and the first log uses `measure` because nothing has improved yet; it is only the baseline. The state report then tells you whether the session is ready for an experiment or needs repair first.

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

## Qualitative work

Docs, UX, architecture, and product research do not always have a natural performance metric. For those, start a research session with an accepted checklist:

```bash
node scripts/autoresearch.mjs research-start --cwd <project> --slug docs-pass --goal "Make the setup docs clear to a first-time user."
```

`research-start` creates a scratchpad under `autoresearch.research/<slug>/`, configures the `quality_gap` benchmark, validates it, and normally records the first baseline as `measure`. Pass `--no-baseline-log` if you want to inspect that first checklist before it enters the ledger.

When the correctness command or edit scope is already known, pass `--checks-command` and `--commit-paths` to `research-start`. Otherwise configure them before the first keep.

The scratchpad keeps sources, judgment, accepted gaps, and deliverables separate. When the metric reaches zero, the accepted checklist for that round is closed. It does not mean the subject has been exhausted.

Setup creates several local files and, in Git repositories, transient state under `.git/autoresearch/`. [Concepts](concepts.md#session-files) lists them. The [Walkthrough](walkthrough.md) continues from here with a full measured change.
