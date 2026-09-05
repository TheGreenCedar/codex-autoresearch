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
