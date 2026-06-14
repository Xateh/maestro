// Default real implementation of the injectable `commandRunner` op consumed by
// the SP3 kind:"command" node. Mirrors workspace.mjs runShellHook: spawn a shell,
// bound the captured output to a tail, and kill on timeout. NEVER throws — a
// spawn error or timeout resolves to a result object the node records as a
// failure (the stage always proceeds, no gating).

import { spawn } from "node:child_process";

const DEFAULT_TAIL_BYTES = 65_536;

// Keep only the last `maxBytes` of UTF-8 output (copied from agent-runner.mjs
// appendBoundedTail — module-private there, so duplicated here).
function appendBoundedTail(current, chunk, maxBytes) {
  const next = `${current}${chunk.toString("utf8")}`;
  const buffer = Buffer.from(next, "utf8");
  if (buffer.length <= maxBytes) return next;
  return buffer
    .subarray(buffer.length - maxBytes)
    .toString("utf8")
    .replace(/^�/, "");
}

/**
 * Run a single shell command, capturing a bounded stdout/stderr tail.
 *
 * @param {object}   opts
 * @param {string}   opts.run           - shell command string
 * @param {string}   opts.cwd           - working directory
 * @param {number}   opts.timeoutMs     - kill the child after this many ms
 * @param {object}   [opts.env]         - extra env vars layered over process.env
 * @param {number}   [opts.maxTailBytes]- output tail cap (default 65_536)
 * @param {Function} [opts.spawnProcess]- injectable spawn (default node:child_process spawn)
 * @param {object}   [opts.timers]      - injectable {setTimeout, clearTimeout} for determinism
 * @returns {Promise<{exit_code, signal, stdout, stderr, timed_out, spawn_error?}>}
 *   Always resolves; never rejects.
 */
export function commandRunner({
  run,
  cwd,
  timeoutMs,
  env = {},
  maxTailBytes = DEFAULT_TAIL_BYTES,
  spawnProcess = spawn,
  timers = { setTimeout, clearTimeout },
}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess("sh", ["-lc", run], {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        exit_code: 127,
        signal: null,
        stdout: "",
        stderr: error?.message ?? String(error),
        timed_out: false,
        spawn_error: true,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = timers.setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({
        exit_code: null,
        signal: "SIGTERM",
        stdout,
        stderr,
        timed_out: true,
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout = appendBoundedTail(stdout, chunk, maxTailBytes);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendBoundedTail(stderr, chunk, maxTailBytes);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      resolve({
        exit_code: 127,
        signal: null,
        stdout,
        stderr: stderr ? `${stderr}\n${error.message}` : error.message,
        timed_out: false,
        spawn_error: true,
      });
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      resolve({
        exit_code: code,
        signal: signal ?? null,
        stdout,
        stderr,
        timed_out: false,
      });
    });
  });
}
