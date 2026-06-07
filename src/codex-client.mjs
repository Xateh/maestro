import { spawn } from "node:child_process";

import { nullLogger } from "./logger.mjs";
import { renderPrompt } from "./workflow.mjs";

function codexError(code, message = code, cause = null) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function decodeUsage(params = {}) {
  const usage = params.tokenUsage ?? params.usage ?? params;
  return {
    inputTokens: Number(usage.inputTokens ?? usage.input_tokens ?? 0) || 0,
    outputTokens: Number(usage.outputTokens ?? usage.output_tokens ?? 0) || 0,
    totalTokens: Number(usage.totalTokens ?? usage.total_tokens ?? 0) || 0,
  };
}

export class CodexAppServerClient {
  constructor({
    command,
    cwd,
    readTimeoutMs = 5_000,
    turnTimeoutMs = 3_600_000,
    spawnProcess = null,
    logger = nullLogger(),
    onEvent = () => {},
  }) {
    this.command = command;
    this.cwd = cwd;
    this.readTimeoutMs = readTimeoutMs;
    this.turnTimeoutMs = turnTimeoutMs;
    this.spawnProcess = spawnProcess ?? ((commandName, args, options) => spawn(commandName, args, options));
    this.logger = logger;
    this.onEvent = onEvent;
    this.child = null;
    this.nextId = 1;
    this.buffer = "";
    this.pending = new Map();
    this.turnWaiter = null;
    this.metrics = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      startedAt: Date.now(),
      rateLimits: null,
    };
  }

  ensureProcess() {
    if (this.child) return;
    this.child = this.spawnProcess("bash", ["-lc", this.command], {
      cwd: this.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk) => {
      this.readStdout(chunk.toString("utf8"));
    });
    this.child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) this.logger.warn("codex_stderr", { cwd: this.cwd, text });
    });
    this.child.on("exit", (code, signal) => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(codexError("codex_process_exited", `${code ?? signal}`));
      }
      this.pending.clear();
      if (this.turnWaiter) {
        this.turnWaiter.reject(codexError("codex_process_exited", `${code ?? signal}`));
        this.turnWaiter = null;
      }
    });
  }

  readStdout(text) {
    this.buffer += text;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      this.handleMessageLine(line);
    }
  }

  handleMessageLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.logger.warn("codex_invalid_json", { line, error: error.message });
      return;
    }

    if (message.id !== undefined && message.method) {
      void this.handleServerRequest(message);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(codexError("codex_jsonrpc_error", message.error.message ?? JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method) {
      this.handleNotification(message);
    }
  }

  send(message) {
    this.ensureProcess();
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  request(method, params) {
    const id = this.nextId;
    this.nextId += 1;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(codexError("codex_request_timeout", method));
      }, this.readTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
    });
    this.send({ id, method, params });
    return promise;
  }

  async handleServerRequest(message) {
    this.onEvent({ event: "input_required", method: message.method });
    if (message.method === "item/tool/requestUserInput") {
      this.send({ id: message.id, result: { answers: {} } });
      return;
    }
    if (message.method === "item/commandExecution/requestApproval") {
      this.send({ id: message.id, result: { decision: "cancel" } });
      return;
    }
    if (message.method === "item/fileChange/requestApproval") {
      this.send({ id: message.id, result: { decision: "cancel" } });
      return;
    }
    if (message.method === "mcpServer/elicitation/request") {
      this.send({ id: message.id, result: { action: "cancel" } });
      return;
    }
    if (message.method === "item/tool/call") {
      this.send({
        id: message.id,
        result: {
          success: false,
          contentItems: [{ type: "inputText", text: "Symphony local-safe client does not execute dynamic tools." }],
        },
      });
      return;
    }
    this.send({
      id: message.id,
      error: { code: -32000, message: `Symphony local-safe client denies ${message.method}` },
    });
  }

  handleNotification(message) {
    const { method, params = {} } = message;
    if (method === "turn/started") {
      const turnId = params.turn?.id ?? null;
      if (this.turnWaiter) {
        this.turnWaiter.turnId = turnId;
      }
      this.onEvent({ event: "turn_started", threadId: params.threadId, turnId });
      return;
    }
    if (method === "turn/completed") {
      const turnId = params.turn?.id ?? this.turnWaiter?.turnId ?? null;
      const status = params.turn?.status ?? "completed";
      this.onEvent({ event: "turn_completed", threadId: params.threadId, turnId, status });
      if (this.turnWaiter) {
        this.turnWaiter.resolve({ turnId, status, turn: params.turn ?? null });
        this.turnWaiter = null;
      }
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      const usage = decodeUsage(params);
      this.metrics.inputTokens = usage.inputTokens;
      this.metrics.outputTokens = usage.outputTokens;
      this.metrics.totalTokens = usage.totalTokens;
      this.onEvent({ event: "token_usage", ...usage });
      return;
    }
    if (method === "account/rateLimits/updated") {
      this.metrics.rateLimits = params;
      this.onEvent({ event: "rate_limits", rateLimits: params });
      return;
    }
    this.onEvent({ event: "notification", method, params });
  }

  async startSession({
    approvalPolicy = "never",
    threadSandbox = "workspace-write",
    config = null,
    model = null,
  } = {}) {
    const result = await this.request("thread/start", {
      cwd: this.cwd,
      approvalPolicy,
      sandbox: threadSandbox,
      config,
      model,
      serviceName: "symphony",
      ephemeral: false,
    });
    const threadId = result?.thread?.id;
    if (!threadId) throw codexError("codex_missing_thread_id");
    this.onEvent({ event: "session_started", threadId });
    return { threadId, raw: result };
  }

  async runTurn({
    threadId,
    prompt,
    approvalPolicy = "never",
    turnSandboxPolicy = null,
    model = null,
  }) {
    if (this.turnWaiter) {
      throw codexError("codex_turn_already_running");
    }
    const completion = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiter = null;
        reject(codexError("codex_turn_timeout", threadId));
      }, this.turnTimeoutMs);
      this.turnWaiter = {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        turnId: null,
      };
    });

    const request = this.request("turn/start", {
      threadId,
      cwd: this.cwd,
      approvalPolicy,
      sandboxPolicy: turnSandboxPolicy,
      model,
      input: [{ type: "text", text: prompt }],
    });

    const [response, completed] = await Promise.all([request, completion]);
    return {
      turnId: completed.turnId ?? response?.turn?.id ?? null,
      status: completed.status,
      raw: completed.turn ?? response?.turn ?? null,
    };
  }

  metricSnapshot() {
    return {
      input_tokens: this.metrics.inputTokens,
      output_tokens: this.metrics.outputTokens,
      total_tokens: this.metrics.totalTokens,
      seconds_running: Math.max(0, (Date.now() - this.metrics.startedAt) / 1000),
    };
  }

  async stop() {
    if (!this.child) return;
    try {
      this.child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
    this.child = null;
  }
}

export class CodexAgentRunner {
  constructor({
    workflowStore,
    workspaceManager,
    tracker,
    clientFactory = null,
    logger = nullLogger(),
  }) {
    this.workflowStore = workflowStore;
    this.workspaceManager = workspaceManager;
    this.tracker = tracker;
    this.clientFactory = clientFactory;
    this.logger = logger;
    this.activeClients = new Map();
  }

  makeClient({ command, workspacePath, readTimeoutMs, turnTimeoutMs, onEvent }) {
    if (this.clientFactory) {
      return this.clientFactory({ command, workspacePath, readTimeoutMs, turnTimeoutMs, onEvent });
    }
    return new CodexAppServerClient({
      command,
      cwd: workspacePath,
      readTimeoutMs,
      turnTimeoutMs,
      logger: this.logger,
      onEvent,
    });
  }

  async run({ issue, attempt = 1, onActivity = null }) {
    const { workflow, config } = this.workflowStore.current;
    const workspace = await this.workspaceManager.createForIssue(issue.identifier);
    await this.workspaceManager.runBeforeRun(workspace.path);

    const client = this.makeClient({
      command: config.codex.command,
      workspacePath: workspace.path,
      readTimeoutMs: config.codex.readTimeoutMs,
      turnTimeoutMs: config.codex.turnTimeoutMs,
      onEvent: (event) => {
        this.logger.info("codex_event", {
          issue_identifier: issue.identifier,
          event: event.event,
          turn_id: event.turnId,
          thread_id: event.threadId,
        });
        // Refresh stall-detection timestamp on every agent event so the
        // orchestrator measures idle time, not wall-clock-since-dispatch (R2).
        if (onActivity) onActivity();
      },
    });
    this.activeClients.set(issue.id, client);

    try {
      const prompt = await renderPrompt(workflow.promptTemplate, {
        issue,
        attempt,
      });
      const session = await client.startSession({
        approvalPolicy: config.codex.approvalPolicy,
        threadSandbox: config.codex.threadSandbox,
        turnSandboxPolicy: config.codex.turnSandboxPolicy,
      });

      let turns = 0;
      let lastTurn = null;
      let nextPrompt = prompt;
      while (turns < config.agent.maxTurns) {
        turns += 1;
        lastTurn = await client.runTurn({
          threadId: session.threadId,
          prompt: nextPrompt,
          approvalPolicy: config.codex.approvalPolicy,
          turnSandboxPolicy: config.codex.turnSandboxPolicy,
        });
        const latest = (await this.tracker.fetchIssueStatesByIds([issue.id]))[0] ?? issue;
        const state = String(latest.state ?? "").toLowerCase();
        const activeStates = config.tracker.activeStates.map((item) => item.toLowerCase());
        if (!activeStates.includes(state)) break;
        nextPrompt = `Continue working on ${issue.identifier}. Inspect current repository state before changing files.`;
      }

      await this.workspaceManager.runAfterRun(workspace.path);
      return {
        status: "succeeded",
        turns,
        lastTurn,
        workspacePath: workspace.path,
        metrics: client.metricSnapshot(),
      };
    } finally {
      this.activeClients.delete(issue.id);
      await client.stop();
    }
  }

  cancel(issueId) {
    const client = this.activeClients.get(issueId);
    if (!client) return false;
    void client.stop();
    this.activeClients.delete(issueId);
    return true;
  }
}
