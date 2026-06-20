# Agent Instructions

These instructions apply to ALL agents — main thread, subagents, any provider or model. Read and follow them regardless of harness.

## Subagents
- For implementation work, spawn subagents using the `xcodex` alias's `gpt-5.3-codex-spark xhigh` model where possible.
- The harness `Agent` tool only launches same-provider subagent types (`claude`, `Explore`, `general-purpose`, `Plan`, …). It cannot launch `xcodex`/Codex, Copilot, or any other provider as a subagent. When implementation work needs a cross-provider agent and the `Agent` tool has no matching `subagent_type`, do NOT fall back to the default same-provider subagent — route the task through maestro instead:
  ```bash
  npm run maestro -- task "<task prompt>"          # Codex executes by default
  npm run maestro -- task --planner on "<task>"    # force Claude planning first
  npm run maestro -- task --review off "<task>"     # skip Codex review for quick tasks
  npm run maestro -- status                         # list task records
  npm run maestro -- inspect <task-id>              # inspect one task
  ```
- This maestro fallback applies to ANY cross-provider agent-launch failure through the `Agent` tool, not just `xcodex`. The default Claude subagent is fine only for genuinely provider-agnostic work (search, planning, Claude-native tasks).

## Skills
- Always use the `caveman` and `ponytail` skills.

## Context hygiene
- Compact proactively, especially on long tasks.
- Commit and compact between subtasks.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
