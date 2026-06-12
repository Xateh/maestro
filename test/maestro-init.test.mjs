import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { resolveWorkspaceLocalInvocation } from "../bin/maestro.mjs";
import { runInitWizard } from "../src/setup/init.mjs";
import { DEFAULT_LOCAL_CONFIG_V2, DEFAULT_WORKFLOW } from "../src/task-store.mjs";

function makeOutput() {
  const stream = new PassThrough();
  let text = "";
  stream.on("data", (chunk) => { text += chunk; });
  return { stream, text: () => text };
}

function makeStdin() {
  const stream = new PassThrough();
  stream.isTTY = false;
  return stream;
}

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-init-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("init scaffolds a fresh .maestro directory", async () => {
  await withTempDir(async (dir) => {
    const out = makeOutput();
    const result = await runInitWizard({
      cwd: dir,
      stdin: makeStdin(),
      stdout: out.stream,
      stderr: out.stream,
    });
    const stateDir = path.join(dir, ".maestro");
    assert.equal(result.stateDir, stateDir);
    assert.deepEqual(result.created, ["config.json", "workflow.json"]);

    const config = JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8"));
    assert.equal(config.cwd, dir);
    assert.deepEqual(config.providers, DEFAULT_LOCAL_CONFIG_V2.providers);
    const workflow = JSON.parse(await readFile(path.join(stateDir, "workflow.json"), "utf8"));
    assert.deepEqual(workflow, DEFAULT_WORKFLOW);

    for (const sub of ["tasks", "runs", "projects", "patches", "logs"]) {
      assert.ok((await stat(path.join(stateDir, sub))).isDirectory(), `missing dir ${sub}`);
    }
    const gitignore = await readFile(path.join(stateDir, ".gitignore"), "utf8");
    for (const entry of ["config.local.json", "secrets.local.json", "imported/"]) {
      assert.ok(gitignore.includes(entry), `gitignore missing ${entry}`);
    }
    assert.match(out.text(), /non-interactive session — scaffold only/);
    assert.match(out.text(), /Next steps/);
  });
});

test("init never clobbers existing files", async () => {
  await withTempDir(async (dir) => {
    const stateDir = path.join(dir, ".maestro");
    const custom = '{\n  "version": 2,\n  "custom": true\n}\n';
    await runInitWizard({ cwd: dir, stdin: makeStdin(), stdout: makeOutput().stream });
    await writeFile(path.join(stateDir, "config.json"), custom);

    const out = makeOutput();
    const result = await runInitWizard({ cwd: dir, stdin: makeStdin(), stdout: out.stream });
    assert.deepEqual(result.created, []);
    assert.deepEqual(result.skipped, ["config.json", "workflow.json"]);
    assert.equal(await readFile(path.join(stateDir, "config.json"), "utf8"), custom);
    assert.match(out.text(), /exists, skipped config\.json/);
  });
});

test("init --dry-run writes nothing", async () => {
  await withTempDir(async (dir) => {
    const out = makeOutput();
    const result = await runInitWizard({
      cwd: dir,
      args: ["--dry-run"],
      stdin: makeStdin(),
      stdout: out.stream,
    });
    assert.equal(result.dryRun, true);
    await assert.rejects(stat(path.join(dir, ".maestro")));
    assert.match(out.text(), /would create: config\.json/);
    assert.match(out.text(), /dry run — nothing written/);
  });
});

test("init chains wizards via injected ask", async () => {
  await withTempDir(async (dir) => {
    const questions = [];
    const answers = ["y", "n", "n"];
    const detect = async () => [
      { provider: "ollama", found: true, alias: "ollama", models: ["llama3.2"], notes: [] },
    ];
    const out = makeOutput();
    const result = await runInitWizard({
      cwd: dir,
      stdin: makeStdin(),
      stdout: out.stream,
      ask: async (question) => {
        questions.push(question);
        return answers.shift();
      },
      detect,
    });
    assert.equal(questions.length, 3);
    assert.deepEqual(result.wizards, { local: true, keys: false, import: false });
    const localConfig = JSON.parse(
      await readFile(path.join(dir, ".maestro", "config.local.json"), "utf8"),
    );
    assert.deepEqual(localConfig.providers.ollama.models, ["llama3.2"]);
  });
});

test("init --yes runs detection only, no prompts", async () => {
  await withTempDir(async (dir) => {
    const detect = async () => [];
    const out = makeOutput();
    const result = await runInitWizard({
      cwd: dir,
      args: ["--yes"],
      stdin: makeStdin(),
      stdout: out.stream,
      ask: async () => { throw new Error("ask must not be called with --yes"); },
      detect,
    });
    assert.deepEqual(result.wizards, { local: true, keys: false, import: false });
    assert.match(out.text(), /skipped keys\/import wizards/);
  });
});

test("local commands discover a caller-side .maestro by walking up", async () => {
  await withTempDir(async (dir) => {
    const nested = path.join(dir, "a", "b");
    const stateDir = path.join(dir, ".maestro");
    const exists = (candidate) => candidate === stateDir;

    const found = resolveWorkspaceLocalInvocation({
      args: ["status"],
      env: {},
      processCwd: nested,
      exists,
    });
    assert.deepEqual(found.args, ["status", "--state-dir", stateDir]);

    // no caller-side state → historical package-root default
    const fallback = resolveWorkspaceLocalInvocation({
      args: ["status"],
      env: {},
      processCwd: nested,
      exists: () => false,
    });
    assert.equal(fallback.args[2].endsWith(path.join("maestro", ".maestro")), true);

    // explicit flag wins; init never gets a default injected
    const explicit = resolveWorkspaceLocalInvocation({
      args: ["status", "--state-dir", "/x"],
      env: {},
      processCwd: nested,
      exists,
    });
    assert.deepEqual(explicit.args, ["status", "--state-dir", "/x"]);
    const init = resolveWorkspaceLocalInvocation({
      args: ["init"],
      env: {},
      processCwd: nested,
      exists,
    });
    assert.deepEqual(init.args, ["init"]);
  });
});
