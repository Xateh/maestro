/**
 * Unit tests for HerdrAgentRunner tab lifecycle:
 *   - tab reuse across runner instances via the tabStore delegate
 *   - stale persisted tabs are recreated
 *   - closeTab() closes the herdr tab and clears all tracking state
 *
 * Each test uses a stub herdr CLI (injected via the `cli` constructor option)
 * so no herdr binary is needed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { HerdrAgentRunner } from "../src/herdr-agent-runner.mjs";

function makeStubCli({ failTabGet = false } = {}) {
  const calls = [];
  let tabCounter = 0;
  const cli = async (args) => {
    calls.push(args);
    const cmd = args.slice(0, 2).join(" ");
    if (cmd === "workspace list") return { workspaces: [{ workspace_id: "ws-1", label: "maestro" }] };
    if (cmd === "tab create") {
      tabCounter += 1;
      return { tab: { tab_id: `tab-${tabCounter}` } };
    }
    if (cmd === "tab get") {
      if (failTabGet) throw new Error("tab_not_found");
      return { tab: { tab_id: args[2] } };
    }
    if (cmd === "tab close") return {};
    return {};
  };
  cli.calls = calls;
  cli.count = (prefix) => calls.filter((a) => a.slice(0, 2).join(" ") === prefix).length;
  return cli;
}

function makeMemTabStore() {
  const map = new Map();
  return {
    get: (taskId) => map.get(taskId) ?? null,
    set: (taskId, tabId) => { map.set(taskId, tabId); },
    map,
  };
}

test("HerdrAgentRunner: second runner instance reuses persisted tab instead of creating a new one", async () => {
  const cli = makeStubCli();
  const tabStore = makeMemTabStore();

  const first = new HerdrAgentRunner({ cli, tabStore });
  const tabId = await first._ensureTab("t1", "/tmp");
  assert.equal(tabId, "tab-1");
  assert.equal(tabStore.get("t1"), "tab-1");
  assert.equal(cli.count("tab create"), 1);

  // Fresh runner (simulates task resume in a new process): must verify + reuse.
  const second = new HerdrAgentRunner({ cli, tabStore });
  const reused = await second._ensureTab("t1", "/tmp");
  assert.equal(reused, "tab-1");
  assert.equal(cli.count("tab create"), 1, "no second tab create");
  assert.equal(cli.count("tab get"), 1, "persisted tab is verified before reuse");
});

test("HerdrAgentRunner: stale persisted tab is recreated and store updated", async () => {
  const cli = makeStubCli({ failTabGet: true });
  const tabStore = makeMemTabStore();
  tabStore.set("t1", "tab-dead");

  const runner = new HerdrAgentRunner({ cli, tabStore });
  const tabId = await runner._ensureTab("t1", "/tmp");
  assert.equal(tabId, "tab-1", "new tab created when persisted one is gone");
  assert.equal(tabStore.get("t1"), "tab-1");
  assert.equal(cli.count("tab create"), 1);
});

test("HerdrAgentRunner: closeTab closes the tab and clears memory + store", async () => {
  const cli = makeStubCli();
  const tabStore = makeMemTabStore();

  const runner = new HerdrAgentRunner({ cli, tabStore });
  await runner._ensureTab("t1", "/tmp");
  runner._taskPanes.set("t1:executor", 1);
  runner._taskPanes.set("t2:executor", 1);

  await runner.closeTab("t1");

  assert.equal(cli.count("tab close"), 1);
  assert.equal(cli.calls.find((a) => a[0] === "tab" && a[1] === "close")[2], "tab-1");
  assert.equal(runner._taskTabs.has("t1"), false);
  assert.equal(runner._taskPanes.has("t1:executor"), false, "panes of closed task cleared");
  assert.equal(runner._taskPanes.has("t2:executor"), true, "other tasks untouched");
  assert.equal(tabStore.get("t1"), null, "persisted tab id cleared");
});

test("HerdrAgentRunner: closeTab is a no-op for unknown tasks", async () => {
  const cli = makeStubCli();
  const runner = new HerdrAgentRunner({ cli, tabStore: makeMemTabStore() });
  await runner.closeTab("nope");
  assert.equal(cli.calls.length, 0);
});

test("HerdrAgentRunner: closeTab survives a failing herdr CLI (best effort)", async () => {
  const cli = async (args) => {
    if (args.slice(0, 2).join(" ") === "tab close") throw new Error("herdr down");
    return { workspaces: [{ workspace_id: "ws-1", label: "maestro" }], tab: { tab_id: "tab-1" } };
  };
  const tabStore = makeMemTabStore();
  const runner = new HerdrAgentRunner({ cli, tabStore });
  await runner._ensureTab("t1", "/tmp");

  await assert.doesNotReject(() => runner.closeTab("t1"));
  assert.equal(tabStore.get("t1"), null, "state cleared even when close fails");
});

test("HerdrAgentRunner: runStep closes the tab's empty root pane after the agent pane starts", async () => {
  const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-root-"));
  const closed = [];
  const cli = async (args) => {
    const cmd = args.slice(0, 2).join(" ");
    if (cmd === "workspace list") return { workspaces: [{ workspace_id: "ws-1", label: "maestro" }] };
    // Real herdr returns a root_pane with every new tab; the runner must close it.
    if (cmd === "tab create") return { tab: { tab_id: "tab-1" }, root_pane: { pane_id: "root-1" } };
    if (cmd === "agent start") {
      await fs.writeFile(path.join(logDir, "executor.exit.txt"), "0");
      return { agent: { pane_id: "agent-1" } };
    }
    if (cmd === "pane close") { closed.push(args[2]); return {}; }
    return {};
  };
  const runner = new HerdrAgentRunner({ cli, tabStore: makeMemTabStore(), pollIntervalMs: 1 });
  await runner.runStep({
    provider: "codex", role: "executor", prompt: "go",
    cwd: logDir, logDir, options: {}, env: { MAESTRO_TASK_ID: "t-root" },
  });

  assert.deepEqual(closed, ["root-1"], "only the empty root pane is closed, never the agent pane");
  await fs.rm(logDir, { recursive: true, force: true });
});

test("HerdrAgentRunner: an aliased provider command is wrapped in `bash -ic` so alias expansion applies", async () => {
  const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-alias-"));
  let startScript = null;
  // Stub cli: capture the `agent start` script and simulate the pane by writing
  // the exit file (waitForFile polls it). Use a command name that is NOT on PATH
  // so resolveCommandSpec takes the interactive-shell alias branch.
  const cli = async (args) => {
    const cmd = args.slice(0, 2).join(" ");
    if (cmd === "workspace list") return { workspaces: [{ workspace_id: "ws-1", label: "maestro" }] };
    if (cmd === "tab create") return { tab: { tab_id: "tab-1" } };
    if (cmd === "agent start") {
      startScript = args[args.length - 1];
      await fs.writeFile(path.join(logDir, "executor.exit.txt"), "0");
      return { agent: { pane_id: "pane-1" } };
    }
    return {};
  };
  const runner = new HerdrAgentRunner({ cli, tabStore: makeMemTabStore(), pollIntervalMs: 1 });
  const providerDef = {
    adapter: "built-in:codex",
    default_alias: "xcodex-not-on-path",
    aliases: ["xcodex-not-on-path"],
    models: ["gpt-5.5"],
  };
  await runner.runStep({
    provider: "codex",
    role: "executor",
    prompt: "do the thing",
    cwd: logDir,
    logDir,
    options: {},
    env: { MAESTRO_TASK_ID: "t-alias" },
    providerDef,
  });

  assert.match(startScript, /bash '-ic'/, "aliased command is routed through interactive bash");
  assert.match(startScript, /xcodex-not-on-path/, "the configured alias is preserved inside the wrapper");

  const command = JSON.parse(await fs.readFile(path.join(logDir, "executor.command.json"), "utf8"));
  assert.equal(command.invocation, "bash-interactive");
  assert.equal(command.configured_command, "xcodex-not-on-path");

  await fs.rm(logDir, { recursive: true, force: true });
});
