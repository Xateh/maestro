import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { resolveWorkspaceLocalInvocation } from "../bin/maestro.mjs";
import { parseCliArgs } from "../src/workflow.mjs";

// PACKAGE_ROOT is bin/../ == the maestro repo root
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("package contains the standalone Maestro implementation", async () => {
  const entry = await readFile(new URL("../bin/maestro.mjs", import.meta.url), "utf8");

  assert.match(entry, /from "\.\.\/src\/workflow\.mjs"/);
  assert.doesNotMatch(entry, /digital-twin-research/);
  assert.doesNotMatch(entry, /from "\.\/maestro\//); // no old-layout imports
  await access(new URL("../src/workflow.mjs", import.meta.url));
  await access(new URL("../src/tui.mjs", import.meta.url));
});

test("package.json declares Maestro runtime dependencies", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(pkg.scripts.maestro, "node bin/maestro.mjs");
  assert.equal(pkg.dependencies.yaml, "^2.9.0");
  assert.equal(pkg.dependencies.liquidjs, "^10.25.7");
});

test("Maestro modules load from package paths", () => {
  const parsed = parseCliArgs(["node", "bin/maestro.mjs", "ops/WORKFLOW.md", "--port", "0"]);

  assert.equal(parsed.workflowPath, path.resolve("ops/WORKFLOW.md"));
  assert.equal(parsed.port, 0);
});

test("local commands keep central state and use caller cwd", () => {
  const invocation = resolveWorkspaceLocalInvocation({
    args: ["tui"],
    env: { INIT_CWD: "/tmp/caller" },
    processCwd: PACKAGE_ROOT,
  });

  assert.equal(invocation.cwd, "/tmp/caller");
  assert.deepEqual(invocation.args, [
    "tui",
    "--state-dir",
    path.join(PACKAGE_ROOT, ".maestro"),
  ]);
});

test("unblock commands also use central Maestro state", () => {
  for (const command of ["message", "retry", "mark-done", "approve-action", "deny-action", "cancel"]) {
    const invocation = resolveWorkspaceLocalInvocation({
      args: [command, "task-1"],
      env: { INIT_CWD: "/tmp/caller" },
      processCwd: PACKAGE_ROOT,
    });

    assert.equal(invocation.cwd, "/tmp/caller");
    assert.deepEqual(invocation.args.slice(-2), [
      "--state-dir",
      path.join(PACKAGE_ROOT, ".maestro"),
    ]);
  }
});
