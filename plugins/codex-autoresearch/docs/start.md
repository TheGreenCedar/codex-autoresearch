# Start

Use this page for the first five minutes of a Codex Autoresearch session. The goal is to get one honest packet measured, logged, and ready to resume.

## What You Need

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

## Codex Prompt

Broad prompt:

```text
/goal @Codex Autoresearch improve the speed of my indexer's pipeline, while keeping it memory efficient.
```

Codex should call `prompt-plan` first. That turns the natural-language request into inferred metric defaults, safety constraints, experiment lanes, and missing essentials. `prompt-plan` is a draft, read-only planning surface. It can return a proposed setup command, but it does not create session files until `setup` is run, and it does not prove the product claim.

Specific prompt:

```text
/goal @Codex Autoresearch indexing pipeline speed and memory footprint optimization.
Benchmark: npm test -- --runInBand
Metric: seconds, lower is better
Checks: npm test
Scope: test runner config and test helpers only
```

Codex should check Git, create or resume the session, verify the metric, run one packet, and log the decision with ASI. Serve the dashboard when the operator asks for it, when packet freshness matters in the browser, or when the CLI readout is not enough.
Before spending another packet, Codex should read `recommend-next --compact` and clear any operator-checklist, watchdog, runtime-provenance, lane-lifecycle, packet-diagnostic, or finalization-pressure blocker.

## CLI Path

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

`setup-plan` and `prompt-plan` are read-only planning surfaces. `prompt-plan` is only a draft inference from prose; review the proposed metric, benchmark, correctness checks, quality constraints, and claim coverage before `setup`. Use them before `setup` when essentials are ambiguous; skip them when the goal, metric, benchmark, and scope are already known. `serve` is the optional live dashboard handoff and is listed in the full help. Advanced diagnostics such as `onboarding-packet`, `benchmark-lint`, `recommend-next`, and `partial-results` are available with `--help --all` when setup is ambiguous, the dashboard needs inspection, or packet work is blocked.

`benchmark-lint` and `doctor` answer different questions. `benchmark-lint` can pass because the benchmark emits the configured primary `METRIC`; `doctor --check-benchmark --explain` can still block or warn because the worktree is dirty, the active runtime is stale, promotion metadata is missing, finalization/current-tree coverage is unresolved, or other trust checks fail.

After setup, optional stop conditions can be recorded with `config`:

```bash
node scripts/autoresearch.mjs config --cwd <project> --packet-budget 5 --wall-clock-budget-seconds 1800 --budget-note "Stop after the first focused pass."
```

Budget exhaustion is a stop/rescope signal. It does not mean the optimization goal is complete, and Autoresearch does not track API or billing spend without an external integration.

For benchmark-sensitive loops, record the files that define the measurement and any secondary guardrails after the real benchmark is configured:

```bash
node scripts/autoresearch.mjs config --cwd <project> --protected-benchmark-paths "bench.mjs,fixtures/" --secondary-metric-constraints "memory_mb <= baseline * 1.05,coverage >= baseline" --secondary-metric-constraint-mode blocking
```

The primary metric still drives the loop. Secondary metric constraints only guard tradeoffs; blocking constraints turn violating keeps into provisional evidence so finalization cannot promote them silently.

For retrieval, search, ranking, accessibility, safety, data-integrity, or speed work that can break correctness, add a quality constraint or checks command before treating a speed win as product-grade. Lazy behavior and semantic retrieval claims need accuracy or ranking proof, not only a faster primary metric.

Before the first expensive `next`, prove the loop shape cheaply:

- `recommend-next --compact --operator-checklist` names packet work as the next action.
- the benchmark command is the real goal benchmark, not a placeholder recipe.
- `benchmark-lint` proves the primary `METRIC` line can be parsed inside its timeout.
- imported `sessionDecisionCapsule` state is clear, acknowledged, or deliberately being handled.
- the first packet is bounded by timeout, sample, task slice, or command file.
- unrelated dirty files are not part of keep/discard cleanup.

If `recommend-next` returns a `decision-capsule` action, do that action first. Hard capsules refuse generic `next`; bounded-next capsules require an explicit bounded command.

Use `recommend-next --compact` whenever you want exactly one safe next action:

```bash
node scripts/autoresearch.mjs recommend-next --cwd <project> --compact
```

Use `state --report` when you want a compact terminal readout. It returns `report.text` and `report.json` with blocker-first next action, gate quality, runtime drift, dashboard status, packet diagnostics, and portfolio guidance.

## Session Files

| File | Purpose |
| --- | --- |
| `autoresearch.md` | Goal, metric, scope, constraints, decisions, and stop conditions. |
| `autoresearch.jsonl` | Append-only config, packet, metric, status, commit, and ASI history. |
| `autoresearch.config.json` | Runtime settings such as budgets, commit paths, and protected benchmark paths. |
| `autoresearch.sh` or `autoresearch.ps1` | Repeatable benchmark entrypoint. |
| `autoresearch.checks.sh` or `autoresearch.checks.ps1` | Optional correctness checks. |
| `autoresearch.ideas.md` | Deferred hypotheses, avoided lanes, and next-action notes. |
| `autoresearch.last-run.json` | Fallback last-packet record. |
| `autoresearch.research/<slug>/` | Deep-research and quality-gap scratchpad for evidence-backed qualitative work. |
| `autoresearch.pending-transaction.json` | Non-Git fallback receipt for an interrupted log mutation; reconcile it with `autoresearch.jsonl` before continuing. |
| `.git/autoresearch/pending-log-*.json` | Git-private pending log receipts that block unsafe continuation after interrupted keep/discard automation. |

In Git repositories, the pending log-mutation receipt lives under Git's private `.git/autoresearch/` path instead of the worktree.

## First Packet

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
- `commitPaths` and `revertPaths` point only at files owned by the experiment.
- protected benchmark paths are clean unless you are intentionally starting a new segment.
- `state --compact` or `doctor --explain` does not show stale packet, dirty source, runtime drift, pending transaction, or finalization blocker that changes the decision.

Use `measure` for a baseline or diagnostic. Use `keep` only after a changed packet is safe to preserve, and use `discard`, `crash`, or `checks_failed` when the packet does not produce a safe improvement.

## What Good Looks Like

- `doctor` has no blocking issues.
- The benchmark emits the configured primary metric.
- The live dashboard URL is available when a fresh visual readout is needed.
- The last packet is fresh before logging.
- ASI names hypothesis, evidence, rollback reason for rejected paths, and next action.
- Product-grade claims have claim coverage for accuracy, lazy behavior, ranking/correctness, and docs or tests; otherwise the output is an experimental primitive.

---

Previous: [Concepts](concepts.md) · Next: [Operate](operate.md) — resume, dashboard, packet logging, and quality-gap rounds.
