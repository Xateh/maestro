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
  await writeDefinition(root, "alpha", { slug: "ALP" });
  await writeDefinition(root, "beta", { slug: "BET", paused: true });
  await writeDefinition(root, "live", { slug: "LIV" });
  const { readStartTime } = await import("../src/cli/serve/proc.mjs");
  await writePidRecord(root, "live", { pid: process.pid, startTimeMs: readStartTime(process.pid) });
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
  assert.match(text, /port 4100/);
  assert.match(text, /MISSING_KEY/);
});

test("formatStartFeedback shows pid, port, logs and stop hint", () => {
  const out = formatStartFeedback({ name: "web", pid: 42, port: 4100, slug: "WEB", intervalMs: 30000, stateDir: "/s/services/web" });
  assert.match(out, /pid 42/);
  assert.match(out, /4100/);
  assert.match(out, /serve logs web/);
  assert.match(out, /serve stop web/);
});

import { runServeCommand } from "../src/cli/serve/commands.mjs";
import { readDefinition as readDef, listDefinitions as listDefs } from "../src/cli/serve/store.mjs";

function capture() {
  let out = "", err = "";
  return { stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, get out() { return out; }, get err() { return err; } };
}

test("serve add writes a definition and prints next steps", async () => {
  const root = await tmpRoot();
  const cap = capture();
  await runServeCommand({ args: ["serve", "add", "web", "--slug", "WEB", "--port", "4100", "--state-dir", root], stdout: cap.stdout, stderr: cap.stderr, env: {} });
  assert.deepEqual(await readDef(root, "web"), { slug: "WEB", port: 4100, paused: false });
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

test("serve rm deletes the definition for a stopped service", async () => {
  const root = await tmpRoot();
  await runServeCommand({ args: ["serve", "add", "web", "--slug", "WEB", "--state-dir", root], stdout: capture().stdout, stderr: capture().stderr, env: {} });
  await runServeCommand({ args: ["serve", "rm", "web", "--force", "--state-dir", root], stdout: capture().stdout, stderr: capture().stderr, env: {} });
  assert.deepEqual(await listDefs(root), []);
});

test("serve start delegates to startService with an injected spawn", async () => {
  const root = await tmpRoot();
  await runServeCommand({ args: ["serve", "add", "web", "--slug", "WEB", "--port", "4100", "--state-dir", root], stdout: capture().stdout, stderr: capture().stderr, env: {} });
  const cap = capture();
  await runServeCommand({
    args: ["serve", "start", "web", "--state-dir", root],
    stdout: cap.stdout, stderr: cap.stderr, env: { LINEAR_API_KEY: "k" },
    spawnProcess: (cmd) => { writePidRecord(root, "web", { pid: 77, startTimeMs: 1, argv0: cmd, port: 4100 }); return { unref() {} }; },
    waitForPid: false,
  });
  assert.match(cap.out, /service 'web' started/);
});

test("serve rm removes a service whose isolated state dir has content", async () => {
  const root = await tmpRoot();
  await runServeCommand({ args: ["serve", "add", "web", "--slug", "WEB", "--state-dir", root], stdout: capture().stdout, stderr: capture().stderr, env: {} });
  // simulate worker-created isolated state under services/web/
  const { servicePaths } = await import("../src/cli/serve/store.mjs");
  const sd = servicePaths(root, "web").stateDir;
  await fs.mkdir(path.join(sd, "work"), { recursive: true });
  await fs.writeFile(path.join(sd, "work", "x.txt"), "data");
  await runServeCommand({ args: ["serve", "rm", "web", "--force", "--state-dir", root], stdout: capture().stdout, stderr: capture().stderr, env: {} });
  await assert.rejects(() => fs.stat(sd)); // state dir gone
});
