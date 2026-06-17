// test/maestro-serve-store.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

import { assertValidServiceName, servicePaths,
  ensureServicesDir, writeDefinition, readDefinition, listDefinitions,
  writePidRecord, readPidRecord, removeFile,
} from "../src/cli/serve/store.mjs";

test("assertValidServiceName accepts simple names, rejects traversal/control/empty", () => {
  assert.equal(assertValidServiceName("web"), "web");
  assert.equal(assertValidServiceName("infra-2"), "infra-2");
  for (const bad of ["", "../config", "a/b", "a.pid", "A", "-x", "..", ".", "a".repeat(65)]) {
    assert.throws(() => assertValidServiceName(bad), /invalid_service_name/, `should reject ${JSON.stringify(bad)}`);
  }
});

test("servicePaths rejects an invalid name before building paths", () => {
  assert.throws(() => servicePaths("/tmp/state", "../evil"), /invalid_service_name/);
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

test("removeFile deletes a file and is a no-op when absent", async () => {
  const root = await tmpRoot();
  await ensureServicesDir(root);
  await writeDefinition(root, "web", { slug: "WEB" });
  const p = path.join(root, "services", "web.json");
  await removeFile(p);
  assert.equal(await readDefinition(root, "web"), null);
  await removeFile(p); // no throw on missing
});

test("servicePaths/assertValidServiceName rejects traversal before any fs touch", () => {
  assert.throws(() => servicePaths("/s", "../../etc/passwd"), /invalid_service_name/);
});

test("readDefinition refuses a symlinked definition", async () => {
  const root = await tmpRoot();
  await ensureServicesDir(root);
  const target = path.join(root, "outside.json");
  await fs.writeFile(target, JSON.stringify({ slug: "X" }));
  await fs.symlink(target, path.join(root, "services", "evil.json"));
  await assert.rejects(() => readDefinition(root, "evil"), /service_file_symlink|ELOOP/);
});
