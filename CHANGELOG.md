# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed (BREAKING)

- **Dispatch consolidation & WORKFLOW.md removal (SP0b)** — the server (Linear
  poll → auto-dispatch) now runs issues through the *same* LangGraph task engine
  as `maestro task`. The standalone dispatch front-matter file and its bespoke
  Codex client are gone; configuration moves into `config.json`'s `server`
  block, and dispatched issues become graph tasks (one per issue, idempotent via
  a new `source_issue_id` field).
  - **Removed:** the dispatch front-matter file and its loader (`src/workflow.mjs`),
    the dispatch-only Codex client (`src/codex-client.mjs`), the
    `--workflow-path` flag, the positional dispatch-file argument to
    `maestro serve`, and the deprecated `maestro <file>.md` entry point.
  - **`maestro serve` surface:** now `maestro serve [--config <path>]
    [--state-dir <dir>] [--port <n>]` only. The tracker/workspace/agent settings
    come from `config.json`.
  - **Live config reload dropped:** `config.json` is read once at server start;
    changes require a restart.
  - **Cancellation is bookkeeping-only:** a terminal/stalled issue clears the
    orchestrator's running/retry maps; an in-flight graph run is left to finish
    (real mid-run engine cancellation is deferred).
  - **MCP `maestro_read_workflow`** no longer returns `workflow_md` (only
    `workflow_json`). Export bundles no longer include a dispatch front-matter
    file.
  - **Migration (manual):** move your old dispatch front-matter into
    `config.json` under `server`:

    | Old front-matter           | New `config.json` location                  |
    | -------------------------- | ------------------------------------------- |
    | `tracker.*`                | `server.tracker.*`                          |
    | `polling.*`                | `server.polling.*`                          |
    | `workspace.*`              | `server.workspace.*`                        |
    | `hooks.*`                  | `server.hooks.*`                            |
    | `agent.*`                  | `server.agent.*`                            |
    | `codex.stall_timeout_ms`   | `server.agent.stall_timeout_ms`             |
    | `codex.*` (sandbox)        | **dropped** (graph engine adapters own sandboxing) |
    | prompt body (Markdown)     | `server.intake_template` (Liquid string)    |
    | *(new)*                    | `server.workflow` (named graph workflow to run) |

### Added

- **Multi-workflow selection (SP0a)** — a single state dir can hold multiple
  named workflows under `.maestro/workflows/<name>.json`, selectable per task.
  The legacy `.maestro/workflow.json` is treated as the `default` workflow (no
  forced migration; named `default.json` takes precedence with a
  `workflow_precedence` warning when both exist).
  - Store API: `readWorkflow(name)`, `writeWorkflow(name, workflow)` (back-compat
    single-arg default write retained), `listWorkflows()`,
    `applyWorkflowTemplate({name, as})`, plus `isValidWorkflowName` and the
    `^[a-z0-9][a-z0-9_-]{0,63}$` name rule.
  - Tasks carry a `workflow` field (default `"default"`); the engine loads the
    selected workflow and surfaces a typed `unknown_workflow` blocker for an
    unknown name instead of falling back silently.
  - CLI: `maestro task --workflow <name>`, `maestro workflow list`, and
    `maestro workflow use <name> --as <slot>`.
  - MCP: optional `workflow` param on `maestro_create_task` (name shape
    validated; existence checked by the spawned CLI).
  - TUI: workflow picker on task creation and a workflows list/edit view
    (defaults to `default`).

## [0.1.0] - 2026-06-14

Initial release.

### Added

- Plan → execute → review pipeline driven by a LangGraph state graph, with
  typed handoffs between roles (raw agent logs never re-enter prompt context).
- Six provider backends: claude, codex, copilot, gemini, antigravity, and a
  built-in ollama adapter for fully local models.
- Herdr terminal integration: one tab per task, agents run in visible panes.
  Tabs close automatically on success, persist as a conversation trail while a
  task waits on the user, and are reused when the task resumes
  (`herdr.close_tab_on`: `success` | `terminal` | `never`).
- **Dual-backend persistence** — SQLite task store (`node:sqlite`) by default,
  or PostgreSQL when `DATABASE_URL=postgres://…` is set. `openStore()` routes to
  `PostgresTaskStore` (`pg` pool) automatically; both backends share an
  identical schema and a uniform async store interface. JSON-file mirror kept
  for legacy readers.
- **Encrypted secret store** — `maestro setup keys --encrypt` migrates
  `.maestro/secrets.local.json` to an encrypted `secrets.local.enc.json`
  (scrypt + AES-256-GCM, zero new deps) and shreds the plaintext. Unlock with
  `MAESTRO_SECRET_PASSPHRASE` or an interactive prompt; real env vars still win.
  `maestro doctor` reports the store mode. `maestro setup harden` installs a
  Claude Code guardrail (PreToolUse hook + deny rules) so only maestro reads its
  secrets. See `docs/configuration.md` § Secrets.
- **OpenTelemetry tracing** — set `OTEL_EXPORTER_OTLP_ENDPOINT` to export
  traces and spans via OTLP/HTTP proto. Auto-instruments `http`, `pg`, and
  `dns`. Completely zero-overhead (no imports, no SDK init) when the env var
  is absent. Override the service name with `OTEL_SERVICE_NAME`.
- MCP server exposing eight `maestro_*` tools for agent callbacks.
- Interactive TUI (`maestro tui`) for reviewing, approving, and answering tasks.
- **Interactive web dashboard** — the HTTP server (`maestro serve`) serves a
  Linear-inspired browser UI at `/`:
  - Live task board polling `/api/v1/state` every 5 s (active) or 30 s (idle)
    with surgical DOM updates — no page reloads.
  - Filter tabs: All / Running / Retrying / Completed.
  - Click any row to open a slide-in detail panel that fetches
    `/api/v1/<identifier>`: shows issue state, attempt, timestamps,
    description, priority, assignee, and full JSON. Actions: Copy JSON,
    Raw endpoint link.
  - Trigger Refresh button (POST `/api/v1/refresh`) with loading spinner;
    Force-Poll button for immediate state sync.
  - Toast notifications and a live pulse indicator in the toolbar.
- Security model: host-command denylist, env secret stripping, path-traversal
  guards, config redaction.
- **HTTP endpoint hardening** — the dashboard/API server (`maestro serve`)
  applies a per-IP token-bucket rate limit (reads ~120/min, writes ~12/min;
  `429` + `Retry-After` when exceeded) and validates input on every route:
  issue identifiers are length-capped and charset-restricted (malformed input
  → `400` instead of `500`), and oversized `POST` bodies are rejected (`413`).
  Disable with `MAESTRO_HTTP_RATELIMIT=off`. MCP tool inputs (ids, prompt,
  status, mode) gained matching length/type validation.
- Headroom context compression for prior-output pipelines.
- Linear tracker integration (server mode).
- GitHub Actions CI: lint (Biome), test matrix (Node 22/24 on Linux plus a
  macOS leg), coverage (c8) with an enforced threshold gate, dependency
  audit; Dependabot for npm and Actions updates.
- `maestro init --workflow <name>` workflow templates: `default` (planner →
  executor → reviewer) and `extended`, which adds a read-only System
  Evaluator role — the reviewer can escalate hard cases via
  `MAESTRO_HANDOFF: {"event":"escalate",...}`, and
  `maestro task --mode evaluate` runs a standalone principal-level audit.
- Two more workflow templates: `local` (every role on ollama, zero cloud) and
  `solo` (executor only, fastest loop).
- `maestro workflow use <name>` — switch `workflow.json` to any built-in
  template; the previous file is always backed up to `workflow.json.bak`.
- `maestro doctor [--json]` — read-only preflight: node version, provider CLI
  presence + versions, herdr availability, and state-dir health (config,
  workflow validation, db, secret store mode). Exit 1 on any failing check.
- Automatic herdr → terminal backend fallback: when the herdr binary isn't on
  PATH, tasks run on the terminal backend with a one-line notice instead of
  failing (`MAESTRO_BACKEND=terminal` still forces/silences it).
- End-of-run summary: after `maestro task` / `run-task`, a per-role table
  with duration, stdout size, and status; steps now persist `started_at`
  alongside `completed_at`.
- npm publish metadata (`repository`, `license`, `author`, `keywords`,
  `prepublishOnly`) and a `RELEASING.md` release checklist.
- Tag-triggered GitHub Release workflow: pushing `vX.Y.Z` lints, tests,
  verifies the tag against `package.json`, and publishes a Release with the
  matching changelog section and the packed tarball (npm publish stays
  manual).
- Community health files: issue forms, Contributor Covenant 2.1 code of
  conduct, CODEOWNERS, and a documented platform policy (Linux/macOS;
  Windows via WSL2).

### Changed

- Project renamed from Symphony to Maestro.
- `maestro task --plan-only` now errors with `unknown_mode` when the workflow
  defines no `plan-only` mode (previously it silently fell back to
  `workflow.initial` and ran a full write-enabled pipeline).
- The init wizard prints a one-line explainer before each setup question.
- Full-screen TUI (`maestro tui` on a real terminal): keyboard-driven task
  board with filter views and live refresh, task detail with one-keystroke
  approve/deny/message/retry/cancel/mark-done/resume/extend, a settings
  editor, and a workflow graph screen that renders roles, handoff arrows, and
  event transitions as a responsive grid (vertical stack on narrow
  terminals). The classic prompt-driven TUI remains the fallback for non-TTY
  use and via `MAESTRO_TUI_CLASSIC=1`.
- `--help` / `-h` / `help` CLI usage output.
- `bin/maestro.mjs` is now a thin entry shim; the CLI implementation lives in
  `src/cli/` modules (no behavior or public-surface change).

### Fixed

- MCP server no longer throws at import time when no `.maestro` directory
  exists up-tree; root discovery is lazy and errors surface on first tool call.
- The `node:sqlite` ExperimentalWarning is no longer printed on every CLI and
  MCP server run; other process warnings still pass through.
- Captured agent stdout/stderr are stripped of ANSI/VT control sequences before
  entering handoff payloads and the console (on-disk logs stay raw), so CLIs
  that redraw streaming progress no longer leak cursor-move escapes.
- `scripts/` is now included in the published package, so `maestro setup harden`
  (which installs a hook backed by `scripts/secret-guard.mjs`), the
  `agent:ocr` / `agent:eval` example agents, and `headroom:setup` work from an
  installed package instead of only from a git clone.
- The `agent:ocr` / `agent:eval` scripts fail fast with an install hint when the
  Ollama binary is absent, instead of surfacing a raw spawn error mid-run.

[0.1.0]: https://github.com/Xateh/maestro/releases/tag/v0.1.0
