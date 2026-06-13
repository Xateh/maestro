// Resolve the passphrase that unlocks the encrypted secret store. Ordered,
// pluggable backends: env var (unattended) → [future OS keyring] → muted TTY
// prompt. Never writes the passphrase anywhere.

import readline from "node:readline";

const ENV_VAR = "MAESTRO_SECRET_PASSPHRASE";

function promptMuted(stdin, stdout, prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
    stdout.write(prompt);
    const origWrite = rl._writeToOutput?.bind(rl);
    if (origWrite) rl._writeToOutput = () => {};
    rl.question("", (answer) => {
      if (origWrite) rl._writeToOutput = origWrite;
      stdout.write("\n");
      rl.close();
      resolve(answer);
    });
  });
}

export async function getPassphrase({
  env = process.env,
  interactive = true,
  stdin = process.stdin,
  stdout = process.stdout,
  prompt = "maestro secret passphrase: ",
} = {}) {
  const fromEnv = env[ENV_VAR];
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  // Future: OS keyring backend (libsecret / Keychain / DPAPI) slots in here.
  if (interactive && stdin.isTTY) {
    const value = (await promptMuted(stdin, stdout, prompt)).trim();
    if (value) return value;
  }
  throw new Error("secret_passphrase_required");
}
