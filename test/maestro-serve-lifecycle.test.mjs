import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureServicesDir, writeDefinition, writePidRecord, readPidRecord } from "../src/cli/serve/store.mjs";
import { startService, acquireStartLock } from "../src/cli/serve/lifecycle.mjs";
import { readStartTime } from "../src/cli/serve/proc.mjs";

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
    // simulate the worker writing its own pid record (worker contract)
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
  // Record this live process's real boot-stable identity so verifyIdentity
  // matches via the primary (starttime) path on Linux; on non-/proc platforms
  // verifyIdentity falls back to liveness alone, which also matches.
  await writePidRecord(root, "web", { pid: process.pid, startTimeMs: readStartTime(process.pid) });
  await assert.rejects(
    () => startService({ stateRoot: root, name: "web", spawnProcess: () => { throw new Error("should not spawn"); }, waitForPid: false }),
    /service_already_running/,
  );
});
