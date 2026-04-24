# Demo Session

This demo is a 100-packet Autoresearch loop for optimizing an indexing pipeline's speed and memory footprint.

The session starts at `10s`, trends down to a best kept `5.62s`, and carries memory footprint on every packet so the dashboard has real tradeoff texture.

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
