import { spawn } from "node:child_process";

import { nullLogger } from "./logger.mjs";

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
          contentItems: [{ type: "inputText", text: "Maestro local-safe client does not execute dynamic tools." }],
        },
      });
      return;
    }
    this.send({
      id: message.id,
      error: { code: -32000, message: `Maestro local-safe client denies ${message.method}` },
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
      serviceName: "maestro",
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
