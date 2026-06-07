# Symphony Architecture

## Overview

Symphony is a multi-agent orchestrator that maps a prompt to a
**planner → executor → reviewer** pipeline. It uses **LangGraph** as the sole flow engine —
LangGraph handles graph traversal and state but never makes model calls. All model calls happen
inside the agent CLI binaries (claude, codex, etc.) that Symphony launches as subprocesses.

```
symphony task "..."
       │
       ▼
  [bin/symphony.mjs] ─── parse args, resolve state dir
       │
       ▼
  [langgraph/engine.mjs] ─── runLangGraphTask()
       │
       ▼
  [langgraph/graph.mjs] ─── buildGraph(workflow.json)
    StateGraph:
      planner ──── done ────► executor ──── done ────► reviewer ──── done ────► $complete
         │                        │                        │
      $ask_user              $ask_user               $ask_user
         │                        │                        │
      (pause + wait)          (pause + wait)          (pause + wait)
```

---

## Module Index

### Entry & CLI

| File | Export | Purpose |
|---|---|---|
| `bin/symphony.mjs` | — | CLI entry (`#!/usr/bin/env node`). Parses commands, resolves `PACKAGE_ROOT` + `--state-dir`, dispatches to local commands or the LangGraph engine. |

### LangGraph Engine (`src/langgraph/`)

| File | Export | Purpose |
|---|---|---|
| `engine.mjs` | `runLangGraphTask()` | Top-level entry point for the LangGraph pipeline. Selects runner (herdr or terminal), builds the graph, runs it, persists to SQLite. |
| `graph.mjs` | `buildGraph()` | Constructs a LangGraph `StateGraph` from `workflow.json`: roles become nodes, transitions become conditional edges. |
| `nodes.mjs` | `makeRoleNode()` | Node factory. Builds a role's step prompt, invokes the agent runner, parses markers, records handoff. |
| `prompt.mjs` | `buildPromptFromHandoffs()` | Token-efficient prompt builder. Uses only typed `{ role, provider, payload }` handoffs — never re-sends raw stdout logs. |
| `state.mjs` | `SymphonyState` | LangGraph Annotation channel definitions. `priorHandoffs` accumulates across steps; other fields track task/step metadata. |

### Adapters (`src/adapters/`)

Pure functions returning `{ command, args, cwd, stdin }` — no I/O.

| File | Export | Purpose |
|---|---|---|
| `registry.mjs` | `resolveAdapter()` | Maps `built-in:<name>` IDs to builder functions. Supports a `custom` adapter with `{alias}/{model}/{effort}` template placeholders. |
| `claude.mjs` | `buildClaudeCommand()` | planner role → `--permission-mode plan`; executor/reviewer → `default`. |
| `codex.mjs` | `buildCodexCommand()` | `codex exec --json`; reviewer → read-only sandbox. |
| `copilot.mjs` | `buildCopilotCommand()` | Prompt via `-p` arg. |
| `gemini.mjs` | `buildGeminiCommand()` | Prompt via `-p` arg. |
| `antigravity.mjs` | `buildAntigravityCommand()` | Prompt via `-p` arg. |

### Agent Runners

| File | Export | Purpose |
|---|---|---|
| `src/herdr-agent-runner.mjs` | `HerdrAgentRunner` | **Default backend.** Runs each step in a herdr workspace → tab → pane. Polls `<role>.exit.txt` for completion. Cancels via `pane send-keys ctrl+c`. |
| `src/herdr-client.mjs` | `herdrCli()`, `ensureServer()` | JSON-RPC wrapper around the `herdr` CLI. Auto-starts `herdr server` if the socket is absent. |
| `src/agent-runner.mjs` | `TerminalAgentRunner`, `buildAgentCommand()` | Fallback backend (`SYMPHONY_BACKEND=terminal`). Direct `child_process.spawn`. Validates command name against `^[A-Za-z0-9_@%+=:,./-]+$`. Strips all env except `SYMPHONY_*` keys. |

### Persistence (`src/db/`)

| File | Export | Purpose |
|---|---|---|
| `store.mjs` | `SqliteTaskStore`, `openStore()` | SQLite-backed store using `node:sqlite` (`DatabaseSync`). DB at `.symphony/symphony.db`. Large logs stay on disk; DB stores paths. |

**SQLite schema:**

```sql
CREATE TABLE tasks (
  id         TEXT PRIMARY KEY,
  status     TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data       TEXT NOT NULL   -- full task JSON
);

CREATE TABLE handoffs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  role       TEXT NOT NULL,
  provider   TEXT NOT NULL,
  payload    TEXT NOT NULL,  -- compact typed handoff
  log_path   TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX handoffs_task_id ON handoffs(task_id);
CREATE INDEX tasks_status     ON tasks(status);
CREATE INDEX tasks_created_at ON tasks(created_at);
```

### Core Logic

| File | Export | Purpose |
|---|---|---|
| `src/orchestrator.mjs` | `SymphonyOrchestrator` | Top-level class for server mode: tick loop, Linear polling, task lifecycle coordination. |
| `src/router.mjs` | `buildStepPrompt()`, `evaluatePlannerDecision()`, `resolveAgentFlow()` | Builds per-role prompts from handoffs; evaluates planner output to decide next step. |
| `src/state-machine.mjs` | `transition(state, event)` | Pure next-state resolver. No I/O. Sink strings: `$halt`, `$ask_user`, `$complete`. |
| `src/task-store.mjs` | `LocalTaskStore`, `DEFAULT_WORKFLOW`, `DEFAULT_LOCAL_STATE_DIR` | Legacy JSON task files in `.symphony/tasks/*.json`. `DEFAULT_WORKFLOW` is the inline default `workflow.json` object. |
| `src/workflow.mjs` | `WorkflowStore`, `parseCliArgs()`, `renderPrompt()` | Loads and validates `workflow.json`; Liquid renders prompt templates. |
| `src/workspace.mjs` | `WorkspaceManager` | Git worktree creation, checkout, merge, cleanup. |
| `src/markers.mjs` | `parseAgentHandoff()`, `parseAgentQuestion()`, `parseReviewerOutput()`, `parseAgentActionRequests()` | Pure parsers for agent output markers. No I/O. Used by nodes.mjs and tests. |

### Support

| File | Export | Purpose |
|---|---|---|
| `src/http-server.mjs` | `startSymphonyHttpServer()` | Optional HTTP API at `/api/v1/state`, `/api/v1/state/:id`, `/api/v1/refresh`. Uses `node:http`. |
| `src/linear-tracker.mjs` | `LinearTrackerClient`, `normalizeLinearIssue()` | GraphQL Linear issue fetcher for server mode. |
| `src/logger.mjs` | `StructuredLogger`, `nullLogger` | Structured JSON logger. |
| `src/tui.mjs` + `src/tui-*.mjs` | `runSymphonyTui()` | Full interactive terminal UI. Provider/model/effort pickers, workflow editor, task browser. |
| `src/mcp/server.mjs` | — | MCP stdio server (7 tools). See [mcp.md](mcp.md). |

---

## Run Flow

```
1. npm run symphony task "..."
   → bin/symphony.mjs: parse CLI, inject --state-dir if local command
   → resolveWorkspaceLocalInvocation(): cwd = INIT_CWD / SYMPHONY_CALLER_CWD / processCwd

2. runLangGraphTask(taskId, prompt, opts):
   a. Open SqliteTaskStore at .symphony/symphony.db
   b. Create task record (status: queued)
   c. Load workflow.json → buildGraph()
   d. Select runner: HerdrAgentRunner (default) or TerminalAgentRunner

3. LangGraph graph execution (planner node):
   a. buildPromptFromHandoffs() → compact context (prior handoffs only)
   b. runner.runStep({ provider, role, prompt, cwd, logDir, options, env, providerDef }) → stdout log written to disk
   c. parseAgentHandoff(stdout) → { role, payload, ... }
   d. Record handoff in SQLite
   e. Return { event: "done" | "$ask_user" | "$halt" }

4. Graph edge resolves next node (executor):
   a. Prompt built from planner handoff payload (NOT from raw stdout)
   b. Repeat step 3 for executor, then reviewer

5. Terminal state ($complete / $halt / $ask_user):
   - $complete → task status: succeeded
   - $halt     → task status: failed
   - $ask_user → task status: waiting_user → resume via symphony message / approve / deny
```

### Continuation (approve / answer / continue)

When a task is resumed after an approval decision or question answer:
1. Both executor and reviewer handoffs are evicted from SQLite.
2. A continuation text ("Approval granted for: …") appears in `User resume directives` in both prompts.
3. Both roles re-run: executor acts on the directive; reviewer verifies.

---

## Marker Protocol

Agents signal intent to Symphony via structured markers embedded in stdout:

| Marker | Parser | Meaning |
|---|---|---|
| `SYMPHONY_HANDOFF: {...}` | `parseAgentHandoff()` | Role is done; typed payload for next role |
| `SYMPHONY_QUESTION: {...}` | `parseAgentQuestion()` | Agent needs user input; task suspends |
| `SYMPHONY_REVIEW: {...}` | `parseReviewerOutput()` | Reviewer's structured assessment |
| `SYMPHONY_ACTION_REQUEST: {...}` | `parseAgentActionRequests()` | Agent requests a host command |

---

## Extension Recipes

### Add a new provider

1. Create `src/adapters/<name>.mjs` exporting `buildNameCommand({ prompt, model, effort, permission, role })`.
2. Register in `src/adapters/registry.mjs`: add `"built-in:<name>": buildNameCommand` to `BUILTIN_ADAPTERS`.
3. Add default aliases/models/efforts to `DEFAULT_WORKFLOW.providers` in `src/task-store.mjs`.

### Add a new runner

Implement a class with:
```js
async runStep({ provider, role, prompt, cwd, logDir, options, env, providerDef }) {
  // returns: { status, stdout, stderr, stdoutPath, stderrPath, command, args }
}
```
Select it in `src/langgraph/engine.mjs` `_getRunner()`.

### Add a new MCP tool

1. Add tool definition to `TOOLS` array in `src/mcp/server.mjs`.
2. Add handler to `HANDLERS` map.
3. Update `src/mcp/SCHEMA.md` to match.

### Add a new workflow role / state

1. Edit `.symphony/workflow.json`: add a role entry and wire transitions.
2. Add a prompt template in `WORKFLOW.md` (or inline in `workflow.json`).
3. Update `src/router.mjs` `buildStepPrompt()` if the new role needs custom context injection.
