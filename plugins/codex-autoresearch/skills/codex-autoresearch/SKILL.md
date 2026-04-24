---
name: codex-autoresearch
description: Run Codex Autoresearch end to end from one plugin skill. Use when Codex should start, resume, inspect, dashboard, deep-research, iterate, log, or finalize measured optimization loops using autoresearch.md, autoresearch.jsonl, quality_gap scratchpads, MCP tools, or the local CLI helpers.
---

# Codex Autoresearch

Use this as the one skill surface for the whole loop and the only Codex-facing skill. Do not route users to old subskills, slash commands, or separate dashboard/finalizer skills.

The job is simple: make one measured improvement loop trustworthy enough that a human can follow it and a future AI can resume it.

Default state machine:

```text
Target -> Onboard -> Setup -> Doctor -> Dashboard -> Packet -> Log -> Continue or Finalize
```

## AX And UX

AX, the AI experience:

- Start by getting machine-readable context: MCP `onboarding_packet`, then `recommend_next`, `read_state`, `guided_setup`, or `doctor_session`.
- When the user gives a broad natural-language goal without a benchmark contract, call MCP `prompt_plan` first. It should infer metric defaults, experiment lanes, safe scope, missing essentials, and the read-only setup path before Codex edits files.
- Prefer MCP tools when available. Use CLI helpers only as the deterministic fallback.
- Keep loop truth in durable files, not chat memory: `autoresearch.md`, `autoresearch.jsonl`, `autoresearch.ideas.md`, `autoresearch.research/<slug>/`, dashboard state, and commits.
- Keep every packet decision recoverable through `METRIC name=value`, ASI, continuation data, and the ledger.

UX, the user experience:

- Let the user ask in plain language: "Use Codex Autoresearch to improve this repo."
- Ask only for essentials that materially change setup: goal, benchmark, primary metric, direction, scope, or correctness checks.
- At session start and resume, start or reuse the live dashboard and directly provide the live dashboard URL, normally `http://127.0.0.1:<port>/`.
- Report evidence instead of helper mechanics: current state, best metric, latest packet, decision, next action, blockers, dashboard URL, and verification.

## Start Or Resume

1. Identify the owning repo or child package before Git, installs, tests, builds, or autoresearch commands.
2. Check Git status and work around unrelated dirty files.
3. If this repo is the target, use the repo-local plugin. From the wrapper root, call `node plugins/codex-autoresearch/scripts/autoresearch.mjs ...`; the package root is `plugins/codex-autoresearch`.
4. Read `autoresearch.md`, `autoresearch.jsonl`, and `autoresearch.ideas.md` when present.
5. Prefer MCP `onboarding_packet` for a compact handoff, then `recommend_next` for one safe action.
6. Use MCP `prompt_plan` when the user prompt is broad, exploratory, or written like the README examples. Prefer MCP `setup_plan` for read-only setup guidance. Use `setup_session` only when essentials are known and files should be created.
7. Use `doctor_session` or `doctor --cwd <project> --explain`; add `--check-benchmark` before trusting first-run or drift-sensitive metrics.
8. If benchmark output is uncertain, use `benchmark_lint` or `benchmark-lint --cwd <project> --sample "METRIC name=value"`.
9. Start the live dashboard with MCP `serve_dashboard` or `scripts/autoresearch.mjs serve --cwd <project>`. Keep the process alive and hand the user the URL.
10. Run and log the baseline immediately.

CLI fallback from `plugins/codex-autoresearch`:

```bash
node scripts/autoresearch.mjs onboarding-packet --cwd <project> --compact
node scripts/autoresearch.mjs prompt-plan --cwd <project> --prompt "<user request>"
node scripts/autoresearch.mjs recommend-next --cwd <project> --compact
node scripts/autoresearch.mjs setup-plan --cwd <project>
node scripts/autoresearch.mjs guide --cwd <project>
node scripts/autoresearch.mjs doctor --cwd <project> --explain
node scripts/autoresearch.mjs serve --cwd <project>
```

Over MCP, pass `allow_unsafe_command: true` before materializing custom benchmark/check commands, model commands, or external recipe-catalog commands.

## Active Loop Contract

After `next_experiment`, log the packet. After `log_experiment`, read the returned continuation object.

- Use `log --from-last` or MCP packet data instead of retyping parsed metrics.
- Include ASI every time: `hypothesis`, `evidence`, `rollback_reason` for rejected paths, `next_action_hint`, and when useful `lane`, `family`, `risk`, and `expected_delta`.
- `keep` and ordinary `discard` require a finite primary metric.
- `crash` and `checks_failed` can be logged without inventing sentinel metrics.
- If `continuation.shouldContinue` is true, choose the next hypothesis from ASI, experiment memory, `autoresearch.ideas.md`, or dashboard lane guidance.
- If `continuation.forbidFinalAnswer` is true, continue the loop with progress updates instead of returning a final answer.
- Stop only when the user interrupts, the limit is reached, benchmark/checks are blocked, cleanup would be unsafe, a fresh segment is needed, or the goal is genuinely exhausted.

CLI fallback:

```bash
node scripts/autoresearch.mjs next --cwd <project>
node scripts/autoresearch.mjs log --cwd <project> --from-last --status keep --description "Describe the kept change"
node scripts/autoresearch.mjs state --cwd <project> --compact
```

## State And Drift Rules

- Missing, null, crashed, and ineligible metrics are unknown. Do not report them as `0`, `0%`, baseline, best, latest plotted evidence, or a win.
- Last-run packets become stale after ledger, config, command, working directory, Git, or relevant file changes. Rerun `next_experiment` before logging.
- If doctor reports benchmark drift, treat the old best as historical evidence, not current runtime proof.
- If the session is maxed, stale, or intentionally changing phase, use `new_segment` or `new-segment --cwd <project> --dry-run` first; confirmed segment creation appends to `autoresearch.jsonl`.
- If `commitPaths` are missing or stale, repair them before relying on keep commits.

Git safety:

- Configure `commitPaths` or pass `--commit-paths` for kept results in Git repos.
- Use `--commit <hash>` when a kept change was already committed outside the helper.
- Use scoped `commitPaths` or `revertPaths` for discard/crash/checks-failed cleanup.
- Use `--allow-add-all` or broad dirty cleanup only when the user explicitly accepts that every dirty file is in scope.

## Dashboard

Prefer the served dashboard:

- Use MCP `serve_dashboard` or `scripts/autoresearch.mjs serve --cwd <project>`.
- Share the served `http://127.0.0.1:<port>/` URL by default.
- Restart `serve_dashboard` if live refresh failed, the old process ended, or the user is looking at a `file://` export but needs actions.
- Use `export_dashboard` or `export` only for offline snapshots.
- Treat static HTML as read-only. It should not expose inert live controls.

Read dashboard evidence in this order:

1. Trust blockers: stale packets, dirty Git, missing paths, runtime drift, corrupt ledger, static export mode.
2. Current decision: next safe action, why it is safe, evidence, best kept change, recent failure.
3. Metric trend: baseline, best, latest, confidence, weighted formula when present.
4. Mission control: setup, gap review, packet readiness, log decision, finalization.
5. Strategy memory: plateau, lanes, novelty, repeated families.

Safe live actions stay bounded to doctor, setup-plan, onboarding packet, recommend-next, benchmark-lint, recipes, gap-candidates preview, finalize-preview, export, new-segment dry-run, and confirmed log decisions. These guarded local actions avoid branch creation, broad staging, arbitrary commands, custom finalizer args, and finalizer mutation inside the dashboard.

## Deep Research Loops

Use a deep-research loop for broad, qualitative, product-study, UX, architecture, or documentation prompts.

1. Create the scratchpad with `setup_research_session` or `research-setup --cwd <project> --slug <slug> --goal "<goal>"`.
2. Keep sources dated and claim-specific in `autoresearch.research/<slug>/sources.md`.
3. Write the judgment pass in `autoresearch.research/<slug>/synthesis.md`: filter hallucinations, separate evidence from inference, and reject weak claims before they become work.
4. Turn accepted findings into `quality-gaps.md`.
5. Measure with `measure_quality_gap` or `quality-gap --cwd <project> --research-slug <slug> --list`.
6. Preview candidates with `gap_candidates` or `gap-candidates`; apply only credible high-impact gaps.
7. Log implementation or rejection with ASI.
8. Start a fresh round before claiming there are no more high-impact gaps.

`quality_gap=0` only means the accepted checklist for the current round is closed. In plain text: quality_gap=0 only means this round's accepted checklist is done; it does not prove discovery is complete.

## Finalize

Use finalization when noisy loop history has useful kept commits.

1. Run MCP `finalize_preview` or `scripts/autoresearch.mjs finalize-preview --cwd <project>`.
2. Keep only `status: "keep"` evidence.
3. Treat previews and plans as read-only.
4. Review dirty tree, stale plan, overlap, excluded commits, and excluded-file warnings.
5. Ask before creating branches unless the user already approved finalization.
6. Run the finalizer from the autoresearch source branch.
7. Verify branch union, session-artifact exclusion, review summary, and cleanup order.
8. Report created review branches, files, metric improvement, verification, and remaining risk.

Runway order: preview, approve, create review branches, verify, merge into trunk, cleanup.

## Integrations

Use `integrations list`, `integrations doctor`, or `integrations sync-recipes` only when recipe catalogs or external helper surfaces are actually part of the loop. Treat integrations as setup support, not a replacement for benchmark evidence, ASI, dashboard trust blockers, or confirmed log decisions.

## Hooks

Do not make hooks required for core behavior. Treat Codex hooks as experimental opt-in reminders.

- Use `doctor hooks` to report local feasibility.
- On Windows, assume hooks are not a dependable default.
- Good future reminders: `SessionStart` can surface `onboarding-packet`; `PostToolUse` can notice shell output containing `METRIC`; `Stop` can warn about unlogged last-run packets.
- Hooks must not replace MCP schemas, CLI validation, dashboard guards, packet freshness, or Git safety.

## Verification

Use the narrowest relevant check while iterating. Before claiming plugin work is done, run from `plugins/codex-autoresearch`:

```bash
npm run check
```

Targeted checks:

```bash
npm test
node scripts/autoresearch.mjs mcp-smoke
node scripts/autoresearch.mjs doctor --cwd . --check-benchmark --explain
node scripts/autoresearch.mjs benchmark-lint --cwd .
git diff --check
```
