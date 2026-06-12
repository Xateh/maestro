# Credits & Acknowledgements

Maestro stands on the shoulders of several excellent projects and ideas.

---

## Conceptual Inspiration

### OpenAI Swarm
[OpenAI Swarm](https://github.com/openai/swarm) is an experimental multi-agent orchestration
framework that demonstrated the power of role-handoff patterns: lightweight agents passing typed
control to each other rather than a monolithic model doing everything. Maestro's
planner → executor → reviewer pipeline is conceptually inspired by this approach — specialised
roles, structured handoffs, clean separation of concerns. Maestro is not a fork or derivative of
Swarm; it is an independent implementation in Node.js built on LangGraph.

---

## Runtime Dependencies

### herdr
Maestro's default agent backend. **herdr** is a terminal-multiplexer daemon that manages
workspaces, tabs, and panes over a Unix socket. When running a Maestro task, each agent role
(planner, executor, reviewer) is launched as a visible CLI pane inside a herdr-managed terminal,
so you can watch agents work in real time.

- Env overrides: `HERDR_BIN` (default `herdr`), `HERDR_SOCKET_PATH`
- Bypass: set `MAESTRO_BACKEND=terminal` to use direct `child_process.spawn` instead

herdr is an optional external binary, not an npm dependency.

### LangGraph — `@langchain/langgraph`
Maestro uses LangGraph as its **sole orchestration engine**. LangGraph handles the flow graph
(roles as nodes, transitions as edges, MemorySaver for in-process state) but **never makes model
calls** — no API key required. All model calls happen inside the agent CLI binaries.

https://github.com/langchain-ai/langgraphjs

### Model Context Protocol SDK — `@modelcontextprotocol/sdk`
The MCP server (`src/mcp/server.mjs`) exposes Maestro's state and task-creation to AI agents
via the Model Context Protocol stdio transport.

https://github.com/modelcontextprotocol/typescript-sdk

### OpenAI Codex CLI — `@openai/codex`
The default executor and reviewer provider. Maestro invokes `codex exec` as an external
subprocess; `@openai/codex` is declared as a dependency so `npm install` makes the `codex`
binary available.

https://github.com/openai/codex

### LiquidJS — `liquidjs`
Used to render Liquid-template prompt strings defined in `WORKFLOW.md` / `workflow.json`
prompt templates.

https://liquidjs.com

### yaml
YAML parsing for workflow configuration files.

https://github.com/eemeli/yaml

---

## Optional Integrations

### Linear
Maestro can poll Linear issues and dispatch tasks automatically (server mode). Linear is an
optional integration; no Linear credentials are required for local task execution.

https://linear.app

### Provider CLIs
Maestro dispatches agent steps to whichever CLI is configured as a provider:

| Provider | CLI binary | Default role |
|---|---|---|
| Claude | `claude` | planner |
| Codex | `codex` | executor, reviewer |
| Copilot | `copilot` | — |
| Gemini | `gemini` | — |
| Antigravity | `antigravity` | — |

Each CLI must be installed separately and available on `PATH` (or configured via
`.maestro/config.json` aliases).

### Local Agent Runtimes
Maestro ships provider entries for locally hosted agents (see
`docs/import-export.md` and `maestro setup local`):

- **[Ollama](https://ollama.com)** — local model server; Maestro drives it via
  `ollama run <model>` with the prompt on stdin.
- **[Pi](https://pi.dev)** (Mario Zechner / earendil-works, MIT) — open-source
  BYOK coding-agent CLI; driven via its print mode (`pi --model <m> -p`).
- **[Hermes Agent](https://hermes-agent.nousresearch.com)** (Nous Research) —
  self-improving agent runtime with Ollama/OpenAI-compatible backends.
- **[OpenClaw](https://docs.openclaw.ai)** — self-hosted personal AI assistant;
  driven via `openclaw agent --message`.

The onboarding wizards of these projects (`openclaw onboard`, `hermes setup`)
inspired Maestro's `setup local` / `setup keys` flow.

---

## Imported User Setups

`maestro setup import` records every imported artifact (skills, subagents,
instruction files, MCP configs) with source paths and credit lines in
`.maestro/import-manifest.json`, and those credits travel with exported
workflow bundles. Credit for imported content belongs to its original
authors.
