# `maestro serve` — Multi-Service Management Design

**Date:** 2026-06-16
**Status:** Approved design, pending spec review
**Scope:** Turn `maestro serve` from a single foreground poller into a command group that manages multiple named, background-running services, with full CRUD + lifecycle control and a security model that withstands the project's existing trust assumptions (tracker issue → agent code execution).

---

## 1. Motivation

Today `maestro serve`:

- Runs **one** Linear tracker in the **foreground**, blocking the terminal until Ctrl-C.
- Surfaces no guidance on what it did or how to stop it.
- On a misconfigured tracker, fails with a bare `unsupported_tracker_kind: missing` (since improved to point at `maestro setup tracker`).

There is no concept of multiple services, no background execution, and no management surface (list/add/rm/edit/pause). This design adds one.

Non-goals: a central supervisor daemon, an OS service-manager integration (systemd/launchd), live config reload, or a remote/multi-host control plane. Those were considered and rejected for v1 (see §11).

---

## 2. Concepts

A **service** is a named overlay on the existing `server` config block. It binds a name to (at minimum) a tracker project slug, and optionally a port, workflow, api-key var, and workspace.

- **Definition** — a file `<state>/services/<name>.json` holding *only the overlay fields* (everything else inherits from the `server` block).
- **Worker** — a detached `node` process running `maestro serve run <name> --foreground`, which resolves the overlay and calls the existing `startMaestro(...)` poller unchanged.
- **Runtime record** — `<state>/services/<name>.pid`, written by the worker itself, holding `{pid, startTimeMs, argv0, port}` for identity-verified liveness.
- **Log** — `<state>/services/<name>.log`, the worker's redirected stdout/stderr.

### 2.1 Data layout

```
.maestro/
  config.json                     # unchanged; server.* = shared defaults
  services/                        # mode 0700
    web.json                       # definition (overlay), mode 0600
    web.pid                        # runtime record, mode 0600, written by worker
    web.log                        # worker stdout/stderr, mode 0600, O_NOFOLLOW
    web/                           # per-service isolated state dir (default; see §6)
      state.sqlite3 …
    infra.json
    infra.pid
    infra.log
    infra/
```

### 2.2 Definition schema (`<name>.json`)

```jsonc
{
  "slug": "WEB",                  // required: tracker project slug/key
  "port": 4100,                   // optional: HTTP dashboard port (1–65535, unique)
  "workflow": "default",          // optional: overrides server workflow
  "var": "LINEAR_API_KEY",        // optional: env-var NAME for the api key ($-ref only)
  "workspace": ".maestro/services/web/work", // optional: worktree root
  "shared_state": false,          // optional: opt-in to the shared task store (default false)
  "paused": false                 // lifecycle intent flag
}
```

A definition **never** stores a literal API key — only a `$VAR` reference name (`var`). The `api_key` field on the resolved config is always `"$" + var`.

---

## 3. Config resolution (overlay + inherit)

`resolveServiceConfig(name, { env, baseDir })`:

1. Read `config.json` → `server` block (shared defaults: polling, agent limits, hooks, tracker kind, default api-key var).
2. Read `<name>.json` overlay.
3. Deep-merge overlay onto `server` (overlay wins on `slug`, `port`, `workflow`, `var`, `workspace`).
4. Resolve `$VAR` references via the existing `resolveDollarValue`, **routed through `ENV_KEY_DENYLIST`** (agent-runner.mjs) so a definition cannot name `PATH`/`LD_*`/`NODE_OPTIONS`/etc. The `var` name must additionally match `^[A-Za-z_][A-Za-z0-9_]*$`.
5. Run the existing `resolveServerConfig` + `validateServerConfig` (whose tracker error messages already guide the user to `setup tracker`).
6. Default `workspace` and the task-store state dir to a **per-service isolated path** unless `shared_state: true` (see §6).

The worker process is given a **minimal constructed env** — the resolved (denylist-clean) secret(s) it needs plus `PATH` — not a blind `...process.env`. This bounds secret blast radius (H3).

---

## 4. Commands

`serve` becomes a subcommand group. Management subcommands route as `local`; only `serve run … --foreground` routes to the `server` runtime.

| Command | Kind | Behavior |
|---|---|---|
| `serve` (bare) / `serve list [--json]` | local | status table; guidance if no services; legacy auto-adopt notice (§7) |
| `serve add <name> --slug S [--port N --workflow W --var NAME --workspace DIR --shared-state]` | local | validate name + fields, write definition (0600); does **not** start; prints next step + warnings |
| `serve edit <name> [--slug … --port … …]` | local | patch definition; warn "restart to apply" if running |
| `serve rm <name> [--force]` | local | confirm/`--force` if running → stop, then delete the *three derived paths* for the validated name (never globs) + the per-service state dir |
| `serve start <name\|--all>` | local | spawn detached worker(s); skip already-running; `--all` skips paused; print pid/port/logs/stop hint |
| `serve stop <name\|--all>` | local | identity-verified SIGTERM → SIGKILL fallback; remove pid file; leaves `paused` untouched |
| `serve pause <name>` | local | stop + set `paused:true` |
| `serve resume <name>` | local | clear `paused` + start |
| `serve status <name>` | local | detail: state, pid, uptime, port, slug, log path |
| `serve logs <name> [-f] [-n N]` | local | tail worker log (O_NOFOLLOW open) |
| `serve run <name> [--foreground]` | server | **worker entrypoint**: resolve overlay, write own pid file, call `startMaestro`, install signal handlers, clean up pid on exit |
| `serve adopt [name]` | local | materialize legacy `server.tracker` into a definition; also recover orphaned workers (§8). Confirms before first start if config defines `hooks.*` (L1) |

---

## 5. Lifecycle & state

State is derived from the pid file + the `paused` flag; nothing else is persisted.

| pid file | process alive & identity matches | `paused` | Shown state |
|---|---|---|---|
| absent | — | false | `stopped` |
| absent | — | true | `paused` |
| present | yes | — | `running (pid N)` |
| present | no / identity mismatch | — | `crashed (stale)` → offer cleanup |

**start** (`serve start <name>`):
1. Validate `name`; refuse if a live, identity-matched worker already exists.
2. Acquire an exclusive `<name>.pid.lock` via `fs.writeFile(..., { flag: "wx" })` (reusing the repo's migration-lock pattern) to close the double-start race (M2).
3. `spawn(process.execPath, [BIN_ENTRY, "serve", "run", name, "--foreground"], { detached: true, shell: false, stdio: [ignore, logFd, logFd], env: minimalEnv })`, where `logFd` is the `O_NOFOLLOW`+`0600` log.
4. `child.unref()`. The **worker** writes `<name>.pid` (`{pid, startTimeMs, argv0, port}`) as its first action; the parent then releases the lock.
5. Wait ~1s, re-check worker liveness; report **failed** (not "started") if it already exited (e.g. bad config), surfacing the tail of the log.

**stop** (`serve stop <name>`):
1. Read pid file; **verify identity** (`/proc/<pid>/stat` starttime == recorded `startTimeMs`, cmdline contains `serve run <name>`) before signaling (C1).
2. SIGTERM; wait grace; SIGKILL fallback. Refuse / warn if identity mismatch (do **not** signal a recycled pid).
3. Remove pid file.

**pause** = stop + `paused:true`. **resume** = clear `paused` + start. `--all` enumerates validated `*.json` stems (never reads pids as a kill list); `start --all` skips paused; `stop --all` stops running.

**Worker self-management:** the worker writes its own pid file and removes it in `process.on('exit')` + SIGINT/SIGTERM handlers, so a crashed *parent* never orphans an untracked worker (M3).

---

## 6. State isolation (default per-service)

**Default:** each service runs against its **own** task store + workspace under `<state>/services/<name>/`. Rationale (H4/M1):

- The project's trust model is explicit: a tracker issue body becomes an agent prompt and the agent **executes code**. A shared state dir lets one poisoned issue's agent rewrite sibling services' `.pid`/`.json`/`.log` and pivot to controlling/killing every other service and reading their secrets.
- A shared store also causes cross-process double-dispatch and task-id collisions (the in-process update lock does not span processes).

**Opt-in shared store** (`shared_state: true` / `--shared-state`): allowed for users who knowingly want one store, but documented as carrying the double-dispatch caveat. When shared, dispatch must take a per-issue claim via an atomic `O_CREAT|O_EXCL` lease file keyed by issue id (M1).

---

## 7. Backward compatibility

- Bare `serve` with a legacy `server.tracker` configured and **no** service files → **auto-adopt** as a service named `default`, print a one-line notice + how to make it explicit (`serve adopt default`).
- **Behavior change (call out in CHANGELOG/help):** bare `serve` no longer blocks in the foreground. The equivalent old behavior is `maestro serve run default --foreground`.
- `setup tracker` is unchanged and continues to set the shared `server.tracker` defaults that services inherit.
- `adopt` treats a freshly-cloned, non-operator-authored `config.json` (especially one defining `hooks.*`, which run via `sh -lc`) as untrusted: it confirms before the first start (L1).

---

## 8. Orphan recovery

`serve adopt` (no-name form) scans for live `serve run <name>` processes that lack a matching valid pid file (parent died mid-spawn, M3) and re-links them by writing the pid record, so they become manageable again.

---

## 9. Feedback & warnings (the core UX ask)

Every lifecycle action prints **what happened + how to reverse it**:

```
$ maestro serve start web
✓ service 'web' started
  pid 4821 · tracker WEB · polling every 30s · HTTP http://127.0.0.1:4100
  state: .maestro/services/web/ (isolated)
  logs:  maestro serve logs web -f
  stop:  maestro serve stop web
```

**Warnings**, emitted at add/edit/start as relevant (non-fatal unless noted):

- api-key var unset in env/secrets → "won't be able to poll" (**fatal at start**).
- port collides with another definition's port, or `EADDRINUSE` at bind → **fatal at start** (surfaced, never swallowed).
- tracker kind ≠ linear / slug missing → **fatal** (reuses improved `validateServerConfig` messages).
- workspace root missing/unwritable → warn.
- `edit` on a running service → "changes apply after restart".
- `rm`/`stop` on a running service → confirm unless `--force`.
- `adopt` of a config with `hooks.*` → confirm before first start.

---

## 10. Security model (summary)

Derived from a dedicated security review. Mitigations folded into the sections above; consolidated here.

| Risk | Mitigation | Section |
|---|---|---|
| C1 recycled-pid kill | rich pid record + `/proc` starttime+cmdline identity check before any signal | §5 |
| C2 planted pid / lax perms / symlink | state dir `0700`; pid/def/log `0600`; `O_NOFOLLOW`; owner check; `assertInsideDirReal` | §2.1, §3 |
| H1 `name` injection | `WORKFLOW_NAME_RE` validation everywhere; `path.join`+`assertInsideDir`; `spawn` array args, never `shell:true` | §4, §5 |
| H2 log leakage | `O_NOFOLLOW`+`0600` log; logger secret-redaction denylist; size cap/rotation | §2.1, §9 |
| H3 env exfiltration | `--var`/`var` allowlist; `$VAR` resolution through `ENV_KEY_DENYLIST`; minimal constructed child env | §3 |
| H4 multi-service pivot | per-service isolated state dir **by default**; shared opt-in only | §6 |
| M1 double-dispatch | per-issue `O_CREAT|O_EXCL` lease when shared | §6 |
| M2 double-start | `{flag:"wx"}` pid lock; worker writes own pid | §5 |
| M3 orphans | worker self-writes/cleans pid; `adopt` recovery scan | §5, §8 |
| L1 untrusted adopt | confirm before first start when `hooks.*` present | §7 |
| L2 HTTP no-auth | confirm 127.0.0.1-only bind (already true); port collision surfaced; (optional) loopback token on `/refresh` | §9 |
| L3 literal key in def | reject `--api-key` literal into a definition; store only `$VAR` | §2.2 |
| L4 bad port | validate 1–65535, reject `0`, enforce uniqueness | §2.2, §9 |

**Reuse existing primitives:** `WORKFLOW_NAME_RE`/`isValidWorkflowName` (task-store.mjs), `{flag:"wx"}` lock (task-store.mjs migration lock), `spawn(process.execPath, [BIN_ENTRY,…])` (tasks-run.mjs), `{mode:0o600}`+chmod (keys.mjs), `assertInsideDirReal` (fs-safe.mjs), `ENV_KEY_DENYLIST` (agent-runner.mjs). Do **not** reuse `writeJsonAtomic` for control files — it does not set restrictive perms.

---

## 11. Rejected alternatives

- **Single supervisor daemon** (one `maestrod`, CLI talks over a unix socket): cleaner state, but adds daemon lifecycle, IPC protocol, crash recovery, and orphan cleanup — more surface to build and test for no v1 benefit.
- **OS service manager** (systemd user units): robust on Linux but non-portable (no macOS/launchd) and ties UX to `systemctl`.
- **Shared task store as default**: rejected on security grounds (H4/M1); offered as explicit opt-in.
- **Foreground-default bare `serve`**: rejected; bare `serve` showing status/guidance best fixes the original "unguided" complaint.

---

## 12. Module layout

New `src/cli/serve/`:

- `store.mjs` — read/write definitions, pid records, log paths; name validation; perm + `O_NOFOLLOW` + owner-checked opens.
- `lifecycle.mjs` — detached spawn, identity-verified stop, liveness, stale detection, start lock.
- `resolve.mjs` — overlay → serverConfig (deep-merge, denylist `$VAR`, isolated-state defaulting).
- `commands.mjs` — handlers for add/list/rm/edit/start/stop/pause/resume/status/logs/adopt.
- `format.mjs` — status table + feedback/warning strings.

`serve run --foreground` reuses `startMaestro` (runtime.mjs) untouched as the worker body. Routing updated in `registry.mjs`, `routeCli`, `main.mjs`.

---

## 13. Testing strategy

- **Unit:** store (read/write/list, name validation rejects traversal/control-suffix/reserved, perm bits, owner/symlink refusal), resolve (overlay merge, `$VAR` denylist, port/var validation), format (table + feedback snapshots), warning detection (port collision, missing key).
- **Lifecycle:** injectable spawner runs a tiny sleep-worker; assert pid record shape, identity-verified stop kills it, identity-mismatch refuses to signal, `pause`/`resume`, `--all` filtering, stale cleanup, double-start lock, worker self-cleans pid on exit.
- **Routing:** each subcommand dispatches to the right handler; bare `serve` → status; legacy auto-adopt path; `run --foreground` → server runtime.
- **Security regression:** name `../config` rejected; planted symlink log refused; literal `--api-key` into a definition rejected; `$AWS_SECRET_ACCESS_KEY`-style `var` rejected by denylist.
