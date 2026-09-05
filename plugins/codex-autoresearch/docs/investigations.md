# Bounded investigations

An outcome records what you want, what Codex may change, the available resources, and the evidence needed for delivery. Individual investigations can fail without replacing that objective. Codex chooses the method; Autoresearch preserves the accepted boundaries and results.

An investigation requires an explicit action limit, execution-time limit, or deadline. There is no automatic allowance. Model-token and monetary estimates remain advisory without a trusted host or provider cap. Unavailable consumption stays unknown.

Authorized linked worktrees share one outcome record and one reservation lock. Every substantial action reserves its exposure before it starts. A hypothesis change, repair, evaluator revision, or agent restart does not reset accumulated costs. Uncertain execution retains its reservation until the existing work is reconciled.

## Existing work

Adoption preserves the legacy contract, ledger, notes, and referenced artifacts without rewriting them. Resolve legacy processes and pending logging transactions first. The new allowance is explicitly a remaining allowance because complete historical costs cannot be reconstructed from a legacy ledger.

Imported evidence remains historical until its applicability to an explicit criterion is established. A later legacy writer changes the source fingerprint and blocks dependent work. A newer schema does not retroactively teach an installed older client how to reject every write.

## Release status

The 3.0 candidate requires engineering verification and a separate comparative evaluation before stable release. Its comparison harness must not start model-driven trials without an accepted trial budget. No improvement over ordinary Codex or 2.9 is established by the implementation itself.

## Start and continue

Keep input documents in `.autoresearch/` or outside the assessed worktree. Other files, including ignored build inputs, enter the complete input fingerprint.

Create an outcome document with an objective, identified criteria, authorization, and budget. Each criterion states whether internal or independent evidence is needed and whether it assesses the candidate or the outcome. The authorization records its source, absolute worktree paths, editable and protected paths, allowed effects, environments, and delivery endpoint (`answer`, `patch`, `integrated`, or `deployed`).

```json
{
  "id": "compatibility-repair",
  "objective": "Restore compatible output",
  "criteria": [{"id": "compatibility", "description": "The examples produce compatible output", "authority": "internal", "subject": "candidate"}],
  "authorization": {
    "reference": "accepted-user-request",
    "worktrees": ["/absolute/project"],
    "editable": ["src"], "protected": ["checks"],
    "effects": ["inspect", "edit", "execute"],
    "environments": ["local"], "delivery": "patch"
  },
  "budget": {"actions": 8, "executionSeconds": 600}
}
```

Run `outcome start --contract-file <file> --cwd <project>` once. Use `outcome adopt` when legacy work exists. A later material change uses `outcome amend --contract-file <file> --authorization <reference> --reason <text>`. Amendments retain consumed allowance. `outcome stop --reason <text>` records an unmet handoff after outstanding work has been reconciled.

`next --action-file <file>` takes a bounded action with an ID, investigation, purpose, effects, paths, environment, seconds, and mode. The investigation identifies a question, intervention, distinguishing observations, evidence references, and retry allowance. Its default permits one repair under unchanged relevant conditions. A repair names the failed execution in `repairOf`. Changing the narrative alone cannot renew a failed execution's conditions.

A managed action returns a ticket. Perform its authorized work and use `log --observation-file <file>` with an observation ID, execution ID, criterion ID, text, and `completed: true`. A predicate evaluator records `observation.observed` as `satisfied`, `counterexample`, or `inconclusive`; no metric is needed. The observation may close its investigation with an evidenced resolution. The outcome stays open while criteria or delivery remain unresolved.

Evaluator versions are immutable children of the outcome. Each identifies its criteria, environment, required repeats, executable arguments, correctness-check arguments, and a `predicate` or `metric` method. A metric method also defines its name, direction, minimum improvement, tolerance, and optional target. New methods stay inside the parent grant and consume the same cumulative allowance.

`next --resume <execution-id>` reconnects to the saved action. Repeated IDs cannot replace its specification. Observation replay is similarly exact. Preparation is reserved before input inspection; even a rejected duplicate consumes the preparation action. Complete input capture fails closed if it encounters external links, changing files, over 100,000 entries, or over 2 GiB of file content.

Managed work reports its ticket's elapsed wall-clock interval. This is not host or provider telemetry. Model usage and monetary cost remain unknown, and managed observations remain internal claims until separately checked.

`state`, `doctor`, `recommend-next`, and `finalize-preview` project the same decision, current question, remaining allowance, unresolved criteria, and delivery endpoint. The original short benchmark path remains available without an outcome document.

## Evidence and selected code

Coverage is attached to an identified criterion and an actual execution receipt. It checks the assessed subject, evaluator, fixtures, environment, correctness checks, criterion version, and any referenced evidence. Changed dependencies make an old result inapplicable; its historical validity and observation remain unchanged. Reusing an execution does not add another measurement. Applicable counterexamples remain visible and prevent positive coverage for that criterion.

The default dependency set is the complete worktree input inventory. Narrower reuse requires an accepted `dependencySource` with a protected relative path, SHA-256 digest, and authority reference. The pinned JSON manifest has `schemaVersion: 1` and a `criteria` object keyed by criterion ID. Each entry lists `subject`, `evaluator`, `fixtures`, and `checks` paths. The subject list must be nonempty. A changed manifest requires an authorization amendment.

An edit ticket saves the original contents of its authorized paths, including preexisting dirty work. Before discarding a candidate, its observation can include `retainPatch: {"id": "regression-test", "paths": ["src/regression.test.ts"]}`. This saves an immutable patch containing only owned changes to the selected paths. It does not accept the candidate or apply the patch. Later application needs a new bounded action, scope review, and current correctness evidence. Audit output exposes the retained patch identity and digest.

Imported legacy sources have explicit unknown applicability and no criterion authority. If an older client changes them, review the drift and include `"reconcileLegacy": true` in an authorized amendment document. Reconciliation retains the original bytes and a new immutable snapshot, establishes a new drift guard, and leaves imported observations unproven. Active legacy writers and unresolved reservations still block this operation.

Goal and learning prose cannot create or satisfy product-wide proof requirements. Legacy sessions can preserve explicitly identified `productProofRequirements` in configuration records; governed outcomes use their accepted criteria. Benchmark keeps alone do not establish a broader product claim.

## Durable execution and confirmation

A `process` action starts a packaged worker after its reservation and launch identity are durable. Closing the observing CLI does not stop that worker. `next --resume <id>` reads its existing progress or completion; `--cancel` requests cancellation. An uncertain launch is never replaced. A proven unattempted action can be cancelled without launching it. If the worker dies, reconciliation preserves unknown exposure; cancellation can release it only after the observed native process boundary is proven quiescent, charging a conservative estimate rather than inventing a measurement.

On POSIX systems that boundary is the process group; on Windows it is the observed native process tree. Helpers that daemonize and escape observation are not contained or accounted. Receipts state this boundary. These are plugin-controlled wall-clock limits, not whole-host resource guarantees. Use an externally enforced environment when the task needs containment of arbitrary subprocesses.

Metric actions can select `referenceEvidenceIds`. Movement uses actual prior worker measurements with the accepted evaluator, unique required repeats, qualified noise, and matching non-subject dependencies. Repeating a reference ID cannot manufacture a repeat. Without a trustworthy narrower dependency manifest, the complete assessed input must match. Target attainment remains independent of movement.

A `github-actions` action has purpose `confirmation` and a `candidateArtifact` containing the repository, artifact ID, and SHA-256 archive digest. Its parent `confirmation` grant pins the evaluator repository, workflow path, workflow revision and ref, protocol digest, dataset ID, and custody reference. The candidate archive contains one `candidate.json` with assessed input fingerprints and corresponding bytes. The current adapter supports 4 MiB of candidate content and 8 MiB ZIP archives.

The adapter persists an attempt before dispatch and saves the returned run ID. If the response is lost, resume finds the uniquely nominated run without dispatching again. Unavailable proof remains reconcilable. Verification binds run, workflow revision, protocol, population, environment, criterion, and candidate to the receipt. Provider duration cannot be replaced by a shorter local observation interval; missing duration is conservatively estimated, and over-budget proof cannot satisfy a criterion.

Each attempt and disclosed feedback stays in the outcome. Changing investigations cannot refresh exposed data. Verified Actions provenance is internal reproduction unless the accepted custody boundary is external and the data remains fresh. Private repository artifact attestations are optional. The maintained public synthetic CI fixture tests this integration and explicitly reports no independence or product-benefit claim.
