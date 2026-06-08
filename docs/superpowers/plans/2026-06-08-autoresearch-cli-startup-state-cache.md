# Autoresearch CLI Startup And State Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce repeated read/report latency for common state, compact, dashboard, and forensics commands.

**Architecture:** Keep behavior identical while making command dispatch lazier and avoiding repeated ledger/state parsing within one command. Add timing regressions that assert command classes stay below a practical local budget.

**Tech Stack:** TypeScript, Node.js 24+, node:test.

---

## File Structure

- Modify: `plugins/codex-autoresearch/scripts/autoresearch.ts`
- Modify: `plugins/codex-autoresearch/lib/session-core.ts`
- Modify: `plugins/codex-autoresearch/lib/cli-handlers.ts`
- Modify: `plugins/codex-autoresearch/lib/live-server.ts`
- Test: `plugins/codex-autoresearch/tests/autoresearch-cli.test.ts`
- Test: `plugins/codex-autoresearch/tests/perfection-benchmark.test.ts`

---

### Task 1: Keep Common Read Commands Light

- [ ] **Step 1: Add startup budget regression**

In `plugins/codex-autoresearch/tests/autoresearch-cli.test.ts`, add a test that runs these commands against a small temp session and records elapsed time:

- `state --compact`
- `recommend-next --compact`
- `guide --compact`

Assert each completes under 1500 ms on a warm local build. Use a generous budget and skip only when `CI_PERF_UNSTABLE=1`.

- [ ] **Step 2: Add parse-once regression**

In `plugins/codex-autoresearch/tests/perfection-benchmark.test.ts`, add a source check that common compact command handlers do not call `loadSessionState` more than once per command path.

- [ ] **Step 3: Run failing tests**

Run:

```powershell
cd C:\Users\alber\source\repos\autoresearch\plugins\codex-autoresearch
npm run build:node
node --test --test-name-pattern "compact.*budget|loadSessionState" dist/tests/autoresearch-cli.test.mjs dist/tests/perfection-benchmark.test.mjs
```

Expected: FAIL if current dispatch or state parsing repeats too much.

- [ ] **Step 4: Split lazy command dispatch**

In `plugins/codex-autoresearch/scripts/autoresearch.ts`, keep top-level imports small and move heavy command-specific imports behind the dispatch branch for uncommon commands such as finalization, dashboard export, research fanout, and forensics.

- [ ] **Step 5: Add command-local state cache**

In `plugins/codex-autoresearch/lib/session-core.ts`, add an optional cache object passed through command handlers:

```ts
export interface SessionReadCache {
  stateByCwd: Map<string, unknown>;
}
```

Expose a helper that returns parsed state from cache when available. Do not persist this cache to disk.

- [ ] **Step 6: Use cache in compact handlers**

In `plugins/codex-autoresearch/lib/cli-handlers.ts`, create one cache per command invocation and pass it into state/report/recommend handlers that compose multiple readouts.

- [ ] **Step 7: Reduce live refresh work**

In `plugins/codex-autoresearch/lib/live-server.ts`, avoid recomputing expensive artifact fingerprints on every request. Use cached hashes unless watched files changed or the TTL expired.

- [ ] **Step 8: Run targeted verification**

Run:

```powershell
cd C:\Users\alber\source\repos\autoresearch\plugins\codex-autoresearch
npm run build:node
node --test dist/tests/autoresearch-cli.test.mjs dist/tests/perfection-benchmark.test.mjs
```

Expected: PASS for startup/cache regressions.

- [ ] **Step 9: Commit**

```powershell
git add plugins/codex-autoresearch/scripts/autoresearch.ts plugins/codex-autoresearch/lib/session-core.ts plugins/codex-autoresearch/lib/cli-handlers.ts plugins/codex-autoresearch/lib/live-server.ts plugins/codex-autoresearch/tests/autoresearch-cli.test.ts plugins/codex-autoresearch/tests/perfection-benchmark.test.ts
git commit -m "perf: lighten autoresearch read commands"
```

