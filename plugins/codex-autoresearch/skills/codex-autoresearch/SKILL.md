---
name: codex-autoresearch
description: Run Codex Autoresearch end to end from one plugin skill. Use when Codex should start, resume, inspect, dashboard, deep-research, iterate, log, or finalize measured optimization loops using autoresearch.md, autoresearch.jsonl, quality_gap scratchpads, or the local CLI helpers.
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

- Start by getting machine-readable context from the CLI: `onboarding-packet`, then `recommend-next`, `state`, `guide`, or `doctor`. Read `decisionEnvelope` / `resumeAudit` first when present.
- Prefer CLI JSON and durable session files for read-only truth: `autoresearch.jsonl`, `autoresearch.last-run.json`, `autoresearch.research/<slug>/quality-gaps.md`, dashboard view-model output, and `finalize-preview`.
- When the user gives a broad natural-language goal without a benchmark contract, run `prompt-plan` first. It should infer metric defaults, experiment lanes, safe scope, missing essentials, and the read-only setup path before Codex edits files.
- If the target repo already has benchmark surfaces in scripts, package/cargo scripts, docs, known benchmark filenames, or `.git/autoresearch` hints, prefer those before generic recipes. Treat score-like metrics as quality-bearing until the session docs prove otherwise.
- Use the CLI as the deterministic execution surface.
- Keep loop truth in durable files, not chat memory: `autoresearch.md`, `autoresearch.jsonl`, `autoresearch.ideas.md`, `autoresearch.research/<slug>/`, evidence indexes, dashboard state, and commits.
- Keep every packet decision recoverable through `METRIC name=value`, packet evidence, ASI, continuation data, promotion labels, and the ledger.
- Before rerunning an expensive crashed or timed-out packet, inspect `partial-results --from-last`; record a selected row only as diagnostic `measure` evidence with `partial-results --record <candidate-id>`.
- ASI means the structured memory attached to a run: hypothesis, evidence, rollback reason, next action hint, and optional lane/family/risk metadata.
- When Codex Goal mode is available and explicitly requested, use `get_goal` to inspect parent thread state, then run `codex-goal-brief --cwd <project>` with any imported Goal fields. Treat the bridge as evidence/advice only: Codex owns thread goals; Autoresearch owns benchmark/session truth.
- When a prior Codex session JSONL is the best evidence source, run `session-forensics --dry-run` first, then `--apply` only to write a bounded context capsule under `autoresearch.research/<slug>/`. Keep raw snippets disabled unless the operator explicitly needs them; imported claims should reference evidence ids instead of persisting raw transcript bodies.

UX, the user experience:

- Let the user ask in plain language: "Use Codex Autoresearch to improve this repo."
- Ask only for essentials that materially change setup: goal, benchmark, primary metric, direction, scope, or correctness checks.
- At session start and resume, run `guide`, start/reuse the live dashboard with `serve`, verify `GET /health` or equivalent liveness, and directly provide the live dashboard URL after it is verified, normally `http://127.0.0.1:<port>/`. If a prior localhost URL fails, restart `serve` and say the old URL was stale.
- Report the operator story instead of helper mechanics: what was tried, what the metric means, the keep/discard/measure/crash/checks decision, the next move, blockers, dashboard URL, and verification.

## Documentation Awareness

The documentation is in `docs/` (or `plugins/codex-autoresearch/docs/` in the source checkout). Use it to understand the product depth, safety rules, and operator workflows before guessing.

- **Start here**: `docs/index.md` is the map.
- **Workflow & Architecture**: `docs/workflows.md` and `docs/architecture.md` show the motion and boundaries.
- **Concepts**: `docs/concepts.md` defines terms like ASI, packets, and lanes.
- **Walkthrough**: `docs/walkthrough.md` is the canonical end-to-end narrated loop.
- **Onboarding & Operations**: `docs/start.md` and `docs/operate.md` cover first runs and daily use.
- **Safety & Trust**: `docs/trust.md` details metric integrity, drift, and Git safety.
- **Finalization**: `docs/finish.md` covers the cleanup and review branch flow.
- **Troubleshooting**: `docs/troubleshooting.md` for diagnosis of cache, dashboard, metrics, and Git issues.

## Start Or Resume

1. Identify the owning repo or child package before Git, installs, tests, builds, or autoresearch commands.
2. Check Git status and work around unrelated dirty files.
3. If this repo is the target, use the repo-local plugin. From the wrapper root, call `node plugins/codex-autoresearch/scripts/autoresearch.mjs ...`; the package root is `plugins/codex-autoresearch`.
4. Read `autoresearch.md`, `autoresearch.jsonl`, and `autoresearch.ideas.md` when present.
5. Use `onboarding-packet --compact` for a compact handoff, then `recommend-next --compact` for one safe action. Read `decisionEnvelope.nextAction`, `resumeAudit.latestPacketFreshness`, `nextStep.stage`, `nextStep.nextAction.reason`, `nextStep.nextAction.safety`, and `nextStep.missingEssentials` before choosing a command.
6. Use `prompt-plan` when the user prompt is broad, exploratory, or written like the README examples. Prefer `setup-plan` for read-only setup guidance. Use `setup` only when essentials are known and files should be created.
7. Use `benchmark-inspect`, `benchmark-lint`, `checks-inspect`, or `doctor --cwd <project> --check-benchmark --explain` before the first live packet or any drift-sensitive metric.
8. If benchmark output is uncertain, inspect a bounded list/dry-run/sample command first, then use `benchmark-lint --cwd <project> --sample "METRIC name=value"`.
9. Start the live dashboard with `scripts/autoresearch.mjs serve --cwd <project>`. Keep the process alive and hand the user the URL.
10. After setup, checkpoint the returned generated session files in Git when appropriate, then run and log the baseline immediately.
11. If the user has asked for an ongoing budget, treat each packet as log-then-continue: log the current packet first, read the returned continuation, then continue without handing the loop back unless a blocker or safety stop appears.

Explicit benchmark commands are assumed to print `METRIC name=value` lines. They may also print `ARTIFACT name=path` for manifests or reports the dashboard/last-run packet should link. Use `--benchmark-prints-metric false` only when the command is a raw workload that should be timed by the generated wrapper.

The shared first-valid-loop contract stages are setup repair, doctor, dashboard serve, baseline packet, log decision, segment reset, finalization preview, and blocker. If a stale dashboard URL or stale last-run packet is present, replace it with the returned recovery action before continuing.

CLI fallback from `plugins/codex-autoresearch`:

```bash
node scripts/autoresearch.mjs onboarding-packet --cwd <project> --compact
node scripts/autoresearch.mjs prompt-plan --cwd <project> --prompt "<user request>"
node scripts/autoresearch.mjs recommend-next --cwd <project> --compact
node scripts/autoresearch.mjs codex-goal-brief --cwd <project>
node scripts/autoresearch.mjs setup-plan --cwd <project>
node scripts/autoresearch.mjs benchmark-inspect --cwd <project>
node scripts/autoresearch.mjs checks-inspect --cwd <project> --command "<checks command>"
node scripts/autoresearch.mjs guide --cwd <project>
node scripts/autoresearch.mjs doctor --cwd <project> --explain
node scripts/autoresearch.mjs serve --cwd <project>
node scripts/autoresearch.mjs partial-results --cwd <project> --from-last
node scripts/autoresearch.mjs session-forensics --cwd <project> --session-jsonl <path> --research-slug <slug> --dry-run
```

## Active Loop Contract

After `next`, log the packet. After `log`, read the returned continuation object.

- Use `log --from-last` instead of retyping parsed metrics.
- Only `next` writes a reusable last-run packet. `run` remains a raw benchmark probe for quick checks and is not loggable with `--from-last`.
- If `log --from-last` reports no loggable packet or a stale packet, recover with `next --cwd <project>` or record a manual measurement with `log --cwd <project> --metric <value> --status measure --description "<what was measured>"`.
- If the last packet crashed or timed out after writing artifacts, run `partial-results --cwd <project> --from-last` before rerunning. Only `partial-results --record <candidate-id>` may turn a selected row into diagnostic `measure` evidence; it must not become promotion-grade evidence.
- Read the last-run `packetEvidence` before logging: packet id, command identity, timeout, exit status, output tails, metrics, artifacts, checks, and freshness fingerprint.
- Include ASI every time: `hypothesis`, `evidence`, `rollback_reason` for rejected paths, `next_action_hint`, and when useful `lane`, `family`, `risk`, and `expected_delta`. Prefer `--asi-file <path>` and `--metrics-file <path>` on PowerShell or any shell where inline JSON quoting is fragile.
- `keep`, ordinary `discard`, and `measure` require a finite primary metric.
- Use `--evidence-status accepted|rejected|provisional|superseded` only when the default status label would hide the actual evidence role. Do not make rejected or quarantined artifacts promotable.
- Use `measure` for non-promotional evidence such as baselines, no-change checks, environment probes, and diagnostic measurements. It updates trend/latest/baseline readouts, but it never stages, commits, reverts, counts as `keep`, or becomes finalizer evidence.
- `crash` and `checks_failed` can be logged without inventing sentinel metrics.
- Treat parsed metrics and promotion readiness separately. New keeps default to `exploratory`; discards are `invalidated`; crashes and failed checks are `blocked`; only repeat, holdout, breadth, or explicit promotion metadata should make evidence promotable.
- If `continuation.shouldContinue` is true, choose the next hypothesis from ASI, experiment memory, `autoresearch.ideas.md`, or dashboard lane guidance.
- If the loop is serially burning time, run `research-fanout --cwd <project> --dry-run` to create a generic parallel lane plan. Dispatch read-only scout lanes first with `lane-runner`; they do not need a worktree and must not edit files. Implementation lanes need `lane-runner --mode implementation` plus a worktree or explicit owned write scope before mutating commands run. Use the coordinator recommendation as the single next measured packet.
- If `continuation.forbidFinalAnswer` is true, continue the loop with progress updates instead of returning a final answer. A finite active budget counts: do not stop at a report while iterations remain and there is no blocker.
- Prefer `next --compact` for live-loop reporting; the full decision packet stays in `lastRunPath` for `log --from-last` and audit.
- Use `--command-file <path>` plus `--packet-env-file <path>` for Windows/PowerShell packets that would otherwise need fragile inline quoting.
- If correctness checks fail, run `checks-inspect` before deciding. Fix malformed command shapes first, then separate touched-path failures from broad-suite, pre-existing, or environment failures.
- Stop only when the user interrupts, the limit is reached, benchmark/checks are blocked, cleanup would be unsafe, a fresh segment is needed, or the goal is genuinely exhausted.
- If a parent Codex Goal is active, do not call `update_goal(status="complete")` until `codex-goal-brief` has a real `completionEvidence` / `completionConfirmed` audit or the operator has explicitly accepted the evidence. Limit reached, `quality_gap=0`, and local bests are review signals, not automatic completion.

CLI fallback:

```bash
node scripts/autoresearch.mjs next --cwd <project> --compact
node scripts/autoresearch.mjs log --cwd <project> --from-last --status keep --description "Describe the kept change"
node scripts/autoresearch.mjs state --cwd <project> --compact
```

## State And Drift Rules

- Missing, null, crashed, and ineligible metrics are unknown. Do not report them as `0`, `0%`, baseline, best, latest plotted evidence, or a win.
- Last-run packets become stale after ledger, config, command, working directory, Git, or relevant file changes. Rerun `next` before logging.
- The resume audit is the single next-decision surface. It compares the active segment, historical best, promotion-grade best, packet freshness, progress/economics, partial-result candidates, workflow friction, benchmark/config drift, dirty source drift, quality round, experiment memory, and finalization readiness before naming `nextAction`.
- If the benchmark/check/config contract changes after logged runs, start a new segment or explicitly invalidate old evidence before running another packet or finalizing.
- Read dev/local best and promotion-grade best separately. A run needs explicit promotion metadata before it counts as promotion evidence.
- Read `scaffoldHealth` before first packets and before keep logging. Self-recursive wrappers, missing benchmark workloads, stale `commitPaths`/`revertPaths`, and Git index locks are setup blockers, not experiment evidence.
- Read `researchIntegrity` before claiming a best. `dev_best`, `pending_repeat`, `invalidated`, `historical`, and `blocked` labels explain why a metric can be interesting without being promotable.
- Treat perfect quality-like metrics as suspicious until repeat, freshness, breadth, holdout, and promotion metadata are present.
- If doctor reports benchmark drift, treat the old best as historical evidence, not current runtime proof.
- If the session is maxed, stale, repeatedly shelving the same score, or intentionally changing phase, use `new-segment --cwd <project> --dry-run` first; confirmed segment creation appends to `autoresearch.jsonl`.
- Treat iteration/tool caps as segment-transition required, not goal completion. Use `new-segment --cwd <project> --yes --reason "<reason>"` only after the dry run makes sense.
- If the benchmark contract is being promoted, use `promote-gate --cwd <project> --reason "<why>" --dry-run` so the new segment records the gate, sample size, and measurement reason.
- If `commitPaths` are missing or stale, repair them before relying on keep commits. `log keep` should fail before `git add` when paths are missing.

Git safety:

- Configure `commitPaths` or pass `--commit-paths` for kept results in Git repos.
- Use `--commit <hash>` when a kept change was already committed outside the helper.
- Use scoped `commitPaths` or `revertPaths` for discard/crash/checks-failed cleanup.
- If a Git index lock appears, report the lock path, live-process check, partial-write state, and safe retry/removal guidance before retrying.
- Use `--allow-add-all` or broad dirty cleanup only when the user explicitly accepts that every dirty file is in scope.

## Dashboard

Prefer the served dashboard:

- Use `scripts/autoresearch.mjs serve --cwd <project>`.
- Share the served `http://127.0.0.1:<port>/` URL by default.
- Restart `serve` if live refresh failed, the old process ended, or the user is looking at a `file://` export but needs fresh data.
- Use `export` only for offline snapshots.
- Static exports are read-only; use the served dashboard when packet freshness matters.
- Treat the dashboard as a visual aid, not a control surface. It should not expose inert live controls, mutation buttons, or command receipts.

Read dashboard evidence in this order:

1. Decision envelope summary: packet freshness, blockers, segment transition, plateau, finalization readiness, and the one authoritative next action.
2. Metric trend: baseline, best, latest, measurement points, confidence, weighted formula when present.
3. Codex brief and session memory: what happened, what matters, plateau, lanes, novelty, repeated families.
4. Current decision: next safe action, why it is safe, evidence, best kept change, recent failure.
5. Ledger and ASI: what was kept, measured, rejected, crashed, or blocked by checks.
6. Finalization, quality-gap, runtime drift, and other supporting diagnostics.

Use the CLI for setup, packet runs, logging, gap review, export, `finalize-preview`, and finalization preview. The dashboard should support judgment; it should not become the workflow driver.

## Deep Research Loops

Use a deep-research loop for broad, qualitative, product-study, UX, architecture, or documentation prompts.

1. Create the scratchpad with `research-setup --cwd <project> --slug <slug> --goal "<goal>"`.
2. Keep sources dated and claim-specific in `autoresearch.research/<slug>/sources.md`.
3. Write the judgment pass in `autoresearch.research/<slug>/synthesis.md`: filter hallucinations, separate evidence from inference, and reject weak claims before they become work.
4. Turn accepted findings into `quality-gaps.md`.
5. Measure with `quality-gap --cwd <project> --research-slug <slug> --list`.
6. Preview candidates with `gap-candidates`; apply only credible high-impact gaps.
7. Log implementation or rejection with ASI.
8. Start a fresh round before claiming there are no more high-impact gaps.

`quality_gap=0` only means the accepted checklist for the current round is closed. In plain text: quality_gap=0 only means this round's accepted checklist is done; it does not prove discovery is complete. Read `qualityRound.closed`, `freshRoundSuggested`, and plateau reason fields before deciding whether to start another research round or segment.

## Finalize

Use finalization when noisy loop history has useful kept commits.

1. Run `finalize-preview --cwd <project>` before branch creation.
2. Keep only `status: "keep"` evidence.
3. Treat previews and plans as read-only.
4. Review dirty tree, stale plan, overlap, semantic safety, unkept base..HEAD commits, excluded commits, and excluded-file warnings. A ready preview must cover the final non-session tree.
5. Ask before creating branches unless the user already approved finalization.
6. Run the finalizer from the autoresearch source branch.
7. Verify branch union, session-artifact exclusion, review summary, and cleanup order.
8. Report created review branches, files, metric improvement, verification, and remaining risk.

Use `scripts/autoresearch.mjs finalize-current-tree --cwd <project>` when the final branch contents are correct but kept-run commits were later corrected, reverted, or bundled with unkept support commits. Explain that the current tree, not old kept commits, is the review unit.

Current-tree finalization excludes `autoresearch.*`, `autoresearch.research/**`, dashboard exports, and generated finalization scratch files by default. Use `--include-session-artifacts` only when the reviewer explicitly wants those session files in the branch, and say why.

Runway order: preview, approve, create review branches, verify, merge into trunk, verify the merge, cleanup. Do not suggest branch cleanup until merge verification has succeeded.

## Integrations

Use `integrations list`, `integrations doctor`, or `integrations sync-recipes` only when recipe catalogs or external helper surfaces are actually part of the loop. Treat integrations as setup support, not a replacement for benchmark evidence, ASI, runtime/blocker checks, or confirmed log decisions.

## Hooks

Do not make hooks required for core behavior. Treat Codex hooks as experimental opt-in reminders.

- Use `doctor hooks` to report local feasibility.
- On Windows, assume hooks are not a dependable default.
- Good future reminders: `SessionStart` can surface `onboarding-packet`; `PostToolUse` can notice shell output containing `METRIC`; `Stop` can warn about unlogged last-run packets.
- Hooks must not replace CLI validation, dashboard guards, packet freshness, or Git safety.

## Subagent Handoffs

When Codex uses subagents to work on Autoresearch itself, keep the lanes boring and accountable:

- Each lane states scope, evidence source, decision, handoff artifact, and tests.
- No nested subagents. Do not nest subagents inside subagents.
- Do not run overlapping write lanes. Split by ownership first, then merge through one parent context.
- Reviewers should check the decision-envelope contract, packet freshness, dashboard read-only behavior, finalization artifact policy, and docs/changelog sync before the pass is called done.

## Verification

Use the narrowest relevant check while iterating. Before claiming plugin work is done, run from `plugins/codex-autoresearch`:

```bash
npm run check
```

Targeted checks:

```bash
npm test
node scripts/autoresearch.mjs --help
node scripts/autoresearch.mjs doctor --cwd . --check-benchmark --explain
node scripts/autoresearch.mjs benchmark-lint --cwd .
node scripts/autoresearch.mjs checks-inspect --cwd . --command "npm test"
git diff --check
```
