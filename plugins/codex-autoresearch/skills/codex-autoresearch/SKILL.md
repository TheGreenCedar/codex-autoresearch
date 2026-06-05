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

The job is simple: make one measured improvement loop trustworthy enough that a human can follow it and a future AI can resume it.

## AX And UX

AX, the AI experience:

- Use the short command path unless the session is ambiguous or blocked: `setup`, `doctor`, `next`, `log`, `state`, then `finalize-preview`.
- Use advanced diagnostics only when needed: `onboarding-packet`, `recommend-next`, `prompt-plan`, `setup-plan`, `benchmark-inspect`, `partial-results`, `session-forensics`, `guide`, or `serve`.
- Use `new-segment` when the active segment is maxed, stale, phase-changing, or no longer comparable.
- Prefer CLI JSON and durable session files over chat memory: `autoresearch.md`, `autoresearch.jsonl`, `autoresearch.ideas.md`, `autoresearch.last-run.json`, and `autoresearch.research/<slug>/`.
- Keep every packet decision recoverable through `METRIC name=value`, packet evidence, ASI, continuation data, promotion labels, and the ledger.

UX, the user experience:

- Let the user ask in plain language: "Use Codex Autoresearch to improve this repo."
- Ask only for essentials that materially change setup: goal, benchmark, primary metric, direction, scope, or correctness checks.
- At session start and resume, stay on the CLI happy path unless setup is ambiguous, the user asks for the dashboard, packet freshness needs a browser readout, or the canonical action is blocked.
- Report the operator story: what was tried, what the metric means, the keep/discard/measure/crash/checks decision, the next move, blockers, optional dashboard URL, and verification.

## Documentation Awareness

Use docs only as needed; do not load everything by default.

- Start/resume or normal operation: `docs/start.md`, `docs/operate.md`, and `references/loop-operations.md`.
- Dashboard, trust, drift, protected paths, unsafe commands, and redaction: `docs/trust.md`, `docs/architecture.md`, and `references/dashboard-trust.md`.
- Deep research, quality gaps, fanout, finalization, or subagent handoffs: `docs/finish.md`, `docs/workflows.md`, and `references/research-finalize.md`.
- Troubleshooting: `docs/troubleshooting.md`.

## Start Or Resume

1. Identify the owning repo or child package before Git, installs, tests, builds, or autoresearch commands.
2. Check Git status and work around unrelated dirty files.
3. If this repo is the target, use the repo-local plugin. From the wrapper root: `node plugins/codex-autoresearch/scripts/autoresearch.mjs ...`. From the package root: `node scripts/autoresearch.mjs ...`.
4. Read `autoresearch.md`, `autoresearch.jsonl`, and `autoresearch.ideas.md` when present.
5. Use `setup-plan` for read-only setup guidance when essentials are unclear. Use `setup` only when essentials are known and files should be created.
6. Run `doctor --cwd <project> --check-benchmark --explain` before the first trusted packet or any drift-sensitive metric.
7. Use the happy path first: `setup -> doctor -> next -> log -> state -> finalize-preview`.
8. Before another packet, read `recommend-next --compact` or `state --compact`; obey blockers; open detailed diagnostics only when the canonical action is blocked, stale, or unclear.
9. Use `state --report` when you want a terminal-first `report.text`; `state --report` and `state` expose `operatorChecklist`, `loopContract`, `sessionDecisionCapsule`, `runtimeProvenance`, `runtimeDriftSummary`, `gateQuality`, `preflight`, `sourceCleanliness`, `portfolioRecommendation`, `laneLifecycle`, and `packetDiagnostics`.
10. `recommend-next --compact` carries the canonical next action plus governance and portfolio fields, including `decision-capsule` blockers.
11. Run `serve --cwd <project>`, verify liveness, and directly provide the live dashboard URL only when the user asks, the browser readout matters, or CLI state is not enough.
12. `benchmark-lint` must prove the primary `METRIC` contract before product packets are trusted.
13. Treat optional `task_manifest` packet evidence as audit data; quarantine malformed manifests and symlink/realpath escapes without invalidating unrelated metric evidence.
14. Treat runtime freshness as unavailable unless the installed runtime version and built-entrypoint fingerprint can be inspected and matched.
15. Configure `commitPaths` or pass `--commit-paths` for kept results in Git repos.

Happy-path CLI from `plugins/codex-autoresearch`:

```bash
node scripts/autoresearch.mjs setup --cwd <project> --name "<session>" --metric-name <metric> --direction lower --benchmark-command "<command>"
node scripts/autoresearch.mjs doctor --cwd <project> --check-benchmark --explain
node scripts/autoresearch.mjs next --cwd <project>
node scripts/autoresearch.mjs log --cwd <project> --from-last --status keep --description "Describe the kept change"
node scripts/autoresearch.mjs state --cwd <project> --report
node scripts/autoresearch.mjs finalize-preview --cwd <project>
```

## Active Loop Contract

After `next`, log the packet. After `log`, read the returned continuation object.

- Only `next` writes a reusable last-run packet. `run` remains a raw benchmark probe.
- Use `log --from-last` instead of retyping parsed metrics.
- `keep`, ordinary `discard`, and `measure` require a finite primary metric.
- Use `measure` and `--status measure` for non-promotional evidence such as baselines, no-change probes, environment checks, and diagnostic measurements.
- `crash` and `checks_failed` can be logged without inventing sentinel metrics.
- Read parsed metrics and promotion readiness separately. New keeps default to exploratory unless repeat, holdout, breadth, or explicit promotion metadata make the evidence promotable.
- If `continuation.shouldContinue` is true, choose the next hypothesis from ASI, experiment memory, `autoresearch.ideas.md`, or dashboard lane guidance.
- If `continuation.forbidFinalAnswer` is true, continue the loop with progress updates instead of returning a final answer.
- Respect packet and wall-clock budgets. Re-run `config --wall-clock-budget-seconds <n>` to reset the wall-clock window; pass an empty budget option only when intentionally clearing it.
- If correctness checks fail, run `checks-inspect` before deciding.
- Stop only when the user interrupts, the limit or budget is reached, benchmark/checks are blocked, cleanup would be unsafe, a fresh segment is needed, or the goal is genuinely exhausted.

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
- Static exports are read-only; use the served dashboard when packet freshness matters.
- Treat the dashboard as a visual aid, not a control surface. Use the CLI for setup, packet runs, logging, gap review, export, `finalize-preview`, and finalization.
- The dashboard read order is decision envelope, metric trend/readiness, Codex brief, current decision, ledger/ASI, finalization, quality-gap, runtime drift, and process hygiene.

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

quality_gap=0 only means the accepted checklist for the current round is closed. It does not prove discovery is complete. Read `freshRoundSuggested`, `researchIntegrity`, `sourceCleanliness`, finalization readiness, and plateau reason fields before deciding whether to start another round, run a promotion gate, finalize, or start a new segment.

## Finalize

Use finalization when noisy loop history has useful kept commits.

1. Run `finalize-preview --cwd <project>` before branch creation.
2. Keep only accepted/current `status: "keep"` evidence; rejected, provisional, superseded, and quarantined evidence stays audit-visible but must not drive review branches.
3. Treat previews and plans as read-only.
4. Review dirty tree, stale plan, overlap, semantic safety, unkept base..HEAD commits, excluded commits, and excluded-file warnings.
5. Session artifacts are excluded by default. Use `--include-session-artifacts` only when the reviewer explicitly wants them in the branch.
6. Ask before creating branches unless the user already approved finalization.
7. Runway order: preview, approve, create review branches, verify, merge into trunk, verify the merge, cleanup.
8. Do not suggest branch cleanup until merge verification has succeeded.
9. Report created review branches, files, metric improvement, verification, and remaining risk.

## Subagent Handoffs

When Codex uses subagents to work on Autoresearch itself:

- Each lane states scope, evidence source, decision, handoff artifact, and tests.
- No nested subagents. Do not nest subagents inside subagents.
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
