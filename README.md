# Maestro

[![CI](https://github.com/Xateh/maestro/actions/workflows/ci.yml/badge.svg)](https://github.com/Xateh/maestro/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.13-brightgreen.svg)](package.json)

**Your agents, conducted.**

One coding agent improvises. Several of them, unsupervised, are a garage band
at 2 a.m. Maestro hands them sheet music: it turns a prompt (or a Linear
issue) into a plan → execute → review pipeline dispatched across CLI coding
agents, where each role — planner, executor, reviewer — plays its part in its
own terminal pane, hands a compact typed score to the next chair, and every
note lands in a local SQLite database. Runs are inspectable, resumable, and
auditable. Nobody plays from memory.

```
prompt → [planner] ──handoff──► [executor] ──handoff──► [reviewer] → done
            │                       │                       │
          claude                  codex                   codex
          (plan mode)           (workspace-write)        (read-only)
```

---

## Features

- **LangGraph-powered flow** — roles are graph nodes, transitions are edges; no
  bespoke state-machine code to maintain. No API key required: LangGraph keeps
  time, it never makes model calls.
- **Compact typed handoffs** — only `{ role, provider, payload, log_path }`
  objects pass between roles. Raw stdout (300–400 KB a step) stays on disk and
  is never re-sent as prompt context. The orchestra passes notes, not noise.
- **SQLite persistence** — every task, step, and handoff lands in
  `.maestro/maestro.db`. Full logs on disk. Inspectable without the
  orchestrator running.
- **Visible agent panes** — the default backend seats each step in a
  [herdr](CREDITS.md#herdr) terminal pane, one tab per task. Watch agents work
  in real time. Tabs take a bow when the task succeeds, stay on stage while a
  task waits on you (the whole conversation, right where you left it), and a
  resumed task picks up in the *same* tab — no trail of empty seats. Tune it
  with `herdr.close_tab_on`; or skip the theatre entirely with
  `MAESTRO_BACKEND=terminal`.
- **Five providers** — claude, codex, copilot, gemini, antigravity. Mix per
  role; the default seating puts claude at first chair (planner) and codex on
  execution and review. Configurable via `.maestro/config.json` and
  `WORKFLOW.md`.
- **MCP server** — seven tools expose Maestro state and task creation to any
  MCP-compatible agent (Claude Code, Cursor, …). One `.mcp.json` entry, no
  other config.
- **Interactive TUI** — browse tasks, approve or deny action requests, answer
  agent questions, edit the workflow, and re-seat providers from the podium.
- **Security model** — host commands are off by default, network binaries are
  hard-denied even when allowlisted, secrets are stripped from subprocess env,
  and MCP file access is path-traversal-guarded. Trust the players, frisk the
  instruments.
- **Linear integration** — optional server mode polls Linear and dispatches
  issues without you lifting the baton.

---

## Requirements

| Requirement | Notes |
|---|---|
| **Node.js ≥ 22.13** | Uses the built-in `node:sqlite` (`DatabaseSync`). Check with `node --version`. |
| **herdr** (optional) | Default terminal-pane backend. Install separately; set `MAESTRO_BACKEND=terminal` to bypass. |
| **Provider CLIs** | At least one of `claude`, `codex`, `copilot`, `gemini`, `antigravity`. The default workflow uses `claude` (planner) and `codex` (executor + reviewer). |

---

## Installation

```bash
# Clone and install
git clone git@github.com:Xateh/maestro.git
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
git clone git@github.com:Xateh/maestro.git
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

# Planner only — read the plan before anyone touches code
maestro plan-only "Refactor the authentication module"

# Watch and steer from the terminal UI
maestro tui

# List tasks
maestro status

# Dump full JSON state for one task
maestro inspect 20260608-120000-add-healthcheck
```

A task that needs you — a question, an approval — parks in `waiting_user` and
keeps its terminal tab open with the conversation intact. Answer with
`maestro message`, `maestro approve`, or the TUI, and the pipeline resumes in
the same tab, same context, no encore required.

---

## Run Modes

| Mode | Flow | Command |
|---|---|---|
| `task` | planner → executor → reviewer | `maestro task "<prompt>"` |
| `plan-only` | planner only; stops at handoff | `maestro plan-only "<prompt>"` |
| server | polls Linear, auto-dispatches | `maestro [WORKFLOW.md]` |

---

## Providers

Default role mapping: **planner = claude**, **executor = codex**, **reviewer = codex**.

| Provider | CLI binary | Notes |
|---|---|---|
| `claude` | `claude` | Runs in `plan` permission mode for the planner role |
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
  config.json       # providers, timeouts, planner policy, worktrees, tab lifecycle
  workflow.json     # roles, transitions, prompt templates
  maestro.db        # SQLite: tasks, steps, handoffs (LangGraph engine)
  tasks/            # legacy per-task JSON state
  runs/             # per-run logs: <role>.stdout.log, handoff.<role>.json
  projects/         # project state
```

See [docs/configuration.md](docs/configuration.md) for the full schema —
including `herdr.close_tab_on` (`"success"` | `"terminal"` | `"never"`), which
decides when a task's terminal tab leaves the stage.

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

- **`host_command` off by default.** Action requests that exec host commands
  are rejected at approval time unless `.maestro/config.json` has
  `"host_command_allow": ["binary1", ...]`. Network/privilege-escalation
  binaries (`curl`, `wget`, `ssh`, `sudo`, …) are hard-denied even if listed.
- **Env key denylist.** `LD_PRELOAD`, `PATH`, `GIT_SSH_COMMAND`,
  `NODE_OPTIONS`, `BASH_ENV`, `DYLD_*`, `GIT_PROXY*` are stripped from all
  action-request `env` objects at parse time.
- **MCP path traversal guard.** `maestro_show_task` and `maestro_show_run`
  reject IDs that do not match `^[0-9A-Za-z][0-9A-Za-z._-]*$` and verify the
  resolved path stays inside `.maestro/`.
- **Config redaction.** `maestro_get_state` strips keys matching
  `*_key/*_token/*_secret/api_key/apikey/password/passwd` before returning
  config to MCP clients.

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
├─ src/herdr-agent-runner.mjs  HerdrAgentRunner (default backend, tab lifecycle)
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
npm test                # full suite — node --test, hermetic
npm run lint            # Biome (lint-only)
npm run test:coverage   # c8 coverage report
npm run test:enterprise # package + maestro + mcp suites in sequence
```

Tests use the Node.js built-in test runner. No API keys, no agent CLIs, no
herdr binary needed — stub runners and temp dirs all the way down. If it's
red, it's the code, not the weather.

---

## Documentation

- [docs/architecture.md](docs/architecture.md) — module index, run flow, SQLite schema, extension recipes
- [docs/cli.md](docs/cli.md) — every command, flags, env vars
- [docs/configuration.md](docs/configuration.md) — `.maestro/` layout, config schema, provider setup, tab lifecycle
- [docs/mcp.md](docs/mcp.md) — MCP tools reference and registration
- [src/mcp/SCHEMA.md](src/mcp/SCHEMA.md) — raw MCP tool schema (kept in sync with `server.mjs`)
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to join the ensemble
- [CHANGELOG.md](CHANGELOG.md) — the programme so far

---

## Credits

See [CREDITS.md](CREDITS.md) for full acknowledgements:
[herdr](CREDITS.md#herdr) · [OpenAI Swarm (inspiration)](CREDITS.md#openai-swarm) · [LangGraph](CREDITS.md#langgraph----langchainlanggraph) · [MCP SDK](CREDITS.md#model-context-protocol-sdk----modelcontextprotocolsdk) · [OpenAI Codex CLI](CREDITS.md#openai-codex-cli----openaicodex) · [LiquidJS](CREDITS.md#liquidjs----liquidjs) · [yaml](CREDITS.md#yaml)

---

## License

[MIT](LICENSE) © 2026 Xateh
