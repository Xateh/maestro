import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

export function defaultGitRunner({ args = [], cwd = process.cwd() } = {}) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr, code: 0 });
    });
  });
}

export function defaultHostRunner({
  command,
  args = [],
  cwd = process.cwd(),
  env = {},
  timeoutMs = null,
} = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd,
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0,
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr, code: 0 });
    });
  });
}

export async function runGit(gitRunner, cwd, args) {
  return gitRunner({ args, cwd });
}

export async function gitStdout(gitRunner, cwd, args) {
  const result = await runGit(gitRunner, cwd, args);
  return String(result.stdout ?? "").trim();
}

export async function gitSucceeds(gitRunner, cwd, args) {
  try {
    await runGit(gitRunner, cwd, args);
    return true;
  } catch {
    return false;
  }
}

export function hashText(value = "") {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

export async function safeGitStdout(gitRunner, cwd, args) {
  try {
    return await gitStdout(gitRunner, cwd, args);
  } catch {
    return "";
  }
}

export async function readGitSnapshot(gitRunner, cwd) {
  const [branch, head, statusResult, remoteUrl] = await Promise.all([
    safeGitStdout(gitRunner, cwd, ["branch", "--show-current"]),
    safeGitStdout(gitRunner, cwd, ["rev-parse", "HEAD"]),
    runGit(gitRunner, cwd, ["status", "--porcelain"]).catch(() => ({ stdout: "" })),
    safeGitStdout(gitRunner, cwd, ["config", "--get", "remote.origin.url"]),
  ]);
  const statusText = String(statusResult.stdout ?? "");
  return {
    branch,
    head,
    status_text: statusText,
    status_hash: hashText(statusText),
    remote_url: remoteUrl,
  };
}
