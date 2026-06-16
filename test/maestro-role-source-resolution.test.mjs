// Engine-level MRC source resolution + composition + tool-policy manifest.
// Drives runLangGraphTask over a tmp LocalTaskStore with a stub runner.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runLangGraphTask } from "../src/langgraph/engine.mjs";
import { LocalTaskStore } from "../src/task-store.mjs";

const silent = { write: () => {} };

const SOLO_SOURCE_WORKFLOW = {
  version: 2,
  initial: "executor",
  roles: {
    executor: {
      source: ".maestro/roles/worker.md",
      provider: "claude",
      prompt_template: "executor",
    },
  },
  transitions: {
    executor: { done: "$complete", question: "$ask_user", error: "$halt" },
  },
  modes: { task: { initial: "executor" } },
};

const WORKER_UNIT = `---
name: worker
description: A worker role
provider: claude
permission: write
tools: [Read, Grep]
---

You are the worker. Do the task.
`;

async function setup(workflow, unit) {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-mrc-"));
  const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
  await mkdir(path.join(store.root, "workflows"), { recursive: true });
  await writeFile(path.join(store.root, "workflows", "default.json"), JSON.stringify(workflow));
  await writeFile(
    path.join(store.root, "config.json"),
    JSON.stringify({ version: 2, providers: { claude: { adapter: "built-in:claude" } } }),
  );
  if (unit) {
    await mkdir(path.join(store.root, "roles"), { recursive: true });
    await writeFile(path.join(store.root, "roles", "worker.md"), unit);
  }
  return { dir, store };
}

test("engine resolves a source-bearing role; manifest snapshot has composed inline role", async () => {
  const { dir, store } = await setup(SOLO_SOURCE_WORKFLOW, WORKER_UNIT);
  try {
    // unit lives relative to task cwd; cwd = store root's parent (repo root)
    const repoRoot = path.dirname(store.root);
    const task = await store.createTask({ prompt: "do it", cwd: repoRoot, reviewEnabled: false });

    const stubRunner = {
      runStep: async () => ({ stdout: 'MAESTRO_HANDOFF: {"summary":"ok"}', stderr: "", stdoutPath: null, stderrPath: null }),
    };
    const { task: finalTask } = await runLangGraphTask(task.id, {
      taskStore: store,
      maestroRoot: store.root,
      runner: stubRunner,
      stdout: silent,
      stderr: silent,
      availabilityProbe: () => true,
    });
    assert.equal(finalTask.status, "succeeded");

    const manifest = JSON.parse(await readFile(path.join(finalTask.run_dir, "run-manifest.json"), "utf8"));
    const resolved = manifest.workflow_snapshot.roles.executor;
    assert.ok(!("source" in resolved), "source key stripped after composition");
    assert.match(resolved.instructions, /You are the worker/);
    assert.equal(resolved.permission, "write");
    assert.deepEqual(resolved.tools, ["Read", "Grep"]);

    // tool_policies recorded with enforcement per the capability matrix
    assert.ok(Array.isArray(manifest.tool_policies));
    const pol = manifest.tool_policies.find((p) => p.role === "executor");
    assert.ok(pol);
    assert.equal(pol.enforcement, "enforced"); // claude
    assert.deepEqual(pol.allow, ["Read", "Grep"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing source surfaces a structured blocker (waiting_user), no false success", async () => {
  const { dir, store } = await setup(SOLO_SOURCE_WORKFLOW, null); // no unit on disk
  try {
    const repoRoot = path.dirname(store.root);
    const task = await store.createTask({ prompt: "do it", cwd: repoRoot, reviewEnabled: false });
    const stubRunner = {
      runStep: async () => { throw new Error("runner must not run when source is missing"); },
    };
    const { task: finalTask } = await runLangGraphTask(task.id, {
      taskStore: store,
      maestroRoot: store.root,
      runner: stubRunner,
      stdout: silent,
      stderr: silent,
      availabilityProbe: () => true,
    });
    assert.equal(finalTask.status, "waiting_user");
    assert.ok((finalTask.blockers ?? []).some((b) => String(b.code).startsWith("role_source")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
