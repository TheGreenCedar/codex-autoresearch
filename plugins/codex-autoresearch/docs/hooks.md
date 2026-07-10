# Optional Codex hooks

Hooks can remind Codex to read or log Autoresearch state at useful moments. They are not required, and they must never become the only place a safety rule lives.

Autoresearch can print its conservative integration guidance:

```bash
node scripts/autoresearch.mjs doctor hooks
```

`doctor hooks` does not probe the active Codex build or configuration. Its output is an Autoresearch compatibility note and may be more conservative than current Codex support, especially on Windows. Check the current Codex Hooks documentation and your local configuration before enabling a hook. The normal CLI path remains complete without hooks.

## Useful reminders

| Event | Useful hook behavior |
| --- | --- |
| `SessionStart` | Print `onboarding-packet --compact`, the next safe action, and any goal advice |
| `PostToolUse` | Notice `METRIC name=value` output and remind Codex to log the packet with a structured experiment note |
| `Stop` | Warn about an unlogged last-run packet or a continuation that still forbids completion |

For Codex Goal mode, a hook may suggest `codex-goal-brief --cwd <project>` and its completion audit. Goal lifecycle stays in Codex; the plugin does not read private Codex databases or mutate task goals.

## Hard limits

Hooks are reminders or context injection. They do not replace:

- benchmark and schema validation
- command approval gates
- last-run freshness checks
- Git scope and pending-transaction receipts
- dashboard freshness labels
- human approval for branch creation or other irreversible work

Official references:

- <https://developers.openai.com/codex/hooks>
- <https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex>
- <https://developers.openai.com/codex/concepts/customization#skills>
