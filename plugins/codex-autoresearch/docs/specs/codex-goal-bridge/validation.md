# Codex Goal Bridge Validation

## Evidence Sources

- Official Goal-mode behavior: [Using Goals in Codex](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex), [Goal mode](https://developers.openai.com/codex/prompting#goal-mode), [CLI /goal](https://developers.openai.com/codex/cli/slash-commands#set-or-view-a-task-goal-with-goal), [App Server goal API](https://developers.openai.com/codex/app-server#manage-a-thread-goal).
- Local implementation: `scripts/autoresearch.ts`, `lib/session-core.ts`, `lib/tool-schemas.ts`, `lib/tool-registry.ts`, `lib/tool-contracts.ts`, `tests/full-product.test.ts`.

## Validation Plan

1. Run `node --check scripts/autoresearch.mjs` after building.
2. Run `node --test dist/tests/full-product.test.mjs` for the goal persistence and bridge regression.
3. Run `npm run check` before release or merge.
4. Manually smoke:

```bash
node scripts/autoresearch.mjs init --cwd <tmp-project> --name "Goal smoke" --goal "Improve score" --metric-name score
node scripts/autoresearch.mjs state --cwd <tmp-project> --compact
node scripts/autoresearch.mjs codex-goal-brief --cwd <tmp-project> --codex-goal-status active
```

## Pass Criteria

- `state --compact` includes `goal` and `goalAdvice`.
- `codex-goal-brief` returns `canMarkCodexGoalComplete=false` unless completion evidence is explicitly confirmed, blockers are clear, and local Autoresearch evidence exists.
- Iteration limits and imported `budget_limited` status produce non-completion advice.
- Tool registry and schema validation report no missing tool surface.

## Known Residual Risk

The bridge cannot prove a parent Codex Goal exists unless the parent agent imports `get_goal` output. That is deliberate. Guessing hidden thread state would be worse than ignorance with a name tag.
