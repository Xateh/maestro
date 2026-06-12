// Detection of locally installed agent runtimes (ollama, pi, hermes,
// openclaw) plus the standard provider CLIs. Read-only probes; results feed
// `maestro setup local`, which writes confirmed values to config.local.json.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { directCommandExists } from "../../agent-runner.mjs";

const execFileAsync = promisify(execFile);

export const LOCAL_AGENT_PROVIDERS = ["ollama", "pi", "hermes", "openclaw"];
export const CLI_PROVIDERS = ["claude", "codex", "copilot", "gemini", "antigravity"];

// Parse `ollama list` output: first column of every non-header line.
export function parseOllamaList(stdout) {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .slice(1) // header: NAME ID SIZE MODIFIED
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((name) => name && name !== "NAME");
}

export async function discoverOllamaModels({ exec = execFileAsync, alias = "ollama" } = {}) {
  try {
    const { stdout } = await exec(alias, ["list"], { timeout: 10_000 });
    return parseOllamaList(stdout);
  } catch {
    return [];
  }
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

// ~/.pi/agent/models.json — custom model/provider registry for the Pi agent.
export async function readPiModels(filePath = path.join(os.homedir(), ".pi", "agent", "models.json")) {
  const parsed = await readJsonIfExists(filePath);
  if (!parsed) return [];
  // models.json maps provider blocks with a models map/array; collect ids defensively.
  const ids = [];
  const visit = (value) => {
    if (Array.isArray(value)) for (const item of value) visit(item);
    else if (value && typeof value === "object") {
      if (typeof value.id === "string") ids.push(value.id);
      else for (const [key, inner] of Object.entries(value)) {
        if (key === "models" && inner && typeof inner === "object" && !Array.isArray(inner)) {
          ids.push(...Object.keys(inner));
        } else visit(inner);
      }
    }
  };
  visit(parsed);
  return [...new Set(ids)];
}

// ~/.openclaw/openclaw.json — agent + model config for OpenClaw.
export async function readOpenclawConfig(filePath = path.join(os.homedir(), ".openclaw", "openclaw.json")) {
  const parsed = await readJsonIfExists(filePath);
  if (!parsed) return null;
  return {
    primaryModel: parsed?.agents?.defaults?.model?.primary ?? null,
    agents: Object.keys(parsed?.agents ?? {}).filter((k) => k !== "defaults"),
  };
}

/**
 * Probe the machine for agent runtimes.
 * Returns [{provider, found, alias, models, notes}].
 */
export async function detectLocalAgents({
  exec = execFileAsync,
  env = process.env,
  cwd = process.cwd(),
  homedir = os.homedir(),
} = {}) {
  const results = [];

  for (const provider of [...CLI_PROVIDERS, ...LOCAL_AGENT_PROVIDERS]) {
    const found = await directCommandExists(provider, { cwd, env });
    const entry = { provider, found, alias: provider, models: [], notes: [] };

    if (provider === "ollama" && found) {
      entry.models = await discoverOllamaModels({ exec });
      if (entry.models.length === 0) {
        entry.notes.push("no local models — run `ollama pull <model>` first");
      }
    }
    if (provider === "pi" && found) {
      const models = await readPiModels(path.join(homedir, ".pi", "agent", "models.json"));
      if (models.length > 0) entry.models = models;
    }
    if (provider === "openclaw" && found) {
      const config = await readOpenclawConfig(path.join(homedir, ".openclaw", "openclaw.json"));
      if (config?.primaryModel) entry.notes.push(`primary model: ${config.primaryModel}`);
    }

    results.push(entry);
  }
  return results;
}
