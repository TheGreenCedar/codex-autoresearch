---
name: autoresearch-deep-research
description: Create Codex Autoresearch deep-research loops that turn project study or source-backed recommendations into a quality_gap benchmark. Use when asked to study first, find high-impact changes, create research scratchpads, or convert recommendations into loops.
---

# Autoresearch Deep Research

Use this skill when the work needs research before experiments. The output is not a one-shot report; it is a source-backed scratchpad plus a `quality_gap` benchmark that Codex can drive down with `/autoresearch next`.

## Quick Start

1. Create the scratchpad and session:

```bash
node <plugin-root>/scripts/autoresearch.mjs research-setup --cwd /absolute/project/path --slug <short-topic> --goal "<research goal>"
```

2. Fill `autoresearch.research/<slug>/brief.md`, `sources.md`, `notes/`, and `synthesis.md` with repo evidence, web sources when needed, contradictions, and confidence.
3. Convert the synthesis into checklist items in `quality-gaps.md`.
4. Run `/autoresearch next` or:

```bash
node <plugin-root>/scripts/autoresearch.mjs next --cwd /absolute/project/path
```

5. Implement or explicitly reject the highest-impact open gap, then log the run with ASI.

## Scratchpad Rules

- Keep all research state under `autoresearch.research/<slug>/`.
- Use `brief.md` for request, audience, constraints, and success criteria.
- Use `plan.md` and `tasks.md` to split work into independent streams.
- Use `sources.md` for source, date checked, claim supported, and confidence.
- Use `synthesis.md` as the live merged answer, not a final dump.
- Use `deliverables/` only for artifacts the user asked to see or that clarify a comparison-heavy result.

## Quality Gap Benchmark

Treat each unchecked line in `quality-gaps.md` as one open gap:

```markdown
- [ ] Source ledger covers current repo evidence.
- [x] Project essence is accurate and cited.
```

The benchmark prints:

```text
METRIC quality_gap=<open>
METRIC quality_total=<all checklist items>
METRIC quality_closed=<checked items>
```

Keep iterating until `quality_gap=0`, checks pass, and the synthesis has no unresolved high-impact recommendation.

## Research To Experiment Flow

- Prefer primary sources, official docs, repo evidence, direct measurements, and dated claims.
- Record contradictions instead of smoothing them over.
- Separate high-impact changes from small QoL fixes.
- Convert only actionable, evidence-backed findings into quality gaps.
- Put next-step guidance in ASI, especially `hypothesis`, `evidence`, and `next_action_hint`.
- For discarded or rejected gaps, include `rollback_reason` or rejection evidence so the next run does not repeat it.

## Local Plugin Routing

When improving this plugin itself, use the repo-local plugin before a globally installed or marketplace-cache copy. Follow the canonical local routing in the [`/autoresearch` command doc](../../commands/autoresearch.md#local-plugin-routing).
