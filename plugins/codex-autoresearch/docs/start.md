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
Use Codex Autoresearch to improve the speed of my indexer's pipeline, while keeping it memory efficient.
```

Codex should call `prompt-plan` first. That turns the natural-language request into inferred metric defaults, safety constraints, experiment lanes, missing essentials, and a read-only setup command.

Specific prompt:

```text
Use Codex Autoresearch for indexing pipeline speed and memory footprint optimization.
Benchmark: npm test -- --runInBand
Metric: seconds, lower is better
Checks: npm test
Scope: test runner config and test helpers only
```

Codex should check Git, create or resume the session, verify the metric, serve the dashboard, run one packet, and log the decision with ASI.
Before spending another packet, Codex should read `recommend-next --compact` and clear any operator-checklist, watchdog, runtime-provenance, lane-lifecycle, packet-diagnostic, or finalization-pressure blocker.

## CLI Path

From `plugins/codex-autoresearch`:

```bash
node scripts/autoresearch.mjs setup --cwd <project> --name "Runtime loop" --metric-name seconds --direction lower --benchmark-command "npm test -- --runInBand"
node scripts/autoresearch.mjs doctor --cwd <project> --check-benchmark --explain
node scripts/autoresearch.mjs next --cwd <project>
node scripts/autoresearch.mjs log --cwd <project> --from-last --status keep --description "Describe the kept change"
node scripts/autoresearch.mjs state --cwd <project> --report
node scripts/autoresearch.mjs finalize-preview --cwd <project>
```

Happy path: `setup -> doctor -> next -> log -> state -> finalize-preview`.

`serve` is the live dashboard handoff and is listed in the full help. Advanced diagnostics such as `prompt-plan`, `onboarding-packet`, `setup-plan`, `benchmark-lint`, `recommend-next`, and `partial-results` are available with `--help --all` when setup is ambiguous, the dashboard needs inspection, or packet work is blocked.

Optional stop conditions can be recorded during setup:

```bash
node scripts/autoresearch.mjs setup --cwd <project> --name "Runtime loop" --metric-name seconds --packet-budget 5 --wall-clock-budget-seconds 1800 --budget-note "Stop after the first focused pass."
```

Budget exhaustion is a stop/rescope signal. It does not mean the optimization goal is complete, and Autoresearch does not track API or billing spend without an external integration.

For benchmark-sensitive loops, record the files that define the measurement and any secondary guardrails up front:

```bash
node scripts/autoresearch.mjs setup --cwd <project> --name "Runtime loop" --metric-name seconds --protected-benchmark-paths "bench.mjs,fixtures/" --secondary-metric-constraints "memory_mb <= baseline * 1.05,coverage >= baseline" --secondary-metric-constraint-mode blocking
```

The primary metric still drives the loop. Secondary metric constraints only guard tradeoffs; blocking constraints turn violating keeps into provisional evidence so finalization cannot promote them silently.

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
| `autoresearch.sh` or `autoresearch.ps1` | Repeatable benchmark entrypoint. |
| `autoresearch.checks.sh` or `autoresearch.checks.ps1` | Optional correctness checks. |
| `autoresearch.ideas.md` | Deferred hypotheses, avoided lanes, and next-action notes. |
| `autoresearch.last-run.json` | Fallback last-packet record. |

## First Packet

Run:

```bash
node scripts/autoresearch.mjs next --cwd <project>
```

Then log from the last packet:

```bash
node scripts/autoresearch.mjs log --cwd <project> --from-last --status keep --description "Baseline packet"
```

Use `measure` for a baseline or diagnostic, and `discard`, `crash`, or `checks_failed` when the packet does not produce a safe improvement.

## What Good Looks Like

- `doctor` has no blocking issues.
- The benchmark emits the configured primary metric.
- The live dashboard URL is available.
- The last packet is fresh before logging.
- ASI names hypothesis, evidence, rollback reason for rejected paths, and next action.

---

Previous: [Concepts](concepts.md) · Next: [Operate](operate.md) — resume, dashboard, packet logging, and quality-gap rounds.
