---
name: codex-autoresearch
description: Run or resume a measured improvement loop in a local project. Use for benchmark-driven optimization, qualitative quality-gap research, packet logging, dashboard readouts, recovery, and review-branch finalization backed by autoresearch session files.
---

# Codex Autoresearch

Turn an improvement request into a measured, resumable loop. Report the metric, decision, evidence, next action, and real publication state. Do not replace them with a generic claim that the project is "better."

```text
setup -> doctor -> next -> log -> state -> finalize-preview
```

Use this as the only Codex-facing Autoresearch skill. Do not route to retired subskills, slash commands, or MCP surfaces.

## Establish the working truth

1. Identify the repository or child package that owns the work.
2. Run `git status --short --branch`; preserve unrelated changes.
3. When changing Autoresearch itself, use the checkout in this repository:
   - wrapper root: `node plugins/codex-autoresearch/scripts/autoresearch.mjs ...`
   - package root: `node scripts/autoresearch.mjs ...`
4. Treat source and installed-plugin behavior as different until their version and built-entrypoint fingerprint match.

## Start or resume

For a new session:

1. Get the goal, benchmark, primary metric, direction, correctness checks, editable scope, and any real budget.
2. Use `prompt-plan` or `setup-plan` when one of those is unclear. Both are read-only.
3. Run `setup` only after the contract is clear enough to create files.
4. Configure `commitPaths` before a keep may commit source changes.
5. Run `doctor --cwd <project> --check-benchmark --explain` before trusting the first packet.
6. Record the baseline with `next`, then `log --from-last --status measure`.

For an existing session:

1. Read [loop operations](references/loop-operations.md).
2. Read `autoresearch.md`, `autoresearch.jsonl`, `autoresearch.ideas.md`, and the active `autoresearch.research/<slug>/` folder when present.
3. Run `state --report`, `recommend-next --compact --operator-checklist`, and `doctor --explain`.
4. Keep `goalFrame.authoritativeGoal` authoritative unless the user deliberately replaces it. If a new request would change the benchmark, metric, edit scope, or final claim, treat it as a possible replacement and resolve that choice before packet work.
5. Follow the printed blocker or command. If the CLI, report, and dashboard disagree, stop mutation and diagnose the shared state.

Happy path from the package root:

```bash
node scripts/autoresearch.mjs setup --cwd <project> --name "<session>" --metric-name <metric> --direction lower --benchmark-command "<command>" --checks-command "<checks>"
node scripts/autoresearch.mjs config --cwd <project> --commit-paths "<editable-paths>"
node scripts/autoresearch.mjs doctor --cwd <project> --check-benchmark --explain
node scripts/autoresearch.mjs next --cwd <project>
node scripts/autoresearch.mjs log --cwd <project> --from-last --status measure --description "Baseline measurement"
node scripts/autoresearch.mjs state --cwd <project> --report
```

After the baseline, implement one bounded hypothesis inside the configured paths, then run and log one packet:

```bash
node scripts/autoresearch.mjs next --cwd <project>
node scripts/autoresearch.mjs log --cwd <project> --from-last --status keep --description "<what changed>" --asi-json-file <path>
node scripts/autoresearch.mjs state --cwd <project> --report
```

The ASI file must contain the real hypothesis, evidence, rollback reason when rejected, and next action. Use `discard`, `crash`, or `checks_failed` instead of `keep` when the evidence requires it. Run `finalize-preview` only when canonical state routes to finalization.

## Run one packet at a time

Use `next` for a reusable packet. Treat `run` as a raw probe that `log --from-last` cannot reuse.

After `next`:

1. Inspect the metric, checks, artifacts, diff, and Git state.
2. Log with `--from-last`; do not copy parsed metrics back into the command.
3. Add a structured experiment note (ASI) with the hypothesis, evidence, rollback reason for rejected work, and useful next action. Use `--asi-json-file <path>` when inline JSON would be fragile in the current shell.
4. Read the returned continuation before doing anything else.

When accepted work was committed outside Autoresearch, verify the commit and log the keep with `--commit <hash>` so finalization retains real commit evidence.

| Status | Use it for |
| --- | --- |
| `measure` | Baselines, no-change checks, environment probes, and diagnostics. Never stage, commit, revert, or finalize it. |
| `keep` | A finite primary metric, passing required checks, and a change worth preserving inside safe Git scope. |
| `discard` | A finite metric and a change not worth keeping; logging may clean the configured or explicit experiment paths. |
| `crash` | A benchmark that failed before usable metric evidence existed. Do not invent a sentinel value; logging may clean the configured or explicit experiment paths. |
| `checks_failed` | A metric exists, but the required correctness proof failed; logging may clean the configured or explicit experiment paths. |

Obey these brakes:

- Keep packet processes on the default minimal environment. Use `--packet-env-mode inherit` only when the benchmark genuinely needs the caller's full environment.
- Treat `termination_failed` as a hard stop. Preserve partial packet evidence, verify the reported PID and descendants are absent, then remove only the retained progress marker before another `run` or `next`.
- Treat typed `process_lifecycle` blockers as process truth: verify absence before recording a later terminal row. Never infer active residue from historical prose, and never repair a malformed lifecycle row by weakening validation.
- Keep a configured working directory inside `--cwd`; require the user's explicit intent before passing `--allow-outside-workdir`.
- Ordinary `doctor` runs must not refresh remote catalogs. Use `doctor --revalidate-catalog` only for an explicit public-HTTPS provenance check; internal catalogs stay local files.
- Continue the active session when `continuation.shouldContinue=true`, but run a packet only when `loopContract.canRunNextPacket=true`; do not report completion when `continuation.forbidFinalAnswer=true`.
- Let blockers, budget stops, segment changes, and finalization outrank another packet.
- Treat `benchmark-lint` as a parser check, not proof that the benchmark represents the product.
- Require the checks implied by the claim: accuracy, behavior, accessibility, safety, data integrity, or performance.
- Keep `review_required` results provisional until the structured note records the review.
- Treat benchmark-keyed fixes, static citations, scorer edits, and row-specific detectors as diagnostic until repeat, holdout, breadth, or a promotion gate supports the broader claim.

Use [loop operations](references/loop-operations.md) for partial results, failed checks, ledger repair, budgets, Git scope, and segment changes. Use [dashboard and trust](references/dashboard-trust.md) for fixed controls, runtime drift, protected paths, redaction, and promotion claims.

## Research broad or qualitative work

Use a quality-gap loop for docs, UX, product study, architecture, or research:

```bash
node scripts/autoresearch.mjs research-start --cwd <project> --slug <slug> --goal "<goal>"
```

Keep dated claims in `sources.md`, judgment in `synthesis.md`, and accepted work in `quality-gaps.md`. Preview additions with `gap-candidates`, then log implementation or rejection with ASI.

Treat `quality_gap=0` as closure of the accepted checklist for this round. Read `researchIntegrity` and its missing-proof warnings before deciding whether the wider question is finished or needs another discovery round.

Read [research, lanes, and finalization](references/research-finalize.md) before fanout, parallel implementation, or review-branch work.

## Show the dashboard only when it helps

```bash
node scripts/autoresearch.mjs serve --cwd <project>
```

Verify the server and give the user its `http://127.0.0.1:<port>/` URL. Use `export` for a portable snapshot.

Keep both forms read-only. Run setup, packets, logging, gap work, export, and finalization through the CLI. A static export cannot prove current packet freshness.

## Finalize accepted work

1. Run `finalize-preview --cwd <project>` before branch creation.
2. For normal finalization, include only accepted, current keeps and exclude session artifacts by default.
3. Compare the intended claim with the accepted checks and measurements. If proof is missing, say: "Experimental review branch only: product-grade proof is missing."
4. When canonical state reports `current-tree-finalization`, treat it as a separate recovery contract: review the entire clean non-session branch diff, exact file set, exclusions, claim evidence, and generated plan, then use `finalize-current-tree --cwd <project> --exclude-session-artifacts`.
5. Ask before creating branches unless the user already approved finalization.
6. Verify the branch union, exclusions, summaries, metrics, and checks before handoff.

Report the real runway: preview, approved, branches created, locally verified, pushed or PR, CI, merged, merge verified, then cleanup. Do not collapse those stages or suggest cleanup before the merge is verified.

## Keep parent ownership clear

Run `codex-goal-brief` and inspect its `completionAudit` field before the parent calls `update_goal(status="complete")`. Keep Goal state in Codex; use Autoresearch only for the evidence.

When subagents are explicitly used, give every lane a scope, evidence source, decision, artifact, and test. Scout commands must match `lane-runner`'s strict Git read-only argv allowlist; do not use shell or interpreter escapes. Treat Git porcelain and write-scope checks as best-effort detection, not process/filesystem containment, and use disposable worktrees for implementation lanes. Do not nest subagents or overlap write scopes. Keep the benchmark, packet decision, integration, and final verification in the parent.

## Load only the documentation you need

- first run: [Start](../../docs/start.md)
- normal operation or resume: [Operate](../../docs/operate.md)
- safety or runtime questions: [Trust](../../docs/trust.md)
- review branches: [Finish](../../docs/finish.md)
- symptom lookup: [Troubleshooting](../../docs/troubleshooting.md)
- cross-surface disagreement: [Control plane](../../docs/control-plane.md)

Before claiming plugin work is done, run from `plugins/codex-autoresearch`:

```bash
npm run check
```

For docs-only work, also inspect the rendered Markdown and command text, then run `git diff --check`. The package gate checks local Markdown links.
