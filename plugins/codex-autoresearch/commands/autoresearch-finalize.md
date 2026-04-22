---
description: Finalize the current autoresearch branch into independent review branches from the merge base.
---

# Finalize Autoresearch

Use the `autoresearch-finalize` skill.

Read `autoresearch.jsonl` and `autoresearch.md`. First draft groups with:

```bash
node <plugin-root>/scripts/finalize-autoresearch.mjs plan --output <groups.json> --goal <short-goal>
```

Review and tighten the generated non-overlapping groups, wait for approval, then run:

```bash
node <plugin-root>/scripts/finalize-autoresearch.mjs <groups.json>
```

Report the created `autoresearch-review/<goal>/...` branches and cleanup commands.
Also report the generated Markdown review summary path printed by the script; it is written under `.git/autoresearch-finalize/` and includes branch stats, suggested PR text, review commands, verification status, and cleanup notes.

Keep the runway order explicit: preview, approve, create review branches, verify, merge into trunk, then cleanup. Do not delete source branches or autoresearch artifacts until the review branch merge has succeeded.

When using this repo-local copy, `<plugin-root>` is `plugins/codex-autoresearch`.
