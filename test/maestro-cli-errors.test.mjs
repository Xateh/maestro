import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(PACKAGE_ROOT, "bin", "maestro.mjs");

// Run the CLI binary, never letting INIT_CWD/MAESTRO_CALLER_CWD leak in from the
// test runner's own environment (the runner is launched from a real .maestro).
async function runCli(args, { cwd, env = {} } = {}) {
  const childEnv = { ...process.env, INIT_CWD: "", MAESTRO_CALLER_CWD: "", ...env };
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, ...args], {
      cwd,
      env: childEnv,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-cli-errors-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("not-found errors print a single friendly line, no stack", async () => {
  await withTempDir(async (dir) => {
    const stateDir = path.join(dir, ".maestro");
    await mkdir(stateDir, { recursive: true });

    const { code, stderr } = await runCli(["inspect", "nope", "--state-dir", stateDir], { cwd: dir });

    assert.equal(code, 1);
    assert.match(stderr, /^maestro: task_not_found: nope/m);
    assert.doesNotMatch(stderr, /maestro_failed/);
    assert.doesNotMatch(stderr, /^\s+at /m); // no stack frames
  });
});

test("MAESTRO_DEBUG=1 restores the full stack trace", async () => {
  await withTempDir(async (dir) => {
    const stateDir = path.join(dir, ".maestro");
    await mkdir(stateDir, { recursive: true });

    const { code, stderr } = await runCli(["inspect", "nope", "--state-dir", stateDir], {
      cwd: dir,
      env: { MAESTRO_DEBUG: "1" },
    });

    assert.equal(code, 1);
    assert.match(stderr, /^\s+at /m); // stack frames present for debugging
  });
});

test("local command in an uninitialized dir asks the user to run init", async () => {
  await withTempDir(async (dir) => {
    const { code, stderr } = await runCli(["status"], { cwd: dir });

    assert.equal(code, 1);
    assert.match(stderr, /^maestro: no \.maestro\/ found here/m);
    assert.match(stderr, /maestro init/);
    // never silently fell back to the package checkout's state dir
    assert.doesNotMatch(stderr, /maestro_failed/);
    await assert.rejects(stat(path.join(dir, ".maestro")));
  });
});

test("init still works in an uninitialized dir", async () => {
  await withTempDir(async (dir) => {
    const { code } = await runCli(["init", "--yes"], { cwd: dir });
    assert.equal(code, 0);
    assert.ok((await stat(path.join(dir, ".maestro"))).isDirectory());
  });
});
