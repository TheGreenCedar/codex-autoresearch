# Bounded investigations

An outcome records what you want, what Codex may change, the available resources, and the evidence needed for delivery. Individual investigations can fail without replacing that objective. Codex chooses the method; Autoresearch preserves the accepted boundaries and results.

An investigation requires an explicit action limit, execution-time limit, or deadline. There is no automatic allowance. Model-token and monetary estimates remain advisory without a trusted host or provider cap. Unavailable consumption stays unknown.

Authorized linked worktrees share one outcome record and one reservation lock. Before each substantial action starts, it reserves the allowance it could consume. Changing a hypothesis, repairing code, revising an evaluator, or restarting an agent does not reset accumulated costs. An unresolved execution keeps its reservation until Autoresearch can account for what happened.

## Existing work

Adoption preserves the legacy contract, ledger, notes, and referenced artifacts without rewriting them. Resolve legacy processes and pending logging transactions first. The new allowance is explicitly a remaining allowance because complete historical costs cannot be reconstructed from a legacy ledger.

Imported evidence stays historical until it has been checked against an explicit criterion. If an older client later writes to that session, the changed source fingerprint blocks work that depends on it. Adoption cannot prevent an older installed client from writing; it detects those changes afterward.

## Release status

The 3.0 candidate requires engineering verification and a separate comparative evaluation before stable release. Its comparison harness must not start model-driven trials without an accepted trial budget. No improvement over ordinary Codex or 2.9 is established by the implementation itself.

## Start and continue

Keep input documents in `.autoresearch/` or outside the assessed worktree. Other files, including ignored build inputs, enter the complete input fingerprint.

Create an outcome document with an objective, criteria with stable IDs, authorization, and a budget. Each criterion says whether it needs internal or independent evidence and whether it assesses the candidate or the outcome. Record where the authorization came from, absolute worktree paths, editable and protected paths, allowed effects, and environments. Choose a delivery endpoint: `answer`, `patch`, `integrated`, or `deployed`.

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

A managed action returns a ticket that identifies the authorized work. Perform that work, then use `log --observation-file <file>` with an observation ID, execution ID, criterion ID, text, and `completed: true`. A predicate evaluator records `observation.observed` as `satisfied`, `counterexample`, or `inconclusive`; it needs no metric. An observation can close the investigation when its evidence resolves the question. The outcome stays open while any criterion or the requested delivery remains unresolved.

Each evaluator version belongs to the outcome and cannot be changed after recording. It identifies its criteria, environment, required repeats, executable arguments, correctness-check arguments, and a `predicate` or `metric` method. A metric method also defines its name, direction, minimum improvement, tolerance, and optional target. A new method must stay within the outcome authorization and uses the same remaining allowance.

`next --resume <execution-id>` reconnects to the saved action. Reusing an action or observation ID requires the exact original specification. Preparation reserves an action before inspecting inputs, so even a rejected duplicate consumes that preparation action. Input capture stops if it encounters external links, files changing during the read, over 100,000 entries, or over 2 GiB of file content.

Managed work reports its ticket's elapsed wall-clock interval. This is not host or provider telemetry. Model usage and monetary cost remain unknown, and managed observations remain internal claims until separately checked.

`state`, `doctor`, `recommend-next`, and `finalize-preview` project the same decision, current question, remaining allowance, unresolved criteria, and delivery endpoint. The original short benchmark path remains available without an outcome document.

## Evidence and selected code

Evidence can satisfy a criterion only when it names that criterion and has an actual execution receipt. Autoresearch checks the assessed subject, evaluator, fixtures, environment, correctness checks, criterion version, and referenced evidence. When a dependency changes, the old result no longer applies; the original observation remains in history. Reusing an execution does not add a measurement. A counterexample that still applies remains visible and prevents the criterion from passing.

The default dependency set is the complete worktree input inventory. Narrower reuse requires an accepted `dependencySource` with a protected relative path, SHA-256 digest, and authority reference. The pinned JSON manifest has `schemaVersion: 1` and a `criteria` object keyed by criterion ID. Each entry lists `subject`, `evaluator`, `fixtures`, and `checks` paths. The subject list must be nonempty. A changed manifest requires an authorization amendment.

An edit ticket saves the original contents of its authorized paths, including preexisting dirty work. Before discarding a candidate, its observation can include `retainPatch: {"id": "regression-test", "paths": ["src/regression.test.ts"]}`. This saves an immutable patch containing only owned changes to the selected paths. It does not accept the candidate or apply the patch. Later application needs a new bounded action, scope review, and current correctness evidence. Audit output exposes the retained patch identity and digest.

Imported legacy records cannot satisfy a criterion until their relevance has been established. If an older client changes them, review the changes and include `"reconcileLegacy": true` in an authorized amendment document. Reconciliation keeps the original bytes and a new immutable snapshot, then watches the new fingerprint for further changes. It does not prove the imported observations. Active legacy writers and unresolved reservations still block reconciliation.

Goal and learning prose cannot create or satisfy product-wide proof requirements. Legacy sessions can preserve explicitly identified `productProofRequirements` in configuration records; governed outcomes use their accepted criteria. Benchmark keeps alone do not establish a broader product claim.

## Durable execution and confirmation

A `process` action saves its reservation and launch identity before starting a packaged worker. Closing the observing CLI does not stop the worker. `next --resume <id>` reads its progress or completion; `--cancel` requests cancellation. An uncertain launch is never replaced. An action proven never to have started can be cancelled without launching it.

If the worker dies, its reservation remains. Cancellation can release that reservation only after every process within the observed native boundary is proven stopped. Autoresearch charges a conservative estimate for that execution; it does not report the estimate as measured usage.

On POSIX systems that boundary is the process group; on Windows it is the observed native process tree. Helpers that daemonize and escape observation are neither contained nor accounted for. Receipts state this limit. The plugin enforces wall-clock limits within that boundary and cannot guarantee resource limits across the whole host. Use an externally enforced environment when the task needs containment of arbitrary subprocesses.

Metric actions can select `referenceEvidenceIds`. Movement uses actual prior worker measurements with the accepted evaluator, unique required repeats, qualified noise, and matching non-subject dependencies. Repeating a reference ID cannot manufacture a repeat. Without a trustworthy narrower dependency manifest, the complete assessed input must match. Target attainment remains independent of movement.

A `github-actions` action has purpose `confirmation` and a `candidateArtifact` containing the repository, artifact ID, and SHA-256 archive digest. Its parent `confirmation` grant pins the evaluator repository, workflow path, workflow revision and ref, protocol digest, dataset ID, and custody reference. The candidate archive contains one `candidate.json` with assessed input fingerprints and corresponding bytes. The current adapter supports 4 MiB of candidate content and 8 MiB ZIP archives.

The adapter saves the attempt before dispatch and records the returned run ID. If the response is lost, resume finds the single matching run without dispatching again. Missing proof can be reconciled later. Receipt verification checks the run, workflow revision, protocol, population, environment, criterion, and candidate. The recorded duration must use provider time, even if the CLI observed only part of the run. Missing duration gets a conservative estimate, and an over-budget run cannot satisfy a criterion.

Each attempt and disclosed feedback stays in the outcome. Changing investigations cannot refresh exposed data. Verified Actions provenance is internal reproduction unless the accepted custody boundary is external and the data remains fresh. Private repository artifact attestations are optional. The maintained public synthetic CI fixture tests this integration and explicitly reports no independence or product-benefit claim.

## Delivery

When every current criterion has supporting evidence, the outcome is ready for delivery. Reserve a managed action with `purpose: "delivery"`, then use `log --observation-file` with an ID, its execution ID, and a `delivery` object. Preparing and recording the delivery use that action's remaining allowance.

For an answer endpoint, provide `delivery.answer`. For a code endpoint, provide `delivery.candidateExecutionId` and `delivery.paths`. The candidate must have a completed owning edit action, unchanged assessed inputs, and actual current worker correctness checks. The delivered patch must contain the complete owned change that was assessed. A subset belongs in retained artifacts until its separate application is assessed. Initial dirty work remains the patch's baseline; the patch does not claim to reconstruct that baseline from Git HEAD.

An integrated or deployed endpoint additionally requires an accepted parent `deliveryTarget` with GitHub `repository`, `ref`, and, for deployment, `environment`. Its delivery action must carry `git` or `publish` authority. Perform the authorized integration or deployment within that ticket, then log its result; logging verifies existing provider state and performs no publish action. Deployment logging includes the existing `deploymentId`.

The provider's immutable commit tree must match the complete assessed input, including tracked evaluator and check sources. Untracked or ignored local build inputs cannot silently disappear from that comparison. Deployment verification also checks the latest successful status's environment and deployment identity. A local patch alone cannot satisfy either endpoint.

A successful transaction saves an immutable manifest with the artifact, candidate, evidence, authorization, endpoint, and delivery execution ID. Repeating the exact request returns the same receipt. Changed inputs, missing or substituted artifacts, incomplete criteria, or expired allowance block completion. `state` and `finalize-preview` report `satisfied` only when the current criteria and requested endpoint are both verified. Full JSON audit output keeps the delivery receipts and identities of the original code baselines.

Outcome dashboard exports are written under the private outcome `exports/` directory, so taking a snapshot cannot change the assessed candidate. An explicit `--output` must name an HTML file within that directory. The `log` delivery response includes the immutable artifact path and digest.
