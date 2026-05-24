# Codex Goal Bridge Requirements

## Requirement 1: Durable Autoresearch Goal

### Acceptance Criteria

1. WHEN `init` receives `--goal`, THE **Session Ledger** SHALL persist that goal in the config entry.
2. WHEN `setup` or `research-setup` initializes a session with a goal, THE **Session Ledger** SHALL preserve it in `autoresearch.jsonl`.
3. WHEN older ledgers do not contain a goal, THE **Session Ledger** SHALL return an empty goal without failing.

## Requirement 2: Goal Bridge Readout

### Acceptance Criteria

1. WHEN `codex-goal-brief --cwd <project>` runs, THE **Goal Bridge** SHALL return `objectiveDraft`, `completionAudit`, `boundary`, and copyable commands.
2. WHEN imported Codex Goal fields are provided, THE **Goal Bridge** SHALL echo them as `importedCodexGoal`.
3. WHEN no imported Codex Goal exists, THE **Goal Bridge** SHALL state that Codex Goal creation is only appropriate when explicitly requested.

## Requirement 3: Completion Safety

### Acceptance Criteria

1. WHEN the iteration limit or imported budget status is reached, THE **Goal Bridge** SHALL recommend budget/blocker handling instead of completion.
2. WHEN a packet needs a log decision, THE **Goal Bridge** SHALL require logging before continuation.
3. WHEN completion evidence is not confirmed, THE **Goal Bridge** SHALL set `canMarkCodexGoalComplete` to false.
4. WHEN completion evidence is confirmed but local Autoresearch evidence or blocker clearance is missing, THE **Goal Bridge** SHALL preserve the evidence text without allowing completion.
5. WHEN completion evidence is confirmed, blockers are clear, and local Autoresearch evidence exists, THE **Goal Bridge** SHALL allow completion advice and preserve the evidence text.

## Requirement 4: Decision Envelope Alignment

### Acceptance Criteria

1. WHEN a durable goal exists, THE **Decision Envelope** SHALL include `goalAdvice`.
2. WHEN blockers exist, THE **Decision Envelope** SHALL advise blocked review rather than continuation.
3. WHEN finalization or a closed quality round suggests review, THE **Decision Envelope** SHALL require completion review rather than automatic success.

## Requirement 5: Documentation and Agent Behavior

### Acceptance Criteria

1. WHEN Codex Goal mode is used, THE **Skill Guidance** SHALL tell the agent to inspect `get_goal` when available.
2. WHEN a parent Codex Goal might be completed, THE **Skill Guidance** SHALL require `codex-goal-brief` evidence before `update_goal(status="complete")`.
3. WHEN hooks are discussed, THE **Skill Guidance** SHALL keep hooks optional and non-load-bearing.
