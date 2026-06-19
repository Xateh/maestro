# Maestro Orchestrator — System Audit Findings

Status: **closed out as of v0.1.2.** F1–F11 are RESOLVED (each carries its
fix evidence below); F12 is ratified WON'T-CHANGE (the marker asymmetry is
deliberate). Severity reflects in-context risk (the HTTP dashboard binds to
127.0.0.1 by default; the secret/DB stores are local, user-owned, single-tenant).

> **Update (2026-06-17, v0.1.2):** the original baseline note below was written
> before the suite could run. Every finding has since been fixed and exercised by
> `node --test`; F4's remainder (shared helper, opt-in strict enforcement, TUI
> round-trip guard) landed in v0.1.2. This file is now historical.

## Baseline note (residual risk)
`npm install`, `node`, `npx biome lint`, and `node --test` could **not** be run
in this environment: the sandbox gates process execution behind an approval that
is unavailable in this autonomous run, and `node_modules` is not present in the
worktree. **All findings below are from static analysis only**; the two applied
fixes were not exercised by lint or the test suite. Re-run `npm install && npm
test && npm run lint` before merge.

---

## Applied fixes

### F1 — Stored XSS via case-sensitive `</script>` neutralization  [Medium · Security]
`src/http-server.mjs:56` (`buildDashboardHtml`)
The snapshot JSON is inlined into a `<script>` block and only `</script>` (lower
case, `/g`) was neutralized. Attacker-influenced fields (issue title/description
flowing through `orchestrator.snapshot()`) containing `</Script>` (or any mixed
case) would break out of the script context → stored XSS on the dashboard.
**Fix applied:** escape every `<` as `<`, which neutralizes `</script>` in
any case as well as `<!--`. Safe inside the JS object-literal context (`<` only
appears inside string values).

### F2 — `assertInsideDir` docstring overstated its guarantee  [Low · Doc/Security accuracy]
`src/fs-safe.mjs:13` (and file header)
The docstring claimed it "Rejects symlink-escape", but the check is purely
lexical (`path.relative`) and does **not** resolve symlinks. **Fix applied:**
corrected the docstring to state it is lexical-only and that symlink escape is
not detected here. (The underlying gap is F3.)

---

## Findings (all resolved or ratified — see Status above)

### F3 — `assertInsideDir` does not detect symlink escape  [Medium · Security] — RESOLVED
`src/fs-safe.mjs:16`; consumers `src/mcp/server.mjs` (showTask/showRun),
`src/artifacts.mjs`.
Purely lexical containment. An agent can write into its own worktree / run dir;
if it plants a symlink there pointing outside (e.g. to `/etc/passwd` or another
project's secrets), a later read via `tailFile`/`readJSON` passes `assertInsideDir`
and exfiltrates arbitrary files through the MCP read tools.
**Fix applied:** `assertInsideDirReal`/`isInsideDirReal` (realpath both parent and
child, then lexical check) added in `fs-safe.mjs`; `mcp/server.mjs` run/task reads
already use them, and `artifacts.mjs` `resolveArtifact` now gates on
`isInsideDirReal` before returning a path that is later read via
`tailFile`/`readFile`. Regression test: "resolveArtifact returns null for a
symlink inside run_dir that escapes it (F3)".

### F4 — `output_schema_ref` is declared but never enforced at runtime  [Medium · Contract drift] — RESOLVED
`src/schemas/index.mjs` (`resolveRoleSchema`/`validateRolePayload`),
`src/langgraph/nodes.mjs`, `src/task-store.mjs`, `src/workflow-validate.mjs`.
A role declaring `output_schema_ref` previously got its schema neither injected
into the prompt nor validated against the emitted payload.
**Fix applied (v0.1.2):**
- `task-store.mjs:_expandSchemaRefs` loads the ref file (guarded by
  `assertInsideDir` against the state dir) and bakes it into an inline
  `output_schema` at load time, so the prompt-inject (`nodes.mjs` `outputSchema`)
  and validation both see a real schema.
- The five duplicated `resolve→validate` branches collapsed into one shared
  `validateRolePayload(roleDef, payload)` helper (`schemas/index.mjs`), called at
  all five node sites (stub/command/regression/scoring + the LLM handoff). [U1]
- Opt-in strict enforcement: `enforce_output_schema: true` promotes soft
  validation to a hard halt (`output_schema_violation` blocker) at every site;
  default stays soft. Type-checked in `workflow-validate.mjs`. [U2]
- TUI round-trip guard: `task-store.writeWorkflow` strips a ref-derived
  `output_schema` so a write-back keeps `output_schema_ref` authoritative and
  never persists the bake. [U3]
Tests: `maestro-schemas` (helper verdicts), `maestro-engine` (strict halt at LLM
+ stub sites), `maestro-workflow-validate` (flag type-check), `maestro` (ref
round-trip).

### F5 — `updateTask` lost-update race (SQLite + Postgres)  [Medium · Concurrency] — RESOLVED
`src/db/store.mjs:113`, `src/db/pg-store.mjs:108`
`updateTask` is `async` and does read (`await getTask`) → merge → `UPDATE` with
no transaction/lock. Two concurrent updates to the same task id (e.g. a stage
write racing an orchestrator `onActivity`/metrics write) can interleave at the
`await` and silently drop one patch.
**Fix applied:** SQLite reads synchronously (`prepare().get`) with no `await`
between read and write, so read→merge→write is one microtask turn. Postgres
(audited per the original note) now wraps read+merge+write in a transaction with
`SELECT … FOR UPDATE`, so a concurrent updateTask on the same id blocks on the
row lock instead of interleaving.

### F6 — SQLite opened without `busy_timeout`/WAL  [Medium · Reliability] — RESOLVED
`src/db/store.mjs`
Two `maestro` processes against the same `.maestro/maestro.db` could hit
`SQLITE_BUSY` (immediate throw) on write contention.
**Fix applied:** `PRAGMA journal_mode=WAL` and `PRAGMA busy_timeout=5000` are set
at connection open (`db/store.mjs`).

### F7 — Timeout kill does not escalate to SIGKILL  [Low · Reliability] — RESOLVED
`src/command-runner.mjs`, `src/agent-runner.mjs`, `src/workspace.mjs`
Timeouts previously sent `SIGTERM` only; a child trapping it could leak.
**Fix applied:** all three sites schedule a `SIGKILL` after a grace period.

### F8 — Streaming UTF-8 split corruption in bounded tail  [Low · Reliability] — RESOLVED
`src/bounded-tail.mjs`
A multibyte codepoint split across two stream chunks was mangled.
**Fix applied:** accumulation now uses `node:string_decoder` `StringDecoder`.
Test: `test/maestro-bounded-tail.test.mjs`.

### F9 — Rate-limiter bucket map can grow past `maxBuckets`  [Low · DoS] — RESOLVED
`src/http-rate-limit.mjs`
Under a flood from many distinct IPs the bucket map could exceed `maxBuckets`.
**Fix applied:** `evictOldest()` caps the map at capacity.
Test: `test/maestro-http-ratelimit.test.mjs`.

### F10 — Stored secrets bypass ENV_KEY_DENYLIST on load  [Low · Security hardening] — RESOLVED
`src/setup/keys.mjs` (`loadLocalSecrets`)
Stored secrets matching the denylist (e.g. `LD_PRELOAD`, `NODE_OPTIONS`) could be
promoted into `process.env` at startup.
**Fix applied:** `loadLocalSecrets` skips keys matching `ENV_KEY_DENYLIST`.

### F11 — `decryptSecrets` trusts envelope KDF params  [Low · Robustness] — RESOLVED
`src/setup/secret-crypto.mjs`
A tampered envelope with a huge scrypt `N` could cause a CPU/memory DoS on decrypt.
**Fix applied:** `N/r/p` are bounds-checked (`N≤2²⁰, r≤32, p≤16`) before
`deriveKey`. Test: `test/maestro-secret-crypto.test.mjs`.

### F12 — First-vs-last marker selection inconsistency  [Info · Correctness] — WON'T CHANGE (ratified)
`src/markers.mjs`
`parseAgentHandoff`/`parseAgentQuestion` return the **first** matching marker;
`parseReviewerOutput` uses the **last** (`payloads.at(-1)`).
**Decision (v0.1.2):** keep the asymmetry. It is deliberate, not a bug — an
executor that emits multiple handoffs/questions is malformed, and committing to
its **first** stated transition is the safer routing choice; flipping the
routing-critical first-match path is not worth the risk. Reviewer output is
genuinely last-wins because reviewers legitimately emit revised drafts and the
final verdict is the settled one. The rationale is documented inline at the top of
the `MAESTRO_HANDOFF` section in `src/markers.mjs`.

---

## Areas audited and found sound
- MCP tool surface (`src/mcp/server.mjs`): id bounding, `assertInsideDir`,
  `--` argv separator (no flag injection), `redactConfig`, prompt size cap.
- HTTP client-IP keying uses `socket.remoteAddress` (no `X-Forwarded-For`
  spoofing); server binds 127.0.0.1 by default.
- Subprocess env layering (`agent-runner.mjs`, `nodes.mjs` `_maestroEnv`):
  command/regression stages get only maestro-generated `MAESTRO_*` vars;
  denylist applied to imported provider/alias env and CLI action-request env.
- Secret store (`keys.mjs`): 0600 perms, atomic temp-write+rename, encrypted
  store wins, loud-not-lossy on malformed JSON.
- `secret-crypto.mjs`: AES-256-GCM + scrypt, per-message random salt/iv.
- Workspace path containment (`workspace.mjs`): sanitized key + inside-root
  re-check defends `..`.
</content>
