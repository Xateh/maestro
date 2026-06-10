# Maestro TUI Review

Date: 2026-05-13

## Scope

This review covers the local `npm run maestro -- tui` path: task creation,
settings, task history, agent handoff, local state, error handling, and
responsiveness. It does not cover the older Linear polling service except where
the same local files are shared.

## Critical Findings And Fixes

### Responsiveness

Finding: submitted tasks previously ran inline inside the TUI loop. A long
Claude or Codex run blocked the menu, so the user could not inspect task
history, adjust settings, or start another task until the run finished.

Fix: task submission now starts a detached `run-task` child process after the
task id is created. The TUI prints `Task id: <task-id>`, reports that the task
started in the background, and returns to the main menu. Quitting the TUI does
not wait for or cancel the task; the task record remains inspectable through
Tasks or `npm run maestro -- status`.

Verification: `TUI starts submitted tasks in the background and returns to the
main menu` and `local TUI launches tasks in a detached runner so quit does not
await agents`.

### Multi-Agent Orchestration Visibility

Finding: the draft screen exposed planner/review toggles but did not preview
the resolved flow. Users had to infer whether Claude would run before Codex.

Fix: New Task asks for the task prompt first, then opens the draft screen with
settings and `Agent flow: ...`, resolved from the same router used by execution.
Examples include `planner:claude -> executor:codex -> reviewer:codex` and
`executor:codex`.

Verification: `new task flow asks for the task prompt before showing settings`
and `task draft previews the resolved multi-agent flow`.

### Page Orientation

Finding: the TUI used plain monochrome section labels, so it was hard to tell
whether the current input belonged to the main menu, new task draft, task list,
task detail, waiting question, or settings page.

Fix: every TUI page now starts with a consistent `== Page ==` header. Headers
use distinct ANSI colors when output is a TTY and fall back to plain text when
color is unavailable or `NO_COLOR` is set.

Verification: `TUI page headers are plain by default and colored when enabled`
and `TUI renders colored page headers on TTY output`.

### Planner Availability

Finding: when `planner:claude` was selected but the configured Claude command
was only a bash alias, direct `spawn(<command>)` could not resolve it and the
detached task failed immediately with `spawn <command> ENOENT`.

Fix: the TUI now preflights the configured Claude command before creating a
task whose resolved flow includes `planner:claude`. The preflight accepts both
executables and bash aliases/functions visible to `bash -ic`. Agent execution
also falls back to `bash -ic` for non-executable safe command names, with
arguments shell-quoted before launch. If neither lookup works, the TUI prompts
to skip Claude for that task. Accepting the default submits with `Claude plan:
off`; declining cancels submission so the user can fix Settings without adding
a doomed failed task.

Verification: `TUI prompts to skip unavailable Claude planner and submits
without planner`, `TUI cancels task submission when Claude planner is
unavailable and user refuses skip`, `TUI command availability check accepts
bash aliases from bashrc`, and `terminal agent runner runs configured bash
aliases through an interactive shell`.

### Running Step Observability

Finding: task records only showed completed steps. While an agent was running,
the Tasks page could show `running` without identifying which role was active.
Task ids were also long enough that manual inspection was awkward, and raw JSON
inspection made common status checks hard to scan.

Fix: local task execution now writes `active_step` before each agent starts and
clears it when the step completes. The Tasks page now uses a compact table:
numeric alias, colorized status when ANSI is available, human-readable created
timestamp, timestamp-free task display name, and a concise activity column. Each
view sorts newest tasks first. The default view is active work, and users can
switch to `active`, `needs-human`, `blocked`, `incomplete`, `failed`, `done`,
or `all` filters. The default inspection view is a readable summary with flow,
prompt, cwd, steps, logs, review fields, approvals, and errors. Raw JSON remains available with
`json <alias-or-id>`.

Verification: `local task CLI records the active agent step while it is running`
and `task selection accepts numeric aliases and unique id prefixes`, plus
`task list uses short display ids and a human timestamp column`, `task list
filters by view and sorts newest tasks first`, `task detail view defaults to a
clean summary instead of raw JSON`, `TUI tasks page can filter by failed tasks`,
and `TUI tasks page shows full JSON only when requested`.

### User Question Flow

Finding: agent runs had no clean way to pause for missing user context. A CLI
agent could only fail, guess, or block outside the Maestro task record.

Fix: planner, executor, and reviewer prompts now tell agents to emit
`MAESTRO_QUESTION: <question>` when they need user input. Maestro parses that
marker from plain output or JSON-line CLI output, records `active_question`,
marks the task `waiting_user`, and shows human-waiting tasks in the active task list.
Selecting a waiting task in the TUI prompts for an answer, stores it in
`question_answers`, marks the task `queued`, and resumes the same task in a
detached `run-task` child. Follow-up prompts include prior answers.

Verification: `local task CLI marks task waiting when an agent asks a Maestro
question` and `TUI answers waiting task questions by alias and resumes the
task`.

### Task List Defaults

Finding: task history was an undifferentiated list, so active work could be
buried under completed or failed records.

Fix: the Tasks page now defaults to active tasks (`waiting_user`,
`waiting_approval`, `running`, and `queued`), sorts newest first, and accepts
`needs-human`, `blocked`, `incomplete`, `failed`, `done`, and `all` filters. If
there are no task records at all, the TUI prints the empty state and returns to
the main menu immediately.

Verification: `task list defaults to active tasks and sorts waiting tasks
first`, `TUI tasks page defaults to active tasks and can switch to all tasks`,
and `TUI tasks page returns to main menu immediately when no tasks exist`.

### Reviewer Outcome Control

Finding: reviewer runs could say work was incomplete or blocked while the task
still ended as success because the lifecycle status was inferred from step
exit codes.

Fix: reviewer prompts now require a final `MAESTRO_REVIEW: {...}` marker.
Maestro validates the marker, stores the normalized verdict in `task.review`,
and applies one reducer for lifecycle status. Complete reviews become
`succeeded`; missing markers become `incomplete`; user questions become
`waiting_user`; approval gates become `waiting_approval`; external, repo, or
safety blockers become `waiting_user` with recovery options; and one safe
continuation can requeue the task with a bounded continuation prompt. The TUI
and local `approve`/`deny` commands record approval decisions; typed host
actions use explicit run/edit/deny controls and approval resumes through a
continuation prompt, not by executing reviewer-suggested commands directly.

Verification: reviewer outcome tests cover complete, missing marker, user gate,
approval gate, and one continuation.

### Task Identity Reliability

Finding: task ids were timestamp-and-slug based. Two tasks with the same prompt
created in the same second could collide and overwrite the previous task file.

Fix: task creation now appends numeric suffixes (`-2`, `-3`, ...) when a task id
already exists.

Verification: `local task store creates unique ids for duplicate prompts in the
same second`.

### Concurrent State Reliability

Finding: a responsive TUI can read task history while a background agent is
updating the same task file. Direct JSON writes can briefly expose a partial
file and crash the Tasks page with a parse error.

Fix: config and task JSON writes now use same-directory temp files followed by
atomic rename. Task history also reports unreadable legacy/corrupt task files as
`unreadable` rows instead of crashing the TUI.

Verification: `local task store reports unreadable task files without crashing
task history` and the responsive TUI smoke.

### Input Safety

Finding: invalid main-menu input fell back to quit. A typo could exit the TUI.

Fix: invalid main-menu input now prints `Unknown menu choice.` and stays in the
TUI.

Verification: `TUI invalid main menu choices do not quit the application`.

### Failure Reporting

Finding: task failures could be reported without a stable id in the TUI, making
it harder to inspect the failed record afterward.

Fix: failures carry `taskId` from the local runner, and the TUI reports
`Task <task-id> failed: ...`.

Verification: `local task CLI attaches task id when an agent step fails`, `TUI
task submission failure stays in the TUI instead of crashing`, and `TUI reports
background task failures after returning to the menu`.

### Large Prompt Reliability

Finding: reviewer prompts can include prior agent output. Passing those prompts
as process arguments can hit OS argument-size limits and produce `spawn E2BIG`.

Fix: Codex prompts are sent through stdin. Command logs record `stdin_bytes`
instead of embedding the prompt in argv.

Verification: `Codex adapter sends long prompts over stdin to avoid argv
limits` and `terminal agent runner writes command stdin and records only stdin
size`.

### Context Window Reliability

Finding: the 2026-05-14 repository review task failed after the planner and
executor succeeded because the reviewer received the full prior stdout logs in
its prompt. The reviewer command recorded `stdin_bytes: 1003085`; the prior
planner and executor stdout logs were 152629 bytes and 849969 bytes. Codex then
reported that it ran out of context and asked for a new thread.

Fix: prior agent output is now a bounded handoff, not a raw transcript dump.
Prompts include compacted head/tail excerpts, original byte counts, stdout and
stderr log paths, and an explicit compacted-output heading. If a step still
hits a context-window error, Maestro records the failed attempt as `retried`,
switches that same step to stricter compaction, and retries once automatically
without asking the user to rewrite the task.

Verification: `step prompts compact large prior outputs before review` and
`local task CLI auto-compacts and retries context-window failures`.

### Project Lifecycle Visibility

Finding: Maestro now owns project-level worktree lifecycles, but the TUI still
only exposed individual task history. Users could miss integration blockers,
path leases, dirty cleanup blockers, or agent-commit review states unless they
opened raw project JSON on disk.

Fix: the main menu now includes `Projects`. The page lists project status,
target branch, blockers, and aliases. Inspecting a project shows integration
branch/worktree, tasks, active path leases, merge blockers, and cleanup
blockers. Raw project JSON remains available with `json <alias-or-id>`.

Verification: `project list and detail views show lifecycle blockers` and
`TUI projects page lists and inspects project state`.

## Remaining Limits

- The TUI launches detached task runner processes, not a durable daemon. Reopen
  the TUI or use `status`/`inspect` to check tasks after quitting.
- Local agent steps are still sequential inside one task: optional Claude
  planner, Codex executor, optional Codex reviewer. Project path leases prevent
  unsafe overlapping write tasks from running as independent worktree tasks.
- The Tasks page is text-first. It is reliable and inspectable, but it is not a
  full curses-style live dashboard.
- Agent stdout is retained in full logs for auditability. The prompt handoff is
  bounded, but very large logs can still consume disk unless a future retention
  policy is added.
