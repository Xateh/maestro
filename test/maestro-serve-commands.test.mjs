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
