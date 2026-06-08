# Autoresearch Dashboard Serve Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make live dashboard serving a first-class, reusable handoff instead of a foreground-process choreography.

**Architecture:** Keep dashboard serving read-only. Add or harden detached serve behavior, registry reuse, health reporting, and recovery commands so agents can return a stable URL without polling a blocked shell.

**Tech Stack:** TypeScript, Node.js 24+, local HTTP server, node:test.

---

## File Structure

- Modify: `plugins/codex-autoresearch/lib/commands/dashboard.ts`
- Modify: `plugins/codex-autoresearch/lib/live-server.ts`
- Modify: `plugins/codex-autoresearch/lib/dashboard-server-registry.ts`
- Modify: `plugins/codex-autoresearch/lib/dashboard-health.ts`
- Modify: `plugins/codex-autoresearch/lib/terminal-report.ts`
- Test: `plugins/codex-autoresearch/tests/dashboard-server-registry.test.ts`
- Test: `plugins/codex-autoresearch/tests/decision-guidance-dashboard-health.test.ts`
- Test: `plugins/codex-autoresearch/tests/decision-guidance-terminal-report.test.ts`

---

### Task 1: Detach And Reuse Live Dashboard Servers

- [ ] **Step 1: Write failing registry reuse test**

In `plugins/codex-autoresearch/tests/dashboard-server-registry.test.ts`, add a test that records a live server for a cwd, calls serve planning again, and asserts the returned command/result reuses the same healthy URL instead of starting a second foreground server.

- [ ] **Step 2: Write failing health recovery test**

In `plugins/codex-autoresearch/tests/decision-guidance-dashboard-health.test.ts`, add a dead/stale registry fixture and assert the recovery command is:

```text
node scripts/autoresearch.mjs serve --cwd <project>
```

not a raw `curl` health probe.

- [ ] **Step 3: Run failing tests**

Run:

```powershell
cd C:\Users\alber\source\repos\autoresearch\plugins\codex-autoresearch
npm run build:node
node --test dist/tests/dashboard-server-registry.test.mjs dist/tests/decision-guidance-dashboard-health.test.mjs
```

Expected: FAIL where reuse/recovery behavior is missing.

- [ ] **Step 4: Add serve lifecycle result fields**

In `plugins/codex-autoresearch/lib/commands/dashboard.ts`, make serve return JSON/text fields:

- `dashboardUrl`
- `healthUrl`
- `pid`
- `detached`
- `registryReused`
- `cwd`
- `mode: "live"`
- `recoveryCommand`

- [ ] **Step 5: Harden live server health**

In `plugins/codex-autoresearch/lib/live-server.ts`, ensure `/health` returns cwd, version, mode, and a last-read timestamp. Avoid full research-tree fingerprinting on every refresh; cache expensive file fingerprints with a short TTL.

- [ ] **Step 6: Reuse registry before starting a server**

In `plugins/codex-autoresearch/lib/dashboard-server-registry.ts`, add a helper that returns the existing healthy server for the same cwd and version. If the entry is dead, mark it stale and return a recovery command.

- [ ] **Step 7: Update terminal report**

In `plugins/codex-autoresearch/lib/terminal-report.ts`, render:

```text
Dashboard: live at <url> (pid <pid>, registry reused)
```

or:

```text
Dashboard: stale/dead. Run <serve command>.
```

- [ ] **Step 8: Run targeted verification**

Run:

```powershell
cd C:\Users\alber\source\repos\autoresearch\plugins\codex-autoresearch
npm run build:node
node --test dist/tests/dashboard-server-registry.test.mjs dist/tests/decision-guidance-dashboard-health.test.mjs dist/tests/decision-guidance-terminal-report.test.mjs
```

Expected: PASS.

- [ ] **Step 9: Commit**

```powershell
git add plugins/codex-autoresearch/lib/commands/dashboard.ts plugins/codex-autoresearch/lib/live-server.ts plugins/codex-autoresearch/lib/dashboard-server-registry.ts plugins/codex-autoresearch/lib/dashboard-health.ts plugins/codex-autoresearch/lib/terminal-report.ts plugins/codex-autoresearch/tests/dashboard-server-registry.test.ts plugins/codex-autoresearch/tests/decision-guidance-dashboard-health.test.ts plugins/codex-autoresearch/tests/decision-guidance-terminal-report.test.ts
git commit -m "fix: make dashboard serve lifecycle reusable"
```

