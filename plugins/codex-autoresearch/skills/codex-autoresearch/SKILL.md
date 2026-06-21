---
name: codex-autoresearch
description: Run Codex Autoresearch end to end from one plugin skill. Use when Codex should start, resume, inspect, dashboard, deep-research, iterate, log, or finalize measured optimization loops using autoresearch.md, autoresearch.jsonl, quality_gap scratchpads, or the local CLI helpers.
---

# Codex Autoresearch

This is the one skill surface and the only Codex-facing skill. Do not route users to old subskills, slash commands, or separate dashboard/finalizer skills.

Default state machine:

```text
setup -> doctor -> next -> log -> state -> finalize-preview
```

The job: make one measured improvement loop trustworthy enough that a human can follow it and a future session can resume it.

## For Codex

- Use the short command path unless the session is ambiguous or blocked: `setup`, `doctor`, `next`, `log`, `state`, then `finalize-preview`.
- For qualitative or deep-research improvement loops, start with `research-start --cwd <project> --slug <slug> --goal "<goal>"`. It creates the scratchpad, configures `quality_gap`, validates the command, and records the first baseline as `measure` unless `--no-baseline-log` is passed.
- Use advanced diagnostics only when needed. Check `node scripts/autoresearch.mjs --help --all` from the package root before naming a less common command.
- Use `new-segment` when the active segment is maxed, stale, phase-changing, or no longer comparable.
- Prefer CLI JSON and durable session state over chat memory: `autoresearch.md`, `autoresearch.jsonl`, `autoresearch.ideas.md`, active last-run/progress snapshots under `.git/autoresearch/` in Git repos, fallback `autoresearch.last-run.json` / `autoresearch.progress.json` outside Git, and `autoresearch.research/<slug>/`.
- Keep every packet decision recoverable through `METRIC name=value`, packet evidence, ASI, continuation data, promotion labels, and the ledger.
- Before another packet, read `recommend-next --compact` or `state --compact`; obey blockers. Compact-state field names: `docs/concepts.md#state-fields`.
- `benchmark-lint` must prove the primary `METRIC` contract before product packets are trusted.
- Configure `commitPaths` or pass `--commit-paths` for kept results in Git repos.

## For the user

- Plain-language prompts work: "/goal @Codex Autoresearch improve this repo."
- Ask only for essentials that materially change setup: goal, benchmark, primary metric, direction, scope, or correctness checks.
- For shippable, product, or final requests, identify product claims before setup. Retrieval, search, ranking, lazy behavior, accessibility, safety, or performance work needs a quality constraint or checks path before promotion.
- Stay on the CLI happy path unless setup is ambiguous, the user asks for the dashboard, packet freshness needs a browser readout, or the canonical action is blocked.
- Report the story: what was tried, what the metric means, the keep/discard/measure/crash/checks decision, the next move, blockers, optional dashboard URL, and verification.

## Documentation awareness

Use docs only as needed; do not load everything by default.

- Start/resume or normal operation: `docs/start.md`, `docs/operate.md`, and `references/loop-operations.md`.
- Dashboard, trust, drift, protected paths, unsafe commands, and redaction: `docs/trust.md`, `docs/architecture.md`, and `references/dashboard-trust.md`.
- Deep research, quality gaps, fanout, finalization, or subagent handoffs: `docs/finish.md`, `docs/workflows.md`, and `references/research-finalize.md`.
- Troubleshooting: `docs/troubleshooting.md`.
- Control-plane failures or cross-surface disagreement: `docs/control-plane.md`.

## Start or resume

1. Identify the owning repo or child package before Git, installs, tests, builds, or autoresearch commands.
2. Check Git status and work around unrelated dirty files.
3. If this repo is the target, use the repo-local plugin. From the wrapper root: `node plugins/codex-autoresearch/scripts/autoresearch.mjs ...`. From the package root: `node scripts/autoresearch.mjs ...`.
4. Read `autoresearch.md`, `autoresearch.jsonl`, and `autoresearch.ideas.md` when present.
5. Use `setup-plan` for read-only setup guidance when essentials are unclear. Use `setup` only when essentials are known and files should be created.
6. Run `doctor --cwd <project> --check-benchmark --explain` before the first trusted packet or any drift-sensitive metric.
7. Use the happy path first: `setup -> doctor -> next -> log -> state -> finalize-preview`.
8. Before another packet, read `recommend-next --compact` or `state --compact`; obey blockers; open detailed diagnostics only when the canonical action is blocked, stale, or unclear.
9. Use `state --report` for a terminal-first `report.text`. Governance fields are listed in `docs/concepts.md#state-fields`.
10. Run `serve --cwd <project>`, verify liveness, and provide the live dashboard URL only when the user asks, the browser readout matters, or CLI state is not enough.
11. For retrieval/search/ranking/performance work, require quality constraints before promotion.
12. Treat optional `task_manifest` packet evidence as audit data; quarantine malformed manifests and path escapes without invalidating unrelated metric evidence.
13. Treat benchmark-shaped fixes as diagnostic until proven otherwise. Row-specific detector or citation work is diagnostic repair until holdout, repeat, breadth, or promotion gate proves the broader claim.
14. If `session-forensics` imports benchmark-overfit or row-specific steering feedback, treat the decision capsule as a trust blocker.
15. Treat runtime freshness as unavailable unless installed runtime version and built-entrypoint fingerprint can be inspected and matched.

Happy-path CLI from `plugins/codex-autoresearch`:

```bash
node scripts/autoresearch.mjs setup --cwd <project> --name "<session>" --metric-name <metric> --direction lower --benchmark-command "<command>"
node scripts/autoresearch.mjs doctor --cwd <project> --check-benchmark --explain
node scripts/autoresearch.mjs next --cwd <project>
node scripts/autoresearch.mjs log --cwd <project> --from-last --status measure --description "Baseline measurement"
node scripts/autoresearch.mjs state --cwd <project> --report
node scripts/autoresearch.mjs finalize-preview --cwd <project>
```

## Active loop contract

After `next`, log the packet. After `log`, read the returned continuation object.

- Only `next` writes a reusable last-run packet. `run` remains a raw benchmark probe.
- Use `log --from-last` instead of retyping parsed metrics.
- `keep`, ordinary `discard`, and `measure` require a finite primary metric.
- Use `measure` for non-promotional evidence: baselines, no-change probes, environment checks, and diagnostics.
- `crash` and `checks_failed` can be logged without inventing sentinel metrics.
- Treat `review_required` metrics as provisional until ASI acknowledges the review outcome.
- If `autoresearch.config.json` contains `fixedControl`, treat the named artifact as control truth. Do not rerun commands matching `forbiddenCommandPatterns` unless the user explicitly accepts `--allow-fixed-control-rerun`; prefer `reuseCommandHint`.
- If run numbers duplicate, segments look stale, or manual log entries were edited, run `ledger-doctor --cwd <project> --json` before another packet. Use `ledger-doctor --repair --yes` only after reviewing the JSON health summary; after repair, verify the returned `backupPath`.
- Read parsed metrics and promotion readiness separately. New keeps default to exploratory unless repeat, holdout, breadth, or explicit promotion metadata make the evidence promotable.
- The loop contract is the authority for whether to spend another packet. `sourceCleanliness.blocks.nextPacket=false` only says source dirtiness is not the blocker.
- Control-plane contracts are packet brakes too: goal mismatches, missing scoped approvals, stale process residue, unsupported broad claims, and unsafe finalization runways outrank another packet.
- When the metric improves because the benchmark was steered toward known answers, say so.
- If `continuation.shouldContinue` is true, choose the next hypothesis from ASI, experiment memory, `autoresearch.ideas.md`, or dashboard lane guidance.
- If `continuation.forbidFinalAnswer` is true, continue with progress updates instead of returning a final answer.
- Respect packet and wall-clock budgets.
- If correctness checks fail, run `checks-inspect` before deciding.
- Stop when the user interrupts, the limit or budget is reached, benchmark/checks are blocked, cleanup would be unsafe, a fresh segment is needed, or the goal is genuinely exhausted.

## Codex-only Goal completion

- Use `completionAudit` before a parent agent calls `update_goal(status="complete")`.
- Do not complete a parent Codex Goal while the continuation says the loop is still active.
- Keep Goal state in Codex; Autoresearch only provides `codex-goal-brief` and completion-audit evidence.

CLI fallback:

```bash
node scripts/autoresearch.mjs next --cwd <project> --compact
node scripts/autoresearch.mjs log --cwd <project> --from-last --status keep --description "Describe the kept change"
node scripts/autoresearch.mjs state --cwd <project> --report
node scripts/autoresearch.mjs state --cwd <project> --compact
```

## Dashboard

Use the served dashboard when a live readout is useful:

- Use `scripts/autoresearch.mjs serve --cwd <project>`.
- Share the served `http://127.0.0.1:<port>/` URL by default.
- Static exports are read-only snapshots; serve a fresh dashboard when packet freshness matters.
- Readout only. Use the CLI to do the work.
- The live server accepts only loopback Host headers, sends defensive headers, and keeps the raw ledger endpoint disabled unless `--debug-ledger` is explicitly used.

## Deep research loops

Use a deep-research loop for broad, qualitative, product-study, UX, architecture, or documentation prompts. Study, accept gaps, measure `quality_gap`, close credible candidates, then start a fresh round when the question is still alive.

1. Start with `research-start --cwd <project> --slug <slug> --goal "<goal>"`. It seeds `autoresearch.research/<slug>/`, configures the `quality_gap` benchmark, validates the command, records the first baseline as `measure`, and prints the resume commands. Use `--no-baseline-log` only when that first baseline should not be recorded.
2. Keep sources dated and claim-specific in `autoresearch.research/<slug>/sources.md`.
3. Write the judgment pass in `synthesis.md`: filter hallucinations, separate evidence from inference.
4. Turn accepted findings into `quality-gaps.md`.
5. Measure with `quality-gap --cwd <project> --research-slug <slug> --list`.
6. Preview candidates with `gap-candidates`; apply only credible high-impact gaps.
7. Log implementation or rejection with ASI.
8. Start a fresh round before claiming there are no more high-impact gaps.

`quality_gap=0` only means the accepted checklist for the current round is closed. Read `freshRoundSuggested`, `researchIntegrity`, `sourceCleanliness`, finalization readiness, and plateau reason fields before deciding next steps.

For crashed or timed-out packets with artifact rows, use `partial-results --from-last` before rerunning expensive work.

## Finalize

Use finalization when noisy loop history has useful kept commits.

1. Run `finalize-preview --cwd <project>` before branch creation.
2. Keep only accepted/current `status: "keep"` evidence.
3. Compare product claim coverage against accepted evidence.
4. If coverage is missing, report experimental status. Use "Experimental review branch only: product-grade proof is missing."
5. Treat previews and plans as read-only.
6. Review dirty tree, stale plan, overlap, semantic safety, and excluded-file warnings.
7. Session artifacts are excluded by default. Use `--include-session-artifacts` only when the reviewer explicitly wants them.
8. When state reports `current-tree-finalization`, run `finalize-current-tree --cwd <project> --exclude-session-artifacts`. Do not substitute generic `finalize-preview` as the primary command.
9. Ask before creating branches unless the user already approved finalization.
10. Runway order: preview, approve, create review branches, verify, merge into trunk, verify the merge, cleanup.
11. Do not suggest branch cleanup until merge verification has succeeded.
12. Classify existing review branches before reuse.
13. Report created review branches, files, metric improvement, claim coverage, verification, runway status, and remaining risk.

## Subagent handoffs

When Codex uses subagents to work on Autoresearch itself:

- Each lane states scope, evidence source, decision, handoff artifact, and tests.
- No nested subagents.
- Do not run overlapping write lanes. Split by ownership first, then merge through one parent context.
- Reviewers should check the decision-envelope contract, packet freshness, dashboard read-only behavior, finalization artifact policy, and docs/changelog sync.

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
