# Operate

Use this page while running or resuming a loop.

## Resume

Start with read-only context:

```bash
node scripts/autoresearch.mjs onboarding-packet --cwd <project> --compact
node scripts/autoresearch.mjs recommend-next --cwd <project> --compact
node scripts/autoresearch.mjs doctor --cwd <project> --explain
```

If MCP tools are available, prefer `prompt_plan` for broad new requests, then `onboarding_packet`, `recommend_next`, `read_state`, `guided_setup`, and `doctor_session`.

Read existing files before editing:

- `autoresearch.md`
- `autoresearch.jsonl`
- `autoresearch.ideas.md`
- `autoresearch.research/<slug>/` for research loops

## Dashboard

Serve the live local runboard:

```bash
node scripts/autoresearch.mjs serve --cwd <project>
```

Use it for:

- next safe action and why it is safe
- trust blockers
- best kept change and recent failure
- metric trajectory
- mission-control steps
- strategy lanes and plateau guidance
- copyable report and AI handoff packet

Static exports are offline snapshots:

```bash
node scripts/autoresearch.mjs export --cwd <project>
```

If you need actions, serve a fresh dashboard. Do not treat an old `file://` export as runtime truth.

## Packet Loop

Normal loop:

```bash
node scripts/autoresearch.mjs next --cwd <project>
node scripts/autoresearch.mjs log --cwd <project> --from-last --status keep --description "Describe the kept change"
node scripts/autoresearch.mjs state --cwd <project> --compact
```

Statuses:

- `keep`: finite metric and a change worth preserving.
- `discard`: finite metric but not worth keeping.
- `crash`: benchmark failed before usable metric evidence.
- `checks_failed`: metric exists but correctness checks failed.

After logging, follow `continuation.shouldContinue` and `continuation.forbidFinalAnswer`.

## ASI

Use ASI to make the next agent smarter:

```json
{
  "hypothesis": "What was expected to improve",
  "evidence": "Metric/check proof",
  "rollback_reason": "Why a rejected path should not return",
  "next_action_hint": "The next safest measured step",
  "lane": "distant-scout",
  "family": "parser-cache",
  "risk": "low",
  "expected_delta": "-5% seconds"
}
```

## Quality Gap Loops

For broad research, product study, docs, UX, and architecture:

```bash
node scripts/autoresearch.mjs research-setup --cwd <project> --slug <slug> --goal "<goal>"
node scripts/autoresearch.mjs quality-gap --cwd <project> --research-slug <slug> --list
node scripts/autoresearch.mjs gap-candidates --cwd <project> --research-slug <slug>
```

`quality_gap=0` closes the accepted checklist for the current round. It does not mean discovery is permanently complete.

## Fresh Segment

When a session is maxed, stale, or deliberately entering a new phase:

```bash
node scripts/autoresearch.mjs new-segment --cwd <project> --dry-run
node scripts/autoresearch.mjs new-segment --cwd <project> --reason "fresh phase" --yes
```

This appends a new config segment to `autoresearch.jsonl` and preserves old history.
