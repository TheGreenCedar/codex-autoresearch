---
name: autoresearch-deep-research
description: Create Codex Autoresearch deep-research loops that turn project study or source-backed recommendations into a quality_gap benchmark. Use when asked to study first, find high-impact changes, create research scratchpads, or convert recommendations into loops.
---

# Autoresearch Deep Research

Use this skill when the work needs research before experiments. The output is not a one-shot report; it is a source-backed scratchpad plus a `quality_gap` benchmark that Codex can drive down with `/autoresearch next`.

For repeated "study the project and suggest delightful improvements" work, treat each full prompt pass as one research round. A round starts by rerunning the study prompt against the current project, refreshing source-backed synthesis, previewing gap candidates, rejecting hallucinations, and accepting only evidence-backed high-impact gaps. All implementation done from that accepted set counts as the same round.

## Quick Start

1. Create the scratchpad and session:

```bash
node <plugin-root>/scripts/autoresearch.mjs research-setup --cwd /absolute/project/path --slug <short-topic> --goal "<research goal>"
```

2. Fill `autoresearch.research/<slug>/brief.md`, `sources.md`, `notes/`, and `synthesis.md` with repo evidence, web sources when needed, contradictions, and confidence.
3. Run `node <plugin-root>/scripts/autoresearch.mjs gap-candidates --cwd /absolute/project/path --research-slug <slug>` to preview validated gap candidates from `synthesis.md`. If model assistance is useful, pass `--model-command <cmd>`; the command must print a JSON array and its output is validated before apply.
4. Convert accepted candidates into checklist items with `gap-candidates --apply` or by editing `quality-gaps.md`.
5. Run `/autoresearch next` or:

```bash
node <plugin-root>/scripts/autoresearch.mjs next --cwd /absolute/project/path
```

6. Implement or explicitly reject the highest-impact open gap, then log the run with ASI.

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

Important: `quality_gap=0` only means the currently accepted checklist is closed. Put plainly: quality_gap=0 only means the round checklist is closed. It does not prove fresh research has no new suggestions. Before stopping, run a fresh research round and stop only when that round yields no credible high-impact candidates, checks pass, and the synthesis has no unresolved high-impact recommendation.

## Round Protocol

For each round:

1. Rerun the project-study prompt, adapted to the project and plugin context.
2. Update `sources.md`, `notes/`, and `synthesis.md` with current repo evidence, dated external sources when needed, contradictions, and confidence.
3. Run `gap-candidates` to preview candidate gaps from the refreshed synthesis.
4. Filter hallucinations before applying; in notes, use the phrase "filter hallucinations" for rejected unsupported candidates:
   - Reject candidates that cannot point to repo evidence, a primary source, a direct measurement, or a dated external source.
   - Reject candidates that duplicate behavior already present in the current branch.
   - Reject candidates that cannot name a validation path.
   - Keep small QoL and bug-fix ideas separate unless they materially advance the round goal.
5. Apply only the accepted high-impact candidates.
6. Implement or explicitly reject those accepted gaps, then log the whole implementation set as that round's result with ASI.
7. Start another round from a fresh prompt pass. Stop when nothing credible and high-impact survives filtering.

## Research To Experiment Flow

- Prefer primary sources, official docs, repo evidence, direct measurements, and dated claims.
- Record contradictions instead of smoothing them over.
- Separate high-impact changes from small QoL fixes.
- Convert only actionable, evidence-backed findings into quality gaps.
- Put next-step guidance in ASI, especially `hypothesis`, `evidence`, and `next_action_hint`.
- For discarded or rejected gaps, include `rollback_reason` or rejection evidence so the next run does not repeat it.

## Local Plugin Routing

When improving this plugin itself, use the repo-local plugin before a globally installed or marketplace-cache copy. Follow the canonical local routing in the [`/autoresearch` command doc](../../commands/autoresearch.md#local-plugin-routing).
