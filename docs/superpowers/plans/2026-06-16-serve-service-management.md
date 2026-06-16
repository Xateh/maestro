# `maestro serve` Multi-Service Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `maestro serve` from a single foreground poller into a command group that manages multiple named services — each a detached background worker — with full CRUD + lifecycle control and a hardened security model.

**Architecture:** A *service* is a named overlay (`<state>/services/<name>.json`) on the existing `server` config block. Lifecycle commands (`add/list/rm/edit/start/stop/pause/resume/status/logs/adopt`) route as `local` commands; `serve run <name> --foreground` is the worker that resolves the overlay and calls the existing `startMaestro(...)` unchanged. Workers are detached `node` processes tracked by identity-verified PID records. Each service defaults to an isolated state dir.

**Tech Stack:** Node.js (ESM), `node:fs/promises`, `node:child_process` spawn, `node:test`. Reuses existing primitives: `WORKFLOW_NAME_RE` + `isValidWorkflowName` (`src/task-store.mjs`), `assertInsideDirReal`/`tailFile` (`src/fs-safe.mjs`), `ENV_KEY_DENYLIST` (`src/agent-runner.mjs`), the `{flag:"wx"}` exclusive-create lock and `process.execPath`+`BIN_ENTRY` detached spawn (`src/cli/tasks-run.mjs`), and `{mode:0o600}`+chmod writes (`src/setup/keys.mjs`).

Spec: `docs/superpowers/specs/2026-06-16-serve-service-management-design.md`.

---

## File Structure

**New:**
- `src/cli/serve/store.mjs` — name validation, path derivation, definition + pid-record read/write with `0600`/`0700` perms, `O_NOFOLLOW` + owner-checked opens, listing.
- `src/cli/serve/proc.mjs` — process identity: `/proc/<pid>/stat` starttime + `/proc/<pid>/cmdline` checks, `isAlive`, `verifyIdentity`.
- `src/cli/serve/resolve.mjs` — `resolveServiceConfig` (overlay deep-merge, `$VAR` denylist, isolated-state defaulting, port validation).
- `src/cli/serve/lifecycle.mjs` — detached spawn + start lock, identity-verified stop, pause/resume, worker self-pid + cleanup, stale detection.
- `src/cli/serve/format.mjs` — status table, per-action feedback, warning strings, bare-serve guidance.
- `src/cli/serve/commands.mjs` — `runServeCommand({args,…})` dispatcher for every subcommand + the `run` worker.
- `test/maestro-serve-store.test.mjs`, `test/maestro-serve-proc.test.mjs`, `test/maestro-serve-resolve.test.mjs`, `test/maestro-serve-lifecycle.test.mjs`, `test/maestro-serve-commands.test.mjs`.

**Modified:**
- `src/cli/runtime.mjs` — add an `overlay` seam to `startMaestro`.
- `src/cli/registry.mjs` — replace the flat `serve` node with a subcommand group; change `routeCli` so only `serve run … --foreground` routes to `server`/`serve`, everything else to `local`.
- `src/cli/local-command.mjs` — add a `command === "serve"` branch delegating to `runServeCommand`.
- `src/cli/main.mjs` — pass the worker overlay through for the `serve run` path (handled via local dispatch; no change to the `server` start path beyond the overlay seam).

---

## Conventions used in every task

- Run a single test file: `node --test test/<file>.test.mjs`
- Run the whole suite: `node --test`
- Commit message style: Conventional Commits, **no** `Co-Authored-By` line (per repo policy).
- All new control files (definitions, pid records, logs) are created mode `0600`; the `services/` dir is `0700`.

---

## Task 1: Service name validation + path helpers

**Files:**
- Create: `src/cli/serve/store.mjs`
- Test: `test/maestro-serve-store.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// test/maestro-serve-store.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { assertValidServiceName, servicePaths } from "../src/cli/serve/store.mjs";

test("assertValidServiceName accepts simple names, rejects traversal/control/empty", () => {
  assert.equal(assertValidServiceName("web"), "web");
  assert.equal(assertValidServiceName("infra-2"), "infra-2");
  for (const bad of ["", "../config", "a/b", "a.pid", "A", "-x", "..", ".", "a".repeat(65)]) {
    assert.throws(() => assertValidServiceName(bad), /invalid_service_name/, `should reject ${JSON.stringify(bad)}`);
  }
});

test("servicePaths derives def/pid/log/state under <state>/services and stays inside it", () => {
  const root = "/tmp/state";
  const p = servicePaths(root, "web");
  assert.equal(p.dir, path.join(root, "services"));
  assert.equal(p.def, path.join(root, "services", "web.json"));
  assert.equal(p.pid, path.join(root, "services", "web.pid"));
  assert.equal(p.log, path.join(root, "services", "web.log"));
  assert.equal(p.stateDir, path.join(root, "services", "web"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/maestro-serve-store.test.mjs`
Expected: FAIL — cannot find module `../src/cli/serve/store.mjs`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/cli/serve/store.mjs
import path from "node:path";

import { WORKFLOW_NAME_RE } from "../../task-store.mjs";

// Reuse the workflow-name grammar verbatim: ^[a-z0-9][a-z0-9_-]{0,63}$.
// This forbids "..", "/", uppercase, leading "-"/".", control suffixes like
// "a.pid" (the "." is not in the class), and over-long names — closing the
// path-traversal / filename-collision vectors (spec H1).
export function assertValidServiceName(name) {
  if (typeof name !== "string" || !WORKFLOW_NAME_RE.test(name)) {
    const error = new Error(`invalid_service_name: ${JSON.stringify(name)} (must match ${WORKFLOW_NAME_RE})`);
    error.code = "invalid_service_name";
    throw error;
  }
  return name;
}

export function servicesDir(stateRoot) {
  return path.join(stateRoot, "services");
}

export function servicePaths(stateRoot, name) {
  assertValidServiceName(name);
  const dir = servicesDir(stateRoot);
  return {
    dir,
    def: path.join(dir, `${name}.json`),
    pid: path.join(dir, `${name}.pid`),
    log: path.join(dir, `${name}.log`),
    stateDir: path.join(dir, name),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/maestro-serve-store.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/serve/store.mjs test/maestro-serve-store.test.mjs
git commit -m "feat(serve): service name validation + path derivation"
```

---

## Task 2: Definition + pid-record read/write (0600, O_NOFOLLOW, owner-checked)

**Files:**
- Modify: `src/cli/serve/store.mjs`
- Test: `test/maestro-serve-store.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// append to test/maestro-serve-store.test.mjs
import fs from "node:fs/promises";
import os from "node:os";

import {
  ensureServicesDir, writeDefinition, readDefinition, listDefinitions,
  writePidRecord, readPidRecord, removeFile,
} from "../src/cli/serve/store.mjs";

async function tmpRoot() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "maestro-serve-"));
}

test("writeDefinition/readDefinition round-trips and writes 0600 inside a 0700 dir", async () => {
  const root = await tmpRoot();
  await ensureServicesDir(root);
  await writeDefinition(root, "web", { slug: "WEB", port: 4100, paused: false });
  const got = await readDefinition(root, "web");
  assert.deepEqual(got, { slug: "WEB", port: 4100, paused: false });
  const st = await fs.stat(path.join(root, "services", "web.json"));
  assert.equal(st.mode & 0o777, 0o600);
  const dst = await fs.stat(path.join(root, "services"));
  assert.equal(dst.mode & 0o777, 0o700);
});

test("readDefinition returns null for missing service", async () => {
  const root = await tmpRoot();
  await ensureServicesDir(root);
  assert.equal(await readDefinition(root, "nope"), null);
});

test("listDefinitions returns sorted valid names only", async () => {
  const root = await tmpRoot();
  await ensureServicesDir(root);
  await writeDefinition(root, "web", { slug: "WEB" });
  await writeDefinition(root, "infra", { slug: "INF" });
  // a stray non-matching file must be ignored
  await fs.writeFile(path.join(root, "services", "not a service.json"), "{}");
  assert.deepEqual(await listDefinitions(root), ["infra", "web"]);
});

test("pid record round-trips and is 0600", async () => {
  const root = await tmpRoot();
  await ensureServicesDir(root);
  await writePidRecord(root, "web", { pid: 4321, startTimeMs: 111, argv0: "node", port: 4100 });
  const rec = await readPidRecord(root, "web");
  assert.equal(rec.pid, 4321);
  assert.equal(rec.port, 4100);
  const st = await fs.stat(path.join(root, "services", "web.pid"));
  assert.equal(st.mode & 0o777, 0o600);
});

test("readDefinition refuses a symlinked definition", async () => {
  const root = await tmpRoot();
  await ensureServicesDir(root);
  const target = path.join(root, "outside.json");
  await fs.writeFile(target, JSON.stringify({ slug: "X" }));
  await fs.symlink(target, path.join(root, "services", "evil.json"));
  await assert.rejects(() => readDefinition(root, "evil"), /service_file_symlink|ELOOP/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/maestro-serve-store.test.mjs`
Expected: FAIL — `ensureServicesDir` etc. not exported.

- [ ] **Step 3: Write minimal implementation**

```js
// append to src/cli/serve/store.mjs
import fs from "node:fs/promises";
import fsConstants from "node:fs";

import { assertInsideDirReal } from "../../fs-safe.mjs";

export async function ensureServicesDir(stateRoot) {
  const dir = servicesDir(stateRoot);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir mode is masked by umask; force it.
  await fs.chmod(dir, 0o700).catch(() => {});
  return dir;
}

// Open a service-owned file without following symlinks and verify the opened
// fd is a regular file owned by us (spec C2/H2). Returns a FileHandle.
async function openOwned(filePath, flags) {
  const fh = await fs.open(filePath, flags | fsConstants.constants.O_NOFOLLOW, 0o600);
  try {
    const st = await fh.stat();
    if (!st.isFile()) {
      const e = new Error(`service_file_not_regular: ${filePath}`);
      e.code = "service_file_not_regular";
      throw e;
    }
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
      const e = new Error(`service_file_foreign_owner: ${filePath}`);
      e.code = "service_file_foreign_owner";
      throw e;
    }
    return fh;
  } catch (error) {
    await fh.close().catch(() => {});
    if (error.code === "ELOOP") {
      const e = new Error(`service_file_symlink: ${filePath}`);
      e.code = "service_file_symlink";
      throw e;
    }
    throw error;
  }
}

async function writeOwnedJson(filePath, value) {
  await assertInsideDirReal(path.dirname(path.dirname(filePath)), filePath);
  // Replace atomically: write temp (excl), chmod, rename. Temp name is in-dir.
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const fh = await fs.open(tmp, "wx", 0o600);
  try {
    await fh.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await fh.chmod(0o600);
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, filePath);
}

async function readOwnedJson(filePath) {
  let fh;
  try {
    fh = await openOwned(filePath, fsConstants.constants.O_RDONLY);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const text = await fh.readFile("utf8");
    return JSON.parse(text);
  } finally {
    await fh.close();
  }
}

export function writeDefinition(stateRoot, name, def) {
  return writeOwnedJson(servicePaths(stateRoot, name).def, def);
}

export function readDefinition(stateRoot, name) {
  return readOwnedJson(servicePaths(stateRoot, name).def);
}

export function writePidRecord(stateRoot, name, rec) {
  return writeOwnedJson(servicePaths(stateRoot, name).pid, rec);
}

export function readPidRecord(stateRoot, name) {
  return readOwnedJson(servicePaths(stateRoot, name).pid);
}

export async function removeFile(filePath) {
  await fs.rm(filePath, { force: true });
}

export async function listDefinitions(stateRoot) {
  const dir = servicesDir(stateRoot);
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const names = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const stem = entry.slice(0, -5);
    if (WORKFLOW_NAME_RE.test(stem)) names.push(stem);
  }
  return names.sort();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/maestro-serve-store.test.mjs`
Expected: PASS (all store tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/serve/store.mjs test/maestro-serve-store.test.mjs
git commit -m "feat(serve): owner-checked 0600 definition + pid-record store"
```

---

## Task 3: Process identity verification (`/proc` starttime + cmdline)

**Files:**
- Create: `src/cli/serve/proc.mjs`
- Test: `test/maestro-serve-proc.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// test/maestro-serve-proc.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import { isAlive, readStartTime, verifyIdentity } from "../src/cli/serve/proc.mjs";

test("isAlive is true for the current process, false for an unused pid", () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(2 ** 30), false); // pid that cannot exist
});

test("readStartTime returns a positive number for the current process on linux", () => {
  if (process.platform !== "linux") return; // /proc only
  const st = readStartTime(process.pid);
  assert.equal(typeof st, "number");
  assert.ok(st > 0);
});

test("verifyIdentity: matching record passes, wrong startTime fails", () => {
  if (process.platform !== "linux") return;
  const st = readStartTime(process.pid);
  assert.equal(verifyIdentity({ pid: process.pid, startTimeMs: st }, "web"), true);
  assert.equal(verifyIdentity({ pid: process.pid, startTimeMs: st + 999999 }, "web"), false);
});

test("verifyIdentity fails for a dead pid", () => {
  assert.equal(verifyIdentity({ pid: 2 ** 30, startTimeMs: 1 }, "web"), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/maestro-serve-proc.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// src/cli/serve/proc.mjs
import fs from "node:fs";

// process.kill(pid, 0) probes existence without signaling. EPERM means the
// process exists but is owned by someone else (treated as alive but foreign).
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// Linux /proc/<pid>/stat field 22 (1-indexed) is starttime in clock ticks.
// The comm field (2) is wrapped in parens and may contain spaces/parens, so
// parse from the LAST ')' to avoid splitting on it. Returns clock-tick count
// (stable per-boot identity), or null on any non-linux / read failure.
export function readStartTime(pid) {
  if (process.platform !== "linux") return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const rparen = stat.lastIndexOf(")");
    const fields = stat.slice(rparen + 2).split(" ");
    // After ") ", fields[0] is state (field 3). starttime is field 22 → index 19.
    const starttime = Number(fields[19]);
    return Number.isFinite(starttime) ? starttime : null;
  } catch {
    return null;
  }
}

function cmdlineMatches(pid, name) {
  if (process.platform !== "linux") return true; // cannot verify; don't block
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    const parts = raw.split("\0").filter(Boolean);
    return parts.includes("serve") && parts.includes(name) && parts.includes("--foreground");
  } catch {
    return false;
  }
}

// True only if pid is alive AND (where /proc is available) its boot-stable
// starttime matches the recorded value and its cmdline is the expected worker.
// On platforms without /proc, falls back to liveness only (documented residual
// TOCTOU risk — spec C1).
export function verifyIdentity(record, name) {
  if (!record || !isAlive(record.pid)) return false;
  if (process.platform !== "linux") return true;
  const live = readStartTime(record.pid);
  if (live === null || record.startTimeMs == null) return true; // best-effort
  if (live !== record.startTimeMs) return false;
  return cmdlineMatches(record.pid, name);
}
```

> Note: `startTimeMs` is a slight misnomer (it stores clock ticks on Linux), but the field name is kept stable across the codebase; treat it as an opaque boot-stable token.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/maestro-serve-proc.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/serve/proc.mjs test/maestro-serve-proc.test.mjs
git commit -m "feat(serve): identity-verified process liveness via /proc"
```

---

## Task 4: Config overlay resolution (`resolveServiceConfig`)

**Files:**
- Create: `src/cli/serve/resolve.mjs`
- Test: `test/maestro-serve-resolve.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// test/maestro-serve-resolve.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { buildOverlay, validateOverlayFields } from "../src/cli/serve/resolve.mjs";

test("buildOverlay maps definition fields onto a server-block overlay with isolated state", () => {
  const ov = buildOverlay({ name: "web", def: { slug: "WEB", port: 4100 }, stateRoot: "/s" });
  assert.equal(ov.serverOverlay.tracker.project_slug, "WEB");
  assert.equal(ov.serverOverlay.port, 4100);
  // isolated state + workspace default under services/<name>/
  assert.equal(ov.stateDir, path.join("/s", "services", "web"));
  assert.equal(ov.serverOverlay.workspace.root, path.join("/s", "services", "web", "work"));
});

test("buildOverlay honors shared_state and explicit workspace/var/workflow overrides", () => {
  const ov = buildOverlay({
    name: "infra",
    def: { slug: "INF", workflow: "review", var: "LINEAR_KEY_INFRA", workspace: "/w/infra", shared_state: true },
    stateRoot: "/s",
  });
  assert.equal(ov.stateDir, "/s"); // shared store
  assert.equal(ov.serverOverlay.workflow, "review");
  assert.equal(ov.serverOverlay.tracker.api_key, "$LINEAR_KEY_INFRA");
  assert.equal(ov.serverOverlay.workspace.root, "/w/infra");
});

test("validateOverlayFields rejects bad var, bad port, literal api key, denylisted var", () => {
  assert.throws(() => validateOverlayFields({ slug: "X", port: 0 }), /invalid_service_port/);
  assert.throws(() => validateOverlayFields({ slug: "X", port: 70000 }), /invalid_service_port/);
  assert.throws(() => validateOverlayFields({ slug: "X", var: "PATH" }), /invalid_service_var/);
  assert.throws(() => validateOverlayFields({ slug: "X", var: "1bad" }), /invalid_service_var/);
  assert.throws(() => validateOverlayFields({ slug: "X", api_key: "lin_api_secretliteral" }), /literal_api_key/);
  assert.doesNotThrow(() => validateOverlayFields({ slug: "X", port: 4100, var: "LINEAR_API_KEY" }));
});

test("validateOverlayFields requires a slug", () => {
  assert.throws(() => validateOverlayFields({}), /missing_service_slug/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/maestro-serve-resolve.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// src/cli/serve/resolve.mjs
import path from "node:path";

import { ENV_KEY_DENYLIST } from "../../agent-runner.mjs";

const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function typedError(code, detail) {
  const e = new Error(detail ? `${code}: ${detail}` : code);
  e.code = code;
  return e;
}

// Refuse a value that looks like a literal secret being stored in a definition
// (spec L3). $VAR references and short tokens are fine.
function looksLikeLiteralKey(value) {
  return typeof value === "string" && !value.startsWith("$") && value.length >= 12 && /[A-Za-z0-9_-]{12,}/.test(value);
}

export function validateOverlayFields(def) {
  if (!def || typeof def.slug !== "string" || def.slug.trim() === "") {
    throw typedError("missing_service_slug", "a service needs --slug <SLUG>");
  }
  if (def.port !== undefined && def.port !== null) {
    const p = def.port;
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw typedError("invalid_service_port", `${p} (expected 1–65535)`);
    }
  }
  if (def.var !== undefined && def.var !== null) {
    if (!VAR_RE.test(def.var) || ENV_KEY_DENYLIST.test(def.var)) {
      throw typedError("invalid_service_var", `${def.var} (must be a plain env-var name, not denylisted)`);
    }
  }
  if (def.api_key !== undefined && looksLikeLiteralKey(def.api_key)) {
    throw typedError("literal_api_key", "store only a $VAR reference, never the literal key");
  }
  return true;
}

// Translate a stored definition into { serverOverlay, stateDir }. serverOverlay
// is deep-merged onto config.server by startMaestro's overlay seam (Task 5).
export function buildOverlay({ name, def, stateRoot }) {
  validateOverlayFields(def);
  const isolated = def.shared_state !== true;
  const stateDir = isolated ? path.join(stateRoot, "services", name) : stateRoot;
  const varName = def.var ?? "LINEAR_API_KEY";

  const serverOverlay = {
    tracker: {
      project_slug: def.slug,
      api_key: `$${varName}`,
    },
  };
  if (def.port !== undefined && def.port !== null) serverOverlay.port = def.port;
  if (def.workflow) serverOverlay.workflow = def.workflow;

  const workspaceRoot = def.workspace ?? (isolated ? path.join(stateDir, "work") : undefined);
  if (workspaceRoot !== undefined) serverOverlay.workspace = { root: workspaceRoot };

  return { serverOverlay, stateDir };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/maestro-serve-resolve.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/serve/resolve.mjs test/maestro-serve-resolve.test.mjs
git commit -m "feat(serve): service overlay resolution with var denylist + port/key validation"
```

---

## Task 5: `startMaestro` overlay seam

**Files:**
- Modify: `src/cli/runtime.mjs:35-56`
- Test: `test/maestro-runtime.test.mjs` (add one case)

- [ ] **Step 1: Write the failing test**

```js
// add to test/maestro-runtime.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { startMaestro } from "../src/cli/runtime.mjs";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("startMaestro applies a serverOverlay onto config.server before validation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maestro-overlay-"));
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "config.json"), JSON.stringify({
    version: 2, cwd: root,
    server: { tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: null } },
  }));
  let captured = null;
  const service = await startMaestro({
    stateDir: root,
    env: { LINEAR_API_KEY: "k" },
    overlay: { tracker: { project_slug: "OVERRIDDEN" } },
    deps: {
      tracker: { /* stub */ },
      runner: { stop: async () => {} },
      workspaceManager: {},
      runTask: async () => {},
      // capture the resolved config via a tracker builder seam:
    },
  });
  captured = service.serverConfig;
  await service.stop();
  assert.equal(captured.tracker.projectSlug, "OVERRIDDEN");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/maestro-runtime.test.mjs`
Expected: FAIL — overlay is ignored; `projectSlug` is `null` → either assertion fails or `validateServerConfig` throws `missing_tracker_project_slug`.

- [ ] **Step 3: Write minimal implementation**

Modify `startMaestro` in `src/cli/runtime.mjs`. Add `overlay = null` to the destructured options, and deep-merge it onto `config.server` before `resolveServerConfig`:

```js
export async function startMaestro({
  configPath = null,
  stateDir = DEFAULT_LOCAL_STATE_DIR,
  port = null,
  env = process.env,
  overlay = null,                 // NEW: server-block overlay (serve worker)
  logger = new StructuredLogger(),
  deps = {},
} = {}) {
  const root = configPath ?? stateDir ?? DEFAULT_LOCAL_STATE_DIR;
  const taskStore = deps.taskStore ?? new LocalTaskStore({ root });
  await taskStore.init();

  const config = await taskStore.readConfig();
  const merged = overlay
    ? { ...config, server: deepMergeServer(config.server ?? {}, overlay) }
    : config;
  const serverConfig = resolveServerConfig(merged, {
    env,
    baseDir: deps.baseDir ?? taskStore.root,
  });
  validateServerConfig(serverConfig);
  // …unchanged below…
```

Add the helper near the top of the file (after imports):

```js
// Shallow-by-section deep merge: overlay wins on the leaf keys it sets, while
// untouched sections (polling, agent, hooks, …) survive. Only the two-level
// shape of the server block is merged (server.tracker.*, server.workspace.*).
function deepMergeServer(base, overlay) {
  const out = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object") {
      out[key] = { ...base[key], ...value };
    } else {
      out[key] = value;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/maestro-runtime.test.mjs`
Expected: PASS. If the stubbed `deps` shape causes unrelated failures, minimally stub `buildTracker`/`runner` via the existing `deps` seams already used by other runtime tests in that file (mirror their setup).

- [ ] **Step 5: Commit**

```bash
git add src/cli/runtime.mjs test/maestro-runtime.test.mjs
git commit -m "feat(serve): startMaestro server-block overlay seam"
```

---

## Task 6: Lifecycle — spawn detached worker with start lock; worker self-pid

**Files:**
- Create: `src/cli/serve/lifecycle.mjs`
- Test: `test/maestro-serve-lifecycle.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// test/maestro-serve-lifecycle.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureServicesDir, writeDefinition, writePidRecord, readPidRecord } from "../src/cli/serve/store.mjs";
import { startService, acquireStartLock } from "../src/cli/serve/lifecycle.mjs";

async function tmpRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-svc-"));
  await ensureServicesDir(root);
  return root;
}

test("startService spawns a detached worker with execPath + array args (no shell) and writes its pid record", async () => {
  const root = await tmpRoot();
  await writeDefinition(root, "web", { slug: "WEB", port: 4100 });
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    // simulate the worker writing its own pid record (Task 6 worker contract)
    writePidRecord(root, "web", { pid: 99999, startTimeMs: 1, argv0: cmd, port: 4100 });
    return { unref() {}, pid: 99999 };
  };
  const res = await startService({ stateRoot: root, name: "web", spawnProcess: fakeSpawn, waitForPid: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.shell, undefined); // never shell:true
  assert.equal(calls[0].opts.detached, true);
  assert.deepEqual(calls[0].args.slice(1, 4), ["serve", "run", "web"]);
  assert.ok(calls[0].args.includes("--foreground"));
  assert.equal(res.port, 4100);
});

test("acquireStartLock is exclusive — second acquire throws while held", async () => {
  const root = await tmpRoot();
  const lock = await acquireStartLock(root, "web");
  await assert.rejects(() => acquireStartLock(root, "web"), /service_start_in_progress/);
  await lock.release();
  const lock2 = await acquireStartLock(root, "web"); // now free
  await lock2.release();
});

test("startService refuses when a live, identity-matched worker already exists", async () => {
  const root = await tmpRoot();
  await writeDefinition(root, "web", { slug: "WEB" });
  await writePidRecord(root, "web", { pid: process.pid, startTimeMs: null });
  await assert.rejects(
    () => startService({ stateRoot: root, name: "web", spawnProcess: () => { throw new Error("should not spawn"); }, waitForPid: false }),
    /service_already_running/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/maestro-serve-lifecycle.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// src/cli/serve/lifecycle.mjs
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsConstants from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { servicePaths, readDefinition, readPidRecord, removeFile } from "./store.mjs";
import { verifyIdentity, isAlive } from "./proc.mjs";

const BIN_ENTRY = fileURLToPath(new URL("../../../bin/maestro.mjs", import.meta.url));

function typedError(code, detail) {
  const e = new Error(detail ? `${code}: ${detail}` : code);
  e.code = code;
  return e;
}

// Exclusive create lock (reuses the repo's {flag:"wx"} migration-lock pattern)
// so two concurrent `serve start web` cannot both spawn (spec M2).
export async function acquireStartLock(stateRoot, name) {
  const lockPath = `${servicePaths(stateRoot, name).pid}.lock`;
  try {
    await fs.writeFile(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code === "EEXIST") throw typedError("service_start_in_progress", name);
    throw error;
  }
  return { release: async () => { await fs.rm(lockPath, { force: true }); } };
}

// Is the service currently backed by a live, identity-matched worker?
export async function isRunning(stateRoot, name) {
  const rec = await readPidRecord(stateRoot, name).catch(() => null);
  return rec ? verifyIdentity(rec, name) : false;
}

export async function startService({ stateRoot, name, spawnProcess = spawn, waitForPid = true, cwd = process.cwd() }) {
  const def = await readDefinition(stateRoot, name);
  if (!def) throw typedError("unknown_service", name);
  if (await isRunning(stateRoot, name)) throw typedError("service_already_running", name);

  const lock = await acquireStartLock(stateRoot, name);
  try {
    const paths = servicePaths(stateRoot, name);
    // O_NOFOLLOW append fd for the worker's stdout/stderr (spec H2).
    const logFh = await fs.open(paths.log, fsConstants.constants.O_CREAT | fsConstants.constants.O_WRONLY | fsConstants.constants.O_APPEND | fsConstants.constants.O_NOFOLLOW, 0o600);
    try {
      await logFh.chmod(0o600).catch(() => {});
      const child = spawnProcess(process.execPath, [
        BIN_ENTRY, "serve", "run", name, "--foreground", "--state-dir", stateRoot,
      ], {
        cwd,
        detached: true,
        stdio: ["ignore", logFh.fd, logFh.fd],
      });
      if (child && typeof child.unref === "function") child.unref();
    } finally {
      await logFh.close();
    }
    // The worker writes its own pid record as its first action (closes the
    // parent-crash orphan window — spec M3). Optionally wait for it to appear.
    if (waitForPid) await waitForPidRecord(stateRoot, name);
    const rec = await readPidRecord(stateRoot, name).catch(() => null);
    return { name, pid: rec?.pid ?? null, port: rec?.port ?? def.port ?? null };
  } finally {
    await lock.release();
  }
}

async function waitForPidRecord(stateRoot, name, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rec = await readPidRecord(stateRoot, name).catch(() => null);
    if (rec && isAlive(rec.pid)) return rec;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw typedError("service_start_failed", `${name} (worker did not report a pid; check \`maestro serve logs ${name}\`)`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/maestro-serve-lifecycle.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/serve/lifecycle.mjs test/maestro-serve-lifecycle.test.mjs
git commit -m "feat(serve): detached worker spawn with exclusive start lock"
```

---

## Task 7: Lifecycle — identity-verified stop, pause, resume

**Files:**
- Modify: `src/cli/serve/lifecycle.mjs`
- Test: `test/maestro-serve-lifecycle.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// append to test/maestro-serve-lifecycle.test.mjs
import { stopService, pauseService, resumeService } from "../src/cli/serve/lifecycle.mjs";
import { readDefinition } from "../src/cli/serve/store.mjs";
import { spawn } from "node:child_process";

test("stopService signals a real child and removes its pid record", async () => {
  const root = await tmpRoot();
  await writeDefinition(root, "web", { slug: "WEB" });
  // a real long-lived child we are allowed to kill
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1e9)"], { stdio: "ignore" });
  const { readStartTime } = await import("../src/cli/serve/proc.mjs");
  await writePidRecord(root, "web", { pid: child.pid, startTimeMs: readStartTime(child.pid), argv0: "node" });
  const res = await stopService({ stateRoot: root, name: "web" });
  assert.equal(res.stopped, true);
  assert.equal(await readPidRecord(root, "web"), null);
  // child is gone
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((() => { try { process.kill(child.pid, 0); return true; } catch { return false; } })(), false);
});

test("stopService refuses to signal a pid whose identity does not match", async () => {
  const root = await tmpRoot();
  await writeDefinition(root, "web", { slug: "WEB" });
  // record claims our pid but with a bogus startTime → identity mismatch
  await writePidRecord(root, "web", { pid: process.pid, startTimeMs: 123456789 });
  const res = await stopService({ stateRoot: root, name: "web" });
  assert.equal(res.signaled, false); // did NOT signal us
  assert.equal(await readPidRecord(root, "web"), null); // stale record cleaned
});

test("pause stops + marks paused; resume clears paused", async () => {
  const root = await tmpRoot();
  await writeDefinition(root, "web", { slug: "WEB", paused: false });
  await pauseService({ stateRoot: root, name: "web" });
  assert.equal((await readDefinition(root, "web")).paused, true);
  // resume calls startService → inject a fake spawn that writes a pid
  await resumeService({
    stateRoot: root, name: "web", waitForPid: false,
    spawnProcess: (cmd) => { writePidRecord(root, "web", { pid: 91, startTimeMs: 1, argv0: cmd }); return { unref() {} }; },
  });
  assert.equal((await readDefinition(root, "web")).paused, false);
});
```

> On Linux, `readStartTime` reflects the platform check; on non-linux it returns `null` and identity falls back to liveness, so the mismatch test asserts behavior only meaningful on linux (the project's platform). Guard the mismatch test with `if (process.platform !== "linux") return;` at its top.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/maestro-serve-lifecycle.test.mjs`
Expected: FAIL — `stopService`/`pauseService`/`resumeService` not exported.

- [ ] **Step 3: Write minimal implementation**

```js
// append to src/cli/serve/lifecycle.mjs
import { writeDefinition } from "./store.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stop a service: verify identity BEFORE signaling so we never SIGKILL an
// OS-recycled pid (spec C1). Always clears the pid record afterward.
export async function stopService({ stateRoot, name, graceMs = 3000 }) {
  const rec = await readPidRecord(stateRoot, name).catch(() => null);
  const paths = servicePaths(stateRoot, name);
  if (!rec) return { stopped: false, signaled: false, reason: "not_running" };

  if (!verifyIdentity(rec, name)) {
    // Stale / recycled / foreign — do NOT signal; just clean the record.
    await removeFile(paths.pid);
    return { stopped: true, signaled: false, reason: "stale" };
  }

  try { process.kill(rec.pid, "SIGTERM"); } catch { /* already gone */ }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && verifyIdentity(rec, name)) await sleep(100);
  if (verifyIdentity(rec, name)) {
    try { process.kill(rec.pid, "SIGKILL"); } catch { /* gone */ }
  }
  await removeFile(paths.pid);
  return { stopped: true, signaled: true, reason: "signaled" };
}

export async function pauseService({ stateRoot, name }) {
  await stopService({ stateRoot, name });
  const def = (await readDefinition(stateRoot, name)) ?? {};
  await writeDefinition(stateRoot, name, { ...def, paused: true });
  return { paused: true };
}

export async function resumeService({ stateRoot, name, spawnProcess, waitForPid }) {
  const def = (await readDefinition(stateRoot, name)) ?? {};
  await writeDefinition(stateRoot, name, { ...def, paused: false });
  return startService({ stateRoot, name, spawnProcess, waitForPid });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/maestro-serve-lifecycle.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/serve/lifecycle.mjs test/maestro-serve-lifecycle.test.mjs
git commit -m "feat(serve): identity-verified stop, pause, resume"
```

---

## Task 8: Status derivation + formatting + warnings

**Files:**
- Create: `src/cli/serve/format.mjs`
- Modify: `src/cli/serve/lifecycle.mjs` (add `serviceStatus`/`listStatuses`)
- Test: `test/maestro-serve-lifecycle.test.mjs`, `test/maestro-serve-commands.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// test/maestro-serve-commands.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureServicesDir, writeDefinition, writePidRecord } from "../src/cli/serve/store.mjs";
import { listStatuses } from "../src/cli/serve/lifecycle.mjs";
import { formatStatusTable, formatStartFeedback, collectWarnings, emptyGuidance } from "../src/cli/serve/format.mjs";

async function tmpRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-cmd-"));
  await ensureServicesDir(root);
  return root;
}

test("listStatuses reports stopped/paused/running states", async () => {
  const root = await tmpRoot();
  await writeDefinition(root, "alpha", { slug: "ALP" });                 // stopped
  await writeDefinition(root, "beta", { slug: "BET", paused: true });    // paused
  await writeDefinition(root, "live", { slug: "LIV" });
  await writePidRecord(root, "live", { pid: process.pid, startTimeMs: null }); // running (best-effort)
  const rows = await listStatuses(root);
  const byName = Object.fromEntries(rows.map((r) => [r.name, r.state]));
  assert.equal(byName.alpha, "stopped");
  assert.equal(byName.beta, "paused");
  assert.equal(byName.live, "running");
});

test("formatStatusTable renders aligned columns; emptyGuidance lists next steps", () => {
  const out = formatStatusTable([{ name: "web", slug: "WEB", port: 4100, state: "running", pid: 42 }]);
  assert.match(out, /NAME/);
  assert.match(out, /web/);
  assert.match(out, /running/);
  assert.match(emptyGuidance(), /serve add/);
});

test("collectWarnings flags missing key, port collision, missing slug", () => {
  const warns = collectWarnings({
    defs: [{ name: "a", slug: "A", port: 4100, var: "LINEAR_API_KEY" }, { name: "b", slug: "B", port: 4100, var: "MISSING_KEY" }],
    env: { LINEAR_API_KEY: "x" },
  });
  const text = warns.join("\n");
  assert.match(text, /port 4100/);     // collision between a and b
  assert.match(text, /MISSING_KEY/);   // unset key for b
});

test("formatStartFeedback shows pid, port, logs and stop hint", () => {
  const out = formatStartFeedback({ name: "web", pid: 42, port: 4100, slug: "WEB", intervalMs: 30000, stateDir: "/s/services/web" });
  assert.match(out, /pid 42/);
  assert.match(out, /4100/);
  assert.match(out, /serve logs web/);
  assert.match(out, /serve stop web/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/maestro-serve-commands.test.mjs`
Expected: FAIL — `listStatuses`/format helpers not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/cli/serve/lifecycle.mjs`:

```js
import { listDefinitions } from "./store.mjs";

export async function serviceStatus(stateRoot, name) {
  const def = await readDefinition(stateRoot, name);
  if (!def) return null;
  const rec = await readPidRecord(stateRoot, name).catch(() => null);
  let state;
  if (rec && verifyIdentity(rec, name)) state = "running";
  else if (rec) state = "crashed";        // pid record present but dead/mismatch
  else if (def.paused) state = "paused";
  else state = "stopped";
  return { name, slug: def.slug, port: def.port ?? rec?.port ?? null, paused: !!def.paused, state, pid: state === "running" ? rec.pid : null };
}

export async function listStatuses(stateRoot) {
  const names = await listDefinitions(stateRoot);
  return Promise.all(names.map((n) => serviceStatus(stateRoot, n)));
}
```

Create `src/cli/serve/format.mjs`:

```js
// src/cli/serve/format.mjs
import { ENV_KEY_DENYLIST } from "../../agent-runner.mjs";

function pad(s, n) { s = String(s); return s + " ".repeat(Math.max(0, n - s.length)); }

export function formatStatusTable(rows) {
  const header = `${pad("NAME", 12)}${pad("SLUG", 10)}${pad("PORT", 8)}STATE`;
  const lines = rows.map((r) => {
    const state = r.state === "running" ? `running (pid ${r.pid})` : r.state === "crashed" ? "crashed (stale)" : r.state;
    return `${pad(r.name, 12)}${pad(r.slug ?? "-", 10)}${pad(r.port ?? "-", 8)}${state}`;
  });
  return [header, ...lines].join("\n") + "\n";
}

export function emptyGuidance() {
  return [
    "No services configured.",
    "  Add one:  maestro serve add <name> --slug <SLUG>",
    "  Then:     maestro serve start <name>",
    "",
  ].join("\n");
}

export function formatStartFeedback({ name, pid, port, slug, intervalMs, stateDir }) {
  const lines = [
    `✓ service '${name}' started`,
    `  pid ${pid} · tracker ${slug} · polling every ${Math.round((intervalMs ?? 30000) / 1000)}s` +
      (port ? ` · HTTP http://127.0.0.1:${port}` : ""),
    `  state: ${stateDir}`,
    `  logs:  maestro serve logs ${name} -f`,
    `  stop:  maestro serve stop ${name}`,
  ];
  return lines.join("\n") + "\n";
}

// Non-fatal advisories surfaced at add/list/start.
export function collectWarnings({ defs, env }) {
  const warnings = [];
  const portMap = new Map();
  for (const d of defs) {
    if (d.port != null) {
      if (portMap.has(d.port)) warnings.push(`port ${d.port} is used by both '${portMap.get(d.port)}' and '${d.name}'`);
      else portMap.set(d.port, d.name);
    }
    const varName = d.var ?? "LINEAR_API_KEY";
    if (ENV_KEY_DENYLIST.test(varName)) warnings.push(`service '${d.name}': api-key var ${varName} is denylisted`);
    else if (!env[varName]) warnings.push(`service '${d.name}': ${varName} is unset — it won't be able to poll`);
    if (!d.slug) warnings.push(`service '${d.name}': missing slug`);
  }
  return warnings;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/maestro-serve-commands.test.mjs test/maestro-serve-lifecycle.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/serve/format.mjs src/cli/serve/lifecycle.mjs test/maestro-serve-commands.test.mjs
git commit -m "feat(serve): status derivation, table/feedback formatting, warnings"
```

---

## Task 9: `logs` (tail / follow)

**Files:**
- Modify: `src/cli/serve/lifecycle.mjs` (add `tailServiceLog`)
- Test: `test/maestro-serve-lifecycle.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// append to test/maestro-serve-lifecycle.test.mjs
import { tailServiceLog } from "../src/cli/serve/lifecycle.mjs";
import { servicePaths } from "../src/cli/serve/store.mjs";

test("tailServiceLog returns the last N lines of a service log", async () => {
  const root = await tmpRoot();
  await writeDefinition(root, "web", { slug: "WEB" });
  const { log } = servicePaths(root, "web");
  await fs.writeFile(log, Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n") + "\n");
  const out = await tailServiceLog({ stateRoot: root, name: "web", lines: 3 });
  assert.equal(out.trim().split("\n").length, 3);
  assert.match(out, /line 49/);
});

test("tailServiceLog on a missing log returns empty string", async () => {
  const root = await tmpRoot();
  await writeDefinition(root, "web", { slug: "WEB" });
  assert.equal(await tailServiceLog({ stateRoot: root, name: "web", lines: 5 }), "");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/maestro-serve-lifecycle.test.mjs`
Expected: FAIL — `tailServiceLog` not exported.

- [ ] **Step 3: Write minimal implementation**

```js
// append to src/cli/serve/lifecycle.mjs
import { tailFile } from "../../fs-safe.mjs";

// Bounded tail of the worker log. tailFile reads at most maxBytes from the end,
// so an unbounded log never floods. Follow-mode (-f) is handled by the command
// layer via fs.watch; this returns the current tail.
export async function tailServiceLog({ stateRoot, name, lines = 40, maxBytes = 65536 }) {
  const { log } = servicePaths(stateRoot, name);
  const text = await tailFile(log, maxBytes);
  if (text == null) return "";
  const split = text.split("\n");
  const tail = split.slice(Math.max(0, split.length - lines - 1));
  return tail.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/maestro-serve-lifecycle.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/serve/lifecycle.mjs test/maestro-serve-lifecycle.test.mjs
git commit -m "feat(serve): bounded service log tail"
```

---

## Task 10: Command dispatcher + worker entrypoint (`runServeCommand`)

**Files:**
- Create: `src/cli/serve/commands.mjs`
- Test: `test/maestro-serve-commands.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// append to test/maestro-serve-commands.test.mjs
import { runServeCommand } from "../src/cli/serve/commands.mjs";
import { readDefinition, listDefinitions } from "../src/cli/serve/store.mjs";

function capture() {
  let out = "", err = "";
  return { stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, get out() { return out; }, get err() { return err; } };
}

test("serve add writes a definition and prints next steps", async () => {
  const root = await tmpRoot();
  const cap = capture();
  await runServeCommand({ args: ["serve", "add", "web", "--slug", "WEB", "--port", "4100", "--state-dir", root], stdout: cap.stdout, stderr: cap.stderr, env: {} });
  assert.deepEqual(await readDefinition(root, "web"), { slug: "WEB", port: 4100, paused: false });
  assert.match(cap.out, /serve start web/);
});

test("serve add rejects an invalid name and a literal api key", async () => {
  const root = await tmpRoot();
  const cap = capture();
  await assert.rejects(
    () => runServeCommand({ args: ["serve", "add", "../evil", "--slug", "X", "--state-dir", root], stdout: cap.stdout, stderr: cap.stderr, env: {} }),
    /invalid_service_name/,
  );
});

test("serve list with no services prints guidance", async () => {
  const root = await tmpRoot();
  const cap = capture();
  await runServeCommand({ args: ["serve", "list", "--state-dir", root], stdout: cap.stdout, stderr: cap.stderr, env: {} });
  assert.match(cap.out, /No services configured/);
});

test("serve rm deletes the definition (and derived files) for a stopped service", async () => {
  const root = await tmpRoot();
  await runServeCommand({ args: ["serve", "add", "web", "--slug", "WEB", "--state-dir", root], stdout: capture().stdout, stderr: capture().stderr, env: {} });
  await runServeCommand({ args: ["serve", "rm", "web", "--force", "--state-dir", root], stdout: capture().stdout, stderr: capture().stderr, env: {} });
  assert.deepEqual(await listDefinitions(root), []);
});

test("serve start delegates to startService with an injected spawn", async () => {
  const root = await tmpRoot();
  await runServeCommand({ args: ["serve", "add", "web", "--slug", "WEB", "--port", "4100", "--state-dir", root], stdout: capture().stdout, stderr: capture().stderr, env: {} });
  const cap = capture();
  const { writePidRecord } = await import("../src/cli/serve/store.mjs");
  await runServeCommand({
    args: ["serve", "start", "web", "--state-dir", root],
    stdout: cap.stdout, stderr: cap.stderr, env: { LINEAR_API_KEY: "k" },
    spawnProcess: (cmd) => { writePidRecord(root, "web", { pid: 77, startTimeMs: 1, argv0: cmd, port: 4100 }); return { unref() {} }; },
    waitForPid: false,
  });
  assert.match(cap.out, /service 'web' started/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/maestro-serve-commands.test.mjs`
Expected: FAIL — `runServeCommand` not found.

- [ ] **Step 3: Write minimal implementation**

```js
// src/cli/serve/commands.mjs
import path from "node:path";

import { DEFAULT_LOCAL_STATE_DIR } from "../../task-store.mjs";
import { startMaestro } from "../runtime.mjs";
import { StructuredLogger } from "../../logger.mjs";

import {
  ensureServicesDir, writeDefinition, readDefinition, listDefinitions, servicePaths, removeFile, writePidRecord,
} from "./store.mjs";
import { validateOverlayFields, buildOverlay } from "./resolve.mjs";
import {
  startService, stopService, pauseService, resumeService, isRunning, serviceStatus, listStatuses, tailServiceLog,
} from "./lifecycle.mjs";
import { formatStatusTable, emptyGuidance, formatStartFeedback, collectWarnings } from "./format.mjs";

function typedError(code, detail) { const e = new Error(detail ? `${code}: ${detail}` : code); e.code = code; return e; }

function parse(args) {
  // args = ["serve", <sub?>, ...positional/flags]; we own everything after "serve".
  const rest = args.slice(1);
  let stateRoot = path.resolve(process.cwd(), DEFAULT_LOCAL_STATE_DIR);
  const positional = [];
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === "--state-dir") { stateRoot = path.resolve(process.cwd(), rest[++i] ?? ""); continue; }
    if (a === "--slug") { flags.slug = rest[++i]; continue; }
    if (a === "--port") { flags.port = Number(rest[++i]); continue; }
    if (a === "--workflow") { flags.workflow = rest[++i]; continue; }
    if (a === "--var") { flags.var = rest[++i]; continue; }
    if (a === "--workspace") { flags.workspace = rest[++i]; continue; }
    if (a === "--shared-state") { flags.shared_state = true; continue; }
    if (a === "--force") { flags.force = true; continue; }
    if (a === "--all") { flags.all = true; continue; }
    if (a === "-f" || a === "--follow") { flags.follow = true; continue; }
    if (a === "-n") { flags.lines = Number(rest[++i]); continue; }
    if (a === "--foreground") { flags.foreground = true; continue; }
    if (a === "--json") { flags.json = true; continue; }
    positional.push(a);
  }
  return { stateRoot, sub: positional[0], rest: positional.slice(1), flags };
}

export async function runServeCommand({ args, stdout = process.stdout, stderr = process.stderr, env = process.env, spawnProcess, waitForPid, logger } = {}) {
  const { stateRoot, sub, rest, flags } = parse(args);
  await ensureServicesDir(stateRoot);
  const write = (s) => stdout.write(s);
  const writeErr = (s) => stderr.write(s);

  // Bare `serve` and `serve list` → status table or guidance.
  if (sub === undefined || sub === "list") {
    const rows = await listStatuses(stateRoot);
    if (flags.json) { write(JSON.stringify(rows, null, 2) + "\n"); return {}; }
    if (rows.length === 0) { write(emptyGuidance()); return {}; }
    write(formatStatusTable(rows));
    const defs = await Promise.all((await listDefinitions(stateRoot)).map(async (n) => ({ name: n, ...(await readDefinition(stateRoot, n)) })));
    for (const w of collectWarnings({ defs, env })) writeErr(`warning: ${w}\n`);
    return {};
  }

  if (sub === "add") {
    const name = rest[0];
    if (!name) throw typedError("usage", "maestro serve add <name> --slug <SLUG>");
    const def = {
      slug: flags.slug,
      ...(flags.port != null ? { port: flags.port } : {}),
      ...(flags.workflow ? { workflow: flags.workflow } : {}),
      ...(flags.var ? { var: flags.var } : {}),
      ...(flags.workspace ? { workspace: flags.workspace } : {}),
      ...(flags.shared_state ? { shared_state: true } : {}),
      paused: false,
    };
    validateOverlayFields(def);                  // throws on bad slug/port/var/literal-key
    if (await readDefinition(stateRoot, name)) throw typedError("service_exists", name);
    await writeDefinition(stateRoot, name, def); // store.assertValidServiceName guards the name
    write(`✓ service '${name}' added (${def.slug})\n  start it:  maestro serve start ${name}\n`);
    const defs = [{ name, ...def }];
    for (const w of collectWarnings({ defs, env })) writeErr(`warning: ${w}\n`);
    return {};
  }

  if (sub === "edit") {
    const name = rest[0];
    const cur = await readDefinition(stateRoot, name);
    if (!cur) throw typedError("unknown_service", name);
    const next = { ...cur };
    if (flags.slug != null) next.slug = flags.slug;
    if (flags.port != null) next.port = flags.port;
    if (flags.workflow != null) next.workflow = flags.workflow;
    if (flags.var != null) next.var = flags.var;
    if (flags.workspace != null) next.workspace = flags.workspace;
    if (flags.shared_state) next.shared_state = true;
    validateOverlayFields(next);
    await writeDefinition(stateRoot, name, next);
    write(`✓ service '${name}' updated\n`);
    if (await isRunning(stateRoot, name)) writeErr(`warning: '${name}' is running — restart to apply: maestro serve stop ${name} && maestro serve start ${name}\n`);
    return {};
  }

  if (sub === "rm") {
    const name = rest[0];
    if (!(await readDefinition(stateRoot, name))) throw typedError("unknown_service", name);
    if (await isRunning(stateRoot, name)) {
      if (!flags.force) throw typedError("service_running", `${name} is running — stop it first or pass --force`);
      await stopService({ stateRoot, name });
    }
    const p = servicePaths(stateRoot, name);
    for (const f of [p.def, p.pid, p.log, `${p.pid}.lock`]) await removeFile(f);
    await removeFile(p.stateDir).catch(() => {}); // best-effort isolated state cleanup
    write(`✓ service '${name}' removed\n`);
    return {};
  }

  if (sub === "start") {
    const targets = flags.all ? await pickStartable(stateRoot) : [requireName(rest)];
    for (const name of targets) {
      const res = await startService({ stateRoot, name, spawnProcess, waitForPid });
      const status = await serviceStatus(stateRoot, name);
      write(formatStartFeedback({ name, pid: res.pid, port: res.port, slug: status?.slug, intervalMs: 30000, stateDir: servicePaths(stateRoot, name).stateDir }));
    }
    return {};
  }

  if (sub === "stop") {
    const targets = flags.all ? await listDefinitions(stateRoot) : [requireName(rest)];
    for (const name of targets) {
      const res = await stopService({ stateRoot, name });
      write(`${res.stopped ? "✓ stopped" : "— not running"} '${name}'${res.reason === "stale" ? " (stale record cleaned)" : ""}\n`);
    }
    return {};
  }

  if (sub === "pause") { await pauseService({ stateRoot, name: requireName(rest) }); write(`✓ service '${rest[0]}' paused\n`); return {}; }
  if (sub === "resume") {
    const name = requireName(rest);
    const res = await resumeService({ stateRoot, name, spawnProcess, waitForPid });
    const status = await serviceStatus(stateRoot, name);
    write(formatStartFeedback({ name, pid: res.pid, port: res.port, slug: status?.slug, intervalMs: 30000, stateDir: servicePaths(stateRoot, name).stateDir }));
    return {};
  }

  if (sub === "status") {
    const s = await serviceStatus(stateRoot, requireName(rest));
    if (!s) throw typedError("unknown_service", rest[0]);
    write(formatStatusTable([s]));
    return {};
  }

  if (sub === "logs") {
    const name = requireName(rest);
    write(await tailServiceLog({ stateRoot, name, lines: flags.lines ?? 40 }) + "\n");
    if (flags.follow) await followLog({ stateRoot, name, write });
    return {};
  }

  if (sub === "adopt") { return runAdopt({ stateRoot, rest, write, writeErr }); }

  // The worker entrypoint: resolve the overlay and run the real poller.
  if (sub === "run") {
    const name = requireName(rest);
    return runWorker({ stateRoot, name, env, logger });
  }

  throw typedError("usage", `unknown serve subcommand: ${sub}`);
}

function requireName(rest) { if (!rest[0]) throw typedError("usage", "a service name is required"); return rest[0]; }

async function pickStartable(stateRoot) {
  const rows = await listStatuses(stateRoot);
  return rows.filter((r) => !r.paused && r.state !== "running").map((r) => r.name);
}

async function followLog({ stateRoot, name, write }) {
  const fs = await import("node:fs");
  const { log } = servicePaths(stateRoot, name);
  return new Promise(() => {
    let size = 0;
    try { size = fs.statSync(log).size; } catch {}
    fs.watch(log, { persistent: true }, () => {
      try {
        const cur = fs.statSync(log).size;
        if (cur > size) { const buf = Buffer.alloc(cur - size); const fd = fs.openSync(log, "r"); fs.readSync(fd, buf, 0, buf.length, size); fs.closeSync(fd); write(buf.toString("utf8")); size = cur; }
      } catch {}
    });
  });
}

// The worker process: write our own pid record FIRST (orphan-safe), install
// signal handlers that clean it up, then run the existing poller via the
// startMaestro overlay seam.
async function runWorker({ stateRoot, name, env, logger = new StructuredLogger() }) {
  const def = await readDefinition(stateRoot, name);
  if (!def) throw typedError("unknown_service", name);
  const { serverOverlay, stateDir } = buildOverlay({ name, def, stateRoot });

  const { readStartTime } = await import("./proc.mjs");
  await writePidRecord(stateRoot, name, {
    pid: process.pid,
    startTimeMs: readStartTime(process.pid),
    argv0: process.execPath,
    port: def.port ?? null,
  });
  const cleanup = () => { try { require("node:fs").rmSync(servicePaths(stateRoot, name).pid, { force: true }); } catch {} };
  process.on("exit", cleanup);

  const service = await startMaestro({ stateDir, overlay: serverOverlay, env, logger });
  const shutdown = async () => { try { await service.stop(); } finally { cleanup(); process.exit(0); } };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return new Promise(() => {}); // run until signaled
}

async function runAdopt({ stateRoot, rest, write, writeErr }) {
  // Materialize legacy server.tracker into a 'default' service (spec §7).
  const name = rest[0] ?? "default";
  const { LocalTaskStore } = await import("../../task-store.mjs");
  const store = new LocalTaskStore({ root: stateRoot });
  await store.init();
  const cfg = await store.readConfig();
  const tracker = cfg.server?.tracker;
  if (!tracker?.project_slug) throw typedError("nothing_to_adopt", "no configured server.tracker found");
  if (await readDefinition(stateRoot, name)) throw typedError("service_exists", name);
  await writeDefinition(stateRoot, name, { slug: tracker.project_slug, paused: false });
  write(`✓ adopted legacy tracker as service '${name}' (${tracker.project_slug})\n`);
  if (cfg.server?.hooks && Object.values(cfg.server.hooks).some((v) => typeof v === "string" && v)) {
    writeErr(`warning: this config defines hooks that run via the shell — review before \`maestro serve start ${name}\`\n`);
  }
  return {};
}
```

> The `require("node:fs")` inside `cleanup` is intentional: `process.on("exit")` handlers must be synchronous, so a sync `rmSync` via `createRequire` is used. At the top of `commands.mjs` add: `import { createRequire } from "node:module"; const require = createRequire(import.meta.url);`

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/maestro-serve-commands.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/serve/commands.mjs test/maestro-serve-commands.test.mjs
git commit -m "feat(serve): command dispatcher + overlay-resolving worker entrypoint"
```

---

## Task 11: CLI routing — registry tree + `routeCli` + local dispatch

**Files:**
- Modify: `src/cli/registry.mjs` (the `serve` node ~434-443; `routeCli` ~597-599)
- Modify: `src/cli/local-command.mjs` (add `command === "serve"` branch)
- Test: `test/maestro-cli-registry.test.mjs`, `test/maestro-serve-commands.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// add to test/maestro-cli-registry.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { routeCli } from "../src/cli/registry.mjs";

test("serve management subcommands route as local; serve run --foreground routes to serve", () => {
  assert.equal(routeCli(["serve"]).kind, "local");
  assert.equal(routeCli(["serve", "list"]).kind, "local");
  assert.equal(routeCli(["serve", "add", "web", "--slug", "WEB"]).kind, "local");
  assert.equal(routeCli(["serve", "start", "web"]).kind, "local");
  const worker = routeCli(["serve", "run", "web", "--foreground"]);
  assert.equal(worker.kind, "local"); // worker handled inside the local serve dispatcher
});

test("serve is registered as a subcommand group", () => {
  const help = routeCli(["serve", "--help"]);
  assert.equal(help.kind, "help");
  assert.match(help.text, /add/);
  assert.match(help.text, /pause/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/maestro-cli-registry.test.mjs`
Expected: FAIL — bare `serve` currently routes to `{kind:"serve"}`, not `local`.

- [ ] **Step 3: Write minimal implementation**

In `src/cli/registry.mjs`, replace the flat `serve` node (lines ~434-443) with a subcommand group, and make it a `local` command so `LOCAL_COMMAND_SET` includes it:

```js
{
  name: "serve",
  kind: "local",
  synopsis: "maestro serve <subcommand>",
  summary: "manage background tracker-polling services",
  subcommands: [
    { name: "list", synopsis: "maestro serve list [--json]", summary: "show all services + state" },
    { name: "add", synopsis: "maestro serve add <name> --slug <SLUG> [--port N --workflow W --var NAME --workspace DIR --shared-state]", summary: "register a service" },
    { name: "edit", synopsis: "maestro serve edit <name> [--slug … --port … …]", summary: "update a service definition" },
    { name: "rm", synopsis: "maestro serve rm <name> [--force]", summary: "remove a service" },
    { name: "start", synopsis: "maestro serve start <name|--all>", summary: "start service(s) in the background" },
    { name: "stop", synopsis: "maestro serve stop <name|--all>", summary: "stop service(s)" },
    { name: "pause", synopsis: "maestro serve pause <name>", summary: "stop + mark paused" },
    { name: "resume", synopsis: "maestro serve resume <name>", summary: "clear paused + start" },
    { name: "status", synopsis: "maestro serve status <name>", summary: "detail for one service" },
    { name: "logs", synopsis: "maestro serve logs <name> [-f] [-n N]", summary: "tail a worker log" },
    { name: "adopt", synopsis: "maestro serve adopt [name]", summary: "materialize a legacy tracker as a service" },
    { name: "run", synopsis: "maestro serve run <name> --foreground", summary: "(internal) foreground worker entrypoint" },
  ],
  flags: [STATE_DIR_FLAG],
},
```

Then update `routeCli` (remove the special `if (first === "serve")` block at ~597-599). Because `serve` is now `kind:"local"`, it falls into the existing `if (LOCAL_COMMAND_SET.has(first)) return { kind: "local" };` branch automatically. Delete:

```js
  if (first === "serve") {
    return { kind: "serve", serverArgs: rawArgs.slice(1) };
  }
```

In `src/cli/local-command.mjs`, add a branch (near the other top-level command branches, e.g. after the `project` branch at ~95):

```js
  if (command === "serve") {
    const { runServeCommand } = await import("./serve/commands.mjs");
    return runServeCommand({ args, stdout, stderr, env: process.env, spawnProcess });
  }
```

> `main.mjs` already routes `kind:"local"` through `runLocalMaestroCommand`. The old `route.kind === "serve"` branch in `main.mjs` (lines ~35-37) becomes dead for the management path; leave it in place only if anything else emits `kind:"serve"` — since we removed the sole producer, also delete the `serverArgv = route.kind === "serve" ? … : process.argv` conditional, simplifying to `const args = parseServerArgs(process.argv);` for the remaining `kind:"server"` (bare flag-only) path.

- [ ] **Step 4: Run tests**

Run: `node --test test/maestro-cli-registry.test.mjs test/maestro-serve-commands.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/registry.mjs src/cli/local-command.mjs src/cli/main.mjs test/maestro-cli-registry.test.mjs
git commit -m "feat(serve): route serve as a subcommand group, wire local dispatch"
```

---

## Task 12: Legacy auto-adopt on bare `serve`

**Files:**
- Modify: `src/cli/serve/commands.mjs` (bare/`list` branch)
- Test: `test/maestro-serve-commands.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// append to test/maestro-serve-commands.test.mjs
import { LocalTaskStore } from "../src/task-store.mjs";

test("bare serve with a legacy tracker and no services auto-adopts as 'default'", async () => {
  const root = await tmpRoot();
  const store = new LocalTaskStore({ root });
  await store.init();
  await store.writeConfig({ server: { tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "WEB" } } });
  const cap = capture();
  await runServeCommand({ args: ["serve", "--state-dir", root], stdout: cap.stdout, stderr: cap.stderr, env: {} });
  assert.match(cap.out, /default/);
  assert.equal((await readDefinition(root, "default")).slug, "WEB");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/maestro-serve-commands.test.mjs`
Expected: FAIL — bare serve currently prints guidance, doesn't auto-adopt.

- [ ] **Step 3: Write minimal implementation**

In the bare/`list` branch of `runServeCommand`, before printing `emptyGuidance()`, attempt auto-adopt:

```js
  if (sub === undefined || sub === "list") {
    let rows = await listStatuses(stateRoot);
    if (rows.length === 0) {
      const adopted = await tryAutoAdopt({ stateRoot, write, writeErr });
      if (adopted) rows = await listStatuses(stateRoot);
    }
    if (flags.json) { write(JSON.stringify(rows, null, 2) + "\n"); return {}; }
    if (rows.length === 0) { write(emptyGuidance()); return {}; }
    // …existing table + warnings…
  }
```

Add the helper:

```js
async function tryAutoAdopt({ stateRoot, write, writeErr }) {
  const { LocalTaskStore } = await import("../../task-store.mjs");
  const store = new LocalTaskStore({ root: stateRoot });
  await store.init();
  const tracker = (await store.readConfig()).server?.tracker;
  if (!tracker?.project_slug) return false;
  await writeDefinition(stateRoot, "default", { slug: tracker.project_slug, paused: false });
  write(`Found a configured tracker with no named service.\nTreating it as service 'default' (${tracker.project_slug}).\n  Make it explicit: maestro serve adopt default\n\n`);
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/maestro-serve-commands.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/serve/commands.mjs test/maestro-serve-commands.test.mjs
git commit -m "feat(serve): auto-adopt a legacy tracker as 'default' on bare serve"
```

---

## Task 13: Security regression tests + full-suite green

**Files:**
- Modify: `test/maestro-serve-store.test.mjs`, `test/maestro-serve-resolve.test.mjs`
- Test: all of the above

- [ ] **Step 1: Write the failing tests**

```js
// append to test/maestro-serve-store.test.mjs
test("servicePaths/assertValidServiceName rejects traversal before any fs touch", () => {
  assert.throws(() => servicePaths("/s", "../../etc/passwd"), /invalid_service_name/);
});

// append to test/maestro-serve-resolve.test.mjs
test("a definition cannot exfiltrate a denylisted env var via --var", () => {
  assert.throws(() => validateOverlayFields({ slug: "X", var: "LD_PRELOAD" }), /invalid_service_var/);
  assert.throws(() => validateOverlayFields({ slug: "X", var: "NODE_OPTIONS" }), /invalid_service_var/);
});
```

- [ ] **Step 2: Run to verify they fail (if not already covered)**

Run: `node --test test/maestro-serve-store.test.mjs test/maestro-serve-resolve.test.mjs`
Expected: PASS if logic from Tasks 1/4 is correct (these lock the behavior in). If any FAIL, fix the underlying guard.

- [ ] **Step 3: Run the full suite**

Run: `node --test`
Expected: all green. Fix any regressions (most likely: the removed `kind:"serve"` route — grep for `kind === "serve"` / `route.serverArgs` and confirm no dangling reference).

```bash
grep -rn '"serve"\|kind === "serve"\|serverArgs' src/cli/
```

- [ ] **Step 4: Manual smoke (optional but recommended)**

```bash
cd "$(mktemp -d)"
node ~/maestro/bin/maestro.mjs serve                       # → guidance
node ~/maestro/bin/maestro.mjs serve add web --slug WEB --port 4100
node ~/maestro/bin/maestro.mjs serve list                  # → table, warning about unset LINEAR_API_KEY
node ~/maestro/bin/maestro.mjs serve rm web --force
```

Expected: guidance → add confirmation → table with an unset-key warning → removal.

- [ ] **Step 5: Commit**

```bash
git add test/maestro-serve-store.test.mjs test/maestro-serve-resolve.test.mjs
git commit -m "test(serve): security regressions for name traversal + var exfiltration"
```

---

## Self-Review

**Spec coverage:**
- §2 data layout + schema → Tasks 1, 2 (paths, 0600/0700, def schema).
- §3 overlay + inherit, denylist `$VAR`, minimal env → Tasks 4, 5 (overlay seam), 10 (worker builds overlay). *Minimal constructed env for the child:* the worker inherits env but resolves only the named key; the stricter "constructed minimal env" is enforced at the `var` denylist + validation layer (Task 4). If full env-stripping for the child is desired, it is an additive hardening on the `spawnProcess` opts in Task 6 (documented, not blocking).
- §4 command table → Tasks 10, 11 (every subcommand + routing).
- §5 lifecycle/state machine → Tasks 6 (start+lock+self-pid), 7 (stop/pause/resume), 8 (status derivation).
- §6 per-service isolated state default → Task 4 (`buildOverlay` isolated default; `shared_state` opt-in).
- §7 back-compat auto-adopt + behavior-change note → Tasks 11 (routing note), 12 (auto-adopt).
- §8 orphan recovery → Task 10 (`adopt`; worker self-writes pid). *Full scan-for-orphans recovery* is implemented as the explicit `adopt <name>` materialization; a process-table scan is noted as a follow-up enhancement, not in v1 scope.
- §9 feedback/warnings → Task 8 (`formatStartFeedback`, `collectWarnings`), surfaced in Task 10.
- §10 security table → C1 (Task 3 + 7), C2 (Task 2), H1 (Task 1), H2 (Task 6 log O_NOFOLLOW), H3 (Task 4 denylist), H4 (Task 4 isolated default), M2 (Task 6 lock), M3 (Task 10 self-pid + cleanup), L1 (Task 10 adopt hook warning), L3 (Task 4 literal-key reject), L4 (Task 4 port validation). M1 (per-issue lease for shared store) is **deferred**: it only applies to opt-in `shared_state`, which v1 documents as carrying the double-dispatch caveat — add a follow-up task before promoting shared mode.
- §12 module layout → matches Tasks 1-10 file map.
- §13 testing → Tasks 1-13 test files.

**Placeholder scan:** no TBD/TODO; every code step has complete code. The two consciously-deferred items (full env-stripping, orphan process-table scan, shared-store lease) are called out explicitly with rationale, not left as silent gaps.

**Type consistency:** `servicePaths(stateRoot, name)` → `{dir, def, pid, log, stateDir}` used consistently. PID record shape `{pid, startTimeMs, argv0, port}` consistent across `writePidRecord`/`verifyIdentity`/`serviceStatus`/`runWorker`. `buildOverlay` → `{serverOverlay, stateDir}` consumed by `runWorker`. `startMaestro({overlay})` matches the seam added in Task 5. Lifecycle fn names (`startService`/`stopService`/`pauseService`/`resumeService`/`isRunning`/`serviceStatus`/`listStatuses`/`tailServiceLog`) are referenced identically in `commands.mjs`.

**Known platform note:** identity verification (`/proc`) is Linux-first (the project's platform); non-Linux falls back to liveness-only with documented residual TOCTOU — consistent with the spec.
