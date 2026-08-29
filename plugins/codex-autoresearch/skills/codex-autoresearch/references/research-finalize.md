# Research, lanes, and finalization

Load this reference for qualitative research, fanout, current-tree recovery, or review-branch edge cases.

Qualitative work stays direct by default. Use the research loop below only after fit routing returns `run-loop` for an explicit repeated checklist contract. Do not create research files merely because the request mentions docs, UX, product, architecture, quality, or research.

## Keep research evidence separated

Store dated, claim-specific evidence in `sources.md`. Put judgment and rejected claims in `synthesis.md`. Put only accepted, actionable findings in `quality-gaps.md`.

Preview checklist changes with `gap-candidates`. Treat hand-edited checkboxes as provisional. Accept a stable gap ID only through `gap-decide` with an implemented or rejected decision, evidence, and validation; the append-only decision ledger is the durable authority. Closing `quality_gap` ends one accepted checklist round only after those decisions are accepted. Read `researchIntegrity` and its missing-proof warnings before closing the larger question.

## Keep lanes bounded

Run `research-fanout --dry-run` before recording a fanout plan. Scout commands must parse as strict allowlisted Git read argv; interpreters, shells, network/process-spawning surfaces, and mutation-capable Git forms are refused before execution. Git porcelain is best-effort post-run detection, not containment. Give implementation lanes a disposable worktree or explicit write scope, while treating both as write boundaries rather than process/filesystem containment. Keep big-idea lanes as advice until the user approves a bounded implementation attempt.

Keep the benchmark, accepted evidence, keep/discard decisions, integration, and finalization in the parent session. A no-learning or same-layer-failure pause never creates a fanout plan automatically.

## Finalize the work that actually exists

Preview before mutation. Normal finalization is backed only by accepted, current keeps; rejected, provisional, superseded, quarantined, invalidated, discarded, and reverted evidence remains audit history.

Treat planned paths as literal Git paths, including brackets, wildcard characters, spaces, and Unicode. Do not shell-expand or manually escape them. Generated and supplied review refs must pass Git ref validation before any branch mutation.

When canonical state routes to `current-tree-finalization`, use `finalize-current-tree --cwd <project> --exclude-session-artifacts` as a separate recovery contract. It packages the entire clean non-session branch diff, not commit-backed keeps. Review the exact file set, exclusions, claim evidence, and generated plan before approval.

Match the claim to its proof. A faster retrieval, ranking, lazy, or performance benchmark still needs the accuracy and behavior checks implied by the claim.

Keep finalization artifacts until the merge is verified. Cleanup comes last.
