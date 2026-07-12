# Dashboard and trust

Load this reference for dashboard mode, runtime drift, protected paths, fixed controls, command safety, redaction, or promotion claims.

## Keep live state distinct from snapshots

Use `serve --cwd <project>` for the live loopback readout and `export --cwd <project>` for an offline snapshot. Verify the served URL before presenting it as current.

Keep the dashboard read-only. Run setup, packets, logging, gap work, export, and finalization through the CLI.

Treat a payload-unavailable screen as a trust blocker. Follow its safe `export` or `serve` recovery guidance; do not describe the missing readout as evidence. Demo data is valid only when an explicit showcase marker is visible. If live refresh fails, report that the dashboard is showing its last validated readout rather than current state.

Read the focused operate view first: status, blocker, action, and safe command come from the canonical decision. Use audit for deeper evidence, not a different answer. A static export is a file artifact, so share the HTML itself; never copy or present its local `file://` location as a usable readout URL.

## Check the proof before the claim

Read these fields before calling a result current or promotable:

- `runtimeProvenance` and `runtimeDriftSummary`: did the intended runtime produce the evidence?
- `packetDiagnostics`: did a packet lose, misclassify, or contradict evidence?
- `sourceCleanliness`: are source files dirty, or only session artifacts?
- `evidenceMaturity`, `researchIntegrity`, and claim coverage: what wording does the evidence actually support?

Do not present source-checkout changes as installed-plugin behavior while the installed version or built-entrypoint fingerprint differs.

Keep `review_required` results provisional until review is recorded. Treat benchmark-keyed fixes, static citations, protected probes, and scorer-tuned changes as diagnostic until repeat, holdout, breadth, or an explicit promotion gate supports more.

## Protect the control and the command boundary

Keep `protectedBenchmarkPaths` small enough to fingerprint and review. Move an intentional change to benchmark meaning into a new segment.

When config contains `fixedControl`, reuse its artifact. Do not run a matching forbidden command unless the user explicitly approves `--allow-fixed-control-rerun`.

Benchmark and checks commands are not sandboxed. Review them, keep secrets out of command lines and output, and treat persisted redaction as best-effort only.