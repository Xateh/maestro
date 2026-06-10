# Maestro Configuration

## State Directory

Maestro reads and writes all persistent state to a `.maestro/` directory. The location is
resolved as follows (first match wins):

1. `--state-dir <path>` CLI flag
2. `PACKAGE_ROOT/.maestro` (default for local commands — `PACKAGE_ROOT` = directory above `bin/maestro.mjs`)
3. `MAESTRO_ROOT` env var (used by the MCP server to find the runtime project root)
4. Walk up from `process.cwd()` until a `.maestro/` directory is found (MCP server discovery)

> **Nested package note:** if you install Maestro as a subpackage (e.g. `workspace/maestro/`),
> the default state dir for CLI invocations is `workspace/maestro/.maestro`. The workspace's
> existing `.maestro/` state is unaffected. To target the workspace state, pass
> `--state-dir /path/to/workspace/.maestro` or set `MAESTRO_ROOT`.

---

## `.maestro/` Layout

```
.maestro/
  config.json       # v2 — runtime provider and behaviour config
  workflow.json     # v1 — roles, transitions, prompt templates
  maestro.db       # SQLite — tasks, handoffs (LangGraph engine)
  tasks/            # legacy per-task JSON files (pre-LangGraph)
  runs/             # per-run artifact directories
    <task-id>/
      planner.stdout.log
      planner.stderr.log
      planner.prompt.txt
      planner.exit.txt
      planner.command.json
      handoff.planner.json
      executor.stdout.log
      ...
  projects/         # project state JSON files
  patches/          # stored patch files
```

---

## `config.json` (v2)

Key fields:

```jsonc
{
  "version": 2,
  "cwd": "/path/to/project",
  "planner_policy": "auto",       // "auto" | "on" | "off"
  "review_enabled": true,
  "timeout_ms": 300000,
  "max_steps": 10,
  "default_role": "executor",
  "stale_after_ms": 86400000,
  "stream_tail_bytes": 8192,
  "context_retry_limit": 3,

  // Worktree settings
  "worktree_root": ".maestro/worktrees",
  "worktree_mode_default": "none",  // "none" | "isolated" | "shared"
  "max_parallel_worktrees": 4,
  "project_close_merge_mode": "squash",
  "delete_closed_project_branches": false,

  // Provider configuration
  "providers": {
    "claude": {
      "label": "Claude",
      "adapter": "built-in:claude",
      "default_alias": "claude",
      "aliases": { "claude": "claude", "opus": "claude-opus-4-8" },
      "models": ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
      "efforts": ["low", "medium", "high"]
    },
    "codex": {
      "label": "Codex",
      "adapter": "built-in:codex",
      "default_alias": "codex",
      "aliases": {},
      "models": [],
      "efforts": ["low", "medium", "high"]
    }
    // ...copilot, gemini, antigravity
  },

  // Herdr terminal integration
  "herdr": {
    "close_tab_on": "success"     // "success" | "terminal" | "never"
  },

  // Security
  "host_command_allow": []        // exact basenames; network binaries hard-denied
}
```

### Herdr Tab Lifecycle

Each task gets one herdr tab (label `mae:<taskId>`); all agent panes for the
task open inside it. The tab id is persisted on the task (`herdr_tab_id`), so
a resumed task reuses its original tab — the conversation stays in one place
instead of spawning blank new tabs.

`herdr.close_tab_on` controls when Maestro closes the tab:

| Value | Behaviour |
|---|---|
| `"success"` (default) | Close when the task reaches `succeeded`. Failed and waiting tasks keep their tab as a trail. |
| `"terminal"` | Close on `succeeded` and `failed`. Note: hard agent failures currently park the task in `waiting_user` (tab kept), so today this behaves like `"success"`; the distinction is reserved for a future failed terminal state. |
| `"never"` | Never close tabs automatically. |

Tabs are **never** closed while a task is `waiting_user`, `waiting_approval`,
or `needs_review` — the conversation stays visible until the task resumes,
and the resume lands in the same tab (verified via `herdr tab get`; recreated
if the tab was closed manually).

### Planner Policy

| Value | Behaviour |
|---|---|
| `"auto"` | Planner runs on new tasks; skipped on retry if plan already exists |
| `"on"` | Planner always runs |
| `"off"` | Skip planner; go straight to executor |

---

## `workflow.json` (v1)

Defines the role graph loaded by LangGraph:

```jsonc
{
  "version": 1,
  "initial": "planner",
  "roles": {
    "planner": {
      "provider": "claude",
      "alias": "claude",
      "model": "",
      "effort": "high",
      "permission": "plan",
      "prompt_template": "..."    // Liquid template; null = use default
    },
    "executor": {
      "provider": "codex",
      "alias": "codex",
      "model": "",
      "effort": "high",
      "permission": "workspace-write",
      "prompt_template": null
    },
    "reviewer": {
      "provider": "codex",
      "alias": "codex",
      "model": "",
      "effort": "medium",
      "permission": "read-only",
      "prompt_template": null
    }
  },
  "transitions": {
    "planner": {
      "done": "executor",
      "halt": "$halt",
      "ask_user": "$ask_user"
    },
    "executor": {
      "done": "reviewer",
      "halt": "$halt",
      "ask_user": "$ask_user"
    },
    "reviewer": {
      "done": "$complete",
      "halt": "$halt",
      "ask_user": "$ask_user"
    }
  }
}
```

The workflow can also be accompanied by a `WORKFLOW.md` file at the same path, which defines
per-role Liquid prompt templates in human-readable Markdown.

---

## Provider Adapters

Each provider entry in `config.json` references a built-in adapter (`"built-in:claude"`) or a
custom adapter:

```jsonc
{
  "adapter": "custom",
  "command_template": "myagent --role {role} --model {model}",
  "prompt_via": "stdin"   // or "arg" with {prompt} in command_template
}
```

Supported `{placeholders}`: `alias`, `model`, `effort`, `role`, `permission`, `prompt`.

---

## Custom Workflow Templates

Override the default prompt for any role by editing `workflow.json` `roles.<role>.prompt_template`
or by defining a `## <Role>` section in `WORKFLOW.md`. Templates are rendered with
[LiquidJS](https://liquidjs.com) and receive context variables:

| Variable | Description |
|---|---|
| `task.prompt` | Original task prompt |
| `task.id` | Task ID |
| `priorHandoffs` | Array of typed handoffs from previous roles |
| `userDirectives` | Resume directives (answers, approval text) |
| `stepIndex` | Zero-based step counter |
