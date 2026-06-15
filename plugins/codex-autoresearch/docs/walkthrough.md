# Walkthrough

This walkthrough shows a complete Codex Autoresearch loop. Commands are copyable; JSON and terminal output below is illustrative — trust your local `doctor`, `state`, dashboard, and finalization readouts.

## 1. Prompt and plan

You give Codex a broad request:

```text
/goal @Codex Autoresearch study the dashboard and docs, accept evidence-backed UX gaps, and close the quality_gap checklist.
```

Codex uses `prompt-plan` to structure the approach. Example output (abbreviated):

```json
{
  "kind": "codex-autoresearch-prompt-plan",
  "intent": {
    "loopKind": "quality-gap",
    "metric": { "name": "quality_gap", "direction": "lower" },
    "setupDefaults": {
      "recipe": "quality-gap",
      "goal": "Study the dashboard and docs, accept evidence-backed UX gaps, and close the quality_gap checklist."
    }
  },
  "nextStep": {
    "stage": "configured-session",
    "nextAction": { "toolName": "doctor", "safety": "read_or_check" }
  }
}
```

Codex confirms the evidence source and research slug before creating session files.

## 2. Setup and doctor

Codex creates the research scratchpad, configures the quality-gap session, and verifies the benchmark.

```bash
node scripts/autoresearch.mjs research-setup --cwd . --slug dashboard-study --goal "Study the dashboard and docs, accept evidence-backed UX gaps, and close the quality_gap checklist."
node scripts/autoresearch.mjs doctor --cwd . --check-benchmark --explain
```

Illustrative output:

```text
Doctor Checks
- Git Working Tree: clean
- Benchmark Output: METRIC quality_gap=3
- Primary Metric: quality_gap (lower is better)

No blocking issues. The session is ready for a first baseline measurement.
```

If `benchmark-lint` passes but `doctor` reports dirty Git, runtime drift, finalization coverage issues, or stale packet blockers, repair those first. A parsed metric proves the benchmark line can be read; it does not prove the loop is finalization-ready.

## 3. First packet (measure)

Codex runs the first packet to measure the accepted checklist before changing the product.

```bash
node scripts/autoresearch.mjs next --cwd . --compact
```

Illustrative output:

```text
Packet Run
Benchmark: node scripts/autoresearch.mjs quality-gap --cwd . --research-slug dashboard-study
Benchmark output:
  METRIC quality_gap=3

Result: 3 accepted checklist gaps remain open
```

Codex logs the first baseline as `measure`, not `keep`:

```bash
git status --short
node scripts/autoresearch.mjs state --cwd . --compact
node scripts/autoresearch.mjs log --cwd . --from-last --status measure --description "Baseline quality-gap measurement"
```

Illustrative output:

```text
Log entry saved.
Status: measure
Primary Metric: quality_gap=3
Continuation: shouldContinue=true
```

## 4. Close credible candidates

Codex previews source-backed candidates, applies the credible ones, and runs another packet.

```bash
node scripts/autoresearch.mjs gap-candidates --cwd . --research-slug dashboard-study
node scripts/autoresearch.mjs next --cwd . --compact
```

Illustrative output:

```text
Packet Run
Benchmark output:
  METRIC quality_gap=0

Result: accepted checklist closed for this round
```

Codex keeps the change only if the code/docs diff and checks support the closed checklist:

```bash
git status --short
node scripts/autoresearch.mjs state --cwd . --compact
node scripts/autoresearch.mjs log --cwd . --from-last --status keep --description "Closed accepted dashboard/docs quality gaps"
```

`quality_gap=0` closes the accepted checklist for this round. If the broader question is still alive, start a fresh research round. See [Concepts](concepts.md#quality-gap).

## 5. Finalization

After running many packets, you want to review the kept changes.

```bash
git status --short
node scripts/autoresearch.mjs finalize-preview --cwd .
```

Illustrative output:

```text
Finalization Preview
Ready to create branches.
Total kept commits: 3
Files affected: README.md, docs/operate.md, dashboard/src/App.tsx
Estimated overlap: safe to collapse

Next step: Review finalize-preview, approve branch creation, then run the finalizer.
Cleanup waits until the merge is verified.
```

If a dashboard is stale during review, serve a fresh dashboard rather than trusting an old `file://` export. If state reports plateau pressure, pivot to finalization, rescope, or a fresh quality-gap round instead of running another packet by habit.

---

Previous: [Start](start.md) · Next: [Operate](operate.md) — resume, dashboard, packet logging.
