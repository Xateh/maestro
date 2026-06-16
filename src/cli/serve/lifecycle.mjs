import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsConstants from "node:fs";
import { fileURLToPath } from "node:url";

import { servicePaths, readDefinition, writeDefinition, readPidRecord, removeFile } from "./store.mjs";
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
    // parent-crash orphan window - spec M3). Optionally wait for it to appear.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stop a service: verify identity BEFORE signaling so we never SIGKILL an
// OS-recycled pid (spec C1). Always clears the pid record afterward.
export async function stopService({ stateRoot, name, graceMs = 3000 }) {
  const rec = await readPidRecord(stateRoot, name).catch(() => null);
  const paths = servicePaths(stateRoot, name);
  if (!rec) return { stopped: false, signaled: false, reason: "not_running" };

  if (!verifyIdentity(rec, name)) {
    // Stale / recycled / foreign - do NOT signal; just clean the record.
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
