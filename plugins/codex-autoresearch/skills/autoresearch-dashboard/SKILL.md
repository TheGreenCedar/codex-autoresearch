---
name: autoresearch-dashboard
description: Export and inspect a Codex autoresearch dashboard from autoresearch.jsonl. Use when the user asks to show, view, export, summarize, chart, or inspect autoresearch experiment progress or results.
---

# Autoresearch Dashboard

Use this skill to turn `autoresearch.jsonl` into a self-contained HTML dashboard.

## Workflow

1. Locate the target project containing `autoresearch.jsonl`.
2. Prefer the MCP `export_dashboard` tool when available.
3. Otherwise run from the plugin root:

```bash
node scripts/autoresearch.mjs export --cwd /absolute/project/path
```

4. Report the generated `autoresearch-dashboard.html` path.
5. If the user asked for a summary, also run:

```bash
node scripts/autoresearch.mjs state --cwd /absolute/project/path
```

Then summarize baseline, best metric, run count, status counts, confidence, and remaining iteration limit if available.

## Notes

The dashboard is static and self-contained. It can be opened directly from disk and does not require a dev server.

If no `autoresearch.jsonl` exists, say that there is no session to export yet and point the user to `autoresearch-create`.
