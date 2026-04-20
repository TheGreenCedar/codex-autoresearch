---
name: autoresearch-finalize
description: Finalize a noisy Codex autoresearch branch into clean independent review branches. Use when the user asks to finalize autoresearch, clean up experiments, prepare kept experiments for review, split an autoresearch branch, or turn autoresearch results into PR-ready branches.
---

# Autoresearch Finalize

Turn an autoresearch branch into one or more independent branches from the merge base.

## Step 1: Analyze

1. Read `autoresearch.jsonl`; keep only results with `status: "keep"`.
2. Read `autoresearch.md` for objective and constraints.
3. Expand each kept commit to a full hash with `git rev-parse`.
4. Determine trunk, usually `main`, then compute:

```bash
git merge-base HEAD main
git rev-parse HEAD
```

5. For each kept commit, inspect the diff:
   - first kept commit: `<base>..<commit>`
   - later kept commits: `<previous-kept>..<commit>`

## Step 2: Propose Groups

Group kept commits into reviewable changesets.

- Preserve application order.
- No two groups may touch the same file. If groups overlap, merge them.
- If one group depends on another, merge them or explicitly flag that they must be reviewed together.
- Keep groups focused on one idea.
- Do not force a fixed number of groups.

Present the groups to the user and wait for approval before creating branches.

Example:

```text
Proposed branches:

1. Switch parser cache strategy (commits abc1234, def5678)
   Files: src/parser.ts, src/cache.ts
   Metric: seconds 12.8 -> 10.4 (-18.8%)

2. Tighten benchmark setup (commit 123abcd)
   Files: scripts/bench.ts
   Metric: seconds 10.4 -> 9.9 (-4.8%)
```

## Step 3: Write groups.json

After approval, write a JSON file like:

```json
{
  "base": "<full merge-base hash>",
  "trunk": "main",
  "final_tree": "<full source branch HEAD hash>",
  "goal": "short-goal",
  "groups": [
    {
      "title": "Switch parser cache strategy",
      "body": "Why this change is valuable.\n\nExperiments: #3, #5\nMetric: seconds 12.8 -> 10.4 (-18.8%)",
      "last_commit": "<full kept commit hash>",
      "slug": "parser-cache"
    }
  ]
}
```

Rules:

- `last_commit` must be a full hash.
- `goal` and `slug` must be short branch-safe slugs.
- Session files named `autoresearch.*` are excluded from review branches.

## Step 4: Run

From the autoresearch source branch:

```bash
node /absolute/path/to/codex-autoresearch/scripts/finalize-autoresearch.mjs /absolute/path/to/groups.json
```

The script:

- checks that the worktree is clean
- creates each branch from the merge base under `autoresearch-review/<goal>/`
- applies only the files for that group
- verifies the union matches the autoresearch branch, excluding session files
- verifies no session artifacts landed in review branches

## Step 5: Report

Report:

- branches created
- files in each branch
- overall metric improvement
- cleanup commands printed by the script

If verification fails, do not delete the created branches unless the user asks. Explain which files differ and what to inspect.
