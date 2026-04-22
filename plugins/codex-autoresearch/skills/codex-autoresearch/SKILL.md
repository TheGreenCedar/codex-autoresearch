---
name: codex-autoresearch
description: Run Codex Autoresearch end to end from one plugin skill. Use when Codex should start, resume, inspect, dashboard, deep-research, iterate, log, or finalize measured optimization loops using autoresearch.md, autoresearch.jsonl, quality_gap scratchpads, MCP tools, or the local CLI helpers.
---

# Codex Autoresearch

Run one measured loop until the useful stopping point: set up the benchmark, keep the live dashboard available, run packets, log decisions, preserve ASI, and finalize kept work into reviewable branches.

## Golden Paths

AX, the AI experience:

- Keep this as the only Codex-facing skill for the plugin. Do not route users to `autoresearch-create`, `autoresearch-dashboard`, `autoresearch-deep-research`, `autoresearch-finalize`, `/autoresearch`, or `/autoresearch-finalize` as separate invocation surfaces.
- Prefer MCP tools when available. Use CLI helpers only as the deterministic fallback.
- Keep the next action machine-readable through `next_experiment`, `log_experiment`, `continuation.shouldContinue`, `continuation.forbidFinalAnswer`, ASI, and `autoresearch.ideas.md`.
- Do not rely on chat memory for loop truth. Durable state lives in `autoresearch.md`, `autoresearch.jsonl`, `autoresearch.research/<slug>/`, dashboard state, and commits.

UX, the user experience:

- Let the user ask in plain language: "Use Codex Autoresearch to improve this repo."
- Ask only for missing essentials that materially change setup: goal, benchmark, primary metric, direction, scope, and correctness checks.
- At session start and resume, start or reuse the live dashboard and directly provide the live dashboard URL, normally `http://127.0.0.1:<port>/`.
- Report evidence, not helper mechanics: best metric, latest packet, decision, next action, blockers, and what was verified.

## Targeting

1. Identify the owning repo or child package before running Git, installs, tests, builds, or autoresearch helpers.
2. Check Git status before a new loop or finalization. Work around unrelated dirty files.
3. If this repository is the target, use the repo-local plugin before any globally installed or marketplace-cache copy. The package root is `plugins/codex-autoresearch`; from the wrapper root, call `node plugins/codex-autoresearch/scripts/autoresearch.mjs ...`.
4. Verify the local MCP startup path with `node plugins/codex-autoresearch/scripts/autoresearch.mjs mcp-smoke` when changing plugin MCP behavior.

## Start Or Resume

1. Read existing `autoresearch.md`, `autoresearch.jsonl`, and `autoresearch.ideas.md` when present.
2. Prefer MCP `setup_plan` for a read-only packet. Use `setup_session` when essentials are known.
3. If MCP is unavailable, use `scripts/autoresearch.mjs setup-plan`, `recipes list`, `setup`, and `doctor` from the plugin root.
4. Require a benchmark that prints the primary metric as `METRIC name=value`. Secondary metrics can explain tradeoffs.
5. Run `doctor_session` or `doctor --check-benchmark` before trusting a first packet.
6. Start the live dashboard with MCP `serve_dashboard` or `scripts/autoresearch.mjs serve --cwd <project>`. Keep the process alive and hand the user the served URL.
7. Run and log the baseline immediately.

Required session files:

- `autoresearch.md`: objective, metric, scope, constraints, decisions, and stop conditions.
- `autoresearch.jsonl`: append-only run log.
- `autoresearch.sh` or `autoresearch.ps1`: benchmark entrypoint.
- `autoresearch.checks.sh` or `autoresearch.checks.ps1`: optional correctness checks.
- `autoresearch.ideas.md`: deferred hypotheses and avoided dead ends.
- `autoresearch.last-run.json`: fallback last packet when Git metadata is unavailable.

## Active Loop Contract

After `next_experiment`, log the packet. After `log_experiment`, read the returned continuation object.

- If `continuation.shouldContinue` is true, choose the next hypothesis from ASI, experiment memory, `autoresearch.ideas.md`, or the session document; edit; run `next_experiment`; log again.
- If `continuation.forbidFinalAnswer` is true, continue the loop with progress updates instead of returning a final answer.
- Stop only when the user interrupts, the iteration limit is reached, benchmark/checks are blocked, cleanup would be unsafe, or the goal is genuinely exhausted.
- Use `log --from-last` or MCP packet data instead of retyping parsed metrics.
- `keep` and ordinary `discard` require a finite primary metric.
- `crash` and `checks_failed` can be logged without a metric. Never invent sentinel metrics.
- Include ASI every time: `hypothesis`, `evidence`, `rollback_reason` for rejected paths, and `next_action_hint`.

Git safety:

- Configure `commitPaths` or pass `--commit-paths` for kept results in Git repos.
- Use `--commit <hash>` when a kept change was already committed outside the helper.
- Use scoped `commitPaths` or `revertPaths` for discard/crash/checks-failed cleanup.
- Use `--allow-add-all` or broad dirty cleanup only when the user explicitly accepts that all dirty files are in scope.

## Deep Research Loops

Use a deep-research loop for broad, qualitative, or product-study prompts. Create `autoresearch.research/<slug>/`, initialize a `quality_gap` session, and turn accepted findings into checklist gaps.

Scratchpad files:

- `brief.md`: request, audience, constraints, and success criteria.
- `plan.md` and `tasks.md`: independent work streams.
- `sources.md`: source, date checked, supported claim, and confidence.
- `synthesis.md`: live merged answer.
- `quality-gaps.md`: accepted checklist measured by the loop.
- `notes/` and `deliverables/`: evidence and requested artifacts.

Round protocol:

1. Rerun the project-study prompt against the current branch.
2. Refresh `sources.md`, notes, and `synthesis.md` with repo evidence and dated external sources when needed.
3. Run `gap_candidates` or `gap-candidates` to preview candidates.
4. Filter hallucinations before applying candidates; in notes, use the phrase "filter hallucinations" for rejected unsupported candidates. Reject items without repo evidence, primary-source support, direct measurement, or a plausible validation path.
5. Apply only credible high-impact gaps.
6. Implement or explicitly reject accepted gaps, then log the round with ASI.
7. Start a fresh round before declaring no more high-impact work.

quality_gap=0 only means the current accepted checklist is closed. It does not prove discovery is complete.

## Dashboard

Prefer the served dashboard:

- Use MCP `serve_dashboard` or `scripts/autoresearch.mjs serve --cwd <project>`.
- Share the served `http://127.0.0.1:<port>/` URL by default.
- Use `export_dashboard` or `export` only for offline snapshots or when live serving is unavailable.
- Treat static HTML as read-only. It should not expose inert live controls or command-copy panels.

Read dashboard evidence in this order:

1. Top metric trajectory and latest/best/baseline markers.
2. Run log for status, metric, delta, commit, description, and ASI.
3. Current readout for best kept change, recent failures, next action, confidence, and finalization readiness.
4. Loop stage rail for setup, gaps, log decision, and finalization.
5. Strategy memory for plateau and lane guidance.

Safe live actions stay bounded to doctor, setup-plan, recipes, gap-candidates preview, finalize-preview, export, and confirmed log decisions. Branch creation stays outside the dashboard.

## Finalize

Use finalization when noisy loop history has useful kept commits.

1. Run `finalize_preview` or `scripts/autoresearch.mjs finalize-preview --cwd <project>`.
2. Read `autoresearch.jsonl` and keep only `status: "keep"`.
3. Use `scripts/finalize-autoresearch.mjs plan --output <groups.json> --goal <short-goal>` to draft non-overlapping groups.
4. Review groups for dependency and file overlap. Merge overlapping or dependent groups.
5. Ask for approval before creating branches unless the user already approved finalization.
6. Run the finalizer from the autoresearch source branch.
7. Report created review branches, files, metric improvement, generated review summary path, verification status, and cleanup order.

Runway order: preview, approve, create review branches, verify, merge into trunk, then cleanup.

## Verification

Use the narrowest relevant check while iterating. Before claiming a plugin change is done, run from `plugins/codex-autoresearch`:

```bash
npm run check
```

For targeted plugin work, useful checks include:

```bash
node --check scripts/autoresearch.mjs
node --check scripts/autoresearch-mcp.mjs
node --test tests/autoresearch-cli.test.mjs
node --test tests/dashboard-verification.test.mjs
node scripts/autoresearch.mjs mcp-smoke
git diff --check
```
