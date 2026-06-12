import { spawn } from "node:child_process";
import { constants, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { buildCodexCommand } from "./adapters/codex.mjs";
import { buildCopilotCommand } from "./adapters/copilot.mjs";
import { buildClaudeCommand } from "./adapters/claude.mjs";
import { buildAntigravityCommand } from "./adapters/antigravity.mjs";
import { buildOllamaCommand } from "./adapters/ollama.mjs";
import { resolveAdapter } from "./adapters/registry.mjs";
import { nullLogger } from "./logger.mjs";

const SAFE_SHELL_COMMAND = /^[A-Za-z0-9_@%+=:,./-]+$/;

async function canExecute(filePath) {
  try {
    await fs.access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function directCommandExists(commandName, { cwd, env = process.env } = {}) {
  const command = String(commandName ?? "").trim();
  if (!command) return false;
  if (command.includes("/") || command.includes(path.sep)) {
    const target = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    return canExecute(target);
  }
  for (const directory of String(env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    if (await canExecute(path.join(directory, command))) return true;
  }
  return false;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function safeRunnerEnv(env = {}) {
  return Object.fromEntries(
    Object.entries(env)
      .filter(([key, value]) => key.startsWith("MAESTRO_") && value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)]),
  );
}

function appendBoundedTail(current, chunk, maxBytes) {
  const next = `${current}${chunk.toString("utf8")}`;
  const buffer = Buffer.from(next, "utf8");
  if (buffer.length <= maxBytes) return next;
  return buffer
    .subarray(buffer.length - maxBytes)
    .toString("utf8")
    .replace(/^\uFFFD/, "");
}

function endStream(stream) {
  return new Promise((resolve, reject) => {
    stream.end((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function shellAliasCommandSpec(commandSpec) {
  if (!SAFE_SHELL_COMMAND.test(commandSpec.command)) {
    const error = new Error(`unsafe_shell_command_name: ${commandSpec.command}`);
    error.code = "unsafe_shell_command_name";
    throw error;
  }
  return {
    ...commandSpec,
    command: "bash",
    args: [
      "-ic",
      [commandSpec.command, ...commandSpec.args.map(shellQuote)].join(" "),
    ],
    invocation: "bash-interactive",
    configuredCommand: commandSpec.command,
  };
}

async function resolveCommandSpec(commandSpec) {
  if (await directCommandExists(commandSpec.command, { cwd: commandSpec.cwd })) {
    return {
      ...commandSpec,
      invocation: "direct",
      configuredCommand: commandSpec.command,
    };
  }
  return shellAliasCommandSpec(commandSpec);
}

export function buildAgentCommand({ provider, prompt, cwd, role, options = {}, providerDef = null }) {
  // Registry path: providerDef supplied (v2 task snapshot)
  if (providerDef) {
    const adapterFn = resolveAdapter(providerDef);
    const alias = options.alias || providerDef.default_alias || provider;
    return adapterFn({
      prompt,
      cwd,
      role,
      alias,
      model: options.model,
      effort: options.effort ?? options.claudeEffort ?? options.codexEffort,
      permission: options.permission,
    });
  }

  // Legacy path: bare provider string (v1 task snapshots and existing callers)
  if (provider === "claude") {
    return buildClaudeCommand({
      prompt,
      cwd,
      role,
      model: options.model,
      effort: options.claudeEffort,
      commandName: options.claudeCommand,
    });
  }
  if (provider === "codex") {
    return buildCodexCommand({
      prompt,
      cwd,
      role,
      model: options.model,
      effort: options.codexEffort,
      commandName: options.codexCommand,
    });
  }
  if (provider === "copilot") {
    return buildCopilotCommand({ prompt, cwd, alias: options.copilotCommand || "copilot", mode: options.mode });
  }
  if (provider === "antigravity") {
    return buildAntigravityCommand({
      prompt,
      cwd,
      role,
      model: options.model,
      effort: options.antigravityEffort ?? options.effort,
      commandName: options.antigravityCommand || "antigravity",
    });
  }
  if (provider === "ollama") {
    return buildOllamaCommand({
      prompt,
      cwd,
      alias: options.ollamaCommand || "ollama",
      model: options.model,
    });
  }
  const error = new Error(`unknown_agent_provider: ${provider}`);
  error.code = "unknown_agent_provider";
  throw error;
}

export class TerminalAgentRunner {
  constructor({
    spawnProcess = spawn,
    timeoutMs = 3_600_000,
    logger = nullLogger(),
    timers = { setTimeout, clearTimeout },
  } = {}) {
    this.spawnProcess = spawnProcess;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.timers = timers;
  }

  isTimeoutEnabled() {
    return this.timeoutMs !== -1;
  }

  async runStep({ provider, role, prompt, cwd, logDir, options = {}, env = {}, providerDef = null }) {
    const commandSpec = await resolveCommandSpec(buildAgentCommand({ provider, role, prompt, cwd, options, providerDef }));
    await fs.mkdir(logDir, { recursive: true });

    const stdoutPath = path.join(logDir, `${role}.stdout.log`);
    const stderrPath = path.join(logDir, `${role}.stderr.log`);
    const commandPath = path.join(logDir, `${role}.command.json`);
    const stdinBytes = typeof commandSpec.stdin === "string"
      ? Buffer.byteLength(commandSpec.stdin, "utf8")
      : 0;
    const runnerEnv = safeRunnerEnv(env);
    const envKeys = Object.keys(runnerEnv).sort();
    const streamTailBytes = Number.isInteger(options.streamTailBytes) && options.streamTailBytes > 0
      ? options.streamTailBytes
      : 65_536;

    await fs.writeFile(commandPath, `${JSON.stringify({
      command: commandSpec.command,
      args: commandSpec.args,
      cwd: commandSpec.cwd,
      invocation: commandSpec.invocation,
      configured_command: commandSpec.configuredCommand,
      ...(stdinBytes > 0 ? { stdin_bytes: stdinBytes } : {}),
      ...(envKeys.length > 0 ? { env_keys: envKeys } : {}),
    }, null, 2)}\n`);

    let result;
    const stdoutStream = createWriteStream(stdoutPath, { flags: "w" });
    const stderrStream = createWriteStream(stderrPath, { flags: "w" });
    try {
      result = await new Promise((resolve, reject) => {
        const child = this.spawnProcess(commandSpec.command, commandSpec.args, {
          cwd: commandSpec.cwd,
          env: {
            ...process.env,
            ...runnerEnv,
          },
          stdio: [stdinBytes > 0 ? "pipe" : "ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timer = this.isTimeoutEnabled()
          ? this.timers.setTimeout(() => {
            settled = true;
            child.kill("SIGTERM");
            const error = new Error(`agent_timeout: ${provider}:${role} exceeded ${this.timeoutMs}ms`);
            error.code = "agent_timeout";
            error.stdout = stdout;
            error.stderr = stderr;
            reject(error);
          }, this.timeoutMs)
          : null;

        child.stdout.on("data", (chunk) => {
          stdoutStream.write(chunk);
          stdout = appendBoundedTail(stdout, chunk, streamTailBytes);
        });
        child.stderr.on("data", (chunk) => {
          stderrStream.write(chunk);
          stderr = appendBoundedTail(stderr, chunk, streamTailBytes);
        });
        if (stdinBytes > 0 && child.stdin) {
          child.stdin.on("error", () => {});
          child.stdin.end(commandSpec.stdin);
        }
        child.on("error", (error) => {
          if (settled) return;
          settled = true;
          if (timer) this.timers.clearTimeout(timer);
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        });
        child.on("exit", (code, signal) => {
          if (settled) return;
          settled = true;
          if (timer) this.timers.clearTimeout(timer);
          if (code === 0) {
            resolve({ stdout, stderr, code, signal });
            return;
          }
          const error = new Error(`agent_failed: ${provider}:${role} exited with ${code ?? signal}`);
          error.code = "agent_failed";
          error.exitCode = code;
          error.signal = signal;
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        });
      });
    } catch (error) {
      await Promise.allSettled([endStream(stdoutStream), endStream(stderrStream)]);
      error.stdoutPath = stdoutPath;
      error.stderrPath = stderrPath;
      throw error;
    }

    await Promise.all([endStream(stdoutStream), endStream(stderrStream)]);
    this.logger.info("agent_step_completed", { provider, role, stdout_path: stdoutPath, stderr_path: stderrPath });

    return {
      status: "succeeded",
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutPath,
      stderrPath,
      command: commandSpec.command,
      args: commandSpec.args,
    };
  }
}
