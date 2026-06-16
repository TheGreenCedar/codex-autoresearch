# Start

Get one honest packet measured, logged, and ready to resume in about five minutes.

## What you need

- a target repo or child package
- one goal
- one primary metric
- a benchmark command or recipe
- optional correctness checks
- a scoped file surface for commits and reverts
- Codex plugin marketplace access
- Git for reviewable kept work
- Node.js 24 or newer, plus npm, when developing the local source checkout

The benchmark must print:

```text
METRIC name=value
```

Example:

```text
METRIC seconds=12.34
METRIC memory_mb=410
```

The configured primary metric drives keep/discard decisions. `measure` records baseline or diagnostic evidence without promotion. Secondary metrics explain tradeoffs.

## Codex prompt

Broad prompt:

```text
/goal @Codex Autoresearch improve the speed of my indexer's pipeline, while keeping it memory efficient.
```

Codex will likely call `prompt-plan` first to infer metric defaults, safety constraints, experiment lanes, and missing essentials. `prompt-plan` is read-only — it does not create session files until `setup` runs.

Specific prompt:

```text
/goal @Codex Autoresearch indexing pipeline speed and memory footprint optimization.
Benchmark: npm test -- --runInBand
Metric: seconds, lower is better
Checks: npm test
Scope: test runner config and test helpers only
```

Ask for the live dashboard when you want a visual readout or fresh browser state. Before another packet, read `state --report` or `recommend-next --compact` and clear any blockers it names. Field names are in [state-fields](concepts.md#state-fields).

## CLI path

From `plugins/codex-autoresearch`:

```bash
# Optional read-only planning; choose setup-plan for structured inputs or prompt-plan for prose.
node scripts/autoresearch.mjs setup-plan --cwd <project> --name "Runtime loop" --metric-name seconds --direction lower --benchmark-command "npm test -- --runInBand"
node scripts/autoresearch.mjs prompt-plan --cwd <project> --prompt "Improve runtime loop speed while preserving correctness."
node scripts/autoresearch.mjs setup --cwd <project> --name "Runtime loop" --metric-name seconds --direction lower --benchmark-command "npm test -- --runInBand"
node scripts/autoresearch.mjs doctor --cwd <project> --check-benchmark --explain
node scripts/autoresearch.mjs next --cwd <project>
node scripts/autoresearch.mjs log --cwd <project> --from-last --status measure --description "Baseline measurement"
node scripts/autoresearch.mjs state --cwd <project> --report
node scripts/autoresearch.mjs finalize-preview --cwd <project>
```

Happy path: `setup -> doctor -> next -> log -> state -> finalize-preview`.

`setup-plan` and `prompt-plan` are read-only. Use them when essentials are ambiguous; skip them when goal, metric, benchmark, and scope are already known. `serve` is the optional live dashboard handoff. Advanced diagnostics (`onboarding-packet`, `benchmark-lint`, `recommend-next`, `partial-results`) are on `--help --all`.

`benchmark-lint` and `doctor` answer different questions. `benchmark-lint` can pass because the benchmark emits the configured primary `METRIC`; `doctor --check-benchmark --explain` can still block because the worktree is dirty, runtime is stale, promotion metadata is missing, or other trust checks fail.

After setup, optional stop conditions:

```bash
node scripts/autoresearch.mjs config --cwd <project> --packet-budget 5 --wall-clock-budget-seconds 1800 --budget-note "Stop after the first focused pass."
```

Budget exhaustion is a stop/rescope signal — not proof the optimization goal is complete. Autoresearch does not track API or billing spend without an external integration.

For benchmark-sensitive loops, record protected paths and secondary guardrails after the real benchmark is configured:

```bash
node scripts/autoresearch.mjs config --cwd <project> --protected-benchmark-paths "bench.mjs,fixtures/" --secondary-metric-constraints "memory_mb <= baseline * 1.05,coverage >= baseline" --secondary-metric-constraint-mode blocking
```

The primary metric still drives the loop. Blocking secondary constraints turn violating keeps into provisional evidence so finalization cannot promote them silently.

For retrieval, search, ranking, accessibility, safety, or speed work that can break correctness, add a quality constraint or checks command before treating a speed win as product-grade.

In Git repositories, set the commit and revert scope before the first packet that might become a keep:

```bash
node scripts/autoresearch.mjs config --cwd <project> --commit-paths "src/hot-path.ts,tests/hot-path.test.ts" --revert-paths "src/hot-path.ts,tests/hot-path.test.ts"
```

Use `log --commit-paths ...` for a one-off keep when you cannot set durable scope yet. Leave scope empty only when every dirty source file belongs to the packet and you are intentionally using `--allow-add-all`.

Use `recommend-next --compact` when you want exactly one safe next action:

```bash
node scripts/autoresearch.mjs recommend-next --cwd <project> --compact
```

Use `state --report` for a compact terminal readout (`report.text` and `report.json`): blockers first, then next action, gate quality, runtime drift, dashboard status, and packet diagnostics.

## Session files

| File | Purpose |
| --- | --- |
| `autoresearch.md` | Goal, metric, scope, constraints, decisions, and stop conditions. |
| `autoresearch.jsonl` | Append-only config, packet, metric, status, commit, and ASI history. |
| `autoresearch.config.json` | Runtime settings such as budgets, commit paths, and protected benchmark paths. |
| `autoresearch.sh` or `autoresearch.ps1` | Repeatable benchmark entrypoint. |
| `autoresearch.checks.sh` or `autoresearch.checks.ps1` | Optional correctness checks. |
| `autoresearch.ideas.md` | Deferred hypotheses, avoided lanes, and next-action notes. |
| `autoresearch.last-run.json` | Fallback last-packet record. |
| `autoresearch.research/<slug>/` | Deep-research and quality-gap scratchpad. |
| `autoresearch.pending-transaction.json` | Non-Git fallback receipt for an interrupted log mutation. |
| `.git/autoresearch/pending-log-*.json` | Git-private pending log receipts that block unsafe continuation. |

In Git repositories, the pending log-mutation receipt lives under `.git/autoresearch/` instead of the worktree.

## First packet

Run:

```bash
node scripts/autoresearch.mjs next --cwd <project>
```

Then log from the last packet:

```bash
node scripts/autoresearch.mjs log --cwd <project> --from-last --status measure --description "Baseline measurement"
```

Before any mutating log, keep, discard, or revert-producing command, check Git state and scope:

- `git status --short` has no unrelated source changes mixed into the packet.
- `commitPaths` and `revertPaths` point only at files owned by the experiment, or the mutating `log` call passes explicit `--commit-paths` / `--revert-paths`.
- protected benchmark paths are clean unless you are intentionally starting a new segment.
- `state --compact` or `doctor --explain` does not show stale packet, dirty source, runtime drift, pending transaction, or finalization blocker that changes the decision.

Use `measure` for a baseline or diagnostic. Use `keep` only after a changed packet is safe to preserve. Use `discard`, `crash`, or `checks_failed` when the packet does not produce a safe improvement.

## What good looks like

- `doctor` has no blocking issues.
- The benchmark emits the configured primary metric.
- The live dashboard URL is available when a fresh visual readout is needed.
- The last packet is fresh before logging.
- ASI names hypothesis, evidence, rollback reason for rejected paths, and next action.
- Product-grade claims have claim coverage; otherwise the output is an experimental primitive. See [Finish](finish.md).

---

Previous: [Concepts](concepts.md) · Next: [Walkthrough](walkthrough.md) — narrated end-to-end loop.
