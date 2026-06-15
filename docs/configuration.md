# Maestro Configuration

## State Directory

Maestro reads and writes all persistent state to a `.maestro/` directory. The location is
resolved as follows (first match wins):

1. `--state-dir <path>` CLI flag
2. Walk up from the caller's cwd (`MAESTRO_CALLER_CWD` / `INIT_CWD` / `process.cwd()`)
   until an existing `.maestro/` directory is found — create one with `maestro init`
3. `PACKAGE_ROOT/.maestro` (fallback for local commands — `PACKAGE_ROOT` = directory above `bin/maestro.mjs`)
4. `MAESTRO_ROOT` env var (used by the MCP server to find the runtime project root)

`maestro init` scaffolds `.maestro/` in the current directory (default `config.json`,
`workflow.json`, state subdirectories, and a `.gitignore` for the machine-local files),
and always targets the caller's directory — never the package checkout.

> **Nested package note:** if you install Maestro as a subpackage (e.g. `workspace/maestro/`),
> run `maestro init` in the workspace (or pass `--state-dir` / set `MAESTRO_ROOT`) to target
> the workspace's `.maestro/`; without one, CLI invocations fall back to
> `workspace/maestro/.maestro`.

---

## `.maestro/` Layout

```
.maestro/
  config.json            # v2 — runtime provider and behaviour config (shareable)
  config.local.json      # machine-local overlay — personal aliases, detected models (never share)
  secrets.local.json     # API keys, mode 0600 (never share)
  workflow.json          # v1 — roles, transitions, prompt templates
  import-manifest.json   # imported sources + credits (see docs/import-export.md)
  imported/              # snapshots of sources imported with --copy
  prompts/               # instruction docs materialized from imported bundles
  .gitignore             # written by the importer; covers the local-only files
  maestro.db             # SQLite — tasks, handoffs (LangGraph engine, default backend)
  tasks/                 # legacy per-task JSON files (pre-LangGraph)
  runs/                  # per-run artifact directories
    <task-id>/
      planner.stdout.log
      planner.stderr.log
      planner.prompt.txt
      planner.exit.txt
      planner.command.json
      handoff.planner.json
      executor.stdout.log
      ...
  projects/              # project state JSON files
  patches/               # stored patch files
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
    // local agent runtimes (run `maestro setup local` to populate models):
    // ollama (built-in:ollama — `ollama run <model>`, prompt on stdin),
    // pi / hermes / openclaw (experimental custom command templates)
    "hermes": {
      "adapter": "custom",
      "custom": { "command_template": "{alias} --model {model}", "prompt_via": "stdin" },
      // optional per-provider env injected into the agent process at spawn
      // time; values are "$VAR" references resolved from the environment
      // (and .maestro/secrets.local.json) — never literals
      "env": { "OPENAI_API_KEY": "$OPENAI_API_KEY" }
    }
  },

  // Herdr terminal integration
  "herdr": {
    "close_tab_on": "success"     // "success" | "terminal" | "never"
  },

  // Server mode (maestro serve) — see "Server-mode Config" below
  "server": {
    "workflow": "default",        // named graph workflow to run per issue
    "port": 4000,                 // HTTP API port; null disables
    "tracker": { "kind": "linear", "api_key": "$LINEAR_API_KEY", "project_slug": "team" },
    "polling": { "interval_ms": 30000 },
    "workspace": { "root": "/maestro_workspaces" },
    "agent": { "max_concurrent_agents": 10, "stall_timeout_ms": 300000 },
    "intake_template": "..."      // Liquid → dispatched task prompt
  },

  // Security
  "host_command_allow": []        // exact basenames; network binaries hard-denied
}
```

### Server-mode Config

`maestro serve` polls a tracker and dispatches each eligible issue as a graph
task (the same LangGraph engine `maestro task` uses). All of its settings live
in the `server` block of `config.json`; the block is read **once** at startup
(edits require a restart). One graph task is created per issue, keyed by a
`source_issue_id` field so repeated polls re-run the same task rather than
duplicating it.

| Field | Meaning |
|---|---|
| `server.workflow` | Named graph workflow (`.maestro/workflows/<name>.json`) run for each dispatched issue. |
| `server.port` | HTTP API port; `null` disables the HTTP server. The `--port` flag overrides this. |
| `server.tracker` | `{ kind: "linear", endpoint?, api_key, project_slug, active_states?, terminal_states? }`. `api_key` accepts a `$VAR` reference. |
| `server.polling.interval_ms` | Poll cadence (default 30000). |
| `server.workspace.root` | Base dir for per-issue workspaces (`~`, `$VAR`, and relative paths expand). |
| `server.hooks` | `after_create` / `before_run` / `after_run` / `before_remove` shell hooks + `timeout_ms`. |
| `server.agent` | `max_concurrent_agents`, `max_turns`, `max_retry_backoff_ms`, `stall_timeout_ms`, `max_concurrent_agents_by_state`. |
| `server.intake_template` | Liquid template rendered into each dispatched task's prompt. Context: `{ issue, attempt }`. |

> **Migration:** earlier releases configured the server through a dispatch
> front-matter file. That file and its loader have been removed — move
> `tracker`/`polling`/`workspace`/`hooks`/`agent` under `server.*`, put the old
> prompt body in `server.intake_template`, and map
> `codex.stall_timeout_ms` → `server.agent.stall_timeout_ms`. The old `codex.*`
> sandbox keys are dropped (the graph engine's adapters own sandboxing). See the
> BREAKING entry in `CHANGELOG.md`.

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

### PostgreSQL Backend

By default Maestro stores all task and handoff state in SQLite
(`.maestro/maestro.db`). Set `DATABASE_URL` to a PostgreSQL connection string
to use PostgreSQL instead — useful for high-availability deployments where
multiple workers share a database, or for persisting state outside the project
directory.

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/maestro maestro serve
```

The schema is created automatically on first connection. Both backends expose
the same async API; no application code changes are needed to switch.

### Local Config Overlay — `config.local.json`

Machine-specific values (personal CLI aliases, locally detected models,
custom command-template tweaks) belong in `.maestro/config.local.json`. It
has the same shape as `config.json` (partial is fine) and is deep-merged
over it at read time: **objects merge, arrays and scalars replace**.

Writes to the shared config never persist overlay values back into
`config.json`, and export bundles always exclude the overlay — personal
aliases cannot leak into a repository or a shared bundle.

### Secrets — `secrets.local.json`

`maestro setup keys` stores key/value env pairs in
`.maestro/secrets.local.json` (chmod 0600). At startup they are loaded into
the process env with real environment variables taking precedence. Shareable
files reference them as `"$VAR"` strings (e.g. `tracker.api_key:
"$LINEAR_API_KEY"`, `providers.<p>.env`). The MCP server redacts
secret-shaped values (`*_key`, `*_token`, `*_secret`, …) on read.

#### Encrypted store (recommended)

Run `maestro setup keys --encrypt` to migrate the plaintext store to an
encrypted one at `.maestro/secrets.local.enc.json` (scrypt + AES-256-GCM, no
new dependencies). The plaintext `secrets.local.json` is shredded after a
successful migration; once encrypted, every subsequent `setup keys` write stays
encrypted.

The unlock passphrase lives in a **different trust domain than the ciphertext**
(that is the whole point of encryption at rest): resolution order is

1. `MAESTRO_SECRET_PASSPHRASE` in the environment (unattended runs, `serve`), then
2. *(future)* OS keyring, then
3. an interactive muted prompt when a TTY is attached.

At startup, if an encrypted store exists but no passphrase is available,
secrets are simply left unloaded (no error, no prompt) — commands that don't
need them run normally. A wrong passphrase or a tampered/malformed store is a
loud failure. `maestro doctor` reports the store mode (`encrypted` / `plaintext`)
without printing or prompting for anything.

#### Agent guardrail — `maestro setup harden`

`maestro setup harden` installs a Claude Code guardrail into
`~/.claude/settings.json` (use `--project` for the cwd's `.claude/settings.json`):
a `PreToolUse` Bash hook (backed by `scripts/secret-guard.mjs`) plus `deny`
rules that block any non-`maestro` command from reading or decrypting the secret
store. Commands unrelated to the store are untouched. Scope note: this hook only
constrains Claude Code — the **encryption above is the cross-process guarantee**;
the hook is defense-in-depth against the agent that drives maestro. Use
`--dry-run` to preview the target path.

### Planner Policy

| Value | Behaviour |
|---|---|
| `"auto"` | Planner runs on new tasks; skipped on retry if plan already exists |
| `"on"` | Planner always runs |
| `"off"` | Skip planner; go straight to executor |

---

## `workflow.json` (v2)

Defines the role graph loaded by LangGraph. The default workflow declares
`"version": 2`; v1 workflows remain valid (all v2 additions are optional). `maestro init --workflow <name>`
(or `maestro workflow use <name>` after init) writes a built-in template:

| Template | Pipeline |
|---|---|
| `default` | planner → executor → reviewer |
| `extended` | `default` + a read-only `system_evaluator` role the reviewer can escalate to, plus an `evaluate` mode that runs the evaluator standalone |
| `local` | `default` with every role on `ollama` (the executor keeps write permission) |
| `solo` | executor only; defines only the `task` mode, so `--plan-only` errors with `unknown_mode` |

Both `maestro import` and `maestro workflow use` back up the previous file to
`workflow.json.bak` before writing (`workflow use` fully replaces the file;
`import` merges).

### Named workflows (multi-workflow selection)

A single state dir can hold multiple named workflows under
`.maestro/workflows/<name>.json`, selectable per task. The legacy
`.maestro/workflow.json` is treated as the **`default`** workflow — there is no
forced migration, so existing setups keep working unchanged.

- Names must match `^[a-z0-9][a-z0-9_-]{0,63}$`.
- Precedence: if both `.maestro/workflows/default.json` and the legacy
  `.maestro/workflow.json` exist, the named file wins and a
  `workflow_precedence` warning is emitted so you can reconcile them.
- Create a named slot from a template with
  `maestro workflow use <template> --as <name>`, list them with
  `maestro workflow list`, and run one with `maestro task --workflow <name>`.
- A task records its workflow name in its task JSON (`workflow` field, default
  `"default"`). At run time an unknown non-`default` name surfaces a typed
  `unknown_workflow` blocker (the task waits for the user rather than falling
  back silently).

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
      "revise": "executor",        // custom event — agents route it via
                                   // MAESTRO_HANDOFF: {"event":"revise",...}
      "halt": "$halt",
      "ask_user": "$ask_user"
    }
  },
  // loop safety: cycles (like reviewer → executor above) should be bounded
  "loop_limits": {
    "default_max_visits": 3,       // applies to roles without their own max_visits
    "on_exceeded": "ask_user"      // "ask_user" (pause + question) | "halt"
  }
}
```

Per-role prompt templates live inline in `workflow.json` under
`roles.<role>.prompt_template` (Liquid syntax). See
[Custom Workflow Templates](#custom-workflow-templates) below.

### Role fields for imported/custom roles

| Field | Description |
|---|---|
| `max_visits` | Per-role visit cap per run (loops re-run roles) |
| `instructions` | Inline role instructions appended to the prompt |
| `instruction_paths` | Doc paths read at prompt time (16 KB/file, 64 KB total cap) |
| `source` | Attribution written by `setup import` (`kind`, `path`, `hash`, `imported_at`) |

Reserved events that handoff payloads may not redefine: `done`, `error`,
`question`, `waiting`, `needs_review`, `pause`. Custom events must be
declared in `transitions[role]` to be honored. Validate with
`maestro workflow validate` — unterminated cycles produce a warning with a
recommended termination clause. See [import-export.md](import-export.md).

### Stage I/O contracts (manifest v2)

A role may declare the structured-output schema its agent should emit. SP1
ships this vocabulary plus **soft** validation: a non-conforming payload is
recorded as evidence, never blocked, and routing is unaffected.

| Field | Description |
|---|---|
| `output_schema` | A built-in registry name (string) **or** an inline JSON Schema object (draft 2020-12). |
| `output_schema_ref` | A path, relative to the state dir, to a JSON Schema file. Must not be absolute or escape the state dir (`..`). |
| `gates` (top-level) | Quality gate declarations (defined and validated now; enforcement is a later sub-project). |

Resolution order when more than one is set: inline `output_schema` object >
`output_schema_ref` > `output_schema` registry name.

Built-in registry schema names: `implementation`, `static_analysis`, `review`,
`threat_model`, `edge_cases`, `tests`, `evaluation`, `regression`, `scoring`,
`stage_event`. Each is strict on required keys, value types and enums but
permissive on extra keys (`additionalProperties: true`).

```jsonc
{
  "version": 2,
  "roles": {
    "executor": { "output_schema": "implementation" },
    "auditor":  { "output_schema_ref": "schemas/audit.schema.json" }
  },
  "gates": {
    "min_coverage": 90,                  // number 0–100
    "no_high_severity_findings": true,   // boolean
    "all_regressions_pass": true,        // boolean
    "min_overall_confidence": 0.8        // number 0–1
  }
}
```

When an agent emits a `MAESTRO_HANDOFF` marker and its role resolves a schema,
Maestro records `schema_validation: { ok, errors, schema }` alongside the
handoff — in graph state (`priorHandoffs`), the `handoff.<role>.json` run-dir
file, and the database `handoffs` row. No marker emitted ⇒ no
`schema_validation` (nothing to check).

`maestro workflow validate` reports new codes: `unknown_output_schema` (string
name not in the registry), `bad_output_schema` (inline schema fails to compile,
or a bad `output_schema_ref` path), `bad_gates` (unknown gate key or
out-of-range/typed value), and a `missing_output_schema` warning for a role
whose name matches a verifier stage (review/threat_model/edge_cases/tests/
evaluation/regression) but declares no schema.

### Role `kind` and the verification pipeline (manifest v2)

Two additive role fields drive the SP2 verification spine:

| Field | Description |
|---|---|
| `kind` | `"agent"` (default; absent ⇒ agent) runs the role's provider as usual. `"stub"` skips provider resolution and the agent call entirely, emitting a minimal payload conforming to the role's `output_schema` (empty/zero values; first enum member for enum keys) with `event: "done"`. `"command"` (SP3) runs declared shell commands instead of an LLM (see below). Neither a stub nor a command role invokes a provider, so neither can fail on availability. |
| `verifies` | `true` marks the role a verification stage. Inert at runtime in SP2; it is read by the independence rule (below) and reserved for later scoring. |

For a role that is **not** planner/executor/reviewer (i.e. uses the generic
prompt), when it declares a resolvable `output_schema` Maestro renders that
schema's required-key skeleton plus any enum constraints into the
`MAESTRO_HANDOFF` example in the prompt, so verifier agents reliably emit
conforming JSON. Verifier roles can route work back for rework by emitting a
custom `event` (e.g. `"changes_requested"`) declared in their transitions.

`maestro workflow validate` adds the `non_independent_role` error: a single
role must not be both an implementation entry role (`initial` /
`modes.<mode>.initial`) and a verifier (`verifies: true`) — distinct roles ⇒
distinct sessions ⇒ independent verification by construction.

#### `full-audit-sweep` template

A built-in template wiring the full 9-stage pipeline:

```
implementation → static_analysis → review → threat_model → edge_cases
  → tests → evaluation → regression → human_approval ($complete)

rework loops (event: changes_requested):
  review / threat_model / edge_cases → implementation
```

`static_analysis` and `regression` are `kind: "stub"` pass-throughs (real logic
arrives in later sub-projects); `evaluation` is a `kind: "command"` stage (SP3,
below) shipped with an empty `commands: []` (a vacuous no-op until you populate
it); the rest are agent roles, each with an `output_schema`. Rework loops are
bounded by
`loop_limits.default_max_visits: 3` (escalates to the user on exceed).
`human_approval` summarizes the recorded artifacts for a human to inspect, then
completes.

It is **opt-in** (not scaffolded by `maestro init`). Install and run it with:

```sh
maestro workflow use full-audit-sweep --as full-audit-sweep
maestro task "…" --workflow full-audit-sweep
```

#### `kind: "command"` — the automated evaluation stage (SP3)

A `kind: "command"` role is a **non-LLM** stage that runs declared shell
commands in the task's working tree (`worktree_path ?? cwd`), collects their
results, and maps them to the `evaluation` schema `{pass_rate, failures,
coverage}`. It is evidence-gathering only — **no gating**: every command runs
and the stage always emits `event: "done"` (a failing command lowers
`pass_rate` but never halts the run). The agent runner is never invoked.

The role declares a `commands` array. Each command:

| Field | Required | Description |
|---|---|---|
| `name` | yes | Unique within the role. |
| `run` | yes | Shell string, executed via `sh -lc`. |
| `category` | no | Free-form label (e.g. `lint`, `typecheck`, `unit`, `integration`, `e2e`, `security`). Permissive — unknown values are not rejected. |
| `timeout_ms` | no | Per-command timeout. Falls back to `config.command_timeout_ms`, then `120000`. On timeout the child is killed (`SIGTERM`), `timed_out: true`. |
| `allow_failure` | no | `true` ⇒ the command still runs and is recorded, but is excluded from both `pass_rate` and `failures`. |
| `parser` | no | `{passed?, failed?, total?}` of regex strings (below). |

**`pass_rate` (hybrid).** Each non-`allow_failure` command contributes
`(passed, total)`:

- No parser, or parser did not produce a derivable total ⇒ exit-code
  granularity: `total = 1`, `passed = (exit_code === 0 && !timed_out &&
  !spawn_error) ? 1 : 0`.
- Parser produced counts ⇒ those `total`/`passed`.

`pass_rate = round4(Σpassed / Σtotal)`, defined as `1.0` when `Σtotal === 0`
(no commands). Empty `commands: []` ⇒ `pass_rate: 1.0`, `failures: []`.

**`parser` sufficiency rule (never fabricate a pass-rate).** The first capture
group of each regex is parsed as an integer against `stdout + "\n" + stderr`. A
total is used only when it is *derivable*: either a `total` regex matched, OR
**both** `passed` and `failed` matched (then `total = passed + failed`). A
parser that yields only `passed`, only `failed`, or nothing returns no counts —
the command falls back to exit-code granularity. (A failing run still lowers
`pass_rate` through its non-zero exit.)

**`failures[]`.** One entry per non-`allow_failure` command that did not fully
pass (`exit_code !== 0`, `timed_out`, a spawn error, or `parsed.passed <
parsed.total`): `{name, run, category, exit_code, signal, timed_out,
output_tail, parsed?}`. `output_tail` is the bounded combined output (last
`config.stream_tail_bytes` bytes, default 65536). A spawn error (missing `sh`,
bad cwd, thrown/absent runner) is captured as `exit_code: 127`.

**`coverage`** is always `{}` in SP3 (coverage parsing is a future concern).

Validation (`maestro workflow validate`) adds `bad_command_spec`: a command
missing a non-empty `name` or `run`, a duplicate `name`, or a non-array
`commands` is rejected. An empty `commands: []` is valid.

The shipped `full-audit-sweep` `evaluation` role declares `commands: []`, so the
default runner is never invoked by the shipped manifest until you opt in:

```jsonc
"evaluation": {
  "kind": "command",
  "output_schema": "evaluation",
  "commands": [
    { "name": "lint", "run": "npm run lint", "category": "lint" },
    { "name": "unit", "run": "npm test", "category": "unit",
      "parser": { "passed": "# pass (\\d+)", "failed": "# fail (\\d+)" } }
  ]
}
```

Relevant config knobs (both optional, read with fallbacks — neither is added to
the default config): `command_timeout_ms` (default `120000`) and
`stream_tail_bytes` (default `65536`, already used for agent output).

### YAML authoring

A workflow may be authored in YAML instead of JSON:
`.maestro/workflows/<name>.yaml` (named) or `.maestro/workflow.yaml` (default).
`readWorkflow()` normalizes YAML to the same in-memory shape as the JSON
equivalent. JSON remains canonical: when both a `.json` and `.yaml` exist for
the same slot, the JSON wins and a `workflow_format_precedence` warning is
emitted. Writers (`writeWorkflow`, templates) keep writing JSON.

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

### Local LLMs (Ollama)

The `built-in:ollama` adapter dispatches a fully local model — no API key, no
network. It runs `ollama run <model>` with the prompt on stdin:

```jsonc
"ollama": {
  "label": "Ollama (local)",
  "adapter": "built-in:ollama",
  "default_alias": "ollama",
  "models": ["llama3.2", "qwen3", "llama3.2-vision"]
}
```

Assign it to any role (e.g. `reviewer`) in `workflow.json` or the TUI. Other
local runtimes (LM Studio, llama.cpp) work through the `custom` adapter.
Full guide: [local-llm.md](local-llm.md).

---

## Custom Workflow Templates

Override the default prompt for any role by editing `workflow.json` `roles.<role>.prompt_template`.
Templates are rendered with
[LiquidJS](https://liquidjs.com) and receive context variables:

| Variable | Description |
|---|---|
| `task.prompt` | Original task prompt |
| `task.id` | Task ID |
| `priorHandoffs` | Array of typed handoffs from previous roles |
| `userDirectives` | Resume directives (answers, approval text) |
| `stepIndex` | Zero-based step counter |
