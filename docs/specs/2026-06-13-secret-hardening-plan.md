# Maestro Secret Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a native encrypted secret store to maestro (scrypt + AES-256-GCM, zero new deps, passphrase-unlocked) plus a `maestro setup harden` installer that drops an agent guardrail, so maestro's secrets are unreadable at rest and not directly accessible to the driving agent.

**Architecture:** A new `secret-crypto.mjs` encrypts the secret env map into a JSON envelope; `secret-passphrase.mjs` resolves the unlock passphrase (env → future keyring → muted prompt). `keys.mjs` is extended to read/write the encrypted store at `.maestro/secrets.local.enc.json`, preferring it over the legacy plaintext `secrets.local.json` and keeping the "real env wins / only fill unset" load contract. `setup harden` merges a `PreToolUse` hook + deny rules into the user's Claude Code `settings.json`, backed by a shipped `scripts/secret-guard.mjs`.

**Tech Stack:** Node 22, built-in `node:crypto`, `node:test`, biome lint.

---

## File Structure

- Create `src/setup/secret-crypto.mjs` — pure encrypt/decrypt of the envelope. One responsibility: crypto.
- Create `src/setup/secret-passphrase.mjs` — passphrase resolution (pluggable backends). One responsibility: where the unlock secret comes from.
- Modify `src/setup/keys.mjs` — store-format awareness (encrypted vs legacy), migration, `--encrypt`.
- Create `src/setup/harden.mjs` — compute + apply the Claude-settings merge. One responsibility: installer logic.
- Create `scripts/secret-guard.mjs` — the PreToolUse guard executable (reads tool input on stdin, allow/deny).
- Modify `src/cli/local-command.mjs` — route `setup keys --encrypt|--migrate` and `setup harden`.
- Modify `src/cli/registry.mjs` — document the new flags/subcommand.
- Modify `src/setup/doctor.mjs` — report store mode (plaintext|encrypted) + passphrase resolvability.
- Modify `docs/configuration.md`, `CHANGELOG.md`.
- Create `test/maestro-secret-crypto.test.mjs`; extend `test/maestro-setup.test.mjs`; create `test/maestro-harden.test.mjs`.
- Modify `package.json` — add the two new test files to the `test` script.

---

## Task 1: Secret crypto envelope (encrypt/decrypt round-trip)

**Files:**
- Create: `src/setup/secret-crypto.mjs`
- Test: `test/maestro-secret-crypto.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// test/maestro-secret-crypto.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decryptSecrets,
  encryptSecrets,
  isEncryptedEnvelope,
} from "../src/setup/secret-crypto.mjs";

test("encrypt then decrypt round-trips the env map", () => {
  const env = { LINEAR_API_KEY: "lin_api_secret", OTHER: "x" };
  const envelope = encryptSecrets(env, "correct horse");
  assert.equal(envelope.version, 1);
  assert.equal(envelope.cipher, "aes-256-gcm");
  assert.equal(envelope.kdf, "scrypt");
  assert.ok(isEncryptedEnvelope(envelope));
  assert.ok(!("LINEAR_API_KEY" in envelope)); // no plaintext leak in the envelope
  assert.deepEqual(decryptSecrets(envelope, "correct horse"), env);
});

test("wrong passphrase fails closed without leaking plaintext", () => {
  const envelope = encryptSecrets({ A: "1" }, "right");
  assert.throws(() => decryptSecrets(envelope, "wrong"), /secret_decrypt_failed/);
});

test("tampered ciphertext is rejected by the auth tag", () => {
  const envelope = encryptSecrets({ A: "1" }, "pw");
  const tampered = { ...envelope, ciphertext: Buffer.from("AAAA", "utf8").toString("base64") };
  assert.throws(() => decryptSecrets(tampered, "pw"), /secret_decrypt_failed/);
});

test("empty passphrase is refused on encrypt", () => {
  assert.throws(() => encryptSecrets({ A: "1" }, ""), /secret_passphrase_required/);
});

test("isEncryptedEnvelope distinguishes legacy plaintext shape", () => {
  assert.ok(!isEncryptedEnvelope({ version: 1, env: { A: "1" } }));
  assert.ok(!isEncryptedEnvelope(null));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/maestro-secret-crypto.test.mjs`
Expected: FAIL — `Cannot find module '../src/setup/secret-crypto.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/setup/secret-crypto.mjs
//
// Encrypt maestro's secret env map at rest. The decryption secret (passphrase)
// must live in a different trust domain than this ciphertext — see
// secret-passphrase.mjs. This module is pure: it never touches the filesystem
// or the environment.

import crypto from "node:crypto";

const KDF = { N: 32768, r: 8, p: 1, keylen: 32 };
// scrypt needs maxmem >= 128 * N * r; give generous headroom for the defaults.
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

function deriveKey(passphrase, salt, params = KDF) {
  return crypto.scryptSync(passphrase, salt, KDF.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

export function isEncryptedEnvelope(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      value.version === 1 &&
      value.kdf === "scrypt" &&
      value.cipher === "aes-256-gcm" &&
      typeof value.ciphertext === "string",
  );
}

export function encryptSecrets(envObj, passphrase) {
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    throw new Error("secret_passphrase_required");
  }
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(envObj ?? {}), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    kdf: "scrypt",
    kdfParams: { N: KDF.N, r: KDF.r, p: KDF.p, salt: salt.toString("base64") },
    cipher: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptSecrets(envelope, passphrase) {
  if (!isEncryptedEnvelope(envelope)) throw new Error("secret_envelope_unsupported");
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    throw new Error("secret_passphrase_required");
  }
  try {
    const params = {
      N: envelope.kdfParams.N,
      r: envelope.kdfParams.r,
      p: envelope.kdfParams.p,
    };
    const salt = Buffer.from(envelope.kdfParams.salt, "base64");
    const iv = Buffer.from(envelope.iv, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");
    const key = deriveKey(passphrase, salt, params);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const parsed = JSON.parse(plaintext.toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new Error("secret_decrypt_failed");
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/maestro-secret-crypto.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Lint**

Run: `npx biome lint src/setup/secret-crypto.mjs test/maestro-secret-crypto.test.mjs`
Expected: no errors.

- [ ] **Step 6: Register the new test file**

Modify `package.json` `scripts.test`: append ` test/maestro-secret-crypto.test.mjs` to the `node --test …` list.

- [ ] **Step 7: Commit**

```bash
git add src/setup/secret-crypto.mjs test/maestro-secret-crypto.test.mjs package.json
git commit -m "feat(secrets): add scrypt+aes-256-gcm secret envelope"
```

---

## Task 2: Passphrase resolution backend

**Files:**
- Create: `src/setup/secret-passphrase.mjs`
- Test: extend `test/maestro-secret-crypto.test.mjs`

- [ ] **Step 1: Write the failing test** (append to `test/maestro-secret-crypto.test.mjs`)

```js
import { getPassphrase } from "../src/setup/secret-passphrase.mjs";

test("getPassphrase prefers MAESTRO_SECRET_PASSPHRASE", async () => {
  const pw = await getPassphrase({
    env: { MAESTRO_SECRET_PASSPHRASE: "from-env" },
    interactive: false,
  });
  assert.equal(pw, "from-env");
});

test("getPassphrase throws when unattended and no env passphrase", async () => {
  await assert.rejects(
    () => getPassphrase({ env: {}, interactive: false }),
    /secret_passphrase_required/,
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/maestro-secret-crypto.test.mjs`
Expected: FAIL — `Cannot find module '../src/setup/secret-passphrase.mjs'`.

- [ ] **Step 3: Implement**

```js
// src/setup/secret-passphrase.mjs
//
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/maestro-secret-crypto.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Lint + commit**

```bash
npx biome lint src/setup/secret-passphrase.mjs
git add src/setup/secret-passphrase.mjs test/maestro-secret-crypto.test.mjs
git commit -m "feat(secrets): add passphrase resolution backend"
```

---

## Task 3: Encrypted store read/write in keys.mjs

**Files:**
- Modify: `src/setup/keys.mjs`
- Test: extend `test/maestro-setup.test.mjs`

Add near the top of `keys.mjs`:

```js
import { decryptSecrets, encryptSecrets, isEncryptedEnvelope } from "./secret-crypto.mjs";
import { getPassphrase } from "./secret-passphrase.mjs";

const ENC_SECRETS_FILE = "secrets.local.enc.json";

export function encryptedSecretsPath(stateDir) {
  return path.join(stateDir, ENC_SECRETS_FILE);
}
```

- [ ] **Step 1: Write the failing test** (append to `test/maestro-setup.test.mjs`, reusing `withTempDir`)

```js
import {
  encryptedSecretsPath,
  writeEncryptedSecrets,
} from "../src/setup/keys.mjs";

test("encrypted secrets write+load round-trip via passphrase env", async () => {
  await withTempDir(async (dir) => {
    await writeEncryptedSecrets(dir, { LINEAR_API_KEY: "lin_secret" }, "pw");
    const enc = JSON.parse(await readFile(encryptedSecretsPath(dir), "utf8"));
    assert.ok(!JSON.stringify(enc).includes("lin_secret")); // ciphertext only
    const env = {};
    const applied = await loadLocalSecrets(dir, env, {
      passphraseEnv: { MAESTRO_SECRET_PASSPHRASE: "pw" },
    });
    assert.deepEqual(applied, ["LINEAR_API_KEY"]);
    assert.equal(env.LINEAR_API_KEY, "lin_secret");
  });
});

test("encrypted store: real env still wins over stored value", async () => {
  await withTempDir(async (dir) => {
    await writeEncryptedSecrets(dir, { LINEAR_API_KEY: "stored" }, "pw");
    const env = { LINEAR_API_KEY: "real" };
    const applied = await loadLocalSecrets(dir, env, {
      passphraseEnv: { MAESTRO_SECRET_PASSPHRASE: "pw" },
    });
    assert.deepEqual(applied, []);
    assert.equal(env.LINEAR_API_KEY, "real");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/maestro-setup.test.mjs`
Expected: FAIL — `writeEncryptedSecrets` is not exported.

- [ ] **Step 3: Implement in `src/setup/keys.mjs`**

Add `writeEncryptedSecrets` and make the readers encryption-aware. Insert after `writeLocalSecrets`:

```js
export async function writeEncryptedSecrets(stateDir, env, passphrase) {
  const filePath = encryptedSecretsPath(stateDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const envelope = encryptSecrets(env, passphrase);
  const tempPath = path.join(
    path.dirname(filePath),
    `.${ENC_SECRETS_FILE}.${process.pid}.${Date.now()}.tmp`,
  );
  await fs.writeFile(tempPath, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, filePath);
  await fs.chmod(filePath, 0o600);
  return env;
}

// Read the secret env map, preferring the encrypted store. opts.passphraseEnv
// lets callers/tests inject the env used for passphrase resolution.
export async function readSecretsEnvMap(stateDir, { passphraseEnv = process.env, interactive = false } = {}) {
  // Encrypted store wins when present.
  try {
    const encText = await fs.readFile(encryptedSecretsPath(stateDir), "utf8");
    const envelope = JSON.parse(encText);
    if (isEncryptedEnvelope(envelope)) {
      const passphrase = await getPassphrase({ env: passphraseEnv, interactive });
      return decryptSecrets(envelope, passphrase);
    }
    throw new Error("secret_envelope_unsupported");
  } catch (error) {
    if (error.code !== "ENOENT") throw error; // real decrypt/format errors propagate
  }
  // Legacy plaintext fallback.
  return readLocalSecrets(stateDir);
}
```

Then change `loadLocalSecrets` to accept options and use the new reader:

```js
export async function loadLocalSecrets(stateDir, env = process.env, opts = {}) {
  const secrets = await readSecretsEnvMap(stateDir, {
    passphraseEnv: opts.passphraseEnv ?? env,
    interactive: opts.interactive ?? false,
  });
  const applied = [];
  for (const [key, value] of Object.entries(secrets)) {
    if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (env[key] === undefined) {
      env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}
```

(Leave the existing `readLocalSecrets` plaintext reader unchanged — it is the legacy fallback and is still imported by doctor.)

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/maestro-setup.test.mjs`
Expected: PASS, including the two new tests and all pre-existing ones.

- [ ] **Step 5: Lint + commit**

```bash
npx biome lint src/setup/keys.mjs test/maestro-setup.test.mjs
git add src/setup/keys.mjs test/maestro-setup.test.mjs
git commit -m "feat(secrets): read/write encrypted store, env-wins preserved"
```

---

## Task 4: `setup keys --encrypt` migration (plaintext → encrypted + shred)

**Files:**
- Modify: `src/setup/keys.mjs` (extend `runKeysWizard`)
- Test: extend `test/maestro-setup.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { runKeysWizard } from "../src/setup/keys.mjs";

test("setup keys --encrypt migrates plaintext store and shreds it", async () => {
  await withTempDir(async (dir) => {
    await writeLocalSecrets(dir, { LINEAR_API_KEY: "lin_secret" });
    const out = [];
    await runKeysWizard({
      stateDir: dir,
      args: ["--encrypt"],
      env: { MAESTRO_SECRET_PASSPHRASE: "pw" },
      stdout: { write: (s) => out.push(s) },
    });
    // plaintext file gone
    await assert.rejects(() => stat(secretsPath(dir)), /ENOENT/);
    // encrypted file present and loads back
    const env = {};
    await loadLocalSecrets(dir, env, { passphraseEnv: { MAESTRO_SECRET_PASSPHRASE: "pw" } });
    assert.equal(env.LINEAR_API_KEY, "lin_secret");
    assert.ok(out.join("").includes("encrypted"));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/maestro-setup.test.mjs`
Expected: FAIL — `runKeysWizard` ignores `--encrypt` (no migration; plaintext file still present).

- [ ] **Step 3: Implement** — add an `--encrypt` branch at the top of `runKeysWizard`, before the `--var` branch. Update the signature to accept `env`:

```js
export async function runKeysWizard({
  stateDir,
  args = [],
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
}) {
  if (args.includes("--encrypt")) {
    const current = await readSecretsEnvMap(stateDir, { passphraseEnv: env, interactive: true });
    const passphrase = await getPassphrase({ env, interactive: true, stdout });
    await writeEncryptedSecrets(stateDir, current, passphrase);
    // Shred the legacy plaintext store if it exists.
    try {
      await fs.rm(secretsPath(stateDir));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    stdout.write(`secrets encrypted → ${encryptedSecretsPath(stateDir)} (0600)\n`);
    stdout.write("unlock with MAESTRO_SECRET_PASSPHRASE or the interactive prompt\n");
    return;
  }
  // ... existing --var branch and interactive wizard unchanged ...
```

Also: in the `--var` branch and the interactive add/remove paths, write through the encrypted store when an encrypted store already exists. Replace the two `writeLocalSecrets(stateDir, …)` calls with:

```js
await persistSecrets(stateDir, nextEnvMap, env, stdout);
```

and add this helper above `runKeysWizard`:

```js
async function persistSecrets(stateDir, envMap, env, stdout) {
  // If an encrypted store exists, keep using it; otherwise stay plaintext.
  let encExists = true;
  try {
    await fs.access(encryptedSecretsPath(stateDir));
  } catch {
    encExists = false;
  }
  if (encExists) {
    const passphrase = await getPassphrase({ env, interactive: true, stdout });
    await writeEncryptedSecrets(stateDir, envMap, passphrase);
    return;
  }
  await writeLocalSecrets(stateDir, envMap);
}
```

(Where the old code built `{ ...secrets, [name]: value }` or `rest`, pass that object as `nextEnvMap`.)

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/maestro-setup.test.mjs`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
npx biome lint src/setup/keys.mjs test/maestro-setup.test.mjs
git add src/setup/keys.mjs test/maestro-setup.test.mjs
git commit -m "feat(secrets): setup keys --encrypt migrates+shreds plaintext"
```

---

## Task 5: Guard script (`scripts/secret-guard.mjs`)

**Files:**
- Create: `scripts/secret-guard.mjs`
- Test: `test/maestro-harden.test.mjs`

The guard receives a Claude Code PreToolUse payload on stdin:
`{ "tool_name": "Bash", "tool_input": { "command": "<cmd>" } }`. It must **deny** a
command that touches the secret store unless the command is a `maestro` invocation,
and **allow** everything else. It signals deny via exit code 2 + a stderr reason
(Claude Code blocks the tool and feeds stderr back to the model).

- [ ] **Step 1: Write the failing test**

```js
// test/maestro-harden.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateGuard } from "../scripts/secret-guard.mjs";

test("denies direct reads of the secret store", () => {
  for (const cmd of [
    "cat .maestro/secrets.local.json",
    "gpg -d .maestro/secrets.local.enc.json",
    "grep KEY .maestro/secrets.local.enc.json",
    "python3 -c \"open('.maestro/secrets.local.json')\"",
  ]) {
    assert.equal(evaluateGuard({ tool_name: "Bash", tool_input: { command: cmd } }).decision, "deny", cmd);
  }
});

test("allows maestro invocations that legitimately use secrets", () => {
  for (const cmd of ["maestro setup keys --encrypt", "maestro serve", "  maestro task 'x'"]) {
    assert.equal(evaluateGuard({ tool_name: "Bash", tool_input: { command: cmd } }).decision, "allow", cmd);
  }
});

test("allows unrelated commands untouched", () => {
  for (const cmd of ["ls -la", "curl https://example.com", "git status"]) {
    assert.equal(evaluateGuard({ tool_name: "Bash", tool_input: { command: cmd } }).decision, "allow", cmd);
  }
});

test("non-Bash tools are ignored", () => {
  assert.equal(evaluateGuard({ tool_name: "Read", tool_input: { file_path: ".maestro/secrets.local.json" } }).decision, "allow");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/maestro-harden.test.mjs`
Expected: FAIL — `Cannot find module '../scripts/secret-guard.mjs'`.

- [ ] **Step 3: Implement**

```js
// scripts/secret-guard.mjs
//
// Claude Code PreToolUse guard: deny any Bash command that reads/decrypts
// maestro's secret store unless it is a `maestro` invocation. Everything else
// passes. Pure decision in evaluateGuard(); the CLI wrapper handles stdio.

const SECRET_PATH_RE = /secrets\.local(\.enc)?\.json/;

export function evaluateGuard(payload) {
  if (!payload || payload.tool_name !== "Bash") return { decision: "allow" };
  const command = String(payload.tool_input?.command ?? "");
  if (!SECRET_PATH_RE.test(command)) return { decision: "allow" };
  // References the store. Allow only if this is a maestro invocation.
  if (/(^|[\s;&|(])maestro(\s|$)/.test(command.trim())) return { decision: "allow" };
  return {
    decision: "deny",
    reason:
      "maestro's secret store is maestro-only. Use `maestro setup keys` to manage it and `maestro` to consume it; do not read .maestro/secrets.local*.json directly.",
  };
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let payload = {};
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    process.exit(0); // fail open on unparseable input — don't wedge the agent
  }
  const result = evaluateGuard(payload);
  if (result.decision === "deny") {
    process.stderr.write(`${result.reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}

// Only run as a CLI, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) main();
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/maestro-harden.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Lint + register test + commit**

```bash
npx biome lint scripts/secret-guard.mjs test/maestro-harden.test.mjs
# add test/maestro-harden.test.mjs to package.json scripts.test
git add scripts/secret-guard.mjs test/maestro-harden.test.mjs package.json
git commit -m "feat(secrets): add Claude Code secret-guard script"
```

---

## Task 6: `setup harden` installer (`src/setup/harden.mjs`)

**Files:**
- Create: `src/setup/harden.mjs`
- Test: extend `test/maestro-harden.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyHarden } from "../src/setup/harden.mjs";

test("applyHarden merges hook+deny into settings.json idempotently", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "harden-"));
  const settingsPath = path.join(dir, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }));
  const guardPath = "/opt/maestro/scripts/secret-guard.mjs";

  await applyHarden({ settingsPath, guardScriptPath: guardPath });
  await applyHarden({ settingsPath, guardScriptPath: guardPath }); // second run = no dupes

  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.ok(settings.permissions.allow.includes("Bash(ls:*)")); // preserved
  const denies = settings.permissions.deny;
  assert.equal(denies.filter((d) => d.includes("secrets.local")).length, denies.filter((d, i) => denies.indexOf(d) === i && d.includes("secrets.local")).length);
  const hooks = settings.hooks.PreToolUse;
  const guardHooks = hooks.flatMap((h) => h.hooks).filter((h) => h.command.includes("secret-guard.mjs"));
  assert.equal(guardHooks.length, 1); // exactly one guard hook after two applies
  assert.ok(guardHooks[0].command.includes(guardPath));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/maestro-harden.test.mjs`
Expected: FAIL — `Cannot find module '../src/setup/harden.mjs'`.

- [ ] **Step 3: Implement**

```js
// src/setup/harden.mjs
//
// Install the maestro secret guardrail into a Claude Code settings.json:
// a PreToolUse Bash hook backed by scripts/secret-guard.mjs plus deny rules
// for the secret-store paths. Idempotent keyed merge; preserves user settings.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DENY_RULES = [
  "Bash(cat:*secrets.local*.json*)",
  "Bash(gpg:*secrets.local*.json*)",
  "Bash(grep:*secrets.local*.json*)",
];

export function defaultGuardScriptPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../scripts/secret-guard.mjs");
}

function uniq(list) {
  return [...new Set(list)];
}

export function computeHardenedSettings(settings, guardScriptPath) {
  const next = settings && typeof settings === "object" ? { ...settings } : {};
  next.permissions = { ...(next.permissions ?? {}) };
  next.permissions.deny = uniq([...(next.permissions.deny ?? []), ...DENY_RULES]);

  const command = `node ${guardScriptPath}`;
  next.hooks = { ...(next.hooks ?? {}) };
  const pre = Array.isArray(next.hooks.PreToolUse) ? next.hooks.PreToolUse : [];
  const hasGuard = pre.some((entry) =>
    (entry.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes("secret-guard.mjs")),
  );
  next.hooks.PreToolUse = hasGuard
    ? pre
    : [...pre, { matcher: "Bash", hooks: [{ type: "command", command }] }];
  return next;
}

export async function applyHarden({ settingsPath, guardScriptPath = defaultGuardScriptPath() }) {
  let current = {};
  try {
    current = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const next = computeHardenedSettings(current, guardScriptPath);
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  return { settingsPath, guardScriptPath };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/maestro-harden.test.mjs`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
npx biome lint src/setup/harden.mjs test/maestro-harden.test.mjs
git add src/setup/harden.mjs test/maestro-harden.test.mjs
git commit -m "feat(secrets): add setup harden settings installer"
```

---

## Task 7: CLI wiring (`setup harden`, `setup keys --encrypt`, registry, doctor)

**Files:**
- Modify: `src/cli/local-command.mjs`, `src/cli/registry.mjs`, `src/setup/doctor.mjs`

- [ ] **Step 1: Route the subcommands** — in `src/cli/local-command.mjs`, inside the `if (command === "setup")` block (around line 555):

In the `keys` branch, widen the allowed flags and pass `env`:

```js
if (action === "keys") {
  warnFlags(findUnknownFlags(rest, new Set(["--var", "--encrypt"])), "setup keys", stderr);
  await runKeysWizard({ stateDir: secretsStateDir, args: rest, env: process.env, stdin, stdout });
  return 0;
}
```

Add a `harden` branch before the final `throw usageError`:

```js
if (action === "harden") {
  warnFlags(findUnknownFlags(rest, new Set(["--dry-run", "--global", "--project"])), "setup harden", stderr);
  const { applyHarden, computeHardenedSettings, defaultGuardScriptPath } = await import("../setup/harden.mjs");
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const scope = rest.includes("--project") ? "project" : "global";
  const settingsPath =
    scope === "project"
      ? path.resolve(process.cwd(), ".claude/settings.json")
      : path.join(home, ".claude", "settings.json");
  if (rest.includes("--dry-run")) {
    writeLine(stdout, `would harden ${settingsPath} (guard: ${defaultGuardScriptPath()})`);
    return 0;
  }
  const res = await applyHarden({ settingsPath });
  writeLine(stdout, `hardened ${res.settingsPath} — maestro secret guard installed`);
  return 0;
}
```

- [ ] **Step 2: Document in `src/cli/registry.mjs`** — under the `setup` subcommands array, add an entry mirroring the `keys`/`local` shape:

```js
{
  name: "harden",
  synopsis: "maestro setup harden [--project] [--dry-run]",
  summary: "install the Claude Code secret guardrail (PreToolUse hook + deny rules)",
},
```

And update the `keys` entry's summary to mention `--encrypt`:

```js
summary: "manage optional API keys; --encrypt to migrate to the encrypted store",
```

- [ ] **Step 3: Doctor store-mode report** — in `src/setup/doctor.mjs`, where it currently reads secrets (around line 137/163), detect the encrypted store and report mode without printing values:

```js
import { encryptedSecretsPath } from "./keys.mjs";
// ...
let storeMode = "none";
try {
  await fs.access(encryptedSecretsPath(stateDir));
  storeMode = "encrypted";
} catch {
  try {
    await fs.access(secretsPath(stateDir));
    storeMode = "plaintext";
  } catch {}
}
checks.push(check("secrets store", "secrets store", storeMode === "plaintext" ? "warn" : "ok", `mode: ${storeMode}`));
```

(Use the doctor file's existing `check(...)`/push idiom and its already-imported `fs`; if `fs` is not imported there, add `import fs from "node:fs/promises";`.)

- [ ] **Step 4: Run full suite + lint**

Run: `npm test`
Expected: all suites PASS.
Run: `npx biome lint src/cli/local-command.mjs src/cli/registry.mjs src/setup/doctor.mjs`
Expected: no errors.

- [ ] **Step 5: Manual smoke test**

```bash
cd /tmp && rm -rf hardtest && mkdir hardtest && cd hardtest
node /home/txa/maestro/bin/maestro.mjs init --yes
MAESTRO_SECRET_PASSPHRASE=pw node /home/txa/maestro/bin/maestro.mjs setup keys --var LINEAR_API_KEY <<<'lin_test'
MAESTRO_SECRET_PASSPHRASE=pw node /home/txa/maestro/bin/maestro.mjs setup keys --encrypt
ls .maestro/secrets.local*           # expect only secrets.local.enc.json
node /home/txa/maestro/bin/maestro.mjs setup harden --project --dry-run
```
Expected: encrypted file present, plaintext gone, dry-run prints target path.

- [ ] **Step 6: Commit**

```bash
git add src/cli/local-command.mjs src/cli/registry.mjs src/setup/doctor.mjs
git commit -m "feat(secrets): wire setup harden + keys --encrypt + doctor store mode"
```

---

## Task 8: Docs + CHANGELOG

**Files:**
- Modify: `docs/configuration.md`, `CHANGELOG.md`

- [ ] **Step 1: Document** in `docs/configuration.md` (secrets section): the encrypted store file, `MAESTRO_SECRET_PASSPHRASE`, `maestro setup keys --encrypt`, and `maestro setup harden` (with the honest scope note: encryption is the cross-process guarantee; the hook constrains Claude Code only).

- [ ] **Step 2: CHANGELOG entry** under the unreleased heading:

```md
- secrets: encrypted-at-rest secret store (scrypt + AES-256-GCM) via
  `maestro setup keys --encrypt`; unlock with `MAESTRO_SECRET_PASSPHRASE`.
  `maestro setup harden` installs a Claude Code guardrail so only maestro reads
  its secrets.
```

- [ ] **Step 3: Commit**

```bash
git add docs/configuration.md CHANGELOG.md
git commit -m "docs(secrets): document encrypted store + setup harden"
```

---

## Final verification

- [ ] `npm test` — all suites green.
- [ ] `npx biome lint .` — clean.
- [ ] `git log --oneline feat/serve-workflow-parity..HEAD` — review the focused commits.
- [ ] Do NOT force-push; do NOT touch other branches. Leave the branch for review/PR.
