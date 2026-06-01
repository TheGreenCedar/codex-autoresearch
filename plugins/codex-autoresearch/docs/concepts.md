# Concepts

Quick definitions for terms used across the docs. Each links to the page where the concept lives in detail.

## Packet

One measured experiment cycle: make a change, run the benchmark, observe the metric, decide keep, discard, measure, crash, or checks_failed. A packet is the atomic unit of progress in an autoresearch loop. See [Operate](operate.md#packet-loop).

## ASI

Accumulated Structured Intelligence. The structured memory object attached to each packet decision: hypothesis, evidence, rollback reason, next action hint, and optional lane/family/risk metadata. It tells the next session what happened and what path deserves the next measured attempt. See [Operate](operate.md#asi).

## Metric

A named numeric value printed by the benchmark as `METRIC name=value`. The configured **primary metric** drives keep/discard decisions. **Secondary metrics** explain tradeoffs but do not judge. See [Trust](trust.md#metric-integrity).

## Segment

A chapter of an autoresearch session. When a session is maxed, stale, or entering a new phase, `new-segment` starts a fresh run segment while preserving old ledger history. See [Operate](operate.md#fresh-segment).

## Continuation

The state returned after logging a packet. Contains `shouldContinue` (whether the loop should keep running) and `forbidFinalAnswer` (whether the agent must continue instead of returning a final report). See [Operate](operate.md#packet-loop).

## Operator Checklist

A compact handoff from `recommend-next --compact --operator-checklist`. It names one command, one safety reason, one blocker, one evidence role, and one source so a resumed Codex session can continue without re-deciding the whole loop. See [Operate](operate.md#operator-checklist).

## Goal Frame

The compact resume object that names the durable Autoresearch goal as authoritative and classifies a fresh Codex/user prompt as missing, matching, an operator instruction, or a different research goal. Use `goalFrame.authoritativeGoal` before stating the loop objective. See [Operate](operate.md#resume).

## Operator Handoff

The compact state summary for resumed Codex work. It carries the research-goal line, next action, blocker, and command selected from compact loop governance so a new session can continue without turning the latest prompt into the research goal. See [Operate](operate.md#resume).

## Loop Contract

The governance readout that decides whether another packet is allowed. It can route to setup repair, context distillation, lane cleanup, runtime provenance, packet diagnostics, finalization, segment transition, or a fresh packet. See [Operate](operate.md#operator-checklist).

## Watchdog

A no-progress signal. By default, an eight-hour quiet window with no metric movement, logged decision, kept commit, or completed lane result is suspicious. When it fires, inspect the process, finalize useful work, or rescope before running another packet. See [Operate](operate.md#resume).

## Lane

A strategic category for experiments. Lanes like `distant-scout`, `local-tweak`, or `architectural` help the dashboard track which exploration strategies are producing results and which are plateauing. Set via ASI metadata.

## Fanout Plan

A segment-scoped plan from `research-fanout` that proposes read-only scout lanes, benchmark-contract checks, implementation candidates, and promotion-readiness lanes. Recording a plan with `--yes` appends it to the ledger. See [Operate](operate.md#parallel-research-lanes).

## Parallel Lane

A bounded lane recorded or run with `lane-runner`. Read-only scout lanes do not need a worktree and fail closed for non-Git commands unless explicitly allowed. Implementation lanes need a worktree or write scope before running mutating commands. See [Operate](operate.md#parallel-research-lanes).

## Family

A grouping for related experiments within a lane. For example, a `parser-cache` family within a `local-tweak` lane. Helps identify when a specific approach has been exhausted. Set via ASI metadata.

## Quality Gap

A checklist-driven loop for broad, qualitative work: product study, docs, UX, architecture. Accepted findings become checklist items; `quality_gap=0` means the current round's checklist is closed — not that discovery is complete. See [Operate](operate.md#quality-gap-loops).

## Trust Blocker

A dashboard-visible condition that makes the current session state untrustworthy: dirty Git, stale packets, benchmark drift, missing metrics, corrupt ledger, or static-export mode. Resolve trust blockers before claiming a result is final. See [Trust](trust.md).

## Runtime Provenance

A source-vs-installed-runtime readout. If source and the installed plugin runtime disagree, inspect the active runtime before claiming source behavior is live. See [Trust](trust.md#runtime-provenance-and-packet-diagnostics).

## Packet Diagnostics

Evidence-loss classification for packets that retrieved data but failed to carry citations, lost claims during synthesis, missed a quality score, or reported sufficiency while the benchmark failed. Treat these as diagnostic evidence, not wins. See [Trust](trust.md#runtime-provenance-and-packet-diagnostics).

## Goal Frame Mismatch

A session-forensics decision signal for moments when the user corrects Codex for treating an operator prompt as the Autoresearch goal. It creates a bounded-next capsule so the next session must restate the durable goal and avoid broad packet work until the handoff is clear. See [Operate](operate.md#operator-checklist).

## Evidence Status

The evidence role attached to a logged run. CLI `--evidence-status` accepts `accepted`, `rejected`, `provisional`, or `superseded`. Quarantined artifacts may appear in audit readouts, but `quarantined` is not a `--evidence-status` value. Finalization uses only accepted/current keeps. See [Operate](operate.md#packet-loop).

## Benchmark Drift

When current benchmark output is significantly worse than the historical best. This can mean the environment changed, a dependency shifted, or the previous best was measured under different conditions. Treat the old best as history, not current proof. See [Trust](trust.md#benchmark-drift).

## Session Files

The durable state files written into the target project:

| File | Purpose |
|---|---|
| `autoresearch.md` | Goal, metric, scope, constraints, decisions, and stop conditions |
| `autoresearch.jsonl` | Append-only ledger: config, packets, metrics, status, commits, ASI |
| `autoresearch.sh` / `.ps1` | Repeatable benchmark entrypoint |
| `autoresearch.checks.sh` / `.ps1` | Optional correctness gate |
| `autoresearch.ideas.md` | Deferred hypotheses, rejected lanes, next-action notes |
| `autoresearch.last-run.json` | Fallback last-packet record |

See [Start](start.md#session-files).

## Finalization

The process of extracting useful kept commits from noisy loop history into clean, reviewable branches. Preview is read-only; branch creation requires approval. See [Finish](finish.md).

---

Next: [Start](start.md) — first five minutes, session files, benchmark contract, and first packet.
