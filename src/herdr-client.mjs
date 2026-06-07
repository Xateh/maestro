import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";


const HERDR_BIN = process.env.HERDR_BIN ?? "herdr";

function herdrError(code, message = code) {
  const error = new Error(`herdr_${code}: ${message}`);
  error.code = `herdr_${code}`;
  return error;
}

function socketPath() {
  return process.env.HERDR_SOCKET_PATH
    ?? path.join(os.homedir(), ".config", "herdr", "herdr.sock");
}

async function socketExists() {
  try {
    await fs.access(socketPath());
    return true;
  } catch {
    return false;
  }
}

async function waitForSocket(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await socketExists()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw herdrError("start_timeout", "herdr server socket did not appear within timeout");
}

let _ensurePromise = null;

async function ensureServer() {
  if (_ensurePromise) return _ensurePromise;
  _ensurePromise = (async () => {
    if (await socketExists()) return;
    const child = spawn(HERDR_BIN, ["server"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    await waitForSocket();
  })();
  return _ensurePromise;
}

export async function herdrCli(args) {
  await ensureServer();
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(HERDR_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (c) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
    child.on("error", reject);
    child.on("exit", () => {
      const line = stdout.trim();
      if (!line) {
        reject(herdrError("empty_response", `herdr ${args[0]} ${args[1] ?? ""} returned no output\n${stderr}`));
        return;
      }
      let parsed;
      try { parsed = JSON.parse(line); } catch {
        reject(herdrError("parse_error", `could not parse: ${line}`));
        return;
      }
      if (parsed.error) {
        const e = herdrError(parsed.error.code ?? "api_error", parsed.error.message ?? JSON.stringify(parsed.error));
        reject(e);
        return;
      }
      resolve(parsed.result ?? parsed);
    });
  });
}

