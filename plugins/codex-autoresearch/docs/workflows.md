# Workflow Diagrams

Codex Autoresearch is easiest to understand as a few small loops. Use this page when words start hiding the actual motion and everything starts sounding like a product manager whispered into a blender.

## First Five Minutes

```mermaid
flowchart TD
  A["Human prompt"] --> B["prompt_plan or onboarding_packet"]
  B --> C{"Enough setup detail?"}
  C -- "No" --> D["Ask only for missing essentials"]
  C -- "Yes" --> E["setup or setup_plan"]
  D --> E
  E --> F["doctor --explain"]
  F --> G{"Benchmark prints METRIC?"}
  G -- "No" --> H["benchmark_lint and repair command"]
  G -- "Yes" --> I["serve live dashboard"]
  H --> F
  I --> J["next: run one packet"]
  J --> K["log keep/discard/crash/checks_failed with ASI"]
  K --> L{"continuation says continue?"}
  L -- "Yes" --> J
  L -- "No" --> M["finalize_preview or report blocker"]
```

## Prompt To Loop

```mermaid
flowchart LR
  P["Natural-language request"] --> I["Infer intent"]
  I --> M["Metric plan"]
  I --> S["Scope and safety"]
  I --> E["Experiment lanes"]
  M --> Q{"Missing benchmark?"}
  Q -- "Yes" --> R["Recommend recipe or ask"]
  Q -- "No" --> U["setup defaults"]
  S --> U
  E --> U
  R --> U
  U --> O["Read-only setup command and next safe action"]
```

## Active Packet Loop

```mermaid
stateDiagram-v2
  [*] --> Inspect
  Inspect --> Packet: next_experiment
  Packet --> Log: finite metric or metricless failure
  Log --> Continue: log_experiment returns continuation
  Continue --> Inspect: shouldContinue
  Continue --> Segment: stale or maxed segment
  Continue --> Finalize: useful kept work is ready
  Segment --> Inspect: new_segment baseline
  Finalize --> [*]
```

## Quality-Gap Research

```mermaid
flowchart TD
  A["Broad product/docs/UX prompt"] --> B["setup_research_session"]
  B --> C["brief, sources, synthesis"]
  C --> D["filter hallucinations"]
  D --> E["quality-gaps.md"]
  E --> F["quality_gap benchmark"]
  F --> G{"quality_gap = 0?"}
  G -- "No" --> H["Implement or reject accepted gaps"]
  H --> F
  G -- "Yes" --> I["Round complete, not discovery complete"]
```

## Dashboard Reading Order

```mermaid
flowchart LR
  A["Trust blockers"] --> B["Run chart"]
  B --> C["Next best action"]
  C --> D["Why safe"]
  D --> E["Decision controls"]
  E --> F["Ledger and finalization"]
```
