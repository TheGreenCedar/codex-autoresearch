# Concepts

You do not need this glossary to start. Use it when a command or dashboard label is unfamiliar.

## The everyday terms

| Term | Meaning |
| --- | --- |
| **Packet** | One benchmark run plus its evidence. `next` writes the reusable packet used by `log --from-last`. |
| **Primary metric** | The `METRIC name=value` number that decides whether the attempt improved. |
| **Checks** | A separate command that tests correctness. A better metric with failed checks is not a keep. |
| **Structured experiment note (`asi`)** | The note saved with a decision: hypothesis, evidence, rollback reason, next action, and optional lane/risk metadata. |
| **Continuation** | The answer returned after logging: continue, stop, repair, change segment, or finalize. |
| **Segment** | A comparable chapter of the session. Start a new one when the benchmark, metric, direction, or phase changes. |
| **Quality gap** | An accepted checklist item for qualitative work. `quality_gap=0` closes the current round's checklist. |
| **Finalization** | The process that turns accepted, current keeps into reviewable branches. Its exceptional current-tree recovery mode instead packages an explicitly reviewed clean branch diff. Both start with review before mutation. |

## Packet decisions

| Status | Use it when | Can feed finalization? |
| --- | --- | --- |
| `measure` | Baseline, no-change check, environment probe, or diagnostic result | No |
| `keep` | A finite metric, passing checks, and a change worth preserving | Yes, when the evidence is accepted and current |
| `discard` | The packet measured successfully but the change is not worth keeping | No |
| `crash` | The benchmark failed before producing usable metric evidence | No |
| `checks_failed` | The metric exists, but correctness checks failed | No |

`keep`, `discard`, and `measure` need a finite primary metric. `crash` and `checks_failed` must not invent a zero or sentinel value.

Logging `discard`, `crash`, or `checks_failed` can clean the configured or explicitly supplied experiment paths. `measure` is the only status that always records the decision without staging, committing, or reverting source.

Evidence status is separate from the packet decision. A run can be `accepted`, `rejected`, `provisional`, or `superseded`. Quarantined evidence may appear in audit history, but it is not a value accepted by `--evidence-status`.

## Session files

| Path | What it contains |
| --- | --- |
| `autoresearch.md` | Goal, metric, scope, constraints, decisions, and stop conditions |
| `autoresearch.jsonl` | Append-only config and packet ledger |
| `autoresearch.config.json` | Budgets, commit paths, protected benchmark paths, and runtime options |
| `autoresearch.sh` or `autoresearch.ps1` | Repeatable benchmark entrypoint |
| `autoresearch.checks.sh` or `autoresearch.checks.ps1` | Optional correctness command |
| `autoresearch.ideas.md` | Deferred ideas, failed paths, and next actions |
| `autoresearch.research/<slug>/` | Sources, synthesis, quality gaps, and deliverables for qualitative work |
| `.git/autoresearch/last-run.json` | Reusable packet written by `next` in a Git repo |
| `.git/autoresearch/progress.json` | Progress snapshot for a slow packet in a Git repo |
| `.git/autoresearch/pending-log-*.json` | Interrupted log receipts that block unsafe continuation |

Outside Git, the three transient records fall back to `autoresearch.last-run.json`, `autoresearch.progress.json`, and `autoresearch.pending-transaction.json` in the worktree.

## Trust terms

| Term | What it tells you |
| --- | --- |
| **Trust blocker** | A condition that makes another packet or final claim unsafe: stale packet, dirty Git scope, benchmark drift, corrupt ledger, or runtime mismatch. |
| **Protected benchmark path** | A benchmark or fixture path that must not change silently while results are compared. |
| **Runtime provenance** | Whether the command ran from the source checkout or an installed plugin, and whether those builds match. |
| **Packet diagnostics** | Evidence loss such as missing citations, failed synthesis, or a benchmark failure hidden behind an optimistic summary. |
| **Claim coverage** | The checks and measurements required to support the exact claim you want to make. |
| **Promotion evidence** | Repeat, holdout, breadth, or explicit gate evidence that supports more than a local exploratory result. |

See [Trust](trust.md) for the rules behind these labels.

## State fields

Most sessions need only the blocker and next command printed by `state --report`. This table is for debugging compact JSON or checking CLI/dashboard agreement.

| Field | Question it answers |
| --- | --- |
| `goalFrame`, `goalContract` | Are the durable goal, current prompt, benchmark, and final claim still aligned? |
| `operatorHandoff`, `operatorChecklist` | What is the shortest safe continuation after a pause or handoff? |
| `loopContract` | Is another packet allowed? |
| `sessionDecisionCapsule` | Did imported session evidence constrain the next action? |
| `decisionEnvelope`, `resumeAudit` | Do segment, drift, and readiness checks agree on one action? |
| `runtimeProvenance`, `runtimeDriftSummary` | Did this proof come from the runtime you think it did? |
| `gateQuality`, `preflight`, `resourcePreflight` | Are benchmark, Git, runtime, process, and budget checks healthy? |
| `sourceCleanliness` | Are source files dirty, or only session artifacts? |
| `evidenceMaturity`, `researchIntegrity` | What strength of claim does the evidence support? |
| `packetDiagnostics` | Was evidence lost or misclassified inside a packet? |
| `portfolioRecommendation`, `finalizationPressure` | Should the session continue, pivot, or package kept work? |
| `laneLifecycle`, `laneOrchestration`, `fanoutProvenance` | What parallel lanes exist, and does the current segment own them? |
| `finalizationRunway` | Is the work only previewed, local, pushed, in CI, merged, or cleanup-ready? |
| `approvalLedger` | Does the current gate have an unexpired approval for the same scope? |
| `scaffoldHealth` | Are wrappers, commit paths, or Git locks broken? |
| `metricSemanticsWarning` | Are current and historical numbers no longer directly comparable? |
| `qualityRound` | Is the current checklist closed, and should discovery start another round? |

Cross-surface ownership is documented in [Control plane](control-plane.md).
