# Finish

Use finalization when a noisy loop has useful kept commits that should become reviewable work.

## Preview first

```bash
node scripts/autoresearch.mjs finalize-preview --cwd <project>
```

Preview is read-only. It reports readiness, blockers, overlap, dirty-tree status, finalization readiness, current-tree fingerprints, included/excluded files, and a next action.

Before any branch-changing path:

```bash
git status --short
node scripts/autoresearch.mjs state --cwd <project> --report
node scripts/autoresearch.mjs finalize-preview --cwd <project>
```

Proceed only when unrelated dirty files are isolated, session artifacts are intentionally handled, protected benchmark paths are not drifting silently, and the preview still describes the branch you intend to create.

For slow or noisy source branches:

```bash
node scripts/autoresearch.mjs finalize-preview --cwd <project> --progress
```

Preview reports semantic safety: kept commits later discarded or invalidated, kept commits later reverted, and final non-session branch files not covered by selected review groups.

Preview and state also report `finalizationRunway` — the publication path. Stages include preview, branch creation, local-only, pushed/PR, CI, merge, merge verification, and cleanup-ready. A local branch with no push or PR evidence is local-only, not final.

## Product-grade finalization bar

An experimental primitive is not a shippable deliverable.

A finalization preview can package evidence for review but must not imply product-grade readiness when the product claim is unproven. The preview is a branch/readiness receipt: useful for review, still possibly experimental.

For shippable retrieval, search, ranking, or performance work, compare claim coverage against accepted evidence before using merge-ready language. Retrieval and lazy semantic search claims need proof such as retrieval accuracy, recall/MRR/hit@k, lazy behavior under realistic load, sidecar safety, and docs or tests. A faster benchmark alone is not enough.

When claim coverage is missing, describe the branch as experimental or development review only:

```text
Experimental review branch only: product-grade proof is missing.
```

If the default branch is ambiguous:

```bash
node scripts/autoresearch.mjs finalize-preview --cwd <project> --trunk origin/main
```

## Review what counts

Only accepted/current `status: "keep"` entries are candidates for review branches.

Rejected, provisional, superseded, quarantined, measured, discarded, crashed, failed-checks, unlogged, or unknown-history work must not leak into final branches.

If branch contents are right but commit-level kept evidence is stale:

```bash
git status --short
node scripts/autoresearch.mjs finalize-preview --cwd <project>
node scripts/autoresearch.mjs finalize-current-tree --cwd <project> --exclude-session-artifacts
```

When `state --report` reports `current-tree-finalization`, run `finalize-current-tree --cwd <project> --exclude-session-artifacts` as the primary command. Do not substitute generic `finalize-preview`; preview can explain the blocker, but current-tree mode is the route that packages the current non-session branch diff.

Current-tree mode states that the current tree, not old kept commits, is the review unit. Session artifacts are excluded by default.

If `state --report` shows `session-artifacts-dirty`, temporarily stash or commit session files before branch-changing finalization.

Use the escape hatch only when the reviewer explicitly wants session files in the branch:

```bash
node scripts/autoresearch.mjs finalize-current-tree --cwd <project> --include-session-artifacts
```

## Plan branches

From the autoresearch source branch:

```bash
node scripts/finalize-autoresearch.mjs plan --cwd <project> --goal <short-goal>
```

Review the plan before mutation: source branch, `HEAD`, merge base, planned file sets, excluded commits, semantic safety blockers, final-tree coverage, overlap decisions, and plan fingerprint.

## Create branches

After preview and approval, create the planned review branches from the reviewed plan file:

```bash
node scripts/finalize-autoresearch.mjs --cwd <project> <groups.json>
```

`<groups.json>` is the path produced by `plan`. Rerun `plan` first if the source branch, trunk, merge base, kept commits, or dirty-tree state changed after review.

Ask for approval before branch creation unless you already approved finalization.

After branch creation, verify:

- branch union includes all intended kept files
- session artifacts are excluded unless intentionally included
- finalizer output explains included, excluded, and why
- excluded commits did not leak planned files
- generated review summary is accurate
- cleanup targets are recorded without executable cleanup commands

If a review branch already exists, the finalizer classifies it before reuse. Divergent, stale, checked-out, or unsafe branches stop with the runway recovery reason.

## Final report

Report:

- created review branches
- files and behavior covered
- metric movement
- verification commands
- review summary path
- remaining blockers or risk
- merge verification status
- cleanup targets only after merge verification succeeds

Do not suggest branch cleanup until merge verification has succeeded.

---

Previous: [Trust](trust.md) · Next: [Recipes](recipes.md) — built-in recipes and external catalogs.
