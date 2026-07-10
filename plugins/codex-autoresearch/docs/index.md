# Codex Autoresearch docs

If you are new to the plugin, start with [Start](start.md), then follow [From baseline to finalization preview](walkthrough.md). Together they cover the first baseline, one measured change, and the point where useful work becomes ready for review.

The manual command examples assume a source checkout opened at `plugins/codex-autoresearch`. Marketplace users can stay inside Codex and ask `@Codex Autoresearch` to perform the same steps.

If you would rather inspect a finished session first, the [demo](../examples/index.md) has 100 packets with keeps, discards, failed checks, and a dashboard-ready ledger.

When a session already exists, [Operate](operate.md) explains how to resume it without trusting an old chat summary. [Trust](trust.md) covers the benchmark, Git, runtime, and command boundaries that decide whether a result is safe to keep. [Finish](finish.md) picks up once there are accepted changes worth turning into review branches. If something is broken or stale, go straight to [Troubleshooting](troubleshooting.md).

The remaining pages are references rather than a reading list:

- [Concepts](concepts.md) explains the terms and state fields that appear in detailed output.
- [Recipes](recipes.md) covers the built-in benchmark shapes and external catalogs.
- [Workflows](workflows.md) shows the main loops as diagrams.
- [Privacy](privacy.md) and [Terms](terms.md) describe the local data and command boundary.
- [Hooks](hooks.md) covers optional Codex reminders.

Contributors will also need [Architecture](architecture.md), [Control plane](control-plane.md), [Maintainers](maintainers.md), and the [documentation style guide](STYLE.md).
