<div align="center">

<!-- <img src="docs/assets/banner.svg" width="720" alt="Maestro — your agents, conducted." /> -->

<em>Your agents, conducted.</em>

[![CI](https://github.com/Xateh/maestro/actions/workflows/ci.yml/badge.svg)](https://github.com/Xateh/maestro/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%E2%89%A522.13-brightgreen.svg)](package.json) [![Code style: Biome](https://img.shields.io/badge/code_style-biome-60a5fa.svg)](biome.json) [![Changelog](https://img.shields.io/badge/changelog-keep--a--changelog-orange.svg)](CHANGELOG.md) [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[Getting Started](#getting-started) · [Why](#why-maestro) · [Usage](#usage) · [Dashboard](#web-dashboard) · [Architecture](#architecture)

</div>

Maestro is a **harness for precise, auditable agent workflows**, built on
[LangGraph](https://github.com/langchain-ai/langgraphjs). You declare the exact
graph — which roles run, which model drives each, where the gates and loops sit —
and Maestro conducts the coding CLIs already installed on your machine
(`claude`, `codex`, `gemini`, `copilot`, `antigravity`, `ollama`) across it.
Every handoff between roles is **typed, scoped, recorded, and replayable**: raw
output stays on disk, only compact contracts pass downstream, and any run can be
re-opened and audited later. No API keys, no vendor lock-in, no per-token billing
you didn't sign up for.

The pipeline isn't the point — the **precision** is. `plan → execute → review`
is just the stock graph. Compose your own: a one-shot task, a long-running
multi-stage project, or an unattended background service that polls your tracker
and runs the right workflow on a cadence (`maestro serve`). Right model per role,
gates where you want them, loops that terminate, every run inspectable after the
fact.

### Demo

One prompt, three roles, hands off automatically — plan, execute, review:

<!--
<div align="center">

<img src="docs/assets/demo.svg" width="800" alt="Maestro running a task end to end: planner hands off to executor, executor to reviewer, then the task completes." />

</div>
-->

```mermaid
flowchart LR
    prompt([prompt]) --> planner[planner]
    planner -- handoff --> executor[executor]
    executor -- handoff --> reviewer[reviewer]
    reviewer --> done([done])

    planner -.- p1["claude<br/>plans + architecture"]
    executor -.- e1["codex<br/>writes + edits code"]
    reviewer -.- r1["codex<br/>reviews + approves"]
```

That's the stock `default` workflow — one graph among many. Mix and match
freely: swap any role to any provider (`gemini` for big-context research,
`ollama` for fully local, …) in `.maestro/config.json` or live in the TUI,
or reshape the graph itself (`maestro workflow use`) — add stages, gates, and
bounded loops. You hold the score; only the instruments change.

---

## Table of Contents

- [Why Maestro](#why-maestro)
- [Features](#features)
- [Getting Started](#getting-started)
  - [Requirements](#requirements)
  - [Installation](#installation)
  - [Quick Start](#quick-start)
- [Usage](#usage)
  - [Run Modes](#run-modes)
  - [CLI Commands](#cli-commands)
  - [Providers](#providers)
- [Configuration](#configuration)
- [Web Dashboard](#web-dashboard)
- [MCP Integration](#mcp-integration)
- [Observability](#observability)
- [Security Model](#security-model)
- [Known Limitations](#known-limitations)
- [Architecture](#architecture)
- [Environment Variables](#environment-variables)
- [Development](#development)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [Credits](#credits)
- [License](#license)

---

## Why Maestro

Most developers already know which model to reach for: Gemini for deep
research and big-context reading, Claude for planning and architecture, Codex
for writing and editing code. Maestro makes that instinct automatic.

Instead of wrapping LLM APIs in your own glue code, Maestro drives the CLI
tools already on your machine as subprocesses, each with its own authenticated
session. If you can run `claude --version`, you're ready.

---

## Features

- **CLI agents, no API keys** — Maestro runs the coding CLIs already on your
  machine. No new credentials to provision, no API wrapper to maintain.
- **Right model per role** — assign any provider to any role: Gemini for
  research-heavy planning, Claude for architecture and review, Codex for
  workspace writes.
- **LangGraph-powered flow** — roles are graph nodes, transitions are edges;
  no bespoke state-machine code to maintain.
- **Compact typed handoffs** — only `{ role, provider, payload, log_path }`
  objects pass between roles. Raw stdout (300–400 KB a step) stays on disk and
  is never re-sent as prompt context.
- **Dual-backend persistence** — every task, step, and handoff lands in
  `.maestro/maestro.db` (SQLite, default) or a PostgreSQL database when
  `DATABASE_URL=postgres://…` is set. Logs stay on disk; the DB stores paths.
- **Visible agent panes (optional acceleration)** — the zero-dependency
  terminal backend is the default; install [herdr](CREDITS.md#herdr) on your
  `PATH` and the engine auto-selects it to seat each step in a terminal pane, one
  tab per task. Tabs close on success, stay open while a task waits on you, and a
  resumed task picks up in the *same* tab. Tune with `herdr.close_tab_on`, or
  force the default with `MAESTRO_BACKEND=terminal`.
- **MCP server** — eight tools expose Maestro state, task creation, and
  workflow validation to any MCP-compatible agent (Claude Code, Cursor, …).
  One `.mcp.json` entry, no other config.
- **Full-screen TUI** — a resize-aware, keyboard-driven terminal UI: live task
  board with filter views, one-keystroke approve/deny/answer, full-screen
  provider and role editors, a settings editor, and a workflow graph screen
  that draws roles, handoff arrows, and event transitions as a grid. Pipes and
  scripts get the classic prompt-driven TUI automatically.
- **Preflight + receipts** — `maestro doctor` checks Node, provider CLIs,
  herdr, and `.maestro` state before anything runs; every task run ends with a
  per-role summary (duration, output size, outcome).
- **Portable roles (MRC)** — author a role once as a unit
  (`.maestro/roles/*.md`, a superset of the Claude Code subagent frontmatter),
  or point a workflow role at an existing `.claude/agents/*.md` subagent or
  skill via `source`; Maestro normalizes all three into one role. Per-role
  `tools` allowlists are enforced where the provider supports it (Claude
  `--allowedTools`/`--disallowedTools`) and advisory elsewhere. See
  [docs/role-convention.md](docs/role-convention.md).
- **Workflow templates** — `maestro init --workflow extended|local|solo|triage|research`
  scaffolds ready-made pipelines: an all-local Ollama setup, an executor-only
  fast loop, a single-role classifier (`triage`), and a gather→synthesize
  `research` flow.
- **Import/export bundles** — package a workflow as a shareable bundle and
  import it elsewhere (with automatic backup of the existing workflow).
- **Security model** — host commands off by default, network binaries
  hard-denied even when allowlisted, secrets stripped from subprocess env, MCP
  file access path-traversal-guarded.
- **Interactive web dashboard** — `maestro serve` exposes a Linear-inspired
  browser UI at `http://localhost:<port>/`. Live-polls task state every 5 s,
  filter tabs (All / Running / Retrying / Completed), click any row for a
  detail panel, and trigger an orchestrator refresh — all without page reloads.
- **OpenTelemetry tracing** — set `OTEL_EXPORTER_OTLP_ENDPOINT` to export
  traces, spans, and auto-instrumented http/pg calls via OTLP. Zero overhead
  when the variable is unset.
- **Linear integration** — optional server mode polls Linear and dispatches
  issues automatically.

---

## Getting Started

### Requirements

| Requirement | Notes |
|---|---|
| **Linux or macOS** | Windows is not supported (Maestro relies on unix domain sockets and bash-spawned agent runners). On Windows, use [WSL2](https://learn.microsoft.com/windows/wsl/). |
| **Node.js ≥ 22.13** | Uses the built-in `node:sqlite` (`DatabaseSync`). Check with `node --version`. |
| **herdr** (optional) | Optional acceleration over the zero-dependency terminal-pane default. Install separately and the engine auto-selects it; `MAESTRO_BACKEND=terminal` forces the default. |
| **Provider CLIs** | At least one of `claude`, `codex`, `copilot`, `gemini`, `antigravity`, `ollama` — whichever you already have installed and authenticated. The default workflow uses `claude` (planner) and `codex` (executor + reviewer). |

### Installation

```bash
# Clone and install
git clone git@github.com:Xateh/maestro.git
cd maestro
npm install

# Verify
node bin/maestro.mjs status
```

**Global install (optional):**

```bash
npm link         # makes `maestro` available on PATH
maestro status
```

**As a nested package (monorepo):**

```bash
# From your project root
git clone git@github.com:Xateh/maestro.git
cd maestro && npm install && cd ..

# Add shim scripts to your root package.json:
# "maestro":     "node maestro/bin/maestro.mjs",
# "maestro:mcp": "node maestro/src/mcp/server.mjs"
```

### Quick Start

```bash
# Initialize .maestro/ in your project (config, workflow, dirs) + optional setup wizard
cd /path/to/your/project
maestro init

# Or pick a workflow template:
#   extended — adds a read-only System Evaluator + an `evaluate` audit mode
#   local    — all roles on ollama, zero cloud
#   solo     — executor only, fastest loop
maestro init --workflow extended

# Preflight: node version, provider CLIs, herdr, state dir, workflow, db
maestro doctor

# Create and run a task (planner → executor → reviewer)
maestro task "Add a /healthcheck endpoint to the Express app"

# Planner only — read the plan before anyone touches code
maestro task --plan-only "Refactor the authentication module"

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
the same tab, same context.

<!--
<div align="center">

<img src="docs/assets/doctor.svg" width="720" alt="maestro doctor preflight output checking Node, provider CLIs, herdr, and .maestro state." />

</div>
-->

---

## Usage

### Run Modes

| Mode | Flow | Command |
|---|---|---|
| `task` | planner → executor → reviewer | `maestro task "<prompt>"` |
| `plan-only` | planner only; stops at handoff | `maestro task --plan-only "<prompt>"` |
| `evaluate` | system evaluator only (extended template) | `maestro task --mode evaluate "<prompt>"` |
| server | polls Linear, auto-dispatches | `maestro serve [--config <path>] [--port <n>]` |

### CLI Commands

| Command | Purpose |
|---|---|
| `maestro task [flags] "<prompt>"` | Create and run a task |
| `maestro run-task <id>` | Re-run or continue an existing task |
| `maestro status` / `maestro inspect <id>` | List tasks / dump full task JSON |
| `maestro tui` | Interactive terminal UI |
| `maestro init` / `maestro doctor` | Scaffold `.maestro/` / preflight checks |
| `maestro message · approve · deny` | Answer or decide a waiting task |
| `maestro approve-action · deny-action · run-action · edit-action` | Manage pending action requests |
| `maestro retry · cancel · mark-done · extend-timeout` | Task lifecycle controls |
| `maestro project <subcommand>` | Multi-task project commands (worktrees) |
| `maestro setup <subcommand>` | Configure providers, keys, and imports |
| `maestro workflow <subcommand>` | Workflow file commands |
| `maestro role list · show · lint` | Inspect portable role units (`.maestro/roles`, `.claude/agents`, skills) |
| `maestro import-agent <path>` | Convert a `.claude/agents` subagent into a native role unit |
| `maestro export` / `maestro import <bundle>` | Share workflows as bundles |
| `maestro serve [--config <path>] [--port <n>]` | Server mode (Linear polling) |

Run `maestro help <command>` for flags and details, or see
[docs/cli.md](docs/cli.md) for the full reference.

The full-screen TUI (`maestro tui`) gives you a live task board and a workflow
graph screen (press `2`) that draws roles, handoff arrows, and event transitions.

<!--
<table align="center">
  <tr>
    <td align="center"><img src="docs/assets/tui-board.svg" width="400" alt="Maestro TUI task board with filter views and approve/deny keys." /><br/><sub>Task board</sub></td>
    <td align="center"><img src="docs/assets/tui-graph.svg" width="400" alt="Maestro TUI workflow graph showing roles, handoff arrows, and event transitions." /><br/><sub>Workflow graph (press <code>2</code>)</sub></td>
  </tr>
</table>
-->

### Providers

Default mapping: **planner = claude**, **executor = codex**, **reviewer = codex**.

| Provider | CLI binary | Plays best at |
|---|---|---|
| `claude` | `claude` | Planning, architecture, nuanced review — strong reasoning and instruction-following |
| `codex` | `codex` | Execution and editing — tight workspace integration, file writes, shell commands |
| `gemini` | `gemini` | Research-heavy planning — large context window, web-grounded tasks |
| `copilot` | `copilot` | Optional; good for teams already in the GitHub ecosystem |
| `antigravity` | `antigravity` | Optional; bring-your-own CLI |
| `ollama` | `ollama` | Fully local, offline-capable models — privacy-sensitive or air-gapped work. See [docs/local-llm.md](docs/local-llm.md) |

The default config also ships three **experimental** local providers (`pi`,
`hermes`, `openclaw`) preconfigured against the `custom` adapter — best-effort
templates to verify with `maestro setup local`, not first-class integrations.
`ollama` is the only built-in local adapter. See
[docs/local-llm.md](docs/local-llm.md#experimental-local-clis-pi-hermes-openclaw).

**Assign a provider to each role:** role → provider mapping lives in
`.maestro/workflow.json` (the `providers` block in `config.json` only *defines*
each provider's adapter, models, and aliases). Edit it live in `maestro tui`
(full-screen role editor), or by hand:

```jsonc
// .maestro/workflow.json — defaults shown; swap any provider
{
  "roles": {
    "planner":  { "provider": "claude", "alias": "claude" },  // plans + architecture
    "executor": { "provider": "codex",  "alias": "codex"  },  // writes and edits code
    "reviewer": { "provider": "codex",  "alias": "codex"  }   // reviews and approves
  }
}
```

Want Gemini's large context for planning? Set `planner.provider` to `gemini`.
Editing by hand replaces the whole file, so keep every role you want — the TUI
is the safe path. See [docs/configuration.md](docs/configuration.md) for the
full role schema.

**Terminal backend (the zero-dependency default):**

```bash
MAESTRO_BACKEND=terminal maestro task "..."
```

The terminal backend runs agents via direct `child_process.spawn` (no visible
panes) and is **the default** — a fresh install with nothing else on `PATH` uses
it automatically (with a one-line notice). [herdr](CREDITS.md#herdr) is an
**optional acceleration**: when its binary is found on `PATH`, the engine
auto-selects it to seat each step in a visible terminal pane. Set
`MAESTRO_BACKEND=terminal` to force the default even when herdr is installed.
The terminal backend is covered by its own CI lane (`npm run test:terminal`).

---

## Configuration

State and config live in `.maestro/` in your working directory (or override
with `--state-dir`):

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
decides when a task's terminal tab closes.

---

## MCP Integration

Maestro exposes eight read/create/validate tools via MCP stdio transport.

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
| `maestro_read_workflow` | Current `workflow.json` graph definition |
| `maestro_validate_workflow` | Validate a workflow definition before use |

Full schema: [src/mcp/SCHEMA.md](src/mcp/SCHEMA.md) ·
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
  reject IDs that do not match `^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$` and verify
  the resolved path stays inside `.maestro/`.
- **Config redaction.** `maestro_get_state` strips keys matching
  `*_key/*_token/*_secret/api_key/apikey/password/passwd` before returning
  config to MCP clients.
- **HTTP rate limiting + input validation.** The dashboard/API server applies a
  per-IP token-bucket limit (`429` + `Retry-After` when exceeded) and validates
  every route: identifiers are length-capped and charset-restricted, malformed
  encodings return `400`, and oversized bodies return `413`. Toggle with
  `MAESTRO_HTTP_RATELIMIT`.

Agents themselves run with your user's privileges — review what you approve.
See [SECURITY.md](SECURITY.md) for the vulnerability reporting policy.

---

## Web Dashboard

<!--
<div align="center">

<img src="docs/assets/dashboard.svg" width="800" alt="Maestro web dashboard with a live task board and All / Running / Retrying / Completed filter tabs." />

</div>
-->

When running `maestro serve`, Maestro starts an HTTP server (default port from
`config.json → server.port`). Visit `http://localhost:<port>/` for the dashboard:

- **Live task board** — auto-polls `/api/v1/state` every 5 s (active tasks) or
  30 s (idle). Updates sidebar counts, task rows, and token totals in-place.
- **Filter tabs** — All / Running / Retrying / Completed.
- **Detail panel** — click any row to fetch `/api/v1/<identifier>` and inspect
  full issue data: state, attempt, timestamps, description, priority, assignee.
  Copy JSON to clipboard or open the raw endpoint in a new tab.
- **Trigger Refresh** — sends `POST /api/v1/refresh` then polls immediately;
  button shows a spinner while in-flight.

The JSON API is also directly usable:

| Endpoint | Method | Description |
|---|---|---|
| `/api/v1/state` | GET | Full orchestrator snapshot |
| `/api/v1/<identifier>` | GET | Runtime details for one issue |
| `/api/v1/refresh` | POST | Force an immediate tick + Linear reconcile |

---

## Observability

Maestro emits OpenTelemetry traces when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
It is a **no-op** (zero overhead, zero imports) when the variable is absent.

```bash
# Export to a local Jaeger or Grafana Tempo collector
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 maestro serve
```

Auto-instrumented: `http`, `pg` (when using the PostgreSQL backend), `dns`.
Service name defaults to the package name (`maestro-orchestrator`); override
with `OTEL_SERVICE_NAME`.

---

## Known Limitations

Maestro is a capable local orchestrator. The following areas are not yet
implemented for production/enterprise deployments:

- **Authentication & RBAC:** Single-user design; no identity provider integration or role-based access control.
- **Secrets Management:** Relies on local CLIs for auth. No native HashiCorp Vault or AWS KMS integration.
- **Containerization:** No official Dockerfiles or Kubernetes Helm charts.

---

## Architecture

```mermaid
flowchart TD
    cli["bin/maestro.mjs<br/>CLI entry"] --> engine["LangGraph engine<br/>src/langgraph/"]
    engine --> nodes["role nodes<br/>planner · executor · reviewer"]
    nodes --> adapters["adapters<br/>src/adapters/"]
    adapters --> procs["provider subprocesses<br/>claude · codex · gemini · …"]

    engine -.-> db[("DB<br/>SQLite / Postgres")]
    nodes -.-> logs[("run logs<br/>.maestro/runs/")]
    procs -.-> herdr["herdr panes<br/>(default backend)"]
```

<details>
<summary>Full module tree</summary>

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
│   └─ claude · codex · copilot · gemini · antigravity · ollama
│
├─ src/setup/              init scaffolding, doctor, import/export, templates
├─ src/db/
│   ├─ store.mjs           SqliteTaskStore (node:sqlite, default)
│   └─ pg-store.mjs        PostgresTaskStore (pg pool, activated by DATABASE_URL)
├─ src/telemetry.mjs       OpenTelemetry SDK init (no-op unless OTEL_EXPORTER_OTLP_ENDPOINT set)
├─ src/herdr-client.mjs    JSON-RPC wrapper around herdr binary
├─ src/herdr-agent-runner.mjs  HerdrAgentRunner (default backend, tab lifecycle)
├─ src/agent-runner.mjs    TerminalAgentRunner (fallback backend)
├─ src/orchestrator.mjs    MaestroOrchestrator (server mode + tick loop)
├─ src/router.mjs          buildStepPrompt, evaluatePlannerDecision
├─ src/state-machine.mjs   Pure transition(state, event) → nextState
├─ src/task-store.mjs      LocalTaskStore + DEFAULT_WORKFLOW
├─ src/setup/server-config.mjs  resolveServerConfig, renderPrompt (server mode)
├─ src/task-graph-runner.mjs    TaskGraphRunner (issue → graph task adapter)
├─ src/workflow-validate.mjs  Workflow schema validation
├─ src/workspace.mjs       WorkspaceManager (git worktrees)
├─ src/markers.mjs         Pure parsers: HANDOFF/QUESTION/REVIEW/ACTION_REQUEST
├─ src/logger.mjs          StructuredLogger (logfmt, crash-safe)
├─ src/http-server.mjs     HTTP server: interactive dashboard (/) + JSON API (/api/v1/*)
├─ src/linear-tracker.mjs  Linear GraphQL issue fetcher
├─ src/tui.mjs + src/tui/  Interactive terminal UI (full-screen + classic)
└─ src/mcp/server.mjs      MCP stdio server (8 tools)
```

</details>

Full architecture documentation: [docs/architecture.md](docs/architecture.md)

---

## Environment Variables

<details>
<summary>Environment variables (full table)</summary>

| Variable | Default | Description |
|---|---|---|
| `MAESTRO_BACKEND` | auto (herdr when installed) | `"terminal"` to bypass herdr panes; without herdr on PATH, terminal is used automatically |
| `MAESTRO_ROOT` | cwd walk | Override runtime root (where `.maestro/` lives) |
| `MAESTRO_TUI_CLASSIC` | unset | `1` forces the classic prompt-driven TUI |
| `HERDR_BIN` | `"herdr"` | Path to the herdr binary |
| `HERDR_SOCKET_PATH` | `~/.config/herdr/herdr.sock` | herdr daemon socket |
| `DATABASE_URL` | unset | PostgreSQL connection string (`postgres://user:pass@host/db`). When set, Maestro uses PostgreSQL instead of SQLite for all task/handoff state. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | OTLP collector base URL (e.g. `http://localhost:4318`). Enables OpenTelemetry tracing. No-op when unset. |
| `OTEL_SERVICE_NAME` | `maestro-orchestrator` | Override the OTel service name reported in traces. |
| `MAESTRO_SECRET_PASSPHRASE` | unset | Unlocks the encrypted secret store (`secrets.local.enc.json`) without an interactive prompt. Real environment variables still take precedence. |
| `MAESTRO_OLLAMA_BIN` | `"ollama"` | Ollama binary or alias used by the `agent:ocr`/`agent:eval` helper scripts. |
| `MAESTRO_OLLAMA_MODEL` | `"llama3.2"` | Text model for the `agent:eval` helper script. |
| `MAESTRO_OLLAMA_VISION_MODEL` | `"llama3.2-vision"` | Vision model for the `agent:ocr` helper script (multimodal). |
| `HEADROOM_PROXY_URL` | `http://localhost:8787` | Headroom compression proxy endpoint used for prior-output context compaction. |
| `NO_COLOR` | unset | Set to any value to disable ANSI color in CLI/TUI output (honors the [NO_COLOR](https://no-color.org) standard). |
| `MAESTRO_HTTP_RATELIMIT` | on | Set to `off` to disable the dashboard/API per-IP rate limiter (reads ~120/min, writes ~12/min; `429` + `Retry-After` otherwise). |

</details>

---

## Development

```bash
npm test                # full suite — node --test, hermetic
npm run lint            # Biome (lint-only)
npm run test:coverage   # c8 coverage report
npm run test:enterprise # package + maestro + mcp suites in sequence
```

Tests use the Node.js built-in test runner. No API keys, no agent CLIs, no
herdr binary needed — stub runners and temp dirs all the way down. CI runs
lint, the test matrix (Node 22 and 24), coverage, and `npm audit` on every
push and pull request.

Releases are manual and documented in [RELEASING.md](RELEASING.md).

---

## Documentation

- [docs/architecture.md](docs/architecture.md) — module index, run flow, SQLite schema, extension recipes
- [docs/cli.md](docs/cli.md) — every command, flags, env vars
- [docs/configuration.md](docs/configuration.md) — `.maestro/` layout, config schema, provider setup, tab lifecycle
- [docs/import-export.md](docs/import-export.md) — workflow bundle format, export/import flow
- [docs/role-convention.md](docs/role-convention.md) — portable role units (MRC), tool allowlists, provider capability matrix
- [docs/local-llm.md](docs/local-llm.md) — fully local setup with Ollama
- [docs/mcp.md](docs/mcp.md) — MCP tools reference and registration
- [src/mcp/SCHEMA.md](src/mcp/SCHEMA.md) — raw MCP tool schema (kept in sync with `server.mjs`)
- [CHANGELOG.md](CHANGELOG.md) — release history ([Keep a Changelog](https://keepachangelog.com/) format)

---

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the
workflow, code style (Biome), and test expectations. Security issues should
follow the process in [SECURITY.md](SECURITY.md).

---

## Credits

See [CREDITS.md](CREDITS.md) for full acknowledgements:
[herdr](CREDITS.md#herdr) · [OpenAI Swarm (inspiration)](CREDITS.md#openai-swarm) · [LangGraph](CREDITS.md#langgraph----langchainlanggraph) · [MCP SDK](CREDITS.md#model-context-protocol-sdk----modelcontextprotocolsdk) · [OpenAI Codex CLI](CREDITS.md#openai-codex-cli----openaicodex) · [LiquidJS](CREDITS.md#liquidjs----liquidjs) · [yaml](CREDITS.md#yaml)

---

## License

[MIT](LICENSE) © 2026 Xateh
