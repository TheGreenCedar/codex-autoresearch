# Control-plane contracts

State, doctor, recommendation, continuation, finalization, and dashboard must project one compiled `DecisionPlan`. If they disagree about the phase, blocker, or next action, the disagreement is the bug.

## One decision authority

Every canonical decision includes:

| Field | Meaning |
| --- | --- |
| `decisionId` | Hash of normalized semantic inputs plus the compiler schema version |
| `generationId` | Hash of the raw source version vector |
| `phase` | Current session phase |
| `action` | One canonical action kind and bounded reason |
| `primaryBlockerCode` | Strongest blocker code, independent of explanatory prose |
| `loopDisposition` | Whether the loop is absent, runnable, blocked, paused, or complete |
| `parentDisposition` | Whether the parent should continue the loop, continue directly, ask the user, or consider completion |
| `contractDigest` | Identity of the accepted experiment contract |
| `evaluatorIdentity` | Identity of the accepted evaluator execution specification |
| `requiredEvidence` | Evidence still required for the action or claim |

The terminal and dashboard must agree on decision ID, phase, action kind, blocker code, parent disposition, contract digest, and evaluator identity. The dashboard deliberately strips executable commands.

`resolvedDecision`, `loopContract`, `nextAction`, continuation fields, and dashboard action structures remain compatibility outputs. They are one-way projections from `DecisionPlan`, never inputs to the compiler. Watchdog, portfolio advice, doctor, and older policy helpers may produce diagnostics or candidate inputs; they do not choose the canonical action.

Default projections stay bounded so long sessions remain readable. Use explicit `--json-full` only when a maintainer needs complete machine diagnostics.

## Coherent reads

A session snapshot covers the ledger, config, last packet, transaction receipt, process state, and Git identity. Its version vector includes ledger size, modification time and tail hash; source hashes; Git HEAD; index tree; and status hash.

Read-only commands:

1. Read version vector A.
2. Load and parse every source.
3. Read version vector B.
4. Accept only when A equals B.
5. Retry up to three times, then return `coherent-snapshot-unavailable`.

A timestamp-only change may create a new generation while retaining the same semantic decision. Diagnostic ordering and duplicate prose do not change `decisionId`; a blocker code or contract change does.

Mutating commands acquire the mutation lock before the first snapshot and hold it through mutation and the resulting snapshot. They return a precondition decision, a mutation receipt, and the resulting decision. `doctor --check-benchmark` follows the mutation protocol because it starts a process; pure doctor reads do not.

## Capability-scoped blockers

Diagnostics block capabilities rather than the whole session:

- `mutate-session`
- `run-packet`
- `authorize-keep`
- `transition-segment`
- `finalize`
- `parent-final-answer`

A budget or accepted retry-limit pause blocks `run-packet` while allowing direct work and a bounded final answer. A finalization problem blocks `finalize`, not an unrelated task. Evaluator drift blocks packet execution and keep authorization while allowing an explicit contract transition. A pending or inconsistent log or Git transaction blocks unsafe mutation, finalization, and session-dependent final claims.

The parent-task relationship matters. A session blocker affects `parent-final-answer` only when the current claim depends on that session. An unrelated request stays independent.

## Fit contract

Fit is decided before benchmark discovery, repository scanning, default inference, or setup:

```text
continue-direct | needs-user | run-loop
```

Direct work uses the evidence capsule and creates no session state. An explicit loop with missing or conflicting inputs returns `needs-user`. A matching session requires compatible repository, checkout, goal, metric semantics, evaluator, checks, and scope. Replacement requires explicit intent.

## Experiment and evidence contracts

The accepted `ExperimentContract` is the sole evaluator and checks authority. Its typed metric semantics, canonical commands, environment, working directory, parser, protected inputs, timeouts, noise model, keep and stop rules, and budgets make invalid combinations reject at the boundary. Command overrides must reproduce the accepted execution digest exactly.

Evidence records separate run purpose, evaluation authority, and candidate origin. A keep is authorized mechanically only for a candidate evaluated by the accepted contract, with accepted checks, metric comparison, and noise qualification satisfied. Manual observations and imported commits do not authorize a keep until evaluated under that contract.

Legacy learning records remain visible history. Their prose and unverified references do not authorize continuation or create automatic pauses. Repeated execution failures use the accepted contract's `repeatedFailures.limit` and an exact defect identity (failure code plus registered preconditions). A changed defect or relevant precondition starts a different failure sequence. Governed investigations additionally reserve cumulative resources before work; changing methods cannot restore allowance. Required repeat measurements retain the accepted noise qualification rules.

## Surface disagreement

1. Save the disagreeing outputs.
2. Stop session mutation and session-dependent final claims.
3. Compare decision ID, generation ID, contract digest, evaluator identity, and runtime provenance.
4. Fix the shared source, coherent read, or projection bug.
5. Rerun all affected readouts before continuing.

Field details are listed in [Concepts](concepts.md#state-fields). Persistence and module ownership are documented in [Architecture](architecture.md).

## Measured claims and repeat evidence

Descriptions and next-action hints are explanatory text. They cannot satisfy product-grade or broad-improvement proof, and goal keywords cannot add domain-specific acceptance requirements. Ordinary review receipts describe the accepted measured result; a broader product claim remains unverified.

Non-deterministic keep qualification uses the complete accepted candidate and reference cohorts. Both require repeated observations. Bounded noise must contain each observed range; unknown noise uses observed ranges conservatively and retains adverse samples. These ranges are sampled variability, not confidence intervals. The compatibility `confidence` number is a movement/history-MAD ratio, labeled “Movement / spread” in the dashboard.


The canonical result separates execution completion, measurement validity, hypothesis conclusion, metric movement, criterion attainment, and code acceptance. Valid negative predicate evidence refutes a criterion without becoming a crashed execution. Threshold attainment does not imply improvement, and improvement does not imply attainment or a keep. The compact `result` projection carries these dimensions on every surface; the legacy `outcome` alias describes metric movement (`uncompared` when valid evidence has no comparison).


Governed outcomes add active, blocked, satisfied, and stopped-unmet projections to the same compiler. A satisfied criterion and a resolved hypothesis are separate facts. Delivery-ready means every current criterion is covered; satisfied additionally requires a verified receipt for the requested endpoint. The terminal and read-only dashboard use this projection, including remaining cumulative allowance and unresolved criterion IDs. Legacy finalization and learning records cannot supply outcome completion authority.
