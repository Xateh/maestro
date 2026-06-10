# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
