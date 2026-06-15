// Resolve the passphrase that unlocks the encrypted secret store. Ordered,
// pluggable backends: env var (unattended) → [future OS keyring] → muted TTY
// prompt. Never writes the passphrase anywhere.

import { readSecretMasked } from "./secret-prompt.mjs";

const ENV_VAR = "MAESTRO_SECRET_PASSPHRASE";

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
    // Prompt/instructions stay visible; only the typed passphrase is masked.
    const value = (await readSecretMasked({ stdin, stdout, prompt })).trim();
    if (value) return value;
  }
  throw new Error("secret_passphrase_required");
}
