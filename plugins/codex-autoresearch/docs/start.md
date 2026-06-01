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
- Node/npm only when developing the local source checkout

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
node scripts/autoresearch.mjs onboarding-packet --cwd <project> --compact
node scripts/autoresearch.mjs prompt-plan --cwd <project> --prompt "Use Codex Autoresearch to improve speed while keeping memory efficient"
node scripts/autoresearch.mjs setup-plan --cwd <project>
node scripts/autoresearch.mjs benchmark-lint --cwd <project> --sample "METRIC seconds=1.23" --metric-name seconds
node scripts/autoresearch.mjs setup --cwd <project> --name "Runtime loop" --metric-name seconds --direction lower --benchmark-command "npm test -- --runInBand"
node scripts/autoresearch.mjs doctor --cwd <project> --check-benchmark --explain
node scripts/autoresearch.mjs serve --cwd <project>
node scripts/autoresearch.mjs next --cwd <project>
node scripts/autoresearch.mjs log --cwd <project> --from-last --status keep --description "Describe the kept change"
```

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
