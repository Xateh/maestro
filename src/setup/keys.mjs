// API-key / secrets handling for Maestro.
//
// Secrets live ONLY in .maestro/secrets.local.json (mode 0600, gitignored).
// Shareable files (config.json, workflow.json, export bundles) carry "$VAR"
// references resolved against the environment at spawn time.

import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { ENV_KEY_DENYLIST } from "../agent-runner.mjs";
import { resolveDollarValue } from "../workflow.mjs";

const SECRETS_FILE = "secrets.local.json";

export function secretsPath(stateDir) {
  return path.join(stateDir, SECRETS_FILE);
}

export async function readLocalSecrets(stateDir) {
  try {
    const text = await fs.readFile(secretsPath(stateDir), "utf8");
    const parsed = JSON.parse(text);
    const env = parsed?.env;
    return env && typeof env === "object" && !Array.isArray(env) ? env : {};
  } catch (error) {
    if (error.code === "ENOENT") return {};
    if (error instanceof SyntaxError) {
      // Loud, not lossy: returning {} here would let the wizard's next write
      // silently erase every stored secret. Callers on the startup path
      // (loadLocalSecrets via bin) catch and warn.
      throw new Error(`secrets_local_malformed: fix or remove ${secretsPath(stateDir)} (${error.message})`);
    }
    throw error;
  }
}

export async function writeLocalSecrets(stateDir, env) {
  const filePath = secretsPath(stateDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${SECRETS_FILE}.${process.pid}.${Date.now()}.tmp`,
  );
  await fs.writeFile(tempPath, `${JSON.stringify({ version: 1, env }, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, filePath);
  await fs.chmod(filePath, 0o600);
  return env;
}

// Load secrets into the process env. Real environment variables always win.
// Returns the names of keys that were applied.
export async function loadLocalSecrets(stateDir, env = process.env) {
  const secrets = await readLocalSecrets(stateDir);
  const applied = [];
  for (const [key, value] of Object.entries(secrets)) {
    if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    // Only fill truly-unset keys: an explicit empty string is a deliberate
    // user override (e.g. KEY="" to disable a stored secret for one run).
    if (env[key] === undefined) {
      env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

// Resolve a provider's `env` map ({"OPENAI_API_KEY": "$OPENAI_API_KEY"}) to
// concrete values for the spawned process. Unresolvable refs are dropped, as
// are execution-subverting keys (PATH, LD_*, NODE_OPTIONS, …) — provider
// definitions can arrive via imported bundles and must honor the same env
// contract as agent-supplied action requests.
export function resolveProviderEnv(providerDef, env = process.env) {
  const declared = providerDef?.env;
  if (!declared || typeof declared !== "object" || Array.isArray(declared)) return {};
  const resolved = {};
  for (const [key, value] of Object.entries(declared)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || ENV_KEY_DENYLIST.test(key)) continue;
    const concrete = resolveDollarValue(value, env);
    if (typeof concrete === "string" && concrete !== "") resolved[key] = concrete;
  }
  return resolved;
}

// Read one line with terminal echo muted (best-effort; falls back to plain).
function questionMuted(rl, stdout, prompt) {
  return new Promise((resolve) => {
    stdout.write(prompt);
    const origWrite = rl._writeToOutput?.bind(rl);
    if (origWrite) {
      // Suppress ALL echo while muted — a pasted secret containing newlines
      // must not leak to the terminal; the resolve path writes its own "\n".
      rl._writeToOutput = () => {};
    }
    rl.question("", (answer) => {
      if (origWrite) rl._writeToOutput = origWrite;
      stdout.write("\n");
      resolve(answer);
    });
  });
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Interactive wizard: list/add/remove secret env vars.
// Non-interactive: `maestro setup keys --var NAME` reads the value from stdin.
export async function runKeysWizard({
  stateDir,
  args = [],
  stdin = process.stdin,
  stdout = process.stdout,
}) {
  const varFlagIndex = args.indexOf("--var");
  if (varFlagIndex !== -1) {
    const name = args[varFlagIndex + 1];
    if (!name || !ENV_NAME_RE.test(name)) {
      throw new Error(`invalid_env_name: ${name ?? "(missing)"}`);
    }
    const chunks = [];
    for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const value = Buffer.concat(chunks).toString("utf8").trim();
    if (!value) throw new Error("empty_secret_value");
    const secrets = await readLocalSecrets(stateDir);
    await writeLocalSecrets(stateDir, { ...secrets, [name]: value });
    stdout.write(`stored ${name} in ${secretsPath(stateDir)} (0600)\n`);
    stdout.write(`reference it from shareable config as "$${name}"\n`);
    return;
  }

  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
  const ask = (prompt) => new Promise((resolve) => rl.question(prompt, resolve));
  try {
    for (;;) {
      const secrets = await readLocalSecrets(stateDir);
      const names = Object.keys(secrets);
      stdout.write(`\nSecrets in ${secretsPath(stateDir)} (values hidden):\n`);
      stdout.write(names.length ? `${names.map((n) => `  - ${n}`).join("\n")}\n` : "  (none)\n");
      stdout.write("\nKeys are optional — Maestro drives provider CLIs that handle their own auth.\n");
      stdout.write("Use them for trackers (e.g. LINEAR_API_KEY) or API-based local agents.\n");
      const action = (await ask("\n[a]dd, [r]emove, [q]uit: ")).trim().toLowerCase();
      if (action === "q" || action === "") break;
      if (action === "a") {
        const name = (await ask("env var name (e.g. OPENAI_API_KEY): ")).trim();
        if (!ENV_NAME_RE.test(name)) {
          stdout.write("invalid name — letters, digits, underscore; cannot start with a digit\n");
          continue;
        }
        const value = (await questionMuted(rl, stdout, "value (hidden): ")).trim();
        if (!value) {
          stdout.write("empty value — skipped\n");
          continue;
        }
        await writeLocalSecrets(stateDir, { ...secrets, [name]: value });
        stdout.write(`stored ${name}. Reference it from shareable config as "$${name}".\n`);
      } else if (action === "r") {
        const name = (await ask("env var name to remove: ")).trim();
        if (!(name in secrets)) {
          stdout.write(`no such key: ${name}\n`);
          continue;
        }
        const { [name]: _removed, ...rest } = secrets;
        await writeLocalSecrets(stateDir, rest);
        stdout.write(`removed ${name}\n`);
      }
    }
  } finally {
    rl.close();
  }
}
