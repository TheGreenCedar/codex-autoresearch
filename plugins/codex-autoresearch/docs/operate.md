# Operate

Use this page while running or resuming a loop. This is the part where discipline matters, because the benchmark will tempt you with numbers and numbers are very good at wearing little fake mustaches.

## Resume

Start with read-only context:

```bash
node scripts/autoresearch.mjs onboarding-packet --cwd <project> --compact
node scripts/autoresearch.mjs recommend-next --cwd <project> --compact
node scripts/autoresearch.mjs doctor --cwd <project> --explain
```

For broad new requests, start with `prompt-plan`, then `onboarding-packet`, `recommend-next`, `state`, `guide`, and `doctor`.

CLI commands return structured content; prefer `--json-full`, `--compact`, or the written session files over scraping prose.

Read `decisionEnvelope` / `resumeAudit` as the resume contract. It should name one authoritative `nextAction` after checking the active segment, historical best, promotion-grade best, latest packet freshness, benchmark/config drift, dirty source drift, quality round, and finalization readiness.

`state --compact`, `recommend-next --compact`, and the dashboard should agree on the same watchdog summary and canonical next-action kind. If they diverge, treat that as a bug rather than a dashboard-only signal.

The resume contract also carries a watchdog summary. By default it treats an eight-hour quiet window as suspicious when there has been no metric movement, no logged decision, no kept commit, or a completed lane result in the active segment. Tune it with `watchdogNoProgressHours` or `watchdogNoProgressSeconds` in config when a project has a different overnight rhythm. If it fires, do not just feed the machine another packet. Inspect the process, finalize kept work, or rescope the segment.

## Operator Checklist

Use the compact operator checklist as the Codex resume handoff after compaction, long-running work, or any point where another agent may inherit the loop:

```bash
node scripts/autoresearch.mjs recommend-next --cwd <project> --compact --operator-checklist
```

The checklist returns one command, one safety reason, one blocker, one evidence role, and one source. Treat it as the shortest safe continuation path: the command says what to do next, the safety reason explains why it outranks another packet, the blocker names the stop condition when one exists, the evidence role says how to use the result, and the source points back to the governance readout that made the call.

Read `operatorChecklist`, `loopContract`, `runtimeProvenance`, `laneLifecycle`, and `packetDiagnostics` when present. If any of them blocks packet work, clear that action before `next`.

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

The command writes `session-digest.md`, `decisions.jsonl`, `quality-gaps.md`, and `evidence-index.json` under `autoresearch.research/<slug>/`. Leave snippets off by default so transcript bodies do not become durable session state.

## Dashboard

Serve the live local readout:

```bash
node scripts/autoresearch.mjs serve --cwd <project>
```

Use it for:

- the chart-led readiness strip: next action, evidence status, lanes, watchdog, and finalization pressure
- decision-envelope summary and one next action
- next safe action and why it is safe
- trust blockers
- watchdog and process-hygiene readouts for quiet windows, active cwd, plugin version, stale snapshots, and server-detection limits
- best kept change and recent failure
- metric trajectory
- measurement points that are trend evidence, not promotion evidence
- setup, gap, packet, log, and finalize readiness
- strategy lanes, fanout status, lane evidence, and plateau guidance
- copyable report and AI handoff packet

Static exports are offline snapshots:

```bash
node scripts/autoresearch.mjs export --cwd <project>
```

If you need fresh state, serve a fresh dashboard. Do not treat an old `file://` export as runtime truth. Use the CLI for setup, packet runs, logging, gap review, export, and finalization.

The process-hygiene panel reports what the snapshot can actually know. It can show active cwd, plugin version, live URL metadata, runtime drift, export age, and dashboard servers started by this process. It cannot enumerate random old localhost servers outside the current process, so that gap is labeled instead of faked.

## Packet Loop

Normal loop:

```bash
node scripts/autoresearch.mjs next --cwd <project>
node scripts/autoresearch.mjs log --cwd <project> --from-last --status keep --description "Describe the kept change"
node scripts/autoresearch.mjs state --cwd <project> --compact
```

`next` is the packet-producing command. `run` is a raw benchmark probe; use it for quick diagnostics, but do not expect `log --from-last` to reuse it.

For shells where inline JSON is fragile, put structured metric metadata and ASI in files:

```bash
node scripts/autoresearch.mjs log --cwd <project> --from-last --status keep --description "Describe the kept change" --metrics-file metrics.json
node scripts/autoresearch.mjs log --cwd <project> --from-last --status keep --description "Describe the kept change" --asi-json-file asi.json
```

If a packet crashes or times out after writing artifact rows, inspect partial results before spending another expensive rerun:

```bash
node scripts/autoresearch.mjs partial-results --cwd <project> --from-last
node scripts/autoresearch.mjs partial-results --cwd <project> --record <candidate-id>
```

Recorded partial results are diagnostic `measure` evidence only. They link the source packet, artifact row, metric provenance, validation status, and evidence-index claim, but they are never promotion-grade evidence.

If `log --from-last` says there is no loggable packet or the packet is stale, recover with one of the commands it prints:

```bash
node scripts/autoresearch.mjs next --cwd <project>
node scripts/autoresearch.mjs log --cwd <project> --metric <value> --status measure --description "Diagnostic measurement"
```

Statuses:

- `keep`: finite metric and a change worth preserving.
- `discard`: finite metric but not worth keeping.
- `measure`: finite metric for baselines, no-change checks, or diagnostics. It updates trend/latest/baseline readouts, but never stages, commits, reverts, counts as a keep, or becomes finalizer evidence.
- `crash`: benchmark failed before usable metric evidence.
- `checks_failed`: metric exists but correctness checks failed.

Logged runs carry an evidence status. Defaults are `accepted` for `keep`, `provisional` for `measure`, and `rejected` for discard/crash/check failures. Override with `--evidence-status` only when the evidence role really differs; rejected or quarantined artifacts must stay non-promotable.

After logging, read the continuation result. If `shouldContinue` is true, choose the next hypothesis from ASI, experiment memory, `autoresearch.ideas.md`, or dashboard lane guidance. If `forbidFinalAnswer` is true, continue the loop with progress updates instead of returning a final report — a finite active budget counts.

## Parallel Research Lanes

When a loop is spending hours on one serial idea path, create a generic fanout plan instead of inventing a one-off metric:

```bash
node scripts/autoresearch.mjs research-fanout --cwd <project> --dry-run
node scripts/autoresearch.mjs research-fanout --cwd <project> --lanes 6 --yes
node scripts/autoresearch.mjs lane-runner --cwd <project> --lane-id read-only-scout --summary "Evidence found" --recommendation "Run one measured packet for the chosen hypothesis" --yes
```

The plan uses current ASI and experiment memory to propose read-only scout lanes, benchmark-contract checks, isolated implementation candidates, and promotion-readiness lanes. Fanout plans are segment-scoped: after `new-segment`, run a fresh `research-fanout --yes` for the new segment or rely on memory/default lanes until you do. `state --compact` exposes `fanoutProvenance` so you can see whether the active segment has a matching plan.

Dispatch scout lanes in parallel first. `lane-runner` records or runs one lane with a bounded time budget and returns one coordinator recommendation for the next measured packet. Completed lane results update lane status and count as watchdog progress. Read-only scout lanes do not need a worktree, block commands that look mutating, and fail closed outside Git when running commands unless `--allow-non-git-command` is explicitly passed. Implementation lanes must pass `--worktree <path>` or `--write-scope <paths>` before they can run.

## ASI

ASI is the small structured memory object saved with a packet decision. It is not magic. It is just the useful context the next run needs so it does not walk straight back into the same wall.

Use ASI to make the next agent smarter:

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

## Quality Gap Loops

For broad research, product study, docs, UX, and architecture:

```bash
node scripts/autoresearch.mjs research-setup --cwd <project> --slug <slug> --goal "<goal>"
node scripts/autoresearch.mjs quality-gap --cwd <project> --research-slug <slug> --list
node scripts/autoresearch.mjs gap-candidates --cwd <project> --research-slug <slug>
```

The scratchpad lives under `autoresearch.research/<slug>/`:

| File or folder | Role |
|---|---|
| `brief.md` | Request, audience, constraints, and success criteria |
| `plan.md` and `tasks.md` | Independent work streams |
| `sources.md` | Source, date checked, supported claim, and confidence |
| `synthesis.md` | Current merged answer |
| `quality-gaps.md` | Accepted checklist measured by the loop |
| `notes/` and `deliverables/` | Evidence and requested artifacts |

`quality_gap=0` closes the accepted checklist for the current round. It does not mean discovery is permanently complete. It means this pile is done. There may be another pile. There is usually another pile.

The state/dashboard readout also exposes `qualityRound.closed`, `freshRoundSuggested`, and plateau reasons. A closed round means decide whether to scout the next round, remove a constraint, or start a new segment; it is not a universal victory bell.

## Fresh Segment

When a session is maxed, stale, or deliberately entering a new phase:

```bash
node scripts/autoresearch.mjs new-segment --cwd <project> --dry-run
node scripts/autoresearch.mjs new-segment --cwd <project> --reason "fresh phase" --yes
```

This appends a new config segment to `autoresearch.jsonl` and preserves old history.

Repeated exact-score shelves, max-iteration/tool-cap states, benchmark/config drift, or a quality round that needs fresh discovery should recommend scout/constraint-removal/new-segment work before another near-neighbor tweak.

## Finalization Pressure

Kept commits are not a points system. They are review backlog. When kept runs, missing commit metadata, finalization warnings, or watchdog pressure stack up, the dashboard marks finalization pressure and pushes `finalize-preview` or rescoping ahead of more packets. That does not create branches by itself. It is a shove toward review while the evidence is still warm.

---

Previous: [Start](start.md) · Next: [Trust](trust.md) — metric integrity, drift, and Git safety.
