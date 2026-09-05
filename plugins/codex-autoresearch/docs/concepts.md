# Concepts

You do not need this glossary to start. Use it when a command or dashboard label is unfamiliar.

## The everyday terms

| Term | Meaning |
| --- | --- |
| **Fit decision** | The read-only route taken before repository discovery: continue directly, ask for missing or conflicting contract inputs, or run a loop. |
| **Direct evidence capsule** | The assist-only path: state the outcome and uncertainty, gather the cheapest useful evidence, do the task, verify it, and bound the claim without creating Autoresearch state. |
| **Experiment contract** | The accepted goal, repository and checkout identity, typed metric, evaluator, independent checks, scope, noise, keep and stop rules, and budgets. It is the sole execution authority. |
| **DecisionPlan** | The canonical phase, action, blocker, loop and parent dispositions, contract and evaluator identities, capabilities, and required evidence compiled from one coherent snapshot. |
| **Packet** | One benchmark run plus its evidence. `next` writes the reusable packet used by `log --from-last`. |
| **Primary metric** | The `METRIC name=value` number interpreted by explicit minimize, maximize, or threshold semantics. Its name has no semantic effect. |
| **Checks** | Independent accepted execution specifications that protect correctness. Their code, fixtures, and expected outputs sit outside editable scope or in protected scope. |
| **Structured experiment note (`asi`)** | The note saved with a decision: hypothesis, evidence, rollback reason, next action, and optional lane/risk metadata. |
| **Continuation** | A compatibility projection from the resulting `DecisionPlan` after logging. It is not a separate policy authority. |
| **Segment** | A comparable chapter of the session. Start a new one when the benchmark, metric, direction, or phase changes. |
| **Quality gap** | A stable qualitative-work item. A checked box is provisional until an implemented or rejected `gap-decide` record supplies evidence and validation. `quality_gap=0` closes only that accepted round. |
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

Every run also keeps three independent facts:

| Axis | Values | Why it matters |
| --- | --- | --- |
| Purpose | baseline, candidate, holdout, diagnostic | Only candidates can authorize keeps; baselines and candidates consume packet budget. |
| Evaluation authority | accepted contract, manual, external | Only accepted-contract evaluation can authorize a measured keep. |
| Candidate origin | working tree, commit OID, none | An imported commit remains provenance until the accepted evaluator and checks evaluate it. |

## Session files

| Path | What it contains |
| --- | --- |
| `.autoresearch/autoresearch.md` | Goal, metric, scope, constraints, decisions, and stop conditions |
| `autoresearch.jsonl` | Append-only config and packet ledger |
| `autoresearch.config.json` | Budgets, commit paths, protected benchmark paths, and runtime options |
| `autoresearch.sh` or `autoresearch.ps1` | Repeatable benchmark entrypoint |
| `autoresearch.checks.sh` or `autoresearch.checks.ps1` | Optional correctness command |
| `.autoresearch/autoresearch.ideas.md` | Deferred ideas, failed paths, and next actions |
| `autoresearch.research/<slug>/` | Sources, synthesis, quality gaps, and deliverables for qualitative work |
| `autoresearch.research/<slug>/quality-gap-decisions.jsonl` | Append-only acceptance decisions for stable gap IDs |
| `.git/autoresearch/last-run.json` | Reusable packet written by `next` in a Git repo |
| `.git/autoresearch/progress.json` | Progress snapshot for a slow packet in a Git repo |
| `.git/autoresearch/pending-log-*.json` | Version-2 staged transaction receipts that make interrupted logging exactly-once and block unsafe continuation |

New sessions keep notes and ideas together in `.autoresearch/`. Existing root-level copies remain in use; if both locations contain the same document, resolve the conflict before continuing. Execution inputs and the ledger retain their existing paths so accepted sessions do not need migration.

Outside Git, the three transient records fall back to `autoresearch.last-run.json`, `autoresearch.progress.json`, and `autoresearch.pending-transaction.json` in the worktree. In a Git repository they use one preflighted `.git/autoresearch/` store; conflicting Git-private and fallback copies block instead of choosing whichever file is newest.

## Trust terms

| Term | What it tells you |
| --- | --- |
| **Capability blocker** | A diagnostic that blocks only the affected capability: session mutation, packet execution, keep authorization, segment transition, finalization, or a session-dependent parent answer. |
| **Protected benchmark path** | A benchmark or fixture path that must not change silently while results are compared. |
| **Runtime provenance** | Whether the command ran from the source checkout or an installed plugin, and whether those builds match. |
| **Packet diagnostics** | Evidence loss such as missing citations, failed synthesis, or a benchmark failure hidden behind an optimistic summary. |

Timeout proof uses native containment available without a runtime dependency: POSIX commands start in a detached process group and merge bounded recursive `ps` snapshots before graceful and forced signals; Windows merges bounded CIM descendant snapshots around `taskkill /T`. Every tracked PID must disappear before cleanup is reported as proven. Enumeration failure, an oversized tree, changed process identity, or a surviving tracked PID fails closed as `termination_failed`; deliberately reparented descendants that escape before either native snapshot remain an operating-system boundary and must not be treated as safely stopped without separate verification.

Logged packet processes use redacted `process_lifecycle` rows keyed by packet and logical process identity. The resource governor folds rows in ledger order and trusts only the latest state per identity: `started`, `observed-live`, and `termination-failed` block; a later `terminated` row clears the identity. The Git-private progress snapshot supplies the same typed state while a packet is running, so `next` does not dirty a clean tracked ledger before `log`. Old prose about stale PIDs remains readable but produces only a migration warning, never active process state.
| **Claim coverage** | The checks and measurements required to support the exact claim you want to make. |
| **Promotion evidence** | Repeat, holdout, breadth, or explicit gate evidence that supports more than a local exploratory result. |

See [Trust](trust.md) for the rules behind these labels.

## State fields

Most sessions need only the blocker and next command printed by `state --report`. This table is for debugging compact JSON or checking CLI/dashboard agreement.

| Field | Question it answers |
| --- | --- |
| `decisionPlanProjection.decisionId`, `generationId` | Did the semantic decision change, or only the raw source generation? |
| `decisionPlanProjection.phase`, `action`, `primaryBlockerCode` | What phase owns the session, what is the one next action, and why is anything blocked? |
| `decisionPlanProjection.capabilities` | Which mutations, packets, keeps, segment transitions, finalization, or parent answers are allowed? |
| `decisionPlanProjection.loopDisposition`, `parentDisposition` | Is the loop runnable, blocked, paused, or complete, and should the parent continue the loop, continue directly, ask the user, or consider completion? |
| `decisionPlanProjection.contractDigest`, `evaluatorIdentity` | Which accepted contract and evaluator produced this decision? |
| `decisionPlanProjection.requiredEvidence` | What proof remains before the action or claim is authorized? |
| `goalFrame`, `goalContract` | Are the durable goal, current prompt, evaluator, and final claim still aligned? |
| `operatorHandoff`, `operatorChecklist` | What bounded detail supports the canonical action after a pause or handoff? |
| `resolvedDecision`, `loopContract`, `nextAction`, `continuation` | Compatibility outputs projected from `DecisionPlan`; never compiler inputs. |
| `runtimeProvenance`, `runtimeDriftSummary` | Did this proof come from the runtime you think it did? |
| `gateQuality`, `preflight`, `resourcePreflight` | Are benchmark, Git, runtime, process, and budget checks healthy? |
| `sourceCleanliness` | Are source files dirty, or only session artifacts? |
| `evidenceMaturity`, `researchIntegrity` | What strength of claim does the evidence support? |
| `packetDiagnostics` | Was evidence lost or misclassified inside a packet? |
| `portfolioRecommendation`, `finalizationPressure` | Diagnostic or candidate input that informs the compiler; it does not choose the action. |
| `laneLifecycle`, `laneOrchestration`, `fanoutProvenance` | What parallel lanes exist, and does the current segment own them? |
| `finalizationRunway` | Is the work only previewed, local, pushed, in CI, merged, or cleanup-ready? |
| `approvalLedger` | Does the current gate have an unexpired approval for the same scope? |
| `scaffoldHealth` | Are wrappers, commit paths, or Git locks broken? |
| `metricSemanticsWarning` | Are current and historical numbers no longer directly comparable? |
| `qualityRound` | Is the current checklist closed, and should discovery start another round? |
| `stateStorage` | Which private-state store passed preflight, and did any conflicting candidate block mutation? |

Cross-surface ownership is documented in [Control plane](control-plane.md).

Bounded state, doctor, recommendation, terminal, finalization, and dashboard output project the same `DecisionPlan`. The dashboard may redact the executable command, but its semantic fields must match. Legacy decision shapes remain compatibility outputs only. Use `state --json-full` or `doctor --json-full` only when the complete machine diagnostic is necessary.
