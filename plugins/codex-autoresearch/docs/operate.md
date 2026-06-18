# Operate

Use this page while running or resuming a loop. The benchmark is useful only when the next action is backed by current evidence.

## Resume

Start with read-only context:

```bash
node scripts/autoresearch.mjs onboarding-packet --cwd <project> --compact
node scripts/autoresearch.mjs state --cwd <project> --compact
node scripts/autoresearch.mjs state --cwd <project> --report
node scripts/autoresearch.mjs recommend-next --cwd <project> --compact
node scripts/autoresearch.mjs doctor --cwd <project> --explain
```

For broad qualitative new requests, `research-start --cwd <project> --slug <slug> --goal "<goal>"` is the golden path. It keeps scratchpad seeding, `quality_gap` setup, benchmark validation, first baseline measurement, and resume commands together. Use `prompt-plan` first when you need read-only planning before creating files.

CLI commands return structured content; prefer `--json-full`, `--compact`, or the written session files over scraping prose.

### Resume readout — what to check

Read `state --report` top-down: blockers, next action, next command, then supporting context. Field names are in [state-fields](concepts.md#state-fields).

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| Next action says repair, not `next` | Goal mismatch, decision capsule, or loop contract block | Follow the named command; see [Resume checklist](#resume-checklist) |
| `source-dirty` | Unrelated source files in the worktree | Clean, stash, or scope dirty files before keep/discard or finalization |
| `session-artifacts-dirty` only | `autoresearch.*` or research scratchpad files dirty | Safe for read/run work; stash or commit session files before branch-changing finalization |
| Dashboard liveness missing | No served dashboard or stale export | Run `serve --cwd <project>`; do not trust an old `file://` export |
| Watchdog fired | Eight-hour quiet window with no progress | Inspect process, finalize kept work, or rescope — do not blindly run another packet |
| `metricSemanticsWarning` | Segment or metric changed | Treat active and historical bests as not directly comparable |
| Gap metric at zero but not promotable | `researchIntegrity` says dev-only | Run finalization preview, promotion gate, or new segment before more same-metric packets |
| Runtime drift reported | Source checkout differs from installed plugin | Inspect active runtime before claiming source behavior is live |

`goalFrame.authoritativeGoal` and `operatorHandoff.goal` are the research objective on resume. The latest prompt is an instruction unless goal-frame data says it matches the durable goal. A mismatched objective blocks broad packet and finalization work until repaired.

## Budgets

Setup can record `packetBudget`, `wallClockBudgetSeconds`, and `budgetNote`. Exhausted budgets are stop/rescope signals: extend the budget, start a new segment, preview finalization, or decide what to trade off next.

```bash
node scripts/autoresearch.mjs config --cwd <project> --packet-budget <n>
node scripts/autoresearch.mjs config --cwd <project> --wall-clock-budget-seconds <n>
```

Pass empty values to clear budget fields: `config --packet-budget "" --wall-clock-budget-seconds "" --budget-note ""`.

Packet and wall-clock budgets are not API spend tracking. Autoresearch only tracks configured packet count and elapsed wall-clock unless an external integration supplies separate spend evidence.

## Resume checklist

The compact checklist is the shortest safe continuation path after compaction or a long pause:

```bash
node scripts/autoresearch.mjs recommend-next --cwd <project> --compact --operator-checklist
```

It returns one command, one safety reason, one blocker, one evidence role, and one source. If any governance readout blocks packet work, clear that action before `next`. See [state-fields](concepts.md#state-fields) for field names.

Read existing files before editing:

- `autoresearch.md`
- `autoresearch.jsonl`
- `autoresearch.ideas.md`
- `autoresearch.research/<slug>/` for research loops

When the best evidence lives in a previous Codex session JSONL, import only a bounded capsule:

```bash
node scripts/autoresearch.mjs session-forensics --cwd <project> --session-jsonl <path> --research-slug <slug> --dry-run
node scripts/autoresearch.mjs session-forensics --cwd <project> --session-jsonl <path> --research-slug <slug> --apply
```

The command writes `session-digest.md`, `decisions.jsonl`, `quality-gaps.md`, and `evidence-index.json` under `autoresearch.research/<slug>/`, plus `decision-capsule.json` — a carry-forward note with bottleneck, evidence, next experiment, and wrong next actions. Summarize the one carry-forward conclusion in ASI or `autoresearch.ideas.md` after importing.

Hard capsules block generic `next` and finalization until benchmark repair, a fresh segment, or explicit acknowledgement. Bounded-next capsules allow only explicit bounded packet work such as `next --timeout-seconds <n> --command-file <path>`.

## Friction recovery

When a done claim is rejected because accuracy, lazy behavior, ranking quality, or product-grade proof was not tested, stop packet work and downgrade to an experimental primitive. Run `state --compact` or `recommend-next --compact`, inspect claim coverage, and add missing acceptance proof before finalization uses product-grade language.

When benchmark-contract drift is intentional, use `new-segment` instead of editing the ledger by hand. A fresh segment is the boundary where a new benchmark command, protected path set, metric name, direction, or unit becomes authoritative.

When run numbers duplicate, segments look stale, or manual log entries were edited, inspect the ledger before another packet:

```bash
node scripts/autoresearch.mjs ledger-doctor --cwd <project> --json
```

Use `ledger-doctor --repair --yes` only after reviewing the JSON health summary and deciding the run-number repair is the right fix. After the repair, verify the returned `backupPath` before doing more packet work.

When the dashboard handoff matters:

```bash
node scripts/autoresearch.mjs serve --cwd <project>
```

Use the live URL for fresh status. Use `export` only for a static read-only snapshot.

When exploration output gets oversized, use bounded file reads, `rg` on known paths, `partial-results --from-last`, `session-forensics --dry-run`, or an evidence index — not raw command body dumps.

When a foreground shell has completed and stdin is closed, stop polling that session. Restart only after a precondition changed.

## Dashboard

Serve the live local readout:

```bash
node scripts/autoresearch.mjs serve --cwd <project>
```

Use it for:

- chart-led readiness: next action, evidence status, lanes, watchdog, finalization pressure
- trust blockers and runtime provenance
- best kept change and recent failure
- metric trajectory and lane evidence
- copyable report and handoff packet

Static exports are offline snapshots:

```bash
node scripts/autoresearch.mjs export --cwd <project>
```

The dashboard is a read-only visual aid; setup, packet runs, logging, and finalization stay in the CLI. See [Architecture](architecture.md#dashboard-boundary).

The process-hygiene panel reports what the snapshot can actually know. It cannot enumerate random old localhost servers outside the current process; that gap is labeled instead of faked.

## Packet loop

Do not rerun a heavy packet just because the loop is still open. First check whether a cheaper action suffices: `partial-results --from-last`, `benchmark-inspect`, `benchmark-lint`, `checks-inspect`, `session-forensics --dry-run`, `research-fanout --dry-run`, or a narrower `next --timeout-seconds <n> --command-file <path>`.

`benchmark-lint` must prove the primary `METRIC` contract before product packets are trusted.

Normal loop:

```bash
node scripts/autoresearch.mjs next --cwd <project>
git status --short
node scripts/autoresearch.mjs state --cwd <project> --compact
node scripts/autoresearch.mjs log --cwd <project> --from-last --status keep --description "Describe the kept change"
node scripts/autoresearch.mjs state --cwd <project> --compact
```

The `git status` and `state` checkpoint before `log` is deliberate. Do not let keep/discard automation touch unrelated dirty files, stale packets, pending log transactions, protected benchmark files, or paths outside configured `commitPaths` / `revertPaths`.

`next` is the packet-producing command. `run` is a raw benchmark probe; do not expect `log --from-last` to reuse it.

For shells where inline JSON is fragile:

```bash
node scripts/autoresearch.mjs log --cwd <project> --from-last --status keep --description "Describe the kept change" --metrics-file metrics.json
node scripts/autoresearch.mjs log --cwd <project> --from-last --status keep --description "Describe the kept change" --asi-json-file asi.json
```

If a packet crashes or times out after writing artifact rows:

```bash
node scripts/autoresearch.mjs partial-results --cwd <project> --from-last
node scripts/autoresearch.mjs partial-results --cwd <project> --record <candidate-id>
```

Recorded partial results are diagnostic `measure` evidence only — never promotion-grade.

Packet commands may print optional task manifests:

```text
ARTIFACT task_manifest=out/task-manifest.json
```

Autoresearch indexes task diagnostics inside packet evidence. Malformed manifests or path escapes are quarantined without invalidating unrelated primary metric evidence.

If `log --from-last` says there is no loggable packet or the packet is stale:

```bash
node scripts/autoresearch.mjs next --cwd <project>
node scripts/autoresearch.mjs log --cwd <project> --metric <value> --status measure --description "Diagnostic measurement"
```

Statuses:

- `keep`: finite metric and a change worth preserving.
- `discard`: finite metric but not worth keeping.
- `measure`: finite metric for baselines, no-change checks, or diagnostics. Never stages, commits, reverts, or becomes finalizer evidence.
- `crash`: benchmark failed before usable metric evidence.
- `checks_failed`: metric exists but correctness checks failed.

Logged runs carry an evidence status. Defaults: `accepted` for `keep`, `provisional` for `measure`, `rejected` for discard/crash/check failures. Override with `--evidence-status` only when the evidence role really differs.

After logging, read the continuation result. If the continuation says the loop is still active, continue the loop before treating the run as complete. Choose the next hypothesis from ASI, experiment memory, `autoresearch.ideas.md`, or dashboard lane guidance.

## Parallel research lanes

When a loop spends hours on one serial idea path:

```bash
node scripts/autoresearch.mjs research-fanout --cwd <project> --dry-run
node scripts/autoresearch.mjs research-fanout --cwd <project> --lanes 6 --yes
node scripts/autoresearch.mjs lane-runner --cwd <project> --lane-id read-only-scout --summary "Evidence found" --recommendation "Run one measured packet for the chosen hypothesis" --yes
```

Fanout plans are segment-scoped: after `new-segment`, run a fresh `research-fanout --yes` for the new segment.

Dispatch scout lanes in parallel first. Read-only scout lanes do not need a worktree and fail closed for mutating commands unless explicitly allowed. Implementation lanes need `--worktree <path>` or `--write-scope <paths>` before mutating commands run.

Use `lane-runner --mode big_idea` for distant architecture hypotheses. Big-idea lanes are advice-only and require human approval before measured packet work. `--human-approval` writes a durable scoped approval record; expired or mismatched approvals do not satisfy the current gate.

## ASI

ASI is the structured memory saved with a packet decision — the context the next run needs so it does not repeat the same mistake.

```json
{
  "hypothesis": "What was expected to improve",
  "evidence": "Metric/check proof",
  "rollback_reason": "Why a rejected path should not return",
  "next_action_hint": "The next safest measured step",
  "lane": "distant-scout",
  "family": "parser-cache",
  "risk": "low",
  "expected_delta": "-5% seconds"
}
```

## Quality-gap loops

For broad research, product study, docs, UX, and architecture:

```bash
node scripts/autoresearch.mjs research-start --cwd <project> --slug <slug> --goal "<goal>"
node scripts/autoresearch.mjs quality-gap --cwd <project> --research-slug <slug> --list
node scripts/autoresearch.mjs gap-candidates --cwd <project> --research-slug <slug>
```

`research-start` creates the scratchpad, configures `quality_gap`, validates the command, records the first baseline as `measure`, and prints the resume commands. Add `--no-baseline-log` when the first baseline should stay out of the ledger.

Scratchpad under `autoresearch.research/<slug>/`:

| File or folder | Role |
| --- | --- |
| `brief.md` | Request, audience, constraints, success criteria |
| `plan.md`, `tasks.md` | Independent work streams |
| `sources.md` | Source, date checked, supported claim, confidence |
| `synthesis.md` | Current merged answer |
| `quality-gaps.md` | Accepted checklist measured by the loop |
| `notes/`, `deliverables/` | Evidence and requested artifacts |

`quality_gap=0` closes the accepted checklist for the current round — see [Concepts](concepts.md#quality-gap). The readout also exposes `qualityRound.closed` and `freshRoundSuggested`.

## Fresh segment

When a session is maxed, stale, or entering a new phase:

```bash
node scripts/autoresearch.mjs new-segment --cwd <project> --dry-run
node scripts/autoresearch.mjs new-segment --cwd <project> --reason "fresh phase" --yes
```

This appends a new config segment to `autoresearch.jsonl` and preserves old history. Use it for intentional benchmark-contract changes; run `doctor --check-benchmark --explain` before the next packet.

## Finalization pressure

Kept commits are review backlog. When kept runs, missing commit metadata, finalization warnings, or watchdog pressure stack up, the dashboard marks finalization pressure and pushes `finalize-preview` or rescoping ahead of more packets. That does not create branches by itself.

---

Previous: [Walkthrough](walkthrough.md) · Next: [Trust](trust.md) — metric integrity, drift, and Git safety.
