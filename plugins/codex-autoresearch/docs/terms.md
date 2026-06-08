# Terms

Codex Autoresearch is distributed as an Apache-2.0 licensed Codex plugin package. These terms summarize the practical operating boundary for using it; the license file remains the source for license rights and obligations.

## Local Tooling

Autoresearch helps Codex run measured loops over a target repo:

```text
setup -> doctor -> next -> log -> state -> finalize-preview
```

It is a local CLI/skill workflow, not a hosted Autoresearch service. The dashboard is a readout. Setup, packet runs, logging, gap review, export, and finalization stay in the CLI/Codex workflow, not in dashboard mutation controls.

## Command Responsibility

You are responsible for the commands you ask Autoresearch to run. Benchmark, checks, package-manager, Git, browser, and external-service commands run with local permissions and may read files, write files, start processes, access the network, or use credentials available to the process.

Review command text before execution. Do not run generated or recipe-derived commands unless you understand their effect on the target repo and environment.

## Evidence And Results

Autoresearch records metrics, packet evidence, ASI, artifacts, and finalization previews to make the loop resumable and reviewable. Results are evidence, not guarantees. A parsed metric does not prove correctness, promotion readiness, deployment readiness, security, privacy, legal compliance, or commercial fitness.

`benchmark-lint` can prove that a primary `METRIC name=value` line parses while `doctor`, `state`, and finalization checks may still block because of dirty Git, runtime drift, current-tree coverage, stale packets, missing promotion guards, or other trust issues.

## Secrets And Sensitive Data

Do not put secrets, credentials, private customer data, regulated data, or confidential business data into command lines, benchmark output, ASI, descriptions, or artifacts. Redaction is best-effort only and should not be treated as a security boundary.

If your own commands call external APIs or services, you are responsible for that data flow and any account terms, costs, rate limits, and compliance obligations.

## No Warranty

Autoresearch is provided under the repository license without warranty. Use it as an engineering aid, verify important changes independently, and review all generated branches, commits, docs, dashboards, and package artifacts before publishing or deploying them.

## Package And Marketplace Use

The operator install path is the Codex plugin marketplace flow described in the README. The package is private from an npm-operator perspective; local `npm install` in `plugins/codex-autoresearch` is for development and verification.

When installed plugin behavior differs from source, inspect the active Codex plugin cache, version, and built-entrypoint fingerprint before treating source edits as live behavior.

---

Previous: [Privacy](privacy.md) · Next: [Start](start.md).
