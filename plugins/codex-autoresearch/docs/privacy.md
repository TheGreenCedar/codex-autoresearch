# Privacy

Codex Autoresearch has no hosted backend, account, or product telemetry of its own. It does run inside a Codex session: the Codex service or model provider is a separate data path governed by its own settings and terms. Local state also leaves the machine when your approved commands, Git workflow, browser, package manager, or other tools send it elsewhere.

## Files it writes

The target project may contain:

- `autoresearch.md`, `autoresearch.jsonl`, and `autoresearch.config.json`
- benchmark and checks wrappers
- `autoresearch.ideas.md`
- `autoresearch.research/<slug>/`
- static dashboard exports

In Git repositories, current packet state and interrupted-log receipts live under `.git/autoresearch/`. Outside Git, they fall back to `autoresearch.last-run.json`, `autoresearch.progress.json`, and `autoresearch.pending-transaction.json` in the worktree.

These records can include command names, relative paths, metric values, output excerpts, structured experiment notes, artifact names, and summaries of what Codex tried. A static dashboard export contains a snapshot of the same kind of information.

## What may leave the machine

Autoresearch itself does not require a separate cloud service. Your Codex session may send prompt and repository context to its configured model provider, and the commands you approve may also:

- call an API
- download packages
- start a browser
- push to a Git remote
- read credentials available to the process
- upload or transform project data

Those data paths belong to Codex, the model provider, the command, or the external service, each with its own privacy policy, account terms, cost, and rate limits.

## Redaction is not a security boundary

Packet persistence applies best-effort redaction to common secrets, credentials, home paths, and option-file references. It cannot guarantee that sensitive values will never appear.

Do not put secrets, tokens, credentials, private customer data, regulated data, or sensitive workstation paths into:

- command lines or environment files you do not control
- benchmark and checks output
- packet descriptions or structured experiment notes
- task manifests and artifact files
- dashboard exports

Prefer project-local command files and a minimal packet environment when possible.

## Before sharing or deleting

Before sharing a ledger, branch, dashboard, or research folder, inspect it as project data.

To remove a local session, archive or delete the worktree session files and the matching `.git/autoresearch/` records. Also check commits, stashes, review branches, attachments, and copied exports; deleting the original file does not remove those copies.
