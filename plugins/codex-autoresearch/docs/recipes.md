# Recipes

Recipes give a new loop a benchmark shape before anyone writes custom shell commands.

## List Recipes

```bash
node scripts/autoresearch.mjs recipes list
```

## Recommend A Recipe

```bash
node scripts/autoresearch.mjs recipes recommend --cwd <project>
```

This inspects the project and returns a suggested recipe plus setup/doctor commands.

Built-in ecosystem adapters include Node/npm, Vitest, Cargo, Go, pytest, .NET, TypeScript compile time, bundle size, memory usage, Lighthouse, quality-gap, command latency, and custom metric loops. Recipes carry the primary metric, direction, benchmark/check command, caveats, tags, and scoped commit paths.

Placeholder recipes such as `custom`, `command-latency`, and unconfigured `lighthouse-score` intentionally fail loudly until the benchmark command is replaced with a real workload that prints `METRIC name=value` or is wrapped by setup timing.

## Setup From A Recipe

```bash
node scripts/autoresearch.mjs setup-plan --cwd <project> --recipe node-test-runtime
node scripts/autoresearch.mjs setup --cwd <project> --recipe node-test-runtime
node scripts/autoresearch.mjs doctor --cwd <project> --check-benchmark
```

Use `benchmark-lint` if the recipe output is being customized:

```bash
node scripts/autoresearch.mjs benchmark-lint --cwd <project> --sample "METRIC seconds=1.23" --metric-name seconds
```

## External Catalogs

External catalogs can add local team recipes:

```bash
node scripts/autoresearch.mjs setup-plan --cwd <project> --catalog ./recipes.json --recipe team-runtime
node scripts/autoresearch.mjs setup --cwd <project> --catalog ./recipes.json --recipe team-runtime --trust-catalog
```

External catalog setup guidance can materialize shell commands. Inspect the catalog and setup plan first, then pass `--trust-catalog` only when the source and commands are intentionally admitted. Trusted catalog provenance is stored in session config so `doctor` and `next` can block on later catalog drift.

## Good Recipe Shape

A good recipe:

- has one primary metric
- names direction as `lower` or `higher`
- keeps command output short
- prints `METRIC name=value` or clearly marks that setup should wrap a raw workload and emit elapsed time
- includes checks when a fast correctness gate exists
- scopes commits to project files, not broad repo state
- names caveats before the first packet so Codex does not treat weak placeholders as runnable evidence
