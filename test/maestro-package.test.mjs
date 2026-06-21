import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import { parseServerArgs, resolveWorkspaceLocalInvocation } from "../bin/maestro.mjs";

// PACKAGE_ROOT is bin/../ == the maestro repo root
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("package contains the standalone Maestro implementation", async () => {
  const entry = await readFile(new URL("../bin/maestro.mjs", import.meta.url), "utf8");

  assert.match(entry, /from "\.\.\/src\/cli\/parse-args\.mjs"/);
  assert.doesNotMatch(entry, /digital-twin-research/);
  assert.doesNotMatch(entry, /from "\.\/maestro\//); // no old-layout imports
  await access(new URL("../src/setup/server-config.mjs", import.meta.url));
  await access(new URL("../src/tui.mjs", import.meta.url));
});

test("package.json declares Maestro runtime dependencies", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(pkg.scripts.maestro, "node bin/maestro.mjs");
  assert.equal(pkg.dependencies.yaml, "^2.9.0");
  assert.equal(pkg.dependencies.liquidjs, "^10.25.7");
});

test("package.json includes workflow authoring artifacts", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.ok(pkg.files.includes("schema/"));
  assert.ok(pkg.files.includes("examples/"));
});

test("package.json carries publish metadata", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(pkg.repository.url, "git+https://github.com/Xateh/maestro.git");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.author, "Xateh");
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.length > 0);
  assert.ok(pkg.scripts.prepublishOnly.includes("lint"));
});

test("Maestro modules load from package paths", () => {
  const parsed = parseServerArgs(["node", "bin/maestro.mjs", "--config", "ops/config.json", "--port", "0"]);

  assert.equal(parsed.configPath, "ops/config.json");
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

test("CLI runs without the node:sqlite ExperimentalWarning on stderr", async () => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [path.join(PACKAGE_ROOT, "bin", "maestro.mjs"), "help"],
    { cwd: PACKAGE_ROOT },
  );

  assert.ok(stdout.length > 0);
  assert.doesNotMatch(stderr, /ExperimentalWarning/);
});

test("warning suppressor passes other warnings through to stderr", async () => {
  const script = [
    'await import("./src/suppress-sqlite-warning.mjs");',
    'process.emitWarning("legacy api", "DeprecationWarning");',
    "await new Promise((resolve) => setImmediate(resolve));",
  ].join("\n");
  const { stderr } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { cwd: PACKAGE_ROOT },
  );

  assert.match(stderr, /DeprecationWarning: legacy api/);
});
