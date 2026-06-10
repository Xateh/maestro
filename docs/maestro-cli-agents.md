# Maestro CLI Agents

Maestro is the repo-local terminal orchestration layer for CLI coding agents.
It keeps Codex as the main delegator, uses Claude for planning, and uses Codex
for execution and review. Copilot is disabled by default until a concrete role
is chosen.

## Default Flow

```text
user task -> Codex planner decision -> optional Claude planner -> Codex executor -> optional Codex reviewer
```

- Claude plans only when Codex decides planning is useful, or when the user forces it on.
  It runs with `--permission-mode plan` and should not edit files.
- Codex executes with `codex exec --json -c approval_policy="never" --sandbox workspace-write`.
- Codex reviews with `codex exec --json -c approval_policy="never" --sandbox read-only`.
- Copilot is disabled. The adapter exists so a future role can be added without
  changing the task platform shape.

Planner policy:

```text
Claude plan: auto | on | off
```

- `auto`: Codex introduces Claude for architecture, design, refactor, security,
  workflow, UI/TUI, settings, tests, contract, migration, or other broad tasks.
- `on`: always ask Claude to plan first.
- `off`: skip Claude and execute directly with Codex.

## Commands

Open the terminal UI:

```bash
npm run maestro -- tui
```

The TUI has pages for:

- new task entry that asks for the task prompt first, then opens a draft picker
  for cwd, mode, Claude plan policy, review toggle, timeout, resolved
  agent-flow preview, `s. Submit task`, and `b. Back`
- task history that opens on active tasks sorted newest first, can switch to
  `active`, `needs-human`, `blocked`, `incomplete`, `failed`, `done`, or `all`, and shows a
  compact table with numeric aliases, colored statuses when the terminal
  supports ANSI, human-readable created timestamps, shortened task names
  without the timestamp prefix, and concise activity
- settings picker that lists current values first, then lets you edit one
  setting at a time
- projects page that lists Maestro-owned projects, blockers, path leases,
  cleanup blockers, and integration worktrees

Each page starts with a colored header when ANSI color is available, so main
menu, new task, task list, project list, detail, question, and settings screens
are visually distinct. Set `NO_COLOR=1` to keep plain text headers.

After you submit a task, the TUI prints `Task id: <task-id>`, starts the run in
a detached background runner, and returns to the main menu. Quitting the TUI does
not wait for or cancel the task. Reopen Tasks, or run `npm run maestro --
status`, to view status, active agent step, completed steps, and log paths.
The Tasks page lists aliases like `1. <task-id>` so you can inspect a task by
entering `1`, `#1`, the full id, or a unique id prefix. It displays task names
without the leading `YYYYMMDD-HHMMSS-` timestamp, and puts the created time in
its own `Created` column. It defaults to active tasks (`waiting_user`,
`waiting_approval`, `running`, and `queued`) sorted newest first. It accepts
filter commands: `active`, `needs-human`, `blocked`, `incomplete`, `failed`,
`done`, and `all`.

Plain task inspection shows a readable summary:

```text
1
```

Use `json <alias-or-id>` when you need the full raw task record:

```text
json 1
```

If the resolved flow includes `planner:claude` but the configured Claude command
is neither an executable on `PATH` nor a bash alias/function visible to
`bash -ic`, Maestro prompts before creating the task:

```text
Claude planner command "pclaude" was not found. Skip Claude planner for this task? y|n [y]:
```

Press enter or `y` to submit the task with `Claude plan: off`; enter `n` to
cancel submission and fix the command in Settings. Wrapper commands such as
`pclaude` or `myclaude` may be real executables, bash functions, or bash
aliases loaded by your interactive bash startup files.

Agents can pause for user input by writing this marker in their output:

```text
MAESTRO_QUESTION: <question>
```

Maestro records the task as `waiting_user`, stores the active question in the task
JSON, and moves human-waiting tasks into the active task list. Open Tasks,
select the waiting task alias, enter the answer, and Maestro records the
answer, marks the task `queued`, and resumes it in a detached `run-task` child.
Future agent prompts include prior user answers so the same role can continue
with the missing context.

You can also add context from the CLI. If the task is already `running`, the
message is stored for the next continuation; detached agents do not receive live
chat.

```bash
npm run maestro -- message <task-id> --note "Use the v2 endpoint"
npm run maestro -- retry <task-id> --note "Environment is fixed"
npm run maestro -- retry <task-id> --force-parallel --note "I accept the path overlap"
npm run maestro -- extend-timeout <task-id> --timeout-ms -1 --note "Continue without the old timeout"
npm run maestro -- run-action <task-id> <action-id> --note "Run anyway after checking the changed state"
npm run maestro -- edit-action <task-id> <action-id> --args-json '["push","origin","main"]'
npm run maestro -- mark-done <task-id> [action-id] --note "I ran the blocked command manually"
npm run maestro -- mark-done <task-id> [action-id] --force --note "I verified this outside Maestro"
npm run maestro -- cancel <task-id> --note "No longer needed"
```

`mark-done` may omit the action id only when exactly one action request is
pending. If several actions are pending, Maestro keeps the task
`waiting_user` with a `manual_done_ambiguous` blocker until you name the action.
Manual completion is verified per action: local commit, merge, and pull actions
must show a changed `HEAD` and no obvious merge-conflict status; push and fetch
actions record only `manual_verified_local_state` because local state cannot
prove the remote operation happened. `--force` records `observed: false` and
`forced: true`, then resumes the task with the user's note.

Reviewer outcomes are structured. The reviewer must finish with one
`MAESTRO_REVIEW: {...}` JSON marker describing `completion_state`,
`required_action`, `risk_level`, `confidence`, `evidence`, `blockers`, and any
needed `required_user_input`, `approval_request`, or `continuation`. Maestro
treats reviewer output as untrusted advisory input: it validates enums and size
limits, reads only reviewer logs, prefers the last valid marker, and never runs
commands suggested by the reviewer. Missing or malformed markers become
`waiting_user` with `completion_state: "uncertain"` instead of false success.
Reviewers may include typed `action_requests` and `unblock_options`, but the
reducer owns the final task status and broker policy.

New task writes use these lifecycle statuses: `queued`, `running`,
`waiting_user`, `waiting_approval`, `needs_review`, `succeeded`,
`partial_success`, `incomplete`, `blocked`, `failed`, `cancelled`, and
`unreadable`. Older records such as `blocked_git_publish`, `merge_blocked`,
`queued_path_conflict`, and `needs-review-agent-commit` are still rendered by
the TUI, but new writes store the compact lifecycle status plus typed blockers
or `task.review` detail. New recoverable failures prefer `waiting_user` with
explicit unblock options; `blocked` is reserved for corrupt or unrepresentable
task records.

Approval gates can be resolved through Maestro without executing reviewer
commands directly:

```bash
npm run maestro -- approve <task-id> --note "user completed the gated action"
npm run maestro -- deny <task-id> --note "not safe to proceed"
npm run maestro -- approve-action <task-id> <action-id> --note "run it"
npm run maestro -- run-action <task-id> <action-id> --note "explicit run-anyway or external-cwd run"
npm run maestro -- edit-action <task-id> <action-id> --cwd ../repo --args-json '["push","origin","main"]'
npm run maestro -- deny-action <task-id> <action-id> --note "not safe"
```

Approval records are appended to `approval_decisions`. Approving requeues the
task with a bounded continuation prompt; denying marks it `incomplete`.
`approve` and `deny` are compatibility aliases for old `active_approval`
records. New host actions use `approve-action` and `deny-action`.
`run-action` is the explicit second approval path for stale-state overrides and
external-cwd actions. It still rejects unsafe argv and malformed host commands.
`edit-action` can replace cwd, typed Git argv, or host command details before
retrying.

The TUI exposes the same typed controls from task detail pages with open unblock
options:

```text
(a)pprove <action-id>
(x) run anyway <action-id>
(x) run outside sandbox <action-id>   # shown for external-cwd actions
(d)eny <action-id>
(e)dit <action-id>
(i)nstruct
(m)ark-done [action-id]
(mf)orce mark-done [action-id]
(t)imeout
(r)etry
(f)orce retry
(c)ancel
```

After a typed command, the TUI asks for an optional note and calls the same
local command handlers as the CLI.

Large-task handoffs are compacted before they are sent to the next agent.
Maestro keeps the full stdout and stderr logs on disk, but prompts include
only bounded head/tail excerpts plus original byte counts and log paths. This
prevents a verbose executor or planner from filling the reviewer context window
unnecessarily.

If an agent still reports a context-window failure, Maestro records the failed
attempt as `retried`, switches that step to a stricter compact handoff, and
retries once automatically. The task does not require the user to restate the
prompt. If the retry also fails, the task moves to `waiting_user` with retry,
instruct, and cancel options plus log paths for inspection.

Run a normal task:

```bash
npm run maestro -- task "Add berth ETA regression tests"
```

Tasks that ask a current-cwd Codex agent to `commit`, `merge`, `pull`, `fetch`,
or `push` pause before launch with status `waiting_approval` and typed
`action_requests`. Commit-then-push and similar multi-step Git intents are
brokered sequentially: Maestro creates only the next Git action, re-reads the
repository after a successful approval, then creates the next action request
from a fresh branch, `HEAD`, dirty-status, and remote snapshot. Codex local execution still runs with
`approval_policy="never"` inside a workspace sandbox; Maestro never trusts the
agent to perform host Git operations itself.

The host action broker supports typed Git actions (`git_commit`, `git_merge`,
`git_push`, `git_fetch`, and `git_pull`), explicit external-cwd Git actions
(`external_cwd_git`), and exact argv host commands (`host_command`). Git actions
record the expected cwd, branch, `HEAD`, dirty status hash, remote URL, and
normalized argument array. A harmless leading `git` token is stripped before
validation, so `["git","push","origin","main"]` becomes
`["push","origin","main"]`. If the repo snapshot or task generation changes,
`approve-action` refuses to run and leaves the action pending with
`stale_reason`; use `run-action` only when you intentionally accept that stale
state. The broker accepts only these exact Git
argument shapes:

```text
git_commit: ["commit", "-m", message]
git_merge:  ["merge", "--no-ff", sourceBranch]
git_push:   ["push", remote, branchOrHEAD]
git_fetch:  ["fetch", remote]
git_pull:   ["pull", "--ff-only", remote, branchOrHEAD]
```

Remote names may contain only letters, numbers, `.`, `_`, and `-`, and may not
start with `-`. Branch/ref tokens may contain only letters, numbers, `.`, `_`,
`/`, and `-`; they may not start with `-`, `+`, or `:`, and cannot include
`..`, `:`, or wildcard characters. Commit messages must be non-empty and cannot
contain NUL. Shell metacharacters inside the commit message stay inert because
the broker uses argv, not shell interpolation. The broker rejects every other
arg count or order, force flag, refspec mapping, wildcard, branch deletion, and
ambiguous action shape by keeping the task `waiting_user` with edit, manual,
retry, and cancel options. If the action cwd is outside the task cwd/worktree,
Maestro rewrites it as `external_cwd_git` and requires explicit `run-action`
or TUI `(x)` approval. Duplicate approvals for the same `task_id + action_id`
do not run twice.

`host_command` requests contain an exact command, argv array, cwd, optional env,
and optional timeout. They run only after user approval. Every host action result
records exit code, stdout/stderr log paths under `.maestro/runs`, duration,
cwd, command hash, and the user note; continuations get a compact stdout/stderr
summary plus full log paths.

Run planning only:

```bash
npm run maestro -- task --plan-only "Plan a safer production twin import flow"
```

Force or disable Claude planning:

```bash
npm run maestro -- task --planner on "Design a route migration"
npm run maestro -- task --planner off "Fix typo in README"
```

Disable Codex review for quick tasks:

```bash
npm run maestro -- task --review off "Update one docs sentence"
```

Disable the per-agent timeout with `-1`:

```bash
npm run maestro -- task --timeout-ms -1 "Run a long refactor"
npm run maestro -- extend-timeout <task-id> --timeout-ms -1 --note "continue"
```

`-1 disables timeout` in CLI task creation, TUI settings, and timeout recovery.

Set custom agent command names and per-step models in the TUI Settings page
when your wrappers are named differently or you want fixed models by role:

```json
{
  "claude_command": "pclaude",
  "codex_command": "mycodex",
  "planner_model": "opus",
  "claude_effort": "xhigh",
  "executor_model": "gpt-5.5",
  "executor_effort": "high",
  "reviewer_model": "gpt-5.4",
  "reviewer_effort": "low"
}
```

Leave a model value empty, or type `default`, `none`, or `-` in the settings
picker, to use the CLI default model for that step.

When you edit a model setting, the TUI lists numbered options first. You can
enter a number or type any model id:

```text
Claude planner models:
0. <cli default>
1. opus
2. sonnet
3. haiku

Claude effort levels:
0. <cli default>
1. low
2. medium
3. high
4. xhigh
5. max

Codex models:
0. <cli default>
1. gpt-5.5
2. gpt-5.4
3. gpt-5.4-mini
4. gpt-5.3-codex

Codex effort levels:
0. <cli default>
1. minimal
2. low
3. medium
4. high
5. xhigh
```

List local task records:

```bash
npm run maestro -- status
```

Inspect one task:

```bash
npm run maestro -- inspect <task-id>
```

Use a custom state directory:

```bash
npm run maestro -- task --state-dir /tmp/maestro-state "Review dashboard contracts"
```

Use a specific working directory:

```bash
npm run maestro -- task --cwd singapore-maritime-digital-twin "Patch map tests"
```

Create a project-backed worktree lifecycle:

```bash
npm run maestro -- project create alpha --target main
```

This refuses to start unless `.maestro/` is ignored, the target branch is
clean, project branch names are unused, and the configured
`max_parallel_worktrees` budget is available. Maestro owns only
`.maestro/worktrees/<project-id>/...`; it never mutates `.claude/worktrees`.
If a root `.env` file exists, Maestro reports it as `not_copied` and marks it
sensitive. Secrets are not copied into worktrees by default.

Run a task inside a project task branch/worktree:

```bash
npm run maestro -- task --project alpha --worktree-mode project-worktree \
  --paths maestro/bin/maestro.mjs "Patch Maestro worktree handling"
```

Project task branches use:

```text
maestro/<project-id>/integration
maestro/<project-id>/task/<task-alias>
```

Declared `--paths` become write leases. Overlapping project write tasks become
`waiting_user` with a `queued_path_conflict` blocker and retry/cancel unblock
options unless the task is created with explicit `--force-parallel`. Retrying a
path-conflicted task rechecks the current project leases; if the conflict
remains, the task stays waiting, and if the lease cleared Maestro creates the
missing task branch/worktree and project task record before acquiring leases and
running. `retry --force-parallel` clears the conflict and acquires the task's
leases even when another task still owns the same path. Agents receive only
Maestro metadata environment variables:

```text
MAESTRO_PROJECT_ID
MAESTRO_TASK_ID
MAESTRO_ROLE
MAESTRO_WORKTREE
MAESTRO_BRANCH
MAESTRO_STATE_DIR
```

Agents are instructed not to commit. Maestro records the task start `HEAD`;
if an agent moves `HEAD`, the task becomes `needs_review`, the
project gets an `agent_head_moved` blocker, and merge automation stops.

Close and cleanup a project:

```bash
npm run maestro -- project close alpha
npm run maestro -- project cleanup alpha
```

Close performs a squash merge of the integration branch into the target branch
and records the target merge commit in the project ledger. If the squash merge
conflicts, Maestro creates a `merge-fix` task and marks the project
`close_blocked`. Cleanup removes only clean `.maestro/worktrees` task
worktrees and only project-owned local branches. Dirty worktrees are preserved;
Maestro writes a patch under `.maestro/patches/` and marks
`cleanup_blocked`. After a recorded target squash merge, cleanup also removes
the clean integration worktree and local integration branch. Remote branches
are never deleted.

## Files Written

Runtime state is local and ignored by git:

```text
.maestro/tasks/<task-id>.json
.maestro/projects/<project-id>.json
.maestro/runs/<task-id>/<role>.stdout.log
.maestro/runs/<task-id>/<role>.stderr.log
.maestro/runs/<task-id>/<role>.command.json
.maestro/runs/<task-id>/handoff.<role>.json
.maestro/patches/<task-id>.patch
.maestro/worktrees/<project-id>/<task-alias>/
.maestro/config.json
```

The task JSON records status, prompt, cwd, active step, active question,
active approval, question answers, interactions, unblock options, action
requests, completed steps, providers, command
arguments, planner policy, planner decision, review setting, timeout, command
names, role models, blockers, `task.review`, and log paths. The run folder keeps
raw terminal output for audit and debugging. `MAESTRO_HANDOFF: {...}` lines are parsed into
`handoff.<role>.json`, including when they appear inside Codex JSON agent
messages; reviewer prompts use the structured handoff and log paths before
falling back to bounded stdout excerpts.

## Safety Defaults

- Existing repo instructions still apply through `AGENTS.md` and `CLAUDE.md`.
- Claude is planning-only by default.
- Codex execution is workspace-write, not full access.
- Codex review is read-only.
- Agent commands use argument arrays, not shell interpolation.
- Bash aliases/functions are supported through an interactive bash fallback
  when no executable command with that name exists. Arguments are shell-quoted
  before that fallback is used.
- Codex task prompts are sent through stdin instead of argv, so large planner
  or executor outputs do not hit OS argument-size limits.
- Generated runtime logs and worktrees live under `.maestro/` and are ignored.
- Current-cwd git publish tasks require explicit typed broker approval instead
  of trusting sandboxed agent success claims.
- Remote push is never automatic, and remote branch deletion is rejected.
- Project cleanup refuses to remove dirty worktrees and writes a patch path
  instead.

## Current Limits

- The local task command runs steps sequentially inside one task. Parallel
  safety is enforced at project path-lease boundaries.
- Linear-backed polling mode still exists as the original `WORKFLOW.md` service
  path.
- Copilot is present only as a disabled adapter.
- Local file sync profiles are configuration placeholders. `.env` requires
  explicit future approval before copying.
