# Codex Autoresearch Docs

The root `README.md` is the front door. These pages cover the operator workflow, evidence rules, dashboard readouts, and release-maintainer details.

## Start Here

1. [Start](start.md): the happy path, first five minutes, session files, benchmark contract, and first packet.
2. [Walkthrough](walkthrough.md): an end-to-end narrated loop showing inputs and real terminal output.
3. [Trust](trust.md): metric integrity, stale packets, runtime provenance, packet diagnostics, evidence status, drift, dirty Git, static exports, and unsafe command gates.
4. [Finish](finish.md): accepted/current evidence, finalization pressure, preview, review branches, merge/cleanup, and reporting.

## Advanced Diagnostics

Open these only when the short path is blocked, stale, or too vague to trust.

- [Operate](operate.md): use this when resuming a messy run, deciding whether another packet is safe, serving a fresh dashboard, logging ASI, or opening parallel/quality-gap lanes.
- [Workflow diagrams](workflows.md): use this when the loop order is unclear and you need the setup, packet, fanout, dashboard, or finalization flow at a glance.
- [Architecture diagrams](architecture.md): use this when changing internals or checking that the CLI, skill, dashboard, state files, and finalizer still have clear ownership.
- [Recipes](recipes.md): use this when no benchmark exists yet or the request needs a starter metric plan.
- [Concepts](concepts.md): use this when a term in state, ASI, dashboard output, or reviewer feedback is unfamiliar.
- [Troubleshooting](troubleshooting.md): use this when symptoms point to cache drift, stale dashboards, missing metrics, Git dirtiness, lane isolation, or provenance blockers.
- [Hooks](hooks.md): use this only for optional Codex reminders; hooks are not required for the normal loop.

Reference pages:

- [Maintainers](maintainers.md)
