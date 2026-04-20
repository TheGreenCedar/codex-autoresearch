# Demo Session

This tiny session shows the full Codex Autoresearch shape without needing a real project:

1. A baseline run records `seconds=10`.
2. A kept change improves the metric to `7.2`.
3. A discarded change regresses to `12.4` and leaves rollback notes.
4. The dashboard turns the JSONL trail into an operator readout.

Regenerate the dashboard from the plugin root:

```bash
node scripts/autoresearch.mjs export --cwd examples/demo-session
```
