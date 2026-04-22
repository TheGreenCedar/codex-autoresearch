---
name: autoresearch-dashboard
description: Export and inspect a Codex autoresearch dashboard from autoresearch.jsonl. Use when the user asks to show, view, export, summarize, chart, or inspect autoresearch experiment progress or results.
---

# Autoresearch Dashboard

Use this skill to turn `autoresearch.jsonl` into an HTML dashboard with embedded snapshot data, a next-best-action rail, experiment-family and lane-portfolio panels, optional live refresh from disk, copyable operator commands, setup/readiness/gap/finalization panels, and safe local actions when served through live mode.

## Workflow

1. Locate the target project containing `autoresearch.jsonl`.
2. Prefer the MCP `export_dashboard` tool when available.
3. Otherwise run from the plugin root:

```bash
node scripts/autoresearch.mjs export --cwd /absolute/project/path
```

4. Report the generated `autoresearch-dashboard.html` path and explicitly label it as the static, read-only export with copyable commands.
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
- Plateau and lane-portfolio guidance when recent runs cluster around similar hypotheses.
- Whether the iteration limit is reached and whether finalization looks timely.
- Which segment is active when multiple segments exist.
- Whether the dashboard says the branch is ready to finalize.

## Live Dashboard Behavior

The dashboard has two modes. A direct `file://` open is a static snapshot: it embeds the current JSONL and provides copyable commands, but it must not render inert live controls. A served dashboard from `node scripts/autoresearch.mjs serve --cwd /absolute/project/path` is the live-action surface: it can refresh `view-model.json` and call guarded local `/actions/...` endpoints.

When handing a dashboard to the user, say which mode they are looking at. Use the static export for portable review and PR/status links. Use the served URL when the user expects dashboard buttons to run doctor, gap preview, finalize-preview, export, or confirmed log actions.

The next-best-action rail should be read first. The command panel includes copyable commands for setup-plan, doctor, next run, keep/discard last packet, gap candidates, finalization preview, dashboard export, serve dashboard, and iteration-limit extension. Use those commands as operator shortcuts, not as a substitute for reading the current run output before keeping a change.

The live action panel is shown only when the dashboard is served locally. It calls local `serve` endpoints only. These safe live actions include doctor, setup-plan, recipe listing, gap-candidates preview, finalize-preview, and export. Confirmed keep/discard logging requires a specific description; branch creation stays outside the dashboard.

## Notes

The next-best-action rail, operator readout, setup/gap/finalization cockpit, experiment portfolio, segment selector, command panel, live status strip, and ready-to-finalize card are designed to make exported dashboards useful in PRs and status updates, not just local charts.

If no `autoresearch.jsonl` exists, say that there is no session to export yet and point the user to `autoresearch-create`.
