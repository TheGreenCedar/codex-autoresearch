# Autoresearch Session: Indexing Pipeline Speed and Memory Footprint Optimization

## Goal

Optimize the indexing pipeline so rebuilds finish faster without letting peak memory climb back to the old baseline.

## Metric Contract

- Primary: seconds (`s`, lower is better)
- Secondary: memory_mb
- Formula shown in the dashboard demo: `weighted_cost = 0.7 * (seconds / baseline_seconds) + 0.3 * (memory_mb / baseline_memory_mb)`

`powershell -NoProfile -ExecutionPolicy Bypass -File ./autoresearch.ps1` prints `METRIC name=value` lines.

## Scope

- `autoresearch.ps1`: replayable benchmark script for the embedded 100-packet ledger
- `autoresearch.checks.ps1`: replayable correctness check for the demo packet
- `autoresearch.md`, `autoresearch.ideas.md`, and `demo.md`: human-readable demo context and next-step notes

The demo is intentionally self-contained. Its configured `commitPaths` point only at those demo-owned files, so doctor and showcase checks can prove the example scaffold is not referring to a missing project tree.

## Constraints

- Keep the run log reproducible for docs and screenshots.
- Preserve ASI on every packet so hover, modal, and ledger views stay meaningful.
- Keep correctness checks green before treating a faster path as promotion-ready.

## Baseline

- Baseline packet: `10s`
- Best kept packet: `5.62s`
- Latest tracked memory footprint: `216 MB`
