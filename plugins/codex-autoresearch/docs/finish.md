# Finish

Use finalization when a noisy loop has useful kept commits that should become reviewable work. This is where you stop admiring the evidence pile and turn it into branches other humans can actually review.

## Preview First

```bash
node scripts/autoresearch.mjs finalize-preview --cwd <project>
```

Preview is read-only. It should report readiness, blockers, overlap, dirty-tree status, and a next action.

## Review What Counts

Only `status: "keep"` entries are candidates for review branches.

Discarded, crashed, failed-checks, unlogged, or unknown-history work must not leak into final branches.

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
- overlap/collapse decisions
- plan fingerprint

If any of those changed, refresh the preview and plan.

## Create Branches

Ask for approval before branch creation unless the user already approved finalization.

After branch creation, verify:

- branch union includes all intended kept files
- session artifacts are excluded unless intentionally included
- excluded commits did not leak planned files
- generated review summary is accurate
- cleanup order is clear

## Final Report

Report:

- created review branches
- files and behavior covered
- metric movement
- verification commands
- review summary path
- remaining blockers or risk
- merge and cleanup order

---

Previous: [Trust](trust.md) · Next: [Recipes](recipes.md) — built-in recipes, recommendation flow, and external catalogs.
