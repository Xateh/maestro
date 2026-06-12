// `maestro doctor` — preflight checks: node version, provider CLIs, herdr,
// and the .maestro state directory (config, workflow, db, secrets). Pure
// reporting: never mutates anything, never prints secret values, and works
// outside a project (state checks degrade to "skip").

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { directCommandExists } from "../agent-runner.mjs";
import { validateWorkflow } from "../workflow-validate.mjs";
import { readLocalSecrets, secretsPath } from "./keys.mjs";
import { CLI_PROVIDERS, LOCAL_AGENT_PROVIDERS } from "./scanners/local-agents.mjs";

const execFileAsync = promisify(execFile);

const PACKAGE_JSON = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);

// "22.14.0" vs ">=22.13" minimum (with or without the ">=" prefix).
export function versionAtLeast(version, minimum) {
  const parse = (value) => String(value ?? "")
    .replace(/^[>=^~\s]+/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const have = parse(version);
  const want = parse(minimum);
  for (let i = 0; i < Math.max(have.length, want.length); i += 1) {
    const a = have[i] ?? 0;
    const b = want[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

function check(id, label, status, detail = "") {
  return { id, label, status, detail };
}

async function defaultOpenDb(dbPath) {
  const { SqliteTaskStore } = await import("../db/store.mjs");
  return new SqliteTaskStore(dbPath);
}

export async function runDoctor({
  stateDir,
  cwd = process.cwd(),
  env = process.env,
  exec = execFileAsync,
  commandExists = directCommandExists,
  openDb = defaultOpenDb,
  nodeVersion = process.versions.node,
} = {}) {
  const checks = [];

  const minNode = PACKAGE_JSON.engines?.node ?? ">=22.13";
  checks.push(versionAtLeast(nodeVersion, minNode)
    ? check("node", "node", "pass", `v${nodeVersion} (requires ${minNode})`)
    : check("node", "node", "fail", `v${nodeVersion} — Maestro requires ${minNode}`));

  for (const provider of [...CLI_PROVIDERS, ...LOCAL_AGENT_PROVIDERS]) {
    const found = await commandExists(provider, { cwd, env });
    if (!found) {
      checks.push(check(`provider:${provider}`, provider, "skip", "not installed"));
      continue;
    }
    let detail = "installed";
    try {
      const { stdout } = await exec(provider, ["--version"], { timeout: 10_000 });
      const firstLine = String(stdout ?? "").split(/\r?\n/)[0].trim();
      if (firstLine) detail = firstLine;
    } catch {
      detail = "installed (--version failed)";
    }
    checks.push(check(`provider:${provider}`, provider, "pass", detail));
  }

  const herdrBin = env.HERDR_BIN ?? "herdr";
  const herdrFound = await commandExists(herdrBin, { cwd, env });
  const backend = env.MAESTRO_BACKEND === "terminal" ? "terminal (MAESTRO_BACKEND)" : "auto";
  checks.push(herdrFound
    ? check("herdr", "herdr", "pass", `installed — backend: ${backend}`)
    : check("herdr", "herdr", "skip", `not installed — tasks fall back to the terminal backend (backend: ${backend})`));

  let stateExists = false;
  try {
    stateExists = (await fs.stat(stateDir)).isDirectory();
  } catch {
    stateExists = false;
  }
  checks.push(stateExists
    ? check("state", "state dir", "pass", stateDir)
    : check("state", "state dir", "skip", `${stateDir} not found — run \`maestro init\``));

  if (!stateExists) {
    for (const [id, label] of [["config", "config.json"], ["workflow", "workflow.json"], ["db", "maestro.db"], ["secrets", "secrets"]]) {
      checks.push(check(id, label, "skip", "no state dir"));
    }
    return { ok: checks.every((c) => c.status !== "fail"), checks };
  }

  let config = null;
  try {
    config = JSON.parse(await fs.readFile(path.join(stateDir, "config.json"), "utf8"));
    checks.push(check("config", "config.json", "pass", "parseable"));
  } catch (error) {
    checks.push(error.code === "ENOENT"
      ? check("config", "config.json", "skip", "missing")
      : check("config", "config.json", "fail", `malformed: ${error.message}`));
  }

  try {
    const workflow = JSON.parse(await fs.readFile(path.join(stateDir, "workflow.json"), "utf8"));
    const result = validateWorkflow(workflow, { config });
    if (result.ok) {
      const warnings = result.warnings.length > 0 ? `${result.warnings.length} warning(s)` : "valid";
      checks.push(check("workflow", "workflow.json", "pass", warnings));
    } else {
      checks.push(check("workflow", "workflow.json", "fail", result.errors.map((e) => e.code).join(", ")));
    }
  } catch (error) {
    checks.push(error.code === "ENOENT"
      ? check("workflow", "workflow.json", "skip", "missing")
      : check("workflow", "workflow.json", "fail", `malformed: ${error.message}`));
  }

  try {
    const db = await openDb(path.join(stateDir, "maestro.db"));
    db.close();
    checks.push(check("db", "maestro.db", "pass", "openable"));
  } catch (error) {
    checks.push(check("db", "maestro.db", "fail", error.message));
  }

  try {
    const stat = await fs.stat(secretsPath(stateDir));
    const secrets = await readLocalSecrets(stateDir);
    const names = Object.keys(secrets);
    const tooOpen = process.platform !== "win32" && (stat.mode & 0o077) !== 0;
    if (tooOpen) {
      checks.push(check("secrets", "secrets", "fail", `file mode too open — run: chmod 600 ${secretsPath(stateDir)}`));
    } else {
      checks.push(check("secrets", "secrets", "pass", names.length > 0 ? `keys: ${names.join(", ")}` : "no keys stored"));
    }
  } catch (error) {
    checks.push(error.code === "ENOENT"
      ? check("secrets", "secrets", "skip", "none stored")
      : check("secrets", "secrets", "fail", error.message));
  }

  return { ok: checks.every((c) => c.status !== "fail"), checks };
}

const GLYPHS = {
  pass: { mark: "✓", color: "\u001b[32m" },
  fail: { mark: "✗", color: "\u001b[31m" },
  skip: { mark: "–", color: "\u001b[2m" },
};
const RESET = "\u001b[0m";

export function formatDoctorReport(result, { color = false } = {}) {
  const lines = ["Maestro preflight:"];
  for (const entry of result.checks) {
    const glyph = GLYPHS[entry.status] ?? GLYPHS.skip;
    const mark = color ? `${glyph.color}${glyph.mark}${RESET}` : glyph.mark;
    const detail = entry.detail ? `  ${entry.detail}` : "";
    lines.push(`  ${mark} ${entry.label.padEnd(14)}${detail}`);
  }
  lines.push(result.ok ? "all checks passed" : "problems found — see ✗ lines above");
  return lines.join("\n");
}
