# Documentation Style

Plain-warm senior-engineer voice. Explain what you get, then how to do it. No glossy product fluff.

## Audience split

| Surface | Voice | Examples |
| --- | --- | --- |
| Human docs | **you**, outcomes before internals | `README.md`, `docs/*` except maintainers, architecture, control-plane |
| Agent surfaces | **Codex**, executable contracts | `SKILL.md`, `references/*`, `hooks.md` |
| Maintainer surfaces | practical and dense where needed | `AGENTS.md`, `maintainers.md`, `architecture.md`, `control-plane.md` |

Human docs teach people what to do. Agent docs tell Codex how to operate safely. Maintainer docs help contributors ship without breaking contracts.

## Do

- Lead with what you get, then how to do it.
- One plain-English sentence before internal terms (`packet`, ASI, `quality_gap`).
- Tables and diagrams over 40-line bullet walls.
- Link to canonical homes instead of copying boilerplate. See [index](index.md) for routing.
- README may use problem→solution→example→questions structure; do not label Amazon PR/FAQ or STAR frameworks in user-facing copy.
- FAQ-style answers should be honest and short — not marketing objections handling.

## Banned in user docs

- `Codex should`, `operator workflow`, `when the operator`, `operator asks`
- Long inline JSON key dumps — link to [state-fields](concepts.md#state-fields) instead
- `not magic / not vibes / not decoration` negation chains

## Sentence test

Would a senior engineer explain this to a new teammate over coffee? If not, simplify.

## Canonical homes

| Concept | Home | Everywhere else |
| --- | --- | --- |
| Loop shape | [start.md](start.md) + [workflows.md](workflows.md) | One-line + link |
| `quality_gap=0` | [concepts.md](concepts.md) | Short pointer |
| Dashboard read-only | [architecture.md](architecture.md) | One sentence + link |
| Compact-state fields | [concepts.md#state-fields](concepts.md#state-fields) | Symptom-first prose |
| Safety / trust | [trust.md](trust.md) | Links in, no copy-paste |

## Preserved substance

These stay accurate even when voice changes:

- Command examples and CLI flags
- `METRIC name=value` contract
- Git scoping (`commitPaths`, `revertPaths`)
- Safety warnings and trust blockers
- Finalization bar and claim coverage rules
