# Codex Hooks

Hooks are optional future guardrails for Autoresearch. Useful, maybe. Load-bearing, no.

## Current Position

- Keep hooks opt-in.
- Do not enable hook templates by default.
- Keep core behavior correct without hooks.
- On Windows, treat hooks as not dependable as a default path.
- Use `doctor hooks` for local feasibility and caveats.

```bash
node scripts/autoresearch.mjs doctor hooks
```

## Useful Hook Ideas

`SessionStart`:

- run or suggest `onboarding-packet --compact`
- surface the current next safe action
- remind the agent to start the live dashboard

`PostToolUse`:

- notice shell output containing `METRIC name=value`
- remind the agent to log the packet with ASI
- warn if a packet command ran but no log decision followed

`Stop`:

- warn when `autoresearch.last-run.json` exists
- warn when continuation says `forbidFinalAnswer`
- suggest `state --compact` before final reporting

## Limits

Hooks are experimental. They are best used as reminders or context injection, not irreversible enforcement.

They must not replace:

- MCP schemas
- CLI validation
- unsafe command gates
- last-run freshness checks
- dashboard action guards
- Git safety
- human approval for irreversible work

Official docs:

- <https://developers.openai.com/codex/hooks>
- <https://developers.openai.com/codex/concepts/customization#skills>
