// Tool-policy threading: _stepOptions → buildAgentCommand → adapter (claude
// flags), and advisory-block prompt injection for advisory providers.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildAgentCommand } from "../src/agent-runner.mjs";
import { runLangGraphTask } from "../src/langgraph/engine.mjs";
import { LocalTaskStore } from "../src/task-store.mjs";

const silent = { write: () => {} };

test("buildAgentCommand registry path forwards tools/deny_tools to claude adapter", () => {
  const providerDef = { adapter: "built-in:claude", default_alias: "claude" };
  const cmd = buildAgentCommand({
    provider: "claude",
    prompt: "p",
    cwd: "/tmp",
    role: "executor",
    options: { permission: "write", tools: ["Read", "Grep"], deny_tools: ["Bash(rm:*)"] },
    providerDef,
  });
  const i = cmd.args.indexOf("--allowedTools");
  assert.ok(i >= 0, "--allowedTools present");
  assert.equal(cmd.args[i + 1], "Read Grep");
  assert.ok(cmd.args.includes("--disallowedTools"));
});

function workflow(provider) {
  return {
    version: 2,
    initial: "executor",
    roles: {
      executor: { provider, prompt_template: "executor", permission: "read", tools: ["Read", "Grep"] },
    },
    transitions: { executor: { done: "$complete", question: "$ask_user", error: "$halt" } },
    modes: { task: { initial: "executor" } },
  };
}

async function runCapturingPrompt(provider) {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-thread-"));
  const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
  await mkdir(path.join(store.root, "workflows"), { recursive: true });
  await writeFile(path.join(store.root, "workflows", "default.json"), JSON.stringify(workflow(provider)));
  await writeFile(
    path.join(store.root, "config.json"),
    JSON.stringify({ version: 2, providers: { [provider]: { adapter: `built-in:${provider}` } } }),
  );
  const repoRoot = path.dirname(store.root);
  const task = await store.createTask({ prompt: "do it", cwd: repoRoot, reviewEnabled: false });
  const prompts = [];
  const optionsSeen = [];
  const stubRunner = {
    runStep: async ({ prompt, options }) => {
      prompts.push(prompt);
      optionsSeen.push(options);
      return { stdout: 'MAESTRO_HANDOFF: {"summary":"ok"}', stderr: "", stdoutPath: null, stderrPath: null };
    },
  };
  const { task: finalTask } = await runLangGraphTask(task.id, {
    taskStore: store,
    maestroRoot: store.root,
    runner: stubRunner,
    stdout: silent,
    stderr: silent,
    availabilityProbe: () => true,
  });
  await rm(dir, { recursive: true, force: true });
  return { prompts, optionsSeen, finalTask };
}

test("claude role with tools sets options.tools/deny_tools on runStep", async () => {
  const { optionsSeen } = await runCapturingPrompt("claude");
  assert.ok(optionsSeen.length > 0);
  assert.deepEqual(optionsSeen[0].tools, ["Read", "Grep"]);
});

test("advisory provider (gemini) prepends the Tool Policy block to the prompt", async () => {
  const { prompts } = await runCapturingPrompt("gemini");
  assert.ok(prompts.length > 0);
  assert.ok(prompts[0].includes("## Tool Policy (advisory)"), "advisory block present in prompt");
  assert.ok(prompts[0].includes("Allowed: Grep, Read"));
});

test("claude (enforced) does NOT prepend the advisory block to the prompt", async () => {
  const { prompts } = await runCapturingPrompt("claude");
  assert.ok(!prompts[0].includes("## Tool Policy (advisory)"));
});
