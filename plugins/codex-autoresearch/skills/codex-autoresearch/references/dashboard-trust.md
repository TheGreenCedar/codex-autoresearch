# Dashboard And Trust Reference

Load this for dashboard, trust, drift, protected benchmark, redaction, or command-safety questions.

## Dashboard Modes

The served dashboard is the live local readout. Static exports are offline snapshots. If fresh state matters, serve a new dashboard and verify liveness before sharing the URL.

The dashboard supports judgment; it is not the workflow driver. Mutating setup, packet runs, logging, gap review, export, and finalization stay in the CLI.

## Protected Benchmark Paths

`protectedBenchmarkPaths` records the benchmark files or small fixture folders that define the measurement contract. Keep these paths tight. Prefer a small manifest, fixture list, or contract file over large generated/data directories because protected directory snapshots recursively walk leaves and hash file contents.

Intentional benchmark changes should start a new segment or promotion gate so old and new evidence are not mixed.

## Command Boundary

Autoresearch does not sandbox benchmark or checks commands. Approved commands run as local shell processes with the current user's permissions, environment access, and filesystem reach from the target working directory.

Review generated commands before running them. Keep secrets out of command lines and benchmark output. Evidence redaction is best-effort, not a confidentiality guarantee.

## Runtime Freshness

Treat runtime freshness as unavailable unless the installed runtime version and built-entrypoint fingerprint can be inspected and matched. If source and installed runtime drift, inspect the cache layer before making public claims.
