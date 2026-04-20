---
description: Finalize the current autoresearch branch into independent review branches from the merge base.
---

# Finalize Autoresearch

Use the `autoresearch-finalize` skill.

Read `autoresearch.jsonl` and `autoresearch.md`, propose non-overlapping groups of kept commits, wait for approval, then run:

```bash
node <plugin-root>/scripts/finalize-autoresearch.mjs <groups.json>
```

Report the created `autoresearch-review/<goal>/...` branches and cleanup commands.

When using this repo-local copy, `<plugin-root>` is `plugins/codex-autoresearch`.
