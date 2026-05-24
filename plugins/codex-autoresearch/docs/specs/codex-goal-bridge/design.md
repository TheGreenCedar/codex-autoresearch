# Codex Goal Bridge Design

## 1. State Model

Autoresearch stores the user goal in the active JSONL config entry as `goal`. `currentState()` carries the newest value forward across segments and defaults to `""` for old sessions.

```json
{
  "type": "config",
  "name": "Performance loop",
  "goal": "Reduce startup time without weakening tests",
  "metricName": "seconds",
  "bestDirection": "lower"
}
```

## 2. Read-Only Bridge Command

`codex-goal-brief` is read-only. It accepts optional imported Codex Goal data:

```bash
node scripts/autoresearch.mjs codex-goal-brief --cwd <project> \
  --codex-goal-objective "<objective>" \
  --codex-goal-status active
```

The output includes:

- `boundary`: explicit ownership split.
- `objectiveDraft`: a <= 4000 character Goal-compatible objective.
- `completionAudit`: local status, evidence requirements, and recommended Codex action.
- `commands`: slash-command and explicit tool-prompt variants.
- `session`: metric, direction, run count, best, limit, next action, and decision envelope.

## 3. Completion Audit

Completion is intentionally hard to reach. The bridge marks `canMarkCodexGoalComplete` true only when `completion_confirmed=true`, `completion_evidence` is supplied, no active blockers are present, and local Autoresearch evidence exists.

Budget exhaustion, max iterations, stale packets, blockers, local bests, and closed quality-gap rounds remain review states. This matches the Goal-mode lesson: a budget stop is not victory. It is just the meter running out.

## 4. Decision Envelope

`buildDecisionEnvelope()` emits `goalAdvice`:

```json
{
  "present": true,
  "objective": "Reduce startup time without weakening tests",
  "advice": "continue",
  "reason": "Continue from the decision envelope next action and require evidence before completion.",
  "completionPolicy": "Never treat iteration, tool, or token budget exhaustion as goal completion."
}
```

The dashboard and state surfaces consume the envelope instead of inventing a second goal interpretation.

## 5. Security and Runtime Boundary

The bridge never reads private Codex state files and never calls Codex app-server APIs itself. The parent Codex thread can provide `get_goal` output if available. This keeps the plugin portable and avoids building against private implementation details.
