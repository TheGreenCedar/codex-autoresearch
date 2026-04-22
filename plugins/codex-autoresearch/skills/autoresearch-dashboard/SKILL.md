---
name: autoresearch-dashboard
description: Export and inspect a Codex autoresearch dashboard from autoresearch.jsonl. Use when the user asks to show, view, export, summarize, chart, or inspect autoresearch experiment progress or results.
---

# Autoresearch Dashboard

Use this skill to open the live autoresearch dashboard for `autoresearch.jsonl`: a local served runboard with refresh, compact metric trajectory, experiment-family and lane-portfolio panels, setup/readiness/gap/finalization panels, and safe local actions.

## Workflow

1. Locate the target project containing `autoresearch.jsonl`.
2. Prefer the MCP `serve_dashboard` tool when available.
3. Otherwise run from the plugin root:

```bash
node scripts/autoresearch.mjs serve --cwd /absolute/project/path
```

The `serve` command prints JSON with the local `url` and then stays alive to keep the dashboard available. Report that live URL as the dashboard link.

4. Use `export_dashboard` or `node scripts/autoresearch.mjs export --cwd /absolute/project/path` only when the user explicitly needs an offline snapshot or the live server cannot be started.
5. If the user has the dashboard open, keep using the live URL. It can refresh from disk and does not need a fresh static export after each run.
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

The dashboard has two modes. A served dashboard from `node scripts/autoresearch.mjs serve --cwd /absolute/project/path` is the default live-action surface: it can refresh `view-model.json` and call guarded local `/actions/...` endpoints. A direct `file://` open is only a static fallback snapshot: it embeds the current JSONL, but it must not render inert live controls or a copyable command panel.

When handing a dashboard to the user, provide the served URL by default. Label static exports as fallback snapshots only when live serving is unavailable or explicitly requested.

Read the top metric trajectory, newest-first run log, generated Codex brief, and loop stage rail first. The dashboard should keep the next action visible without turning terminal commands into a second UI language.

Treat dashboard warnings with stable codes as operator blocks. In particular, `empty_commit_paths_in_git_repo` means kept runs will not auto-commit until `commitPaths` are configured, `--commit-paths` is supplied, an existing `--commit` is recorded, or add-all is explicitly allowed.

The live action panel is shown only when the dashboard is served locally. It calls local `serve` endpoints only. These safe live actions include doctor, setup-plan, recipe listing, gap-candidates preview, finalize-preview, and export. Confirmed keep/discard logging requires a specific description; branch creation stays outside the dashboard.

## Notes

The compact metric trajectory, virtualized newest-first run log directly below the graph, generated Codex brief, setup/gap/finalization cockpit, experiment portfolio, segment selector, live status strip, and ready-to-finalize card are designed to keep the active loop visible without burying the chart or making the operator hunt for the next action.

If no `autoresearch.jsonl` exists, say that there is no session to export yet and point the user to `autoresearch-create`.
