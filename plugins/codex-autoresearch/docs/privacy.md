# Privacy

Codex Autoresearch is a local Codex plugin workflow. It does not run a hosted service, create a project account, or add product telemetry of its own.

## What Stays Local

Autoresearch writes session state into the target working directory:

- `autoresearch.md`
- `autoresearch.jsonl`
- `autoresearch.config.json`
- `autoresearch.ideas.md`
- `autoresearch.last-run.json`
- `autoresearch.research/<slug>/`
- dashboard exports such as `autoresearch-dashboard.html`

The served dashboard is a local readout from the same files. Static dashboard exports are portable HTML snapshots. Treat both as project artifacts: they can contain command names, relative paths, metric values, benchmark output tails, ASI notes, artifact names, and summaries of what Codex tried.

## Command And Evidence Boundary

Benchmark and checks commands are not sandboxed by Autoresearch. They run as local shell processes with the current user's permissions, environment access, and filesystem reach from the target working directory.

Autoresearch records bounded evidence from those commands so later Codex sessions can resume the loop. It attempts best-effort redaction for common secrets, credentials, home paths, and env-file references, but redaction is not a confidentiality guarantee. Do not print secrets, tokens, private customer data, credentials, or sensitive local paths into benchmark output, checks output, ASI, descriptions, or artifact files.

Use `--command-file` and `--packet-env-file` for command text and environment overrides that need reviewable local files instead of fragile inline shell quoting. Prefer project-local wrappers such as `autoresearch.sh` or `autoresearch.ps1` when benchmark setup is sensitive.

## External Services

Autoresearch does not require a hosted Autoresearch backend. Your own benchmark, checks, package manager, Codex session, Git remote, browser, or external recipe catalog may contact third-party services. Those services are governed by their own privacy policies and account settings.

If a benchmark or checks command calls an external API, uploads data, pulls dependencies, starts a browser, or reads cloud credentials, that behavior comes from the command you approved, not from a hidden Autoresearch service.

## Package Contents

The plugin package includes the Codex skill, docs, small launcher scripts, compiled runtime, dashboard build assets, and plugin metadata. Source checkouts may contain additional development files and tests. Release/package artifacts are expected to exclude authored source, tests, examples not intended for packaging, stale MCP launchers, local credentials, and private logs.

## Your Responsibilities

Before running packets, logging keeps/discards, exporting dashboards, or sharing session files:

- inspect Git state and scope `commitPaths` / `revertPaths`
- review benchmark and checks commands before execution
- keep secrets out of command lines, output, ASI, and artifacts
- treat dashboard exports and ledgers as potentially sensitive project records
- verify active runtime provenance when installed behavior might differ from source

## Deleting Local Data

Autoresearch session data is stored in local project files. Remove or archive the session files and exports in the target repo when you no longer need them. In Git repos, also check whether session files were committed, stashed, or copied into review branches before assuming they are gone.

---

Previous: [Maintainers](maintainers.md) · Next: [Terms](terms.md).
