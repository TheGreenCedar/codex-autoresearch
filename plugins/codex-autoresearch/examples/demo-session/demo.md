# Demo session

This demo is a 100-packet Autoresearch loop for optimizing an indexing pipeline's speed and memory footprint.

The session starts at `10.00s`, reaches a best kept result of `5.62s`, and records memory on every packet so the dashboard shows the tradeoff instead of runtime alone.

## What the loop tried

Over 100 packets, the loop explores several distinct `lanes` and `families` of ideas:

- **Packets 1-20:** Node.js flags and I/O batch sizes bring runtime from `10.00s` to about `7.50s`.
- **Packets 21-50:** Parsed-AST caching reaches `6.20s` but uses too much memory. Several cache variants are rejected before a bounded LRU cache passes the weighted score.
- **Packets 51-80:** Results flatten near `5.90s`. Repeated failures in the `parser-cache` family push the next-action note toward worker threads.
- **Packets 81-100:** Worker threads reach `5.62s` without breaking the memory budget. Runtime is 43.8% lower than baseline; after the higher memory use is included, weighted cost improves by 24.3%.

## What is in the ledger

The ledger includes:

- a demo-scoped commit surface: `autoresearch.sh`, `autoresearch.ps1`, `autoresearch.checks.ps1`, `autoresearch.md`, `autoresearch.ideas.md`, and `demo.md`
- a baseline recorded as `measure`, before any implementation was changed
- kept runs when an indexing strategy beats the current best metric
- rejected runs when a new batching or cache idea is slower than the best kept path
- checks-failed runs when a measurable packet is unsafe to keep

The checked-in session is preconfigured, so the default benchmark and checks paths work out of the box.

Open the dashboard through the local server to see the example session with fresh dashboard code:

```bash
node scripts/autoresearch.mjs serve --cwd examples/demo-session
```

Verify the default path with doctor:

```bash
node scripts/autoresearch.mjs benchmark-lint --cwd examples/demo-session
node scripts/autoresearch.mjs doctor --cwd examples/demo-session --check-benchmark --explain
```

The demo benchmark is expected to parse cleanly: `benchmark-lint` should report the configured `seconds` metric. That is narrower than full session readiness. In a source checkout, `doctor --check-benchmark --explain` may still return non-ready because finalization/current-tree coverage, dirty local files, stale runtime provenance, development-only evidence, or other trust blockers are real in the current checkout. Treat that as demo truth, not a broken metric parser.

If you need a portable dashboard file for review, generate an ignored showcase export:

```bash
node scripts/autoresearch.mjs export --cwd examples/demo-session --output tmp/autoresearch-dashboard.review.html --showcase
```

`npm run check` writes its own ignored trust export at `examples/demo-session/tmp/autoresearch-dashboard.check.html`. That generated export is the parity target for current dashboard source, bundled assets, showcase metadata, redaction, and read-only behavior.

The committed `autoresearch-dashboard.html` is a legacy fixture. Do not use it as the current runboard, and do not refresh it for routine dashboard changes.

If you want a raw portable export of the example session evidence, write it under `tmp/` instead of overwriting the legacy fixture:

```bash
node scripts/autoresearch.mjs export --cwd examples/demo-session --output tmp/autoresearch-dashboard.session.html
```
