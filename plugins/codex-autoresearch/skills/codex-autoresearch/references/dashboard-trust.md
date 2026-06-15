# Dashboard And Trust Reference

Load this for dashboard, trust, drift, protected benchmark, redaction, or command-safety questions.

## Dashboard modes

The served dashboard is the live local readout. Static exports are offline snapshots. If fresh state matters, serve a new dashboard and verify liveness before sharing the URL.

The dashboard supports judgment; it is not the workflow driver. Mutating setup, packet runs, logging, gap review, export, and finalization stay in the CLI.

## Protected benchmark paths

`protectedBenchmarkPaths` records the benchmark files or small fixture folders that define the measurement contract. Keep these paths tight. Prefer a small manifest, fixture list, or contract file over large generated/data directories.

Intentional benchmark changes should start a new segment or promotion gate so old and new evidence are not mixed.

## Command boundary

Autoresearch does not sandbox benchmark or checks commands. Approved commands run as local shell processes with the current user's permissions.

Review generated commands before running them. Keep secrets out of command lines and benchmark output. Evidence redaction is best-effort, not a confidentiality guarantee.

## Runtime freshness

Treat runtime freshness as unavailable unless the installed runtime version and built-entrypoint fingerprint can be inspected and matched. If source and installed runtime drift, inspect the cache layer before making public claims.

## Trust readout checklist

Before promoting a packet or claiming live behavior:

- Read `runtimeProvenance` and `runtimeDriftSummary` — source edits are not live evidence when runtime drifts.
- Read `packetDiagnostics` — evidence-loss runs are diagnostic, not wins.
- Read `sourceCleanliness` — distinguish source-dirty from session-artifacts-dirty.
- Read `evidenceMaturity` and claim coverage — report the weaker supportable claim when proof is incomplete.

Field glossary: `docs/concepts.md#state-fields`.
