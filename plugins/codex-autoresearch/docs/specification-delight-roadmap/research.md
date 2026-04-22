# Verifiable Research and Technology Proposal

## 1. Core Problem Analysis

Codex Autoresearch already has the primitives for accountable autonomous experimentation: setup, recipe selection, preflight doctoring, benchmark packets, ASI logging, quality-gap research, dashboard export, live safe actions, and finalization preview. The primary technical challenge is to connect those primitives into a guided operator experience that makes first-run setup, resume, slow-run progress, tool choice, and installed-version trust feel obvious.

## 2. Verifiable Technology Recommendations

| Technology/Pattern | Rationale & Evidence |
|---|---|
| **Progressive MCP Apps mission control** | MCP Apps are suitable for this roadmap because they let a tool declare an interactive UI resource that a host can render in the conversation, while preserving conversation context for the user [cite:1]. MCP Apps support bidirectional data flow between the UI and MCP server tools, which fits an operator cockpit that needs setup, state refresh, gap review, and safe action calls [cite:1]. MCP Apps run in sandboxed iframes controlled by the host, so the dashboard can add richer interactions without removing the existing static export fallback [cite:1]. MCP Apps are specifically recommended for complex data exploration, option-heavy configuration, real-time monitoring, and multi-step workflows, which match the proposed dashboard mission-control work [cite:1]. |
| **Optional MCP task/progress execution for slow benchmark operations** | MCP Tasks are experimental in the draft specification, so the implementation should be optional and keep the synchronous CLI path as the fallback [cite:2]. Tasks are durable state machines for request execution state and are intended for polling and deferred result retrieval, which fits slow `next`, `doctor --check-benchmark`, and finalization preview operations [cite:2]. The draft task model includes `tools/call` task support negotiation, polling through `tasks/get`, result retrieval through `tasks/result`, and cancellation through `tasks/cancel`, so a task adapter can remain protocol-shaped instead of inventing an incompatible long-run API [cite:2]. MCP progress notifications provide progress tokens, numeric progress, optional totals, and optional messages for long-running operations, so shorter running tools can expose status without full task persistence [cite:3]. |
| **Structured MCP tool contracts and output schemas** | MCP tools are model-controlled and described with names, descriptions, input schemas, optional output schemas, annotations, and execution metadata [cite:4]. The MCP draft says output schemas help clients and LLMs validate and understand structured results, which supports adding explicit output contracts for adjacent tools such as `setup_plan`, `setup_session`, `next_experiment`, and `log_experiment` [cite:4]. Real-world toolsets can contain overlapping names and descriptions that reduce tool selection accuracy, and ToolScope reports that redundancy and context pressure can harm tool selection in LLM agents [cite:5]. A compact, tested tool-guidance layer should therefore focus on adjacent-tool contrast, when-to-use rules, and output contracts rather than long prose [cite:4]. |
| **Doctor-based trust diagnostics** | The MCP debugging guide recommends logging initialization, resource access, tool execution, errors, and performance metrics, and it warns local stdio servers not to log protocol-breaking output to stdout [cite:6]. This supports keeping version/source/cache diagnostics in `doctor` and structured tool outputs rather than as incidental console noise [cite:6]. MCP tools should be deterministic enough for clients to cache tool lists, so installed source drift should be detected before operators trust a displayed tool surface [cite:4]. |

## 3. Repo Evidence Ledger

| Source | Claim Supported |
|---|---|
| `README.md` | Codex-first product promise, AX/UX golden paths, root-only docs, dashboard contract, and Mermaid concept maps. |
| `plugins/codex-autoresearch/skills/codex-autoresearch/SKILL.md` | Single Codex-facing skill for start/resume, active-loop continuation, deep research, dashboard, and finalization. |
| `plugins/codex-autoresearch/lib/mcp-interface.mjs` | MCP tool schemas expose setup, research setup, configure, run, next, log, state, quality gap, candidates, finalize preview, integrations, doctor, export, and clear. |
| `plugins/codex-autoresearch/lib/live-server.mjs` | Live dashboard actions are intentionally limited to safe local commands. |
| `plugins/codex-autoresearch/assets/template.html` | Static/live dashboard has cockpit panels, safe action buttons, practical run chart, quality-gap state, finalization state, and an experiment ledger. |
| `plugins/codex-autoresearch/lib/research-gaps.mjs` | Candidate extraction and dedupe exist, but apply writes appended candidate sections. |
| `plugins/codex-autoresearch/lib/recipes.mjs` | Built-in recipes exist, but recipes are flat and the `quality-gap` recipe defaults to the `research` slug. |
| `plugins/codex-autoresearch/scripts/autoresearch.mjs` | CLI owns setup, run, next, log, state, doctor, export, serve, config, quality-gap, gap-candidates, finalization preview, and MCP framing. |
| `plugins/codex-autoresearch/tests/*.test.mjs` | Current test coverage includes setup, recipes, research setup, quality gaps, safe discard, last-run packets, MCP smoke, live server, and finalization preview. |

## 4. Browsed Sources

- [1] https://modelcontextprotocol.io/extensions/apps/overview
- [2] https://modelcontextprotocol.io/specification/draft/basic/utilities/tasks
- [3] https://modelcontextprotocol.io/specification/draft/basic/utilities/progress
- [4] https://modelcontextprotocol.io/specification/draft/server/tools
- [5] https://arxiv.org/abs/2510.20036
- [6] https://modelcontextprotocol.io/docs/tools/debugging
