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

- kept runs when an indexing strategy beats the current best metric
- rejected runs when a new batching or cache idea is slower than the best kept path
- checks-failed runs when a measurable packet is unsafe to keep

The checked-in session is preconfigured, so the default benchmark and checks paths work out of the box.

Open the runboard through the local server to see the example session as a live operator surface:

```bash
node scripts/autoresearch.mjs serve --cwd examples/demo-session
```

Verify the default path with doctor:

```bash
node scripts/autoresearch.mjs doctor --cwd examples/demo-session --check-benchmark
```

`autoresearch-dashboard.html` is the curated docs showcase that ships with the current dashboard build and bundled demo data. Refresh it with the portable showcase mode so local workstation paths and feature-branch Git warnings are not embedded in the public demo:

```bash
node scripts/autoresearch.mjs export --cwd examples/demo-session --output autoresearch-dashboard.html --showcase
```

If you want a raw portable export of the example session evidence, write it to a separate file instead of overwriting the curated demo:

```bash
node scripts/autoresearch.mjs export --cwd examples/demo-session --output autoresearch-dashboard.session.html
```
