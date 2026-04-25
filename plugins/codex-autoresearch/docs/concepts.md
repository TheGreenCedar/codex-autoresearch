# Concepts

Quick definitions for terms used across the docs. Each links to the page where the concept lives in detail.

## Packet

One measured experiment cycle: make a change, run the benchmark, observe the metric, decide keep or discard. A packet is the atomic unit of progress in an autoresearch loop. See [Operate](operate.md#packet-loop).

## ASI

Accumulated Structured Intelligence. The structured memory object attached to each packet decision: hypothesis, evidence, rollback reason, next action hint, and optional lane/family/risk metadata. It tells the next session what happened so it does not repeat the same mistake with a fresh face. See [Operate](operate.md#asi).

## Metric

A named numeric value printed by the benchmark as `METRIC name=value`. The configured **primary metric** drives keep/discard decisions. **Secondary metrics** explain tradeoffs but do not judge. See [Trust](trust.md#metric-integrity).

## Segment

A chapter of an autoresearch session. When a session is maxed, stale, or entering a new phase, `new-segment` starts a fresh run segment while preserving old ledger history. See [Operate](operate.md#fresh-segment).

## Continuation

The state returned after logging a packet. Contains `shouldContinue` (whether the loop should keep running) and `forbidFinalAnswer` (whether the agent must continue instead of returning a final report). See [Operate](operate.md#packet-loop).

## Lane

A strategic category for experiments. Lanes like `distant-scout`, `local-tweak`, or `architectural` help the dashboard track which exploration strategies are producing results and which are plateauing. Set via ASI metadata.

## Family

A grouping for related experiments within a lane. For example, a `parser-cache` family within a `local-tweak` lane. Helps identify when a specific approach has been exhausted. Set via ASI metadata.

## Quality Gap

A checklist-driven loop for broad, qualitative work: product study, docs, UX, architecture. Accepted findings become checklist items; `quality_gap=0` means the current round's checklist is closed — not that discovery is complete. See [Operate](operate.md#quality-gap-loops).

## Trust Blocker

A dashboard-visible condition that makes the current session state untrustworthy: dirty Git, stale packets, benchmark drift, missing metrics, corrupt ledger, or static-export mode. Resolve trust blockers before claiming a result is final. See [Trust](trust.md).

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
