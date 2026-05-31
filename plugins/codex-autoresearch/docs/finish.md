# Finish

Use finalization when a noisy loop has useful kept commits that should become reviewable work.

## Preview First

```bash
node scripts/autoresearch.mjs finalize-preview --cwd <project>
```

Preview is read-only. It should report readiness, blockers, overlap, dirty-tree status, finalization readiness, current-tree fingerprints, included/excluded files, and a next action.

Preview also reports semantic safety:

- kept commits later logged as discard, crash, or checks_failed
- kept commits whose ASI or description says they were invalidated, contaminated, tainted, cache-replayed, or failed repeat
- kept commits later reverted on the branch
- final non-session branch files not covered by the selected review groups

## Review What Counts

Only accepted/current `status: "keep"` entries are candidates for review branches.

Rejected, provisional, superseded, quarantined, measured, discarded, crashed, failed-checks, unlogged, or unknown-history work must not leak into final branches.

If the branch contents are right but the commit-level kept evidence is stale, package the final branch content instead:

```bash
node scripts/autoresearch.mjs finalize-current-tree --cwd <project>
```

Current-tree mode states that the current tree, not old kept commits, is the review unit. Session artifacts are excluded by default: `autoresearch.*`, `autoresearch.research/**`, dashboard exports, and generated finalization scratch files stay out of the branch.

Use the escape hatch only when the reviewer explicitly wants the session files:

```bash
node scripts/autoresearch.mjs finalize-current-tree --cwd <project> --include-session-artifacts
```

Use this for current-final-tree finalization after stale bests, contaminated evaluators, failed repeats, cache replay, reverted kept commits, or manual safety commits made outside normal keep logging. Explain why the current tree is the review unit.

## Plan Branches

From the autoresearch source branch:

```bash
node scripts/finalize-autoresearch.mjs plan --goal <short-goal>
```

Review the plan before mutation:

- source branch and `HEAD`
- merge base
- planned file sets
- excluded commits
- semantic safety blockers
- final-tree coverage
- overlap/collapse decisions
- plan fingerprint

If any of those changed, refresh the preview and plan.

## Create Branches

Ask for approval before branch creation unless the user already approved finalization.

After branch creation, verify:

- branch union includes all intended kept files
- session artifacts are excluded unless intentionally included
- finalizer output explains which files were included, excluded, and why
- excluded commits did not leak planned files
- generated review summary is accurate
- cleanup targets are recorded without executable cleanup commands

## Final Report

Report:

- created review branches
- files and behavior covered
- metric movement
- verification commands
- review summary path
- remaining blockers or risk
- merge verification status
- cleanup targets only after merge verification succeeds

Do not suggest branch cleanup until merge verification has succeeded. Before that point, the summary may name cleanup targets, but it should not provide destructive cleanup commands.

---

Previous: [Trust](trust.md) · Next: [Recipes](recipes.md) — built-in recipes, recommendation flow, and external catalogs.
