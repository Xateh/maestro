// Default real implementation of the injectable `commandRunner` op consumed by
// the SP3 kind:"command" node. Mirrors workspace.mjs runShellHook: spawn a shell,
// bound the captured output to a tail, and kill on timeout. NEVER throws — a
// spawn error or timeout resolves to a result object the node records as a
// failure (the stage always proceeds, no gating).

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { createBoundedTail } from "./bounded-tail.mjs";
import { assertInsideDir } from "./fs-safe.mjs";
import { parseCoverage } from "./coverage-parsers.mjs";

const DEFAULT_TAIL_BYTES = 65_536;
// Grace after SIGTERM before escalating to SIGKILL for a child that ignores it.
const KILL_GRACE_MS = 2_000;

const MAX_COV_BYTES = 4 * 1024 * 1024;

/**
 * Private: run the child process and return a result object.
 * Same logic as the original commandRunner body, extracted so the public
 * async wrapper can await it before doing post-exit I/O.
 */
function _runProcess({
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

    const out = createBoundedTail(maxTailBytes);
    const err = createBoundedTail(maxTailBytes);
    let settled = false;

    const timer = timers.setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      // Escalate to SIGKILL if the child ignores SIGTERM; unref so the grace
      // timer never keeps the event loop alive on its own. (F7)
      const killTimer = timers.setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
      }, KILL_GRACE_MS);
      killTimer?.unref?.();
      child.on("exit", () => { try { timers.clearTimeout(killTimer); } catch {} });
      resolve({
        exit_code: null,
        signal: "SIGTERM",
        stdout: out.value(),
        stderr: err.value(),
        timed_out: true,
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => { out.push(chunk); });
    child.stderr?.on("data", (chunk) => { err.push(chunk); });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      resolve({
        exit_code: 127,
        signal: null,
        stdout: out.value(),
        stderr: err.value() ? `${err.value()}\n${error.message}` : error.message,
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
        stdout: out.value(),
        stderr: err.value(),
        timed_out: false,
      });
    });
  });
}

/**
 * Run a single shell command, capturing a bounded stdout/stderr tail.
 * Optionally reads a coverage file after the command exits.
 *
 * @param {object}   opts
 * @param {string}   opts.run           - shell command string
 * @param {string}   opts.cwd           - working directory
 * @param {number}   opts.timeoutMs     - kill the child after this many ms
 * @param {object}   [opts.env]         - extra env vars layered over process.env
 * @param {number}   [opts.maxTailBytes]- output tail cap (default 65_536)
 * @param {Function} [opts.spawnProcess]- injectable spawn (default node:child_process spawn)
 * @param {object}   [opts.timers]      - injectable {setTimeout, clearTimeout} for determinism
 * @param {object}   [opts.coverageSpec]- { format, path, pct? } — read coverage after exit
 * @returns {Promise<{exit_code, signal, stdout, stderr, timed_out, spawn_error?, coverage_pct?, coverage_parse_error?}>}
 *   Always resolves; never rejects.
 */
export async function commandRunner(opts) {
  const {
    run,
    cwd,
    timeoutMs,
    env = {},
    maxTailBytes = DEFAULT_TAIL_BYTES,
    spawnProcess = spawn,
    timers = { setTimeout, clearTimeout },
    coverageSpec = null,
  } = opts;

  const result = await _runProcess({ run, cwd, timeoutMs, env, maxTailBytes, spawnProcess, timers });

  // Post-exit: read coverage file (best-effort, bounded)
  if (coverageSpec?.format && coverageSpec?.path) {
    try {
      const absPath = path.resolve(cwd, coverageSpec.path);
      assertInsideDir(cwd, absPath);
      const raw = await fs.readFile(absPath, { encoding: "utf8" });
      if (Buffer.byteLength(raw, "utf8") > MAX_COV_BYTES) {
        throw new Error("coverage file exceeds 4 MB limit");
      }
      const parsed = parseCoverage(coverageSpec.format, raw, { pct: coverageSpec.pct });
      if (parsed !== null) {
        result.coverage_pct = parsed.pct;
      } else {
        result.coverage_parse_error = `coverage parse failed for format "${coverageSpec.format}"`;
      }
    } catch (err) {
      result.coverage_parse_error = err?.message ?? String(err);
    }
  }

  return result;
}
