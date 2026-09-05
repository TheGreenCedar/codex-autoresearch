# Finish a session

Finish with one reviewable change and a short evidence receipt. The receipt states what changed, which workload was measured, the baseline and candidate results, the checks, and any limits on the claim. It does not decide that the change is ready to ship.

## Preview before changing branches

The manual commands on this page assume a source checkout opened at `plugins/codex-autoresearch`. Marketplace users can ask `@Codex Autoresearch` to preview and finalize the session.

```bash
git status --short
node scripts/autoresearch.mjs state --cwd <project> --report
node scripts/autoresearch.mjs finalize-preview --cwd <project>
```

The default receipt gives bounded counts; use `finalize-preview --json-full` for detailed handoff evidence. The preview shows which accepted keeps are still current, what files they cover, what will be excluded, and what blocks branch creation. With `--json-full`, its `evidenceReceipt` contains the accepted commit IDs, file set, logged measurements, and contract/check identities when recorded. Missing identities remain unknown, and truncated receipts report their full counts. It also reports dirty-tree problems, overlap between proposed groups, stale plans, and gaps between the claim and the evidence.

Use `--trunk origin/main` when the default branch cannot be inferred. Add `--progress` when a large history is quiet long enough to look stuck.

In normal finalization, only accepted, current keeps can enter a review branch. Baselines, measurements, rejected or provisional work, failed checks, crashes, invalidated results, later discards, and reverted changes stay in the ledger but stay out of the branch. Session artifacts are excluded unless the reviewer explicitly asks for them.

## Hand off one change

If the existing branch already contains one coherent accepted change, use the preview to identify the accepted commits and exact file set. Hand off that change with a receipt containing:

- the goal, commit IDs, and changed files
- the accepted evaluator and checks, with baseline and candidate results
- the preview's exclusions and blockers, and any unverified claim
- the current delivery state: local, pushed, or under review

Use the actual preview and ledger results. If the preview is blocked or the branch includes session files, unrelated work, or rejected experiments, it is not ready for this simple handoff. Resolve the blocker or use the branch separation below. A receipt records evidence; it does not bypass finalization checks.

Creating additional branches is unnecessary when the current branch is already the intended review unit. Push, PR creation, and merge remain distinct actions requiring the user's authorization.

## Say only what the evidence supports

A branch can be mechanically ready for review while the product claim is still weak. Before calling work product-grade or merge-ready, compare the claim with the accepted checks and measurements. Search, ranking, lazy behavior, accessibility, safety, and performance claims need proof of those behaviors, not merely a better number from one workload.

When that proof is missing, describe the branch as experimental review work. The preview is a receipt for branch contents and evidence; it is not a release certificate.

## Use the current tree when commit history is stale

Sometimes the final branch contents are correct even though the old kept commits no longer describe them cleanly. A correction may have been committed separately, an earlier keep may have been reverted, or support work may sit outside the original packet.

When state routes to `current-tree-finalization`, use:

```bash
node scripts/autoresearch.mjs finalize-current-tree --cwd <project> --exclude-session-artifacts
```

This is an exceptional recovery route, not keep-backed finalization. It treats the entire clean non-session branch diff as one explicitly reviewed unit and may include corrections or support work that was never logged as a keep. Use it only when canonical state names `current-tree-finalization`. Verify the clean tree, exact file set, session exclusions, claim evidence, and generated plan before approval.

## Separate mixed history into review branches

From the reviewed source branch, write a plan:

```bash
node scripts/finalize-autoresearch.mjs plan --cwd <project> --goal <short-goal> --output groups.json
```

Read the plan before mutation. Check the source branch and `HEAD`, trunk, merge base, file groups, exclusions, overlap, and fingerprint. If any of those change after review, generate a new plan.

After approval, pass the plan file back to the finalizer:

```bash
node scripts/finalize-autoresearch.mjs --cwd <project> <groups.json>
```

Existing branches are classified before reuse. A matching name is not enough; the branch has to match the current plan.

Before handoff, verify that the union of the review branches contains every intended file, excludes session and rejected work, reports the same metric movement as the ledger, and uses language supported by the checks.

The publication path is preview, approval, branch creation, local verification, push or pull request, CI, merge, and merge verification. Cleanup comes after that. Until the merge is verified, cleanup targets are notes rather than commands.
