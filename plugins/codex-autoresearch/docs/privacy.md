# Privacy

Codex Autoresearch is a local Codex plugin workflow. It does not run a hosted service, create a project account, or add product telemetry of its own.

## What stays local

Autoresearch writes durable session state into the target working directory:

- `autoresearch.md`
- `autoresearch.jsonl`
- `autoresearch.config.json`
- `autoresearch.ideas.md`
- `autoresearch.research/<slug>/`
- dashboard exports such as `autoresearch-dashboard.html`

In Git repositories, active packet snapshots are Git-private files under `.git/autoresearch/`: `last-run.json`, `progress.json`, and pending log receipts such as `pending-log-*.json`. Outside Git, the same transient state falls back to worktree files: `autoresearch.last-run.json`, `autoresearch.progress.json`, and `autoresearch.pending-transaction.json`.

The served dashboard is a local readout from the same state. Static exports are portable HTML snapshots. Snapshots, ledgers, pending receipts, and dashboard exports can contain command names, relative paths, metric values, benchmark output tails, ASI notes, artifact names, and summaries of what Codex tried.

## Command and evidence boundary

Benchmark and checks commands are not sandboxed. They run as local shell processes with the current user's permissions, environment access, and filesystem reach from the target working directory.

Autoresearch records bounded evidence from those commands so later sessions can resume the loop. It attempts best-effort redaction for common secrets, credentials, home paths, and env-file references, but redaction is not a confidentiality guarantee. Do not print secrets, tokens, private customer data, credentials, or sensitive local paths into benchmark output, checks output, ASI, descriptions, or artifact files.

Use `--command-file` and `--packet-env-file` for command text and environment overrides that need reviewable local files. Prefer project-local wrappers such as `autoresearch.sh` or `autoresearch.ps1` when benchmark setup is sensitive. Outside-workdir option files are allowed for trusted local CLI use, but persisted last-run packets replace their paths with placeholders.

## External services

Autoresearch does not require a hosted backend. Your own benchmark, checks, package manager, Codex session, Git remote, browser, or external recipe catalog may contact third-party services. Those services are governed by their own privacy policies.

If a benchmark or checks command calls an external API, uploads data, pulls dependencies, starts a browser, or reads cloud credentials, that behavior comes from the command you approved.

## Package contents

The plugin package includes the Codex skill, docs, small launcher scripts, compiled runtime, dashboard build assets, and plugin metadata. Release artifacts exclude authored source, tests, examples not intended for packaging, and local credentials.

## Your responsibilities

Before running packets, logging keeps/discards, exporting dashboards, or sharing session files:

- inspect Git state and scope `commitPaths` / `revertPaths`
- review benchmark and checks commands before execution
- keep secrets out of command lines, output, ASI, and artifacts
- treat dashboard exports, ledgers, last-run packets, progress snapshots, and pending transaction receipts as potentially sensitive project records
- verify active runtime provenance when installed behavior might differ from source

## Deleting local data

Session data lives in local project files and, for Git repos, under `.git/autoresearch/`. Remove or archive both locations when you no longer need them. Also check whether session files, dashboard exports, pending receipts, or copied snapshots were committed, stashed, attached, or moved into review branches.

---

Previous: [Trust](trust.md) · Next: [Terms](terms.md).
