# Benchmark recipes

A recipe supplies the shape of a benchmark: metric, direction, command, checks, caveats, and likely commit scope. It is a starting point, not proof that the workload fits your project.

## Find one

```bash
node scripts/autoresearch.mjs recipes list
node scripts/autoresearch.mjs recipes recommend --cwd <project>
```

Built-in adapters cover Node/npm, Vitest, Cargo, Go, pytest, .NET, TypeScript compile time, bundle size, memory, Lighthouse, command latency, custom metrics, and `quality_gap`.

Recommendations inspect the target project and return a recipe plus setup and doctor commands. Read the proposed command before accepting it.

## Set up from a recipe

Preview first:

```bash
node scripts/autoresearch.mjs setup-plan --cwd <project> --recipe node-test-runtime
```

Then create the session and verify the benchmark:

```bash
node scripts/autoresearch.mjs setup --cwd <project> --recipe node-test-runtime
node scripts/autoresearch.mjs doctor --cwd <project> --check-benchmark --explain
```

Placeholder recipes such as `custom`, `command-latency`, and an unconfigured `lighthouse-score` fail until you replace the placeholder with a real workload. This is deliberate; a template must not masquerade as evidence.

If you customize the output, check the metric contract:

```bash
node scripts/autoresearch.mjs benchmark-lint --cwd <project> --sample "METRIC seconds=1.23" --metric-name seconds
```

## External catalogs

```bash
node scripts/autoresearch.mjs setup-plan --cwd <project> --catalog ./recipes.json --recipe team-runtime
node scripts/autoresearch.mjs setup --cwd <project> --catalog ./recipes.json --recipe team-runtime --trust-catalog
```

Catalog recipes can materialize local commands. Inspect the catalog and setup plan before passing `--trust-catalog`. The catalog fingerprint is saved so later drift can block a packet.

Ordinary `doctor` runs use the saved provenance without making a network request. Run `doctor --revalidate-catalog` only when you deliberately want to refetch a public HTTPS catalog and verify that its digest is unchanged. Keep internal catalogs as local files.

## A useful recipe

A recipe is ready when it has one primary metric, the correct direction, short output, a real `METRIC name=value` contract or explicit timing wrapper, fast checks where possible, narrow commit paths, and honest caveats.
