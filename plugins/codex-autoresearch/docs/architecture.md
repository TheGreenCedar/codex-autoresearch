# Architecture Diagrams

Autoresearch has one product surface and several implementation paths. The rule of thumb: the skill tells Codex how to behave, MCP/CLI execute bounded operations, and durable session files remain the source of truth.

## Runtime Surfaces

```mermaid
flowchart TD
  U["Human in Codex"] --> S["codex-autoresearch skill"]
  A["Future AI / resumed context"] --> S
  S --> MCP["MCP tools"]
  S --> CLI["CLI fallback"]
  MCP --> C["mcp-interface"]
  CLI --> H["cli-handlers"]
  C --> Core["session, runner, recipes, dashboard view-model"]
  H --> Core
  Core --> Files["autoresearch.md / jsonl / config / ideas / research"]
  Core --> Dash["Live dashboard server"]
  Dash --> Browser["Human-readable runboard"]
```

## Trust Boundary

```mermaid
flowchart LR
  Inputs["Commands, metrics, Git, files"] --> Validate["Schema and freshness checks"]
  Validate --> Packet["Last-run packet"]
  Packet --> Decision{"Decision allowed?"}
  Decision -- "keep" --> ScopedGit["Scoped commit paths or explicit commit"]
  Decision -- "discard" --> ScopedRevert["Scoped revert paths"]
  Decision -- "crash/checks_failed" --> Ledger["Metricless failure log"]
  ScopedGit --> Ledger
  ScopedRevert --> Ledger
  Ledger --> Continuation["Continuation contract"]
```

## Source Layout

```mermaid
flowchart TD
  Scripts["scripts/*.ts"] --> CLI["Public CLI shims and command functions"]
  Lib["lib/*.ts"] --> Core["Reusable session, MCP, runner, recipe, dashboard logic"]
  Dashboard["dashboard/src"] --> Assets["assets/dashboard-build"]
  Assets --> Export["Self-contained export HTML"]
  Docs["README + docs + skill"] --> Product["Human and AI onboarding contract"]
  Tests["tests/*.ts"] --> Gate["npm run check / npm test"]
```

## MCP Tool Path

```mermaid
sequenceDiagram
  participant Codex
  participant MCP as autoresearch-mcp
  participant Schema as mcp-tool-schemas
  participant Interface as mcp-interface
  participant CLI as CLI adapter
  participant Core as Core functions

  Codex->>MCP: tools/call
  MCP->>Schema: normalize and validate args
  Schema-->>MCP: typed arguments
  MCP->>Interface: callTool(name, args)
  Interface->>Core: in-process handler
  Interface-->>Codex: structured result
  Interface->>CLI: fallback command shape when needed
```

## Finalization

```mermaid
flowchart TD
  A["Logged keep decisions"] --> B["finalize_preview"]
  B --> C{"Ready?"}
  C -- "No" --> D["Report dirty tree, missing commits, overlap, or stale plan"]
  C -- "Yes" --> E["Create review branches outside dashboard"]
  E --> F["Verify branch union and artifact exclusion"]
  F --> G["Human review / merge / cleanup"]
```
