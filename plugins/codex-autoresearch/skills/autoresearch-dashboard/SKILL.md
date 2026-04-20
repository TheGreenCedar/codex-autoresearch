---
name: autoresearch-dashboard
description: Export and inspect a Codex autoresearch dashboard from autoresearch.jsonl. Use when the user asks to show, view, export, summarize, chart, or inspect autoresearch experiment progress or results.
---

# Autoresearch Dashboard

Use this skill to turn `autoresearch.jsonl` into an HTML dashboard with embedded snapshot data, optional live refresh from disk, and copyable operator commands.

## Workflow

1. Locate the target project containing `autoresearch.jsonl`.
2. Prefer the MCP `export_dashboard` tool when available.
3. Otherwise run from the plugin root:

```bash
node scripts/autoresearch.mjs export --cwd /absolute/project/path
```

4. Report the generated `autoresearch-dashboard.html` path.
5. If the user has the dashboard open, re-export after meaningful new runs so the embedded command metadata stays current.
6. If the user asked for a summary, also run:

```bash
node scripts/autoresearch.mjs state --cwd /absolute/project/path
```

Then summarize baseline, best metric, run count, status counts, confidence, and remaining iteration limit if available.

Use this review readout pattern when summarizing:

- Best kept run and why it appears best.
- Recent regressions, crashes, or checks failures.
- Confidence caveat: explain whether the signal is strong or still noisy.
- Top ASI next action, especially `next_action_hint`.
- Whether the iteration limit is reached and whether finalization looks timely.
- Which segment is active when multiple segments exist.
- Whether the dashboard says the branch is ready to finalize.

## Live Dashboard Behavior

The dashboard can be opened directly from disk and does not require a dev server. It embeds the current JSONL snapshot, then the `Refresh` and `Live on` controls try to refetch `autoresearch.jsonl` next to the HTML file. If the browser blocks local `fetch` for `file://`, the embedded snapshot remains usable and the status strip reports that live refresh is unavailable.

The command panel includes copyable commands for doctor, next run, keep/discard last packet, dashboard export, and iteration-limit extension. Use those commands as operator shortcuts, not as a substitute for reading the current run output before keeping a change.

## Notes

The operator readout, segment selector, command panel, live status strip, and ready-to-finalize card are designed to make exported dashboards useful in PRs and status updates, not just local charts.

If no `autoresearch.jsonl` exists, say that there is no session to export yet and point the user to `autoresearch-create`.
