# Operator Workflows

For a visual map, start with [Workflow diagrams](workflows.md). The task-oriented pages are [Operate](operate.md), [Trust](trust.md), and [Finish](finish.md).

Use this page when running or resuming an autoresearch loop. For first setup, start with [Getting started](getting-started.md).

## Resume A Loop

Before acting, identify the owning repo or child package and check Git status. Read existing session files when present:

- `autoresearch.md`
- `autoresearch.jsonl`
- `autoresearch.ideas.md`
- `autoresearch.research/<slug>/` for research-backed loops

Then get a read-only plan:

```bash
node scripts/autoresearch.mjs setup-plan --cwd <project>
node scripts/autoresearch.mjs guide --cwd <project>
node scripts/autoresearch.mjs doctor --cwd <project> --check-benchmark
```

If MCP tools are available, prefer `setup_plan`, `guided_setup`, and `doctor_session` for the same read-only checks.

## Keep The Dashboard Live

The live dashboard is the normal operator surface:

```bash
node scripts/autoresearch.mjs serve --cwd <project>
```

Use it for state, trust warnings, metric trajectory, latest run, best kept run, recent failures, and next actions. If the server process ended, live refresh fails, or the browser is on a `file://` export but fresh state is needed, restart `serve` and share the new local URL. Use CLI or MCP for actions and logging.

Use static exports only for offline review or archival evidence:

```bash
node scripts/autoresearch.mjs export --cwd <project>
```

Static exports are read-only snapshots. They should not be treated as fresh runtime proof.

## Run And Log Packets

Run one decision packet:

```bash
node scripts/autoresearch.mjs next --cwd <project>
```

After `next`, log the packet deliberately:

```bash
node scripts/autoresearch.mjs log --cwd <project> --from-last --status keep --description "Describe the kept change"
```

Use:

- `keep` for a finite primary metric and an improvement worth preserving.
- `discard` for a finite primary metric that should not be kept.
- `crash` when the benchmark failed before producing usable metric evidence.
- `checks_failed` when the metric exists but correctness checks failed.

After logging, read the continuation result. If `continuation.shouldContinue` is true, use the returned ASI, experiment memory, `autoresearch.ideas.md`, and dashboard lane guidance to choose the next hypothesis. If `continuation.forbidFinalAnswer` is true, continue the loop instead of ending with a final report.

## Deep Research And Quality Gaps

Use deep-research loops for broad product, UX, architecture, or qualitative prompts:

```bash
node scripts/autoresearch.mjs research-setup --cwd <project> --slug <slug> --goal "<goal>"
```

The scratchpad lives under `autoresearch.research/<slug>/`:

| File or folder | Role |
| --- | --- |
| `brief.md` | Request, audience, constraints, and success criteria. |
| `plan.md` and `tasks.md` | Independent work streams. |
| `sources.md` | Source, date checked, supported claim, and confidence. |
| `synthesis.md` | Current merged answer. |
| `quality-gaps.md` | Accepted checklist measured by the loop. |
| `notes/` and `deliverables/` | Evidence and requested artifacts. |

Measure the accepted checklist:

```bash
node scripts/autoresearch.mjs quality-gap --cwd <project> --research-slug <slug> --list
```

Preview candidate gaps before applying them:

```bash
node scripts/autoresearch.mjs gap-candidates --cwd <project> --research-slug <slug>
```

`quality_gap=0` means the current accepted checklist is closed. It does not prove discovery is permanently complete.

## Finalization

Use finalization when noisy loop history contains useful kept commits.

Start with the read-only preview:

```bash
node scripts/autoresearch.mjs finalize-preview --cwd <project>
```

For branch planning, use the finalizer plan command from the autoresearch source branch:

```bash
node scripts/finalize-autoresearch.mjs plan --goal <short-goal>
```

Workflow:

1. Preview readiness.
2. Resolve dirty worktree, stale plan, missing kept evidence, and overlap warnings.
3. Review excluded commits; only `status: "keep"` belongs in review branches.
4. Collapse overlapping kept work only when the replay is safe without excluded-file leakage.
5. Get approval before creating branches unless the user already approved finalization.
6. Create review branches from the clean autoresearch source branch.
7. Verify branch union, session-artifact exclusion, generated review summary, and cleanup order.
8. Merge to trunk, then clean up source branches and session artifacts.

The dashboard can show finalization readiness. Branch creation and finalizer mutation stay outside the dashboard.
