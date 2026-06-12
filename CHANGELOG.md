# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
  workflow validation, db, secrets file mode). Exit 1 on any failing check.
- Automatic herdr → terminal backend fallback: when the herdr binary isn't on
  PATH, tasks run on the terminal backend with a one-line notice instead of
  failing (`MAESTRO_BACKEND=terminal` still forces/silences it).
- End-of-run summary: after `maestro task` / `run-task`, a per-role table
  with duration, stdout size, and status; steps now persist `started_at`
  alongside `completed_at`.
- npm publish metadata (`repository`, `license`, `author`, `keywords`,
  `prepublishOnly`) and a `RELEASING.md` manual release checklist.

### Changed

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

### Fixed

- MCP server no longer throws at import time when no `.maestro` directory
  exists up-tree; root discovery is lazy and errors surface on first tool call.

## [0.1.0] - 2026-06-10

Initial release.

### Added

- Plan → execute → review pipeline driven by a LangGraph state graph, with
  typed handoffs between roles (raw agent logs never re-enter prompt context).
- Five provider backends: claude, codex, copilot, gemini, antigravity.
- Herdr terminal integration: one tab per task, agents run in visible panes.
  Tabs close automatically on success, persist as a conversation trail while a
  task waits on the user, and are reused when the task resumes
  (`herdr.close_tab_on`: `success` | `terminal` | `never`).
- SQLite task store (`node:sqlite`) with JSON-file mirror for legacy readers.
- MCP server exposing seven `maestro_*` tools for agent callbacks.
- Interactive TUI (`maestro tui`) for reviewing, approving, and answering tasks.
- Security model: host-command denylist, env secret stripping, path-traversal
  guards, config redaction.
- Headroom context compression for prior-output pipelines.
- Linear tracker integration (server mode).
- GitHub Actions CI: lint (Biome), test matrix (Node 22/24), coverage (c8),
  dependency audit; Dependabot for npm and Actions updates.

### Changed

- Project renamed from Symphony to Maestro.

[0.1.0]: https://github.com/Xateh/maestro/releases/tag/v0.1.0
