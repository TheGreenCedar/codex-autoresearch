# Recipes

Recipes give a new loop a benchmark shape before anyone starts hand-carving shell commands out of panic.

## List Recipes

```bash
node scripts/autoresearch.mjs recipes list
```

## Recommend A Recipe

```bash
node scripts/autoresearch.mjs recipes recommend --cwd <project>
```

This inspects the project and returns a suggested recipe plus setup/doctor commands.

MCP users can call `list_recipes` with `recommend: true`.

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
```

Over MCP, external catalog setup guidance can materialize shell commands, so pass `allow_unsafe_command: true` deliberately.

## Good Recipe Shape

A good recipe:

- has one primary metric
- names direction as `lower` or `higher`
- keeps command output short
- prints `METRIC name=value`
- includes checks when a fast correctness gate exists
- scopes commits to project files, not broad repo state
