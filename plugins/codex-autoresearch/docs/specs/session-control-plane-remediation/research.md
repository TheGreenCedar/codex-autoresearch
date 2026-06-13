# Verifiable Research and Technology Proposal

> Status: historical implementation spec. The first implementation landed in commit `fa80d8d`; current behavior is defined by source code and `plugins/codex-autoresearch/docs/control-plane.md`.

## 1. Core Problem Analysis
This specification addresses the Autoresearch failure mode exposed by session `019eb85a-e76a-7793-ab2a-26e9ff093659`: the loop produced useful evidence, but it did not govern the live Codex goal, approval state, resource pressure, benchmark maturity, lane orchestration, finalization runway, or operator readout as one coherent control plane.

## 2. Verifiable Technology Recommendations

| Technology/Pattern | Rationale & Evidence |
|---|---|
| **JSON Lines session ledger and streaming forensics import** | JSON Lines stores structured data so it can be processed one record at a time, and the format is described as suitable for log files and cooperating processes [cite:1]. JSON Lines requires UTF-8 encoding, one valid JSON value per line, and a line terminator convention, which fits append-only session evidence and bounded import validation [cite:1]. |
| **Node child-process governor with explicit abort, timeout, and output limits** | Node child process APIs document `signal`, `timeout`, `killSignal`, and `cwd` controls for spawned commands, which supports bounded packet and lane execution [cite:2]. Node child process APIs also document `maxBuffer` behavior for stdout and stderr, which supports hard output budgets instead of unbounded transcript growth [cite:2]. |
| **Git worktree and branch-state finalization state machine** | Git worktree documentation says `worktree add -b` refuses an already-existing branch and `-B` overrides by resetting that branch, which means finalization must classify stale branch state instead of failing generically [cite:3]. Git worktree documentation says `worktree list --porcelain` is stable for scripts and that `prune --dry-run` reports removable entries without removing them, which supports safe stale-worktree reconciliation [cite:3]. |
| **GitHub CLI pull-request status probe for the publish runway** | The GitHub CLI manual exposes pull-request commands including create, list, status, checks, view, and update-branch, which gives a stable command surface for detecting local-only versus PR-visible finalization state [cite:4]. The `gh pr status` manual says status output summarizes pull request number, title, CI checks, and reviews, and points operators to `gh pr checks` for more CI detail [cite:5]. |

## 3. Browsed Sources

- [1] https://jsonlines.org/ - JSON Lines format requirements and usage.
- [2] https://nodejs.org/api/child_process.html - Node child process options, timeouts, abort signals, and buffers.
- [3] https://git-scm.com/docs/git-worktree - Git worktree branch, porcelain, remove, and prune behavior.
- [4] https://cli.github.com/manual/gh_pr - GitHub CLI pull request command family.
- [5] https://cli.github.com/manual/gh_pr_status - GitHub CLI pull request status behavior.

## 4. Historical Phase Note

Research was completed with 5 verifiable, browsed sources, and the recommendations in this document informed the now-implemented control-plane blueprint. This is archived evidence, not an active instruction to continue the phase-gated spec workflow.
