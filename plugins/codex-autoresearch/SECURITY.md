# Security Policy

Security fixes target the latest public plugin release and the current `main` branch.

Report vulnerabilities, credential leaks, private logs, or exploitable workflow problems privately to [albertnajjar@outlook.com](mailto:albertnajjar@outlook.com). Do not open a public issue for sensitive reports. Include the affected version or commit, operating system and Codex/runtime context, reproduction steps, impact, and safe supporting evidence. Remove credentials, private repository names, customer data, and unrelated local paths from logs before sending them.

The maintainer will triage the report, request missing reproduction details when needed, and coordinate a fix or mitigation. Public disclosure should wait until a reasonable patch or workaround is available. This follows the repository's [security policy](https://github.com/TheGreenCedar/codex-autoresearch/blob/main/SECURITY.md).

Approved benchmark and check commands are not sandboxed by this plugin. They run with local permissions and can access explicitly supplied credentials or operating-system stores, contact services, and incur costs. Evidence redaction is best-effort. See [Trust](docs/trust.md) and [Privacy](docs/privacy.md) for the execution and data boundaries.

For ordinary crashes, stale cache behavior, documentation problems, dashboard issues, or benchmark-contract bugs, use the repository's [public issue templates](https://github.com/TheGreenCedar/codex-autoresearch/issues/new/choose).
