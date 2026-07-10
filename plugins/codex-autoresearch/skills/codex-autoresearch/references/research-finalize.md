# Research, lanes, and finalization

Load this reference for qualitative research, fanout, current-tree recovery, or review-branch edge cases.

## Keep research evidence separated

Store dated, claim-specific evidence in `sources.md`. Put judgment and rejected claims in `synthesis.md`. Put only accepted, actionable findings in `quality-gaps.md`.

Preview checklist changes with `gap-candidates`. Closing `quality_gap` ends one accepted checklist round; read `researchIntegrity` and its missing-proof warnings before closing the larger question.

## Keep lanes bounded

Run `research-fanout --dry-run` before recording a fanout plan. Start with read-only scouts. Give implementation lanes a worktree or explicit write scope. Keep big-idea lanes as advice until the user approves a bounded implementation attempt.

Keep the benchmark, accepted evidence, keep/discard decisions, integration, and finalization in the parent session.

## Finalize the work that actually exists

Preview before mutation. Normal finalization is backed only by accepted, current keeps; rejected, provisional, superseded, quarantined, invalidated, discarded, and reverted evidence remains audit history.

When canonical state routes to `current-tree-finalization`, use `finalize-current-tree --cwd <project> --exclude-session-artifacts` as a separate recovery contract. It packages the entire clean non-session branch diff, not commit-backed keeps. Review the exact file set, exclusions, claim evidence, and generated plan before approval.

Match the claim to its proof. A faster retrieval, ranking, lazy, or performance benchmark still needs the accuracy and behavior checks implied by the claim.

Keep finalization artifacts until the merge is verified. Cleanup comes last.
