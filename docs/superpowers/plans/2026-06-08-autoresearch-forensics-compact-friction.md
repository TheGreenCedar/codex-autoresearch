# Autoresearch Forensics And Compact Friction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach session forensics and compact readouts to catch the friction that made session 019ea746 expensive and emotionally noisy.

**Architecture:** Extend forensics signals for false-done corrections, oversized tool outputs, closed stdin polls, and foreground dashboard churn. Then make compact commands enforce a smaller operator handoff envelope.

**Tech Stack:** TypeScript, Node.js 24+, node:test.

---

## File Structure

- Modify: `plugins/codex-autoresearch/lib/session-forensics.ts`
- Modify: `plugins/codex-autoresearch/lib/workflow-friction.ts`
- Modify: `plugins/codex-autoresearch/lib/session-decision-capsule.ts`
- Modify: `plugins/codex-autoresearch/lib/commands/recommend-next.ts`
- Modify: `plugins/codex-autoresearch/lib/terminal-report.ts`
- Test: `plugins/codex-autoresearch/tests/packet-diagnostics.test.ts`
- Test: `plugins/codex-autoresearch/tests/autoresearch-cli.test.ts`
- Test: `plugins/codex-autoresearch/tests/decision-guidance-terminal-report.test.ts`

---

### Task 1: Detect False-Done And Large-Output Friction

- [ ] **Step 1: Add session fixture test**

In `plugins/codex-autoresearch/tests/packet-diagnostics.test.ts`, add an inline JSONL fixture containing:

- user: `Clearly, you did not test accuracy`
- assistant: `I treated autoresearch loop completion as enough`
- tool output with `Original token count: 65601`
- tool output containing `stdin is closed`

Assert forensics emits signals with kinds:

```ts
["product_bar_rejection", "false_done_admission", "oversized_tool_output", "closed_stdin_poll"]
```

- [ ] **Step 2: Run failing test**

Run:

```powershell
cd C:\Users\alber\source\repos\autoresearch\plugins\codex-autoresearch
npm run build:node
node --test --test-name-pattern "product_bar_rejection|oversized_tool_output" dist/tests/packet-diagnostics.test.mjs
```

Expected: FAIL because these signals do not exist yet.

- [ ] **Step 3: Add forensics signal extraction**

In `plugins/codex-autoresearch/lib/session-forensics.ts`, add text detectors:

- `product_bar_rejection`: user text includes `did not test accuracy`, `shippable product`, `broken experiment`, or `not what I wanted`.
- `false_done_admission`: assistant text includes `treated autoresearch loop completion` or `wrong product judgment`.
- `oversized_tool_output`: tool output includes `Original token count:` with value >= 20000.
- `closed_stdin_poll`: tool output includes `stdin is closed`.

- [ ] **Step 4: Add workflow recommendations**

In `plugins/codex-autoresearch/lib/workflow-friction.ts`, map these signals to recommendations:

- Product-bar rejection -> `Add claim coverage before finalization.`
- False-done admission -> `Downgrade evidence maturity or restart with product-grade acceptance.`
- Oversized output -> `Use bounded mapping commands, file-specific reads, or CodeStory search packets.`
- Closed stdin poll -> `Stop polling completed foreground sessions and restart only after a changed precondition.`

- [ ] **Step 5: Enforce compact output size**

In `plugins/codex-autoresearch/lib/commands/recommend-next.ts` and `terminal-report.ts`, keep compact JSON/text to the canonical next action, blockers, one command, top three evidence notes, and top three friction signals.

- [ ] **Step 6: Add compact regression**

In `plugins/codex-autoresearch/tests/autoresearch-cli.test.ts`, assert `recommend-next --compact` output for a noisy session is under 7000 characters and contains no raw tool-output body.

- [ ] **Step 7: Run targeted verification**

Run:

```powershell
cd C:\Users\alber\source\repos\autoresearch\plugins\codex-autoresearch
npm run build:node
node --test dist/tests/packet-diagnostics.test.mjs dist/tests/autoresearch-cli.test.mjs dist/tests/decision-guidance-terminal-report.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add plugins/codex-autoresearch/lib/session-forensics.ts plugins/codex-autoresearch/lib/workflow-friction.ts plugins/codex-autoresearch/lib/session-decision-capsule.ts plugins/codex-autoresearch/lib/commands/recommend-next.ts plugins/codex-autoresearch/lib/terminal-report.ts plugins/codex-autoresearch/tests/packet-diagnostics.test.ts plugins/codex-autoresearch/tests/autoresearch-cli.test.ts plugins/codex-autoresearch/tests/decision-guidance-terminal-report.test.ts
git commit -m "feat: detect autoresearch workflow friction"
```

