# Maestro

**Multi-agent plan → execute → review orchestrator.**

Maestro turns a prompt (or a Linear issue) into a structured pipeline dispatched across configurable
CLI coding agents. Each role — planner, executor, reviewer — runs inside its own agent pane, hands
off a compact typed structure to the next, and the whole pipeline persists to a local SQLite database
so runs are inspectable, resumable, and auditable.

```
prompt → [planner] ──handoff──► [executor] ──handoff──► [reviewer] → done
            │                       │                       │
          claude                  codex                   codex
          (plan mode)           (workspace-write)        (read-only)
```

---

## Features

- **LangGraph-powered flow** — roles are graph nodes, transitions are edges; no bespoke state machine code to maintain. No API key required — LangGraph handles control flow only, never makes model calls.
- **Compact typed handoffs** — only `{ role, provider, payload, log_path }` objects pass between roles. Raw stdout logs (300–400 KB per step) stay on disk, never re-sent as prompt context. Token-efficient by design.
- **SQLite persistence** — every task, step, and handoff stored in `.maestro/maestro.db`. Full log files on disk. Inspectable without running the orchestrator.
- **Visible agent panes** — default backend runs each step inside a [herdr](CREDITS.md#herdr) terminal pane. Watch agents work in real time. Fall back to silent `child_process.spawn` with `MAESTRO_BACKEND=terminal`.
- **Five providers** — claude, codex, copilot, gemini, antigravity. Mix per role. Fully configurable via `.maestro/config.json` and `WORKFLOW.md`.
- **MCP server** — seven tools expose Maestro state and task creation to any MCP-compatible AI agent (Claude, Cursor, etc.). Zero extra config beyond a `.mcp.json` entry.
- **Interactive TUI** — full terminal UI for browsing tasks, approving/denying action requests, editing workflow, and picking providers.
- **Security model** — `host_command` action requests are off by default; env key denylist strips `LD_PRELOAD`, `PATH`, and friends from all subprocess env; MCP IDs are path-traversal-guarded.
- **Linear integration** — optional server mode polls Linear and auto-dispatches issues.

---

## Requirements

| Requirement | Notes |
|---|---|
| **Node.js ≥ 22.5** | Uses `node:sqlite` (`DatabaseSync`). Check with `node --version`. |
| **herdr** (optional) | Default terminal-pane backend. Install separately; set `MAESTRO_BACKEND=terminal` to bypass. |
| **Provider CLIs** | At least one of: `claude`, `codex`, `copilot`, `gemini`, `antigravity`. The default workflow uses `claude` (planner) and `codex` (executor + reviewer). |

---

## Installation

```bash
# Clone and install
git clone <repo-url> maestro
cd maestro
npm install

# Verify
node bin/maestro.mjs status
```

### Global install (optional)

```bash
npm link         # makes `maestro` available on PATH
maestro status
```

### As a nested package (monorepo)

```bash
# From your project root
git clone <repo-url> maestro
cd maestro && npm install && cd ..

# Add shim scripts to your root package.json:
# "maestro":     "node maestro/bin/maestro.mjs",
# "maestro:mcp": "node maestro/src/mcp/server.mjs"
```

---

## Quick Start

```bash
# Create and run a task (planner → executor → reviewer)
maestro task "Add a /healthcheck endpoint to the Express app"

# Planner only — review the plan before execution
maestro plan-only "Refactor the authentication module"

# Watch tasks
maestro tui

# List recent tasks
maestro list

# Show a specific task
maestro show 20260608-120000-add-healthcheck
```

---

## Run Modes

| Mode | Flow | Command |
|---|---|---|
| `task` | planner → executor → reviewer | `maestro task "<prompt>"` |
| `plan-only` | planner only; stops at handoff | `maestro plan-only "<prompt>"` |
| server | polls Linear, auto-dispatches | `maestro server` |

---

## Providers

Default role mapping: **planner = claude**, **executor = codex**, **reviewer = codex**.

| Provider | CLI binary | Notes |
|---|---|---|
| `claude` | `claude` | Used in `plan` permission mode for planner role |
| `codex` | `codex` | Default executor/reviewer; uses `codex exec` |
| `copilot` | `copilot` | Optional |
| `gemini` | `gemini` | Optional |
| `antigravity` | `antigravity` | Optional |

Override per role in `.maestro/workflow.json`, or interactively via `maestro tui`.

### Terminal backend

```bash
MAESTRO_BACKEND=terminal maestro task "..."
```

Bypasses herdr and runs agents via direct `child_process.spawn` (no visible panes).

---

## Configuration

State and config live in `.maestro/` in your working directory (or override with `--state-dir`):

```
.maestro/
  config.json       # providers, timeouts, planner policy, worktree settings
  workflow.json     # roles, transitions, prompt templates
  maestro.db       # SQLite: tasks, steps, handoffs (LangGraph engine)
  tasks/            # legacy per-task JSON state
  runs/             # per-run logs: <role>.stdout.log, handoff.<role>.json
  projects/         # project state
```

See [docs/configuration.md](docs/configuration.md) for the full schema and all options.

---

## MCP Integration

Maestro exposes seven read/create tools via MCP stdio transport.

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "maestro": {
      "command": "node",
      "args": ["/path/to/maestro/src/mcp/server.mjs"]
    }
  }
}
```

| Tool | Purpose |
|---|---|
| `maestro_list_tasks` | List tasks, filter by status, newest-first |
| `maestro_show_task` | Task JSON + handoffs + stdout log tails |
| `maestro_list_runs` | Recent run directories |
| `maestro_show_run` | All files in one run |
| `maestro_create_task` | Spawn a new task by prompt |
| `maestro_get_state` | Runtime state snapshot (HTTP → file fallback) |
| `maestro_read_workflow` | Current `workflow.json` + `WORKFLOW.md` |

Full schema: [src/mcp/SCHEMA.md](src/mcp/SCHEMA.md)  
Extended docs: [docs/mcp.md](docs/mcp.md)

---

## Security Model

- **`host_command` off by default.** Action requests that exec host commands are rejected at approval time unless `.maestro/config.json` has `"host_command_allow": ["binary1", ...]`. Network/privilege-escalation binaries (`curl`, `wget`, `ssh`, `sudo`, etc.) are hard-denied even if listed.
- **Env key denylist.** `LD_PRELOAD`, `PATH`, `GIT_SSH_COMMAND`, `NODE_OPTIONS`, `BASH_ENV`, `DYLD_*`, `GIT_PROXY*` are stripped from all action-request `env` objects at parse time.
- **MCP path traversal guard.** `maestro_show_task` and `maestro_show_run` reject IDs that do not match `^[0-9A-Za-z][0-9A-Za-z._-]*$` and verify the resolved path stays inside `.maestro/`.
- **Config redaction.** `maestro_get_state` strips keys matching `*_key/*_token/*_secret/api_key/apikey/password/passwd` before returning config to MCP clients.

---

## Architecture

```
bin/maestro.mjs (CLI entry)
│
├─ src/langgraph/          LangGraph engine
│   ├─ engine.mjs          runLangGraphTask() — entry point
│   ├─ graph.mjs           buildGraph() from workflow.json
│   ├─ nodes.mjs           makeRoleNode() — node factory
│   ├─ prompt.mjs          compact prompt builder (typed handoffs)
│   └─ state.mjs           MaestroState channels
│
├─ src/adapters/           Provider command builders (pure functions)
│   ├─ registry.mjs        resolveAdapter() — built-in:<name> dispatch
│   ├─ claude.mjs
│   ├─ codex.mjs
│   ├─ copilot.mjs
│   ├─ gemini.mjs
│   └─ antigravity.mjs
│
├─ src/db/store.mjs        SqliteTaskStore (node:sqlite)
├─ src/herdr-client.mjs    JSON-RPC wrapper around herdr binary
├─ src/herdr-agent-runner.mjs  HerdrAgentRunner (default backend)
├─ src/agent-runner.mjs    TerminalAgentRunner (fallback backend)
├─ src/orchestrator.mjs    MaestroOrchestrator (server mode + tick loop)
├─ src/router.mjs          buildStepPrompt, evaluatePlannerDecision
├─ src/state-machine.mjs   Pure transition(state, event) → nextState
├─ src/task-store.mjs      LocalTaskStore + DEFAULT_WORKFLOW
├─ src/workflow.mjs        WorkflowStore, parseCliArgs, renderPrompt
├─ src/workspace.mjs       WorkspaceManager (git worktrees)
├─ src/markers.mjs         Pure parsers: HANDOFF/QUESTION/REVIEW/ACTION_REQUEST
├─ src/http-server.mjs     Optional HTTP API (/api/v1/state)
├─ src/linear-tracker.mjs  Linear GraphQL issue fetcher
├─ src/tui.mjs             Interactive terminal UI
└─ src/mcp/server.mjs      MCP stdio server (7 tools)
```

Full architecture documentation: [docs/architecture.md](docs/architecture.md)

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `MAESTRO_BACKEND` | `"herdr"` | `"terminal"` to bypass herdr panes |
| `MAESTRO_ROOT` | cwd walk | Override runtime root (where `.maestro/` lives) |
| `HERDR_BIN` | `"herdr"` | Path to the herdr binary |
| `HERDR_SOCKET_PATH` | `~/.config/herdr/herdr.sock` | herdr daemon socket |

---

## Testing

```bash
npm run test:package    # packaging invariants
npm run test:maestro   # full suite
npm run test:mcp        # MCP server
npm run test:enterprise # all three in sequence
```

Tests use the Node.js built-in test runner (`node --test`). No external test framework required.

---

## Documentation

- [docs/architecture.md](docs/architecture.md) — module index, run flow, SQLite schema, extension recipes
- [docs/cli.md](docs/cli.md) — every command, flags, env vars
- [docs/configuration.md](docs/configuration.md) — `.maestro/` layout, config schema, provider setup
- [docs/mcp.md](docs/mcp.md) — MCP tools reference and registration
- [src/mcp/SCHEMA.md](src/mcp/SCHEMA.md) — raw MCP tool schema (kept in sync with `server.mjs`)

---

## Credits

See [CREDITS.md](CREDITS.md) for full acknowledgements:  
[herdr](CREDITS.md#herdr) · [OpenAI Swarm (inspiration)](CREDITS.md#openai-swarm) · [LangGraph](CREDITS.md#langgraph----langchainlanggraph) · [MCP SDK](CREDITS.md#model-context-protocol-sdk----modelcontextprotocolsdk) · [OpenAI Codex CLI](CREDITS.md#openai-codex-cli----openaicodex) · [LiquidJS](CREDITS.md#liquidjs----liquidjs) · [yaml](CREDITS.md#yaml)

---

## License

[MIT](LICENSE) © 2026 Xateh
