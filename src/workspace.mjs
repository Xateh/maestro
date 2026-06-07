import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { nullLogger } from "./logger.mjs";

function workspaceError(code, message = code) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

export function sanitizeWorkspaceKey(identifier) {
  const sanitized = String(identifier ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
  return sanitized || "_";
}

function normalizeRoot(root) {
  return path.resolve(root);
}

function isInside(root, child) {
  const relative = path.relative(root, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function pathIsDirectory(target) {
  try {
    const targetStat = await fs.stat(target);
    return targetStat.isDirectory();
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function runShellHook({ script, cwd, timeoutMs, logger, hookName, fatal }) {
  if (!script) return { ok: true };
  logger.info("hook_start", { hook: hookName, cwd });

  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-lc", script], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGTERM");
      const error = workspaceError("hook_timeout", `${hookName} timed out after ${timeoutMs}ms`);
      logger.error("hook_timeout", { hook: hookName, cwd, timeout_ms: timeoutMs });
      if (fatal) reject(error);
      else resolve({ ok: false, error });
    }, timeoutMs);

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const wrapped = workspaceError("hook_spawn_error", error.message);
      logger.error("hook_failed", { hook: hookName, cwd, error: wrapped.message });
      if (fatal) reject(wrapped);
      else resolve({ ok: false, error: wrapped });
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        logger.info("hook_completed", { hook: hookName, cwd });
        resolve({ ok: true });
        return;
      }
      const error = workspaceError(
        "hook_failed",
        `${hookName} exited with ${code ?? signal}${stderr ? `: ${stderr.trim()}` : ""}`,
      );
      logger.error("hook_failed", { hook: hookName, cwd, error: error.message });
      if (fatal) reject(error);
      else resolve({ ok: false, error });
    });
  });
}

export class WorkspaceManager {
  constructor({ root, hooks = {}, logger = nullLogger() }) {
    this.root = normalizeRoot(root);
    this.hooks = {
      afterCreate: hooks.afterCreate ?? null,
      beforeRun: hooks.beforeRun ?? null,
      afterRun: hooks.afterRun ?? null,
      beforeRemove: hooks.beforeRemove ?? null,
      timeoutMs: hooks.timeoutMs ?? 60_000,
    };
    this.logger = logger;
  }

  workspacePath(identifier) {
    const workspaceKey = sanitizeWorkspaceKey(identifier);
    const workspacePath = path.resolve(this.root, workspaceKey);
    if (!this.isPathInsideRoot(workspacePath)) {
      throw workspaceError("workspace_path_outside_root", workspacePath);
    }
    return { workspaceKey, workspacePath };
  }

  isPathInsideRoot(candidate) {
    return isInside(this.root, path.resolve(candidate));
  }

  async createForIssue(identifier) {
    const { workspaceKey, workspacePath } = this.workspacePath(identifier);
    const directoryState = await pathIsDirectory(workspacePath);
    if (directoryState === false) {
      throw workspaceError("workspace_path_not_directory", workspacePath);
    }

    let createdNow = false;
    if (directoryState === null) {
      await fs.mkdir(workspacePath, { recursive: true });
      createdNow = true;
    }

    if (!this.isPathInsideRoot(workspacePath)) {
      throw workspaceError("workspace_path_outside_root", workspacePath);
    }

    if (createdNow) {
      await runShellHook({
        script: this.hooks.afterCreate,
        cwd: workspacePath,
        timeoutMs: this.hooks.timeoutMs,
        logger: this.logger,
        hookName: "after_create",
        fatal: true,
      });
    }

    return {
      path: workspacePath,
      workspaceKey,
      createdNow,
    };
  }

  async runBeforeRun(workspacePath) {
    this.assertLaunchPath(workspacePath);
    return runShellHook({
      script: this.hooks.beforeRun,
      cwd: workspacePath,
      timeoutMs: this.hooks.timeoutMs,
      logger: this.logger,
      hookName: "before_run",
      fatal: true,
    });
  }

  async runAfterRun(workspacePath) {
    this.assertLaunchPath(workspacePath);
    return runShellHook({
      script: this.hooks.afterRun,
      cwd: workspacePath,
      timeoutMs: this.hooks.timeoutMs,
      logger: this.logger,
      hookName: "after_run",
      fatal: false,
    });
  }

  async removeForIssue(identifier) {
    const { workspacePath } = this.workspacePath(identifier);
    const directoryState = await pathIsDirectory(workspacePath);
    if (directoryState !== true) return;

    await runShellHook({
      script: this.hooks.beforeRemove,
      cwd: workspacePath,
      timeoutMs: this.hooks.timeoutMs,
      logger: this.logger,
      hookName: "before_remove",
      fatal: false,
    });
    await fs.rm(workspacePath, { recursive: true, force: true });
  }

  assertLaunchPath(workspacePath) {
    const resolved = path.resolve(workspacePath);
    if (!this.isPathInsideRoot(resolved)) {
      throw workspaceError("invalid_workspace_cwd", resolved);
    }
    return true;
  }
}
