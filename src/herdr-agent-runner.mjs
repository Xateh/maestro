import fs from "node:fs/promises";
import path from "node:path";

import { buildAgentCommand, resolveCommandSpec } from "./agent-runner.mjs";
import { herdrCli } from "./herdr-client.mjs";
import { nullLogger } from "./logger.mjs";

function shellQuote(v) {
  return `'${String(v).replaceAll("'", "'\\''")}'`;
}

function buildScript(commandSpec, promptPath, stdoutPath, exitPath) {
  const hasStdin = typeof commandSpec.stdin === "string" && commandSpec.stdin.length > 0;
  const cmd = [commandSpec.command, ...commandSpec.args.map(shellQuote)].join(" ");
  const input = hasStdin ? `< ${shellQuote(promptPath)} ` : "";
  return `${cmd} ${input}2>&1 | tee ${shellQuote(stdoutPath)}; printf '%s' "$\{PIPESTATUS[0]}" > ${shellQuote(exitPath)}`;
}

async function waitForFile(filePath, intervalMs, timeoutMs) {
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.MAX_SAFE_INTEGER;
  while (Date.now() < deadline) {
    try {
      const content = await fs.readFile(filePath, "utf8");
      if (content.length > 0) return content.trim();
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

export class HerdrAgentRunner {
  // tabStore: optional { get(taskId) -> tabId|null, set(taskId, tabId|null) }
  // persistence delegate so tabs survive runner instances (resume reuses them).
  // Assumes one active runner per task: concurrent cross-process runs of the
  // same task may race _ensureTab and orphan a tab (cosmetic herdr clutter).
  constructor({ timeoutMs = 3_600_000, pollIntervalMs = 500, logger = nullLogger(), cli = herdrCli, tabStore = null } = {}) {
    this.timeoutMs = timeoutMs;
    this.pollIntervalMs = pollIntervalMs;
    this.logger = logger;
    this.cli = cli;
    this.tabStore = tabStore;
    this._taskTabs = new Map();
    this._taskPanes = new Map();
    this._maestroWsId = null;
  }

  async _ensureMaestroWorkspace(cwd) {
    if (this._maestroWsId) return this._maestroWsId;
    const list = await this.cli(["workspace", "list"]);
    const workspaces = list?.workspaces ?? [];
    const existing = workspaces.find((w) => (w.custom_name ?? w.label ?? "") === "maestro");
    if (existing) {
      this._maestroWsId = existing.workspace_id;
      return this._maestroWsId;
    }
    const created = await this.cli(["workspace", "create", "--label", "maestro", "--cwd", cwd, "--no-focus"]);
    this._maestroWsId = created?.workspace?.workspace_id;
    return this._maestroWsId;
  }

  async _ensureTab(taskId, cwd) {
    if (this._taskTabs.has(taskId)) return this._taskTabs.get(taskId);

    // Reuse a persisted tab (task resumed by a fresh runner instance) so the
    // conversation trail stays in one place. Any failure means the tab is
    // gone — fall through and create a new one.
    const persisted = await this.tabStore?.get(taskId);
    if (persisted) {
      try {
        await this.cli(["tab", "get", persisted]);
        this._taskTabs.set(taskId, persisted);
        return persisted;
      } catch { /* tab gone — recreate */ }
    }

    const wsId = await this._ensureMaestroWorkspace(cwd);
    const result = await this.cli([
      "tab", "create",
      "--workspace", wsId,
      "--label", `mae:${taskId}`,
      "--cwd", cwd,
      "--no-focus",
    ]);
    const tabId = result?.tab?.tab_id;
    this._taskTabs.set(taskId, tabId);
    await this.tabStore?.set(taskId, tabId);
    return tabId;
  }

  async closeTab(taskId) {
    const tabId = this._taskTabs.get(taskId) ?? await this.tabStore?.get(taskId);
    if (!tabId) return;
    try {
      await this.cli(["tab", "close", tabId]);
      this.logger.info("herdr_tab_closed", { task_id: taskId, tab_id: tabId });
    } catch { /* best effort */ }
    this._taskTabs.delete(taskId);
    for (const key of this._taskPanes.keys()) {
      if (key.startsWith(`${taskId}:`)) this._taskPanes.delete(key);
    }
    this.tabStore?.set(taskId, null);
  }

  async runStep({ provider, role, prompt, cwd, logDir, options = {}, env = {}, providerDef = null }) {
    const taskId = env.MAESTRO_TASK_ID ?? path.basename(path.dirname(logDir));
    const attempt = (this._taskPanes.get(`${taskId}:${role}`) ?? 0) + 1;
    const paneKey = `${taskId}:${role}`;
    this._taskPanes.set(paneKey, attempt);

    // Resolve aliases the same way TerminalAgentRunner does: a command name that
    // is not a real PATH binary (e.g. a shell alias like `xcodex`) is rewritten
    // to `bash -ic "<cmd>"` so interactive-shell alias expansion applies. The
    // herdr pane runs the script under `bash -lc`, which does NOT expand aliases,
    // so without this an aliased provider command exits 127.
    const commandSpec = await resolveCommandSpec(buildAgentCommand({ provider, role, prompt, cwd, options, providerDef }));
    await fs.mkdir(logDir, { recursive: true });

    const stdoutPath = path.join(logDir, `${role}.stdout.log`);
    const stderrPath = path.join(logDir, `${role}.stderr.log`);
    const promptPath = path.join(logDir, `${role}.prompt.txt`);
    const exitPath = path.join(logDir, `${role}.exit.txt`);
    const commandPath = path.join(logDir, `${role}.command.json`);

    await fs.writeFile(commandPath, `${JSON.stringify({
      command: commandSpec.command,
      args: commandSpec.args,
      cwd: commandSpec.cwd ?? cwd,
      backend: "herdr",
      invocation: commandSpec.invocation,
      configured_command: commandSpec.configuredCommand,
      task_id: taskId,
    }, null, 2)}\n`);

    if (typeof commandSpec.stdin === "string" && commandSpec.stdin.length > 0) {
      await fs.writeFile(promptPath, commandSpec.stdin);
    }

    await fs.rm(exitPath, { force: true });

    const script = buildScript(commandSpec, promptPath, stdoutPath, exitPath);
    const agentLabel = `${provider}:${role}#${attempt}`;
    const tabId = await this._ensureTab(taskId, cwd);

    const paneResult = await this.cli([
      "agent", "start", agentLabel,
      "--tab", tabId,
      "--cwd", cwd,
      "--split", "right",
      "--no-focus",
      "--",
      "bash", "-lc", script,
    ]);
    const paneId = paneResult?.agent?.pane_id;
    this.logger.info("herdr_agent_started", { task_id: taskId, role, provider, pane_id: paneId, tab_id: tabId });

    const exitCodeStr = await waitForFile(exitPath, this.pollIntervalMs, this.timeoutMs);

    if (exitCodeStr === null) {
      try {
        await this.cli(["pane", "send-keys", paneId, "ctrl+c"]);
      } catch { /* best effort */ }
      const error = new Error(`agent_timeout: ${provider}:${role} exceeded ${this.timeoutMs}ms`);
      error.code = "agent_timeout";
      error.stdoutPath = stdoutPath;
      error.stderrPath = stderrPath;
      throw error;
    }

    const exitCode = Number(exitCodeStr);
    let stdout = "";
    try { stdout = await fs.readFile(stdoutPath, "utf8"); } catch { /* empty */ }
    const stderr = "";

    this.logger.info("herdr_agent_completed", { task_id: taskId, role, provider, exit_code: exitCode });

    if (exitCode !== 0) {
      const error = new Error(`agent_failed: ${provider}:${role} exited with ${exitCode}`);
      error.code = "agent_failed";
      error.exitCode = exitCode;
      error.stdout = stdout;
      error.stderr = stderr;
      error.stdoutPath = stdoutPath;
      error.stderrPath = stderrPath;
      throw error;
    }

    return {
      status: "succeeded",
      stdout,
      stderr,
      stdoutPath,
      stderrPath,
      command: commandSpec.command,
      args: commandSpec.args,
    };
  }

  async cancel(taskId) {
    for (const key of this._taskPanes.keys()) {
      if (!key.startsWith(`${taskId}:`)) continue;
      const tabId = this._taskTabs.get(taskId);
      if (!tabId) continue;
      try {
        const list = await this.cli(["pane", "list", "--workspace", this._maestroWsId ?? ""]);
        const panes = list?.panes ?? [];
        for (const pane of panes) {
          if (pane.tab_id === tabId) {
            await this.cli(["pane", "send-keys", pane.id, "ctrl+c"]);
          }
        }
      } catch { /* best effort */ }
    }
  }
}
