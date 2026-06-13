# Finish

Use finalization when a noisy loop has useful kept commits that should become reviewable work.

## Preview First

```bash
node scripts/autoresearch.mjs finalize-preview --cwd <project>
```

Preview is read-only. It should report readiness, blockers, overlap, dirty-tree status, finalization readiness, current-tree fingerprints, included/excluded files, and a next action.

Before any branch-changing finalization path, run a local safety checkpoint:

```bash
git status --short
node scripts/autoresearch.mjs state --cwd <project> --report
node scripts/autoresearch.mjs finalize-preview --cwd <project>
```

Proceed only when unrelated dirty files are isolated, session artifacts are intentionally handled, protected benchmark paths are not drifting silently, and the preview still describes the branch/review unit you intend to create.

For slow or noisy source branches, add `--progress` to print heartbeat lines to stderr while preserving JSON stdout:

```bash
node scripts/autoresearch.mjs finalize-preview --cwd <project> --progress
```

Preview also reports semantic safety:

- kept commits later logged as discard, crash, or checks_failed
- kept commits whose ASI or description says they were invalidated, contaminated, tainted, cache-replayed, or failed repeat
- kept commits later reverted on the branch
- final non-session branch files not covered by the selected review groups

Preview and state also report `finalizationRunway`. Treat it as the publication path, not a decorative status. A review branch can be missing, local-only, equivalent, stale, divergent, checked out, PR-open, CI-blocked, merged, or cleanup-ready. Local-only means a branch exists on the workstation but has no push or PR evidence; do not call that published or final. Stale, divergent, checked-out, or unsafe branches must be resolved before branch reuse, merge claims, or cleanup.

## Product-Grade Finalization Bar

Do not finalize an experimental primitive as a shippable deliverable.

A finalization preview can package evidence for review, but it must not imply product-grade readiness when the product claim is unproven. Treat the preview as a branch/readiness receipt: it can say that a review branch is useful, while still saying the work is experimental.

For shippable, final, product, retrieval, search, ranking, or performance work, compare claim coverage against accepted evidence before using merge-ready language. Retrieval and lazy semantic search claims need proof such as retrieval accuracy, recall/MRR/hit@k or ranking quality, lazy behavior under realistic load, sidecar safety, and docs or tests that capture the behavior. A faster benchmark is not enough by itself.

When claim coverage is missing, describe the branch as an experimental primitive or development review branch. Use wording like:

```text
Experimental review branch only: product-grade proof is missing.
```

If the default branch or trunk is ambiguous, pass it explicitly:

```bash
node scripts/autoresearch.mjs finalize-preview --cwd <project> --trunk origin/main
```

## Review What Counts

Only accepted/current `status: "keep"` entries are candidates for review branches.

Rejected, provisional, superseded, quarantined, measured, discarded, crashed, failed-checks, unlogged, or unknown-history work must not leak into final branches.

If the branch contents are right but the commit-level kept evidence is stale, package the final branch content instead:

```bash
git status --short
node scripts/autoresearch.mjs finalize-preview --cwd <project>
node scripts/autoresearch.mjs finalize-current-tree --cwd <project>
```

Current-tree mode states that the current tree, not old kept commits, is the review unit. Session artifacts are excluded by default: `autoresearch.*`, `autoresearch.research/**`, dashboard exports, and generated finalization scratch files stay out of the branch.

If `state --report` shows `sourceCleanliness.status` as `session-artifacts-dirty`, temporarily stash or commit those session files before branch-changing finalization. The current-tree plan still excludes session artifacts by default; the clean worktree requirement protects Git branch operations.

Use the escape hatch only when the reviewer explicitly wants the session files:

```bash
node scripts/autoresearch.mjs finalize-current-tree --cwd <project> --include-session-artifacts
```

Use this for current-final-tree finalization after stale bests, contaminated evaluators, failed repeats, cache replay, reverted kept commits, or manual safety commits made outside normal keep logging. Explain why the current tree is the review unit.

## Plan Branches

From the autoresearch source branch:

```bash
node scripts/finalize-autoresearch.mjs plan --cwd <project> --output groups.json --goal <short-goal>
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

If a review branch already exists, the finalizer classifies it before reuse. Equivalent branches can continue through verification. Divergent, stale, checked-out, or unsafe branches stop with the runway recovery reason instead of a generic "branch already exists" failure.

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
