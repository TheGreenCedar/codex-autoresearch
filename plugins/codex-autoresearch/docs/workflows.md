# Workflow Diagrams

Codex Autoresearch is easiest to understand as a few small loops. Use this page when words start hiding the actual motion and everything starts sounding like a product manager whispered into a blender.

## First Five Minutes

```mermaid
flowchart TD
  A["Human prompt"] --> B["prompt-plan or onboarding-packet"]
  B --> C{"Enough setup detail?"}
  C -- "No" --> D["Ask only for missing essentials"]
  C -- "Yes" --> E["setup or setup-plan"]
  D --> E
  E --> F["doctor --explain"]
  F --> G{"Benchmark prints METRIC?"}
  G -- "No" --> H["benchmark-lint and repair command"]
  G -- "Yes" --> I["serve live dashboard"]
  H --> F
  I --> J["next: run one packet"]
  J --> K["log keep/discard/measure/crash/checks_failed with ASI"]
  K --> L{"continuation says continue?"}
  L -- "Yes" --> J
  L -- "No" --> M["finalize-preview or report blocker"]
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
  Inspect --> Packet: next
  Packet --> Log: keep/discard/measure or metricless failure
  Log --> Continue: log returns continuation
  Continue --> Inspect: shouldContinue
  Continue --> Segment: stale or maxed segment
  Continue --> Finalize: useful kept work is ready
  Segment --> Inspect: new-segment baseline
  Finalize --> [*]
```

## Quality-Gap Research

```mermaid
flowchart TD
  A["Broad product/docs/UX prompt"] --> B["research-setup"]
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
  A["Decision envelope"] --> B["Trust blockers"]
  B --> C["Run chart"]
  C --> D["Next best action"]
  D --> E["Why safe"]
  E --> F["Read-only handoff"]
  F --> G["Ledger and finalization"]
```
