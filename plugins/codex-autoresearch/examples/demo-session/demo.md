# Demo Session

This demo is a 100-packet Autoresearch loop for optimizing an indexing pipeline's speed and memory footprint.

The session starts at `10.00s`, trends down to a best kept `5.62s`, and carries memory footprint on every packet so the dashboard has real tradeoff texture instead of one lonely number doing interpretive dance.

## The Optimization Journey

Over 100 packets, the loop explores several distinct `lanes` and `families` of ideas:

- **Packets 1-20 (The Easy Wins)**: Initial experiments focus on basic Node.js flags and I/O batch sizes. The score drops rapidly from 10.00s to around 7.50s.
- **Packets 21-50 (The Memory Wall)**: Codex discovers that caching parsed ASTs drops speed to 6.20s, but blows up the memory footprint. The weighted score (which penalizes high memory) rejects several aggressive cache attempts until a balanced LRU cache is found.
- **Packets 51-80 (The Plateau)**: The loop hits a plateau around 5.90s. The dashboard clearly shows repeated failures in the `parser-cache` family. Codex's ASI (`next_action_hint`) eventually pivots to a new lane: worker thread parallelization.
- **Packets 81-100 (The Breakthrough)**: Worker threads break the plateau, dropping the final time to `5.62s` while keeping memory well within budget. The final weighted improvement is **43% better than baseline**.

## Evidence Shape

The ledger includes:

- a demo-scoped commit surface: `autoresearch.sh`, `autoresearch.ps1`, `autoresearch.checks.ps1`, `autoresearch.md`, `autoresearch.ideas.md`, and `demo.md`
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
