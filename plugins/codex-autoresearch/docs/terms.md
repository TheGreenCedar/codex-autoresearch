# Terms and operating boundary

Codex Autoresearch is an Apache-2.0 licensed local plugin. The repository [license](../../../LICENSE) is the authority for license rights and obligations; this page explains the practical boundary of the tool.

## You approve the commands

Benchmark, checks, package-manager, Git, browser, and external-service commands run with local process permissions. They may read or write files, start processes, use available credentials, access the network, and incur third-party costs.

Review command text before execution. Do not trust a generated command or external recipe merely because Autoresearch can run it.

## Evidence is not a guarantee

Autoresearch records metrics, packet evidence, structured experiment notes, artifacts, and finalization previews so work can be resumed and reviewed. A parsed metric does not prove correctness, security, privacy, compliance, deployment readiness, or commercial fitness.

`benchmark-lint` may pass while `doctor`, `state`, or finalization still blocks on dirty Git, runtime mismatch, stale packets, missing checks, or weak promotion evidence.

## Sensitive data

Keep secrets, credentials, private customer data, regulated data, and confidential business data out of commands, output, descriptions, experiment notes, and artifacts. Redaction is best-effort only.

If your commands use external services, you are responsible for their data flow, account terms, cost, rate limits, and compliance requirements.

## No warranty

The plugin is provided under the repository license without warranty. Review generated commits, branches, docs, dashboards, and packages before publishing or deploying them.

The plugin is distributed through the Codex marketplace, not as a public npm package. `npm install` inside `plugins/codex-autoresearch` is for development and verification.
