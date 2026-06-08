# Autoresearch New-Segment Benchmark Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `new-segment` repair intentional benchmark-contract drift so the next packet can run without manual metric logging.

**Architecture:** Treat `new-segment` as a contract boundary. If the user intentionally changes the benchmark command or protected paths, the new segment records a fresh benchmark contract and warns when metrics are no longer comparable.

**Tech Stack:** TypeScript, Node.js 24+, node:test.

---

## File Structure

- Modify: `plugins/codex-autoresearch/scripts/autoresearch.ts`
- Modify: `plugins/codex-autoresearch/lib/session-core.ts`
- Modify: `plugins/codex-autoresearch/lib/packet-diagnostics.ts`
- Test: `plugins/codex-autoresearch/tests/autoresearch-cli.test.ts`
- Test: `plugins/codex-autoresearch/tests/packet-diagnostics.test.ts`

---

### Task 1: Rebaseline Benchmark Contract On New Segment

- [ ] **Step 1: Write failing drift repair test**

In `plugins/codex-autoresearch/tests/autoresearch-cli.test.ts`, add a temp-session test:

- Existing config has benchmark command A and protected path A.
- A run records contract A.
- Invoke `new-segment --benchmark-command <B> --reason "new benchmark surface"`.
- Invoke `doctor --check-benchmark --json`.

Assert:

```ts
assert.equal(payload.benchmarkContract.ok, true);
assert.doesNotMatch(JSON.stringify(payload), /benchmark.*drift/i);
```

- [ ] **Step 2: Write failing comparability warning test**

Add a second test where the old metric is `seconds` and the new segment metric is `embedded_docs`. Assert the new segment output includes:

```ts
assert.match(JSON.stringify(payload), /not comparable|metric semantics/i);
```

- [ ] **Step 3: Run failing tests**

Run:

```powershell
cd C:\Users\alber\source\repos\autoresearch\plugins\codex-autoresearch
npm run build:node
node --test --test-name-pattern "new segment.*benchmark|metric semantics" dist/tests/autoresearch-cli.test.mjs
```

Expected: FAIL because the old contract still blocks the new segment.

- [ ] **Step 4: Recompute contract during new-segment**

In `plugins/codex-autoresearch/scripts/autoresearch.ts`, update the `new-segment` handler so the new config entry includes the current benchmark command, protected benchmark paths, and fresh contract fingerprint. Do not reuse the previous segment fingerprint when the command or protected paths changed.

- [ ] **Step 5: Add metric comparability warning**

When `metricName`, `bestDirection`, or `metricUnit` changes across segments, add a warning:

```text
Metric semantics changed; active segment and historical best may not be directly comparable.
```

Expose the same warning in state/report output.

- [ ] **Step 6: Update packet diagnostics**

In `plugins/codex-autoresearch/lib/packet-diagnostics.ts`, treat an accepted `new-segment` contract as authoritative for the active segment and keep old drift visible only as historical/audit context.

- [ ] **Step 7: Run targeted verification**

Run:

```powershell
cd C:\Users\alber\source\repos\autoresearch\plugins\codex-autoresearch
npm run build:node
node --test dist/tests/autoresearch-cli.test.mjs dist/tests/packet-diagnostics.test.mjs
```

Expected: PASS for the new-segment tests.

- [ ] **Step 8: Commit**

```powershell
git add plugins/codex-autoresearch/scripts/autoresearch.ts plugins/codex-autoresearch/lib/session-core.ts plugins/codex-autoresearch/lib/packet-diagnostics.ts plugins/codex-autoresearch/tests/autoresearch-cli.test.ts plugins/codex-autoresearch/tests/packet-diagnostics.test.ts
git commit -m "fix: rebaseline benchmark contracts for new segments"
```

