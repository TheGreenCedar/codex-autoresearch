# Examples

Codex Autoresearch examples are small, inspectable sessions that show the product shape without needing a real optimization target.

## Demo Session

- [Tour](demo-session/demo.md)
- [Session contract](demo-session/autoresearch.md)
- [Next ideas](demo-session/autoresearch.ideas.md)
- [Ledger](demo-session/autoresearch.jsonl)

The demo improves an indexing pipeline from `10s` to `5.62s` across 100 packets while tracking memory. It includes kept wins, discarded regressions, and failed checks, so you can inspect the evidence trail before trying the workflow in a real repository.

These commands are for a source checkout opened at `plugins/codex-autoresearch`. Marketplace users can ask `@Codex Autoresearch` to show the demo. For current dashboard behavior, serve the demo session locally or generate an ignored review export from the package root:

```bash
node scripts/autoresearch.mjs serve --cwd examples/demo-session
node scripts/autoresearch.mjs export --cwd examples/demo-session --output tmp/autoresearch-dashboard.review.html --showcase
```

The committed `demo-session/autoresearch-dashboard.html` is a legacy fixture, not the current dashboard runboard or product-gate parity target.
