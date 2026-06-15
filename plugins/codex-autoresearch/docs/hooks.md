# Codex Hooks

Hooks are optional guardrails for Autoresearch. Useful, maybe. Required for the normal loop, no.

## Position

- Keep hooks opt-in.
- Do not enable hook templates by default.
- Keep core behavior correct without hooks.
- On Windows, treat hooks as less dependable as a default path.
- Use `doctor hooks` for local feasibility and caveats.

```bash
node scripts/autoresearch.mjs doctor hooks
```

## Useful hook ideas

Codex Goal mode:

- run `codex-goal-brief --cwd <project>` when you explicitly want Goal mode
- pass any `get_goal` output into `--codex-goal-objective` and `--codex-goal-status`
- use `completionAudit` before any parent agent calls `update_goal(status="complete")`
- keep Codex Goal state in Codex; do not read private Codex SQLite or pretend the plugin can mutate thread goals

`SessionStart`:

- run or suggest `onboarding-packet --compact`
- surface the current next safe action
- surface `goalAdvice` when a session has a durable goal
- remind Codex to start the live dashboard when you asked for it or a fresh browser readout would help

`PostToolUse`:

- notice shell output containing `METRIC name=value`
- remind Codex to log the packet with ASI
- warn if a packet command ran but no log decision followed

`Stop`:

- warn when `autoresearch.last-run.json` exists
- warn when continuation says `forbidFinalAnswer`
- suggest `state --compact` before final reporting
- suggest `codex-goal-brief --cwd <project>` before completing a parent Codex Goal

## Limits

Hooks are experimental — best used as reminders or context injection, not irreversible enforcement.

They must not replace:

- CLI validation
- unsafe command gates
- last-run freshness checks
- dashboard readout freshness checks
- Git safety
- human approval for irreversible work

Official docs:

- <https://developers.openai.com/codex/hooks>
- <https://developers.openai.com/codex/prompting#goal-mode>
- <https://developers.openai.com/codex/concepts/customization#skills>

---

Previous: [Troubleshooting](troubleshooting.md) · Next: [Index](index.md).
