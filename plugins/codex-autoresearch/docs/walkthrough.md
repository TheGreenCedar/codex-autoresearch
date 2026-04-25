# Walkthrough

This walkthrough shows a complete, real-world Codex Autoresearch loop. We will start with a broad request, let Codex plan the loop, run two packets (one kept, one discarded), and finally preview the review branches.

## 1. Prompt and Plan

You give Codex a broad request:

```text
Use Codex Autoresearch to improve the speed of my indexer's pipeline, while keeping it memory efficient.
```

Codex uses the `prompt_plan` tool to convert this into a structured approach:

```json
{
  "setupCommand": "node scripts/autoresearch.mjs setup --cwd . --name \"Indexer Optimization\" --metric-name seconds --direction lower",
  "missingEssentials": [
    "benchmark_command: Need a repeatable command that exercises the indexer and prints 'METRIC seconds=value'."
  ],
  "experimentLanes": [
    "cache-tuning: adjust in-memory cache sizes",
    "batch-sizing: modify how many records are processed at once",
    "io-parallelism: adjust concurrent read/write limits"
  ]
}
```

Codex asks you for the missing benchmark command. You provide it: `npm run bench:indexer`.

## 2. Setup and Doctor

Codex runs the setup and doctor commands.

```bash
node scripts/autoresearch.mjs setup --cwd . --name "Indexer Optimization" --metric-name seconds --direction lower --benchmark-command "npm run bench:indexer"
node scripts/autoresearch.mjs doctor --cwd . --check-benchmark --explain
```

Output:

```text
Doctor Checks
- Git Working Tree: clean
- Benchmark Output: METRIC seconds=42.5
- Primary Metric: seconds (lower is better)

All checks passed. The session is ready.
```

## 3. The First Packet (Keep)

Codex runs the first experiment to tune batch sizing, then logs the result.

```bash
node scripts/autoresearch.mjs next --cwd . --compact
```

Output:

```text
Packet Run
Benchmark: npm run bench:indexer
Output:
  METRIC seconds=38.2
  METRIC memory_mb=512

Result: seconds improved from 42.5 to 38.2
```

Codex logs the decision to keep the change:

```bash
node scripts/autoresearch.mjs log --cwd . --from-last --status keep --description "Increased batch size from 100 to 500"
```

Output:

```text
Log entry saved.
Status: keep
Primary Metric: seconds=38.2
Continuation: shouldContinue=true
```

## 4. The Second Packet (Discard)

Codex runs a second experiment to aggressively tune the cache.

```bash
node scripts/autoresearch.mjs next --cwd . --compact
```

Output:

```text
Packet Run
Benchmark: npm run bench:indexer
Output:
  METRIC seconds=37.9
  METRIC memory_mb=1200

Result: seconds improved from 38.2 to 37.9
```

Codex decides the memory tradeoff is too severe and discards the change, reverting the files.

```bash
node scripts/autoresearch.mjs log --cwd . --from-last --status discard --description "Aggressive cache tuning"
```

Output:

```text
Log entry saved.
Status: discard
Files reverted to previous keep state.
Continuation: shouldContinue=true
```

## 5. Finalization

After running many packets, you want to review the kept changes.

```bash
node scripts/autoresearch.mjs finalize-preview --cwd .
```

Output:

```text
Finalization Preview
Ready to create branches.
Total kept commits: 15
Files affected: src/indexer.ts, src/cache.ts
Estimated overlap: safe to collapse

Next step: Run 'node scripts/finalize-autoresearch.mjs plan' from the main branch.
```

The loop is complete, documented, and ready for human review.

---

Previous: [Recipes](recipes.md) · Next: [Troubleshooting](troubleshooting.md) — symptom-to-layer diagnosis.
