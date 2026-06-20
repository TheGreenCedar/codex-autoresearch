# Examples

Codex Autoresearch examples are small, inspectable sessions that show the product shape without needing a real optimization target.

## Demo Session

- [Tour](demo-session/demo.md)
- [Ledger](demo-session/autoresearch.jsonl)

The demo improves an indexing pipeline from `10s` to `5.62s` across 100 packets while tracking memory footprint, with kept wins, discarded regressions, and failed checks. Use it to understand the evidence trail before starting a loop in a real repo, where the floor has sharper edges.

For current dashboard behavior, serve the demo session locally or generate an ignored review export from the package root:

```bash
node scripts/autoresearch.mjs serve --cwd examples/demo-session
node scripts/autoresearch.mjs export --cwd examples/demo-session --output tmp/autoresearch-dashboard.review.html --showcase
```

The committed `demo-session/autoresearch-dashboard.html` is a legacy fixture, not the current dashboard runboard or product-gate parity target.
