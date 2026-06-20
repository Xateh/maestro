# Maestro Secret Hardening — Design

**Date:** 2026-06-13
**Branch:** `feat/encrypted-secret-store`
**Status:** Approved design → implementation

## Problem

Maestro stores provider/tracker secrets (e.g. `LINEAR_API_KEY`) as **plaintext** in
`.maestro/secrets.local.json` (mode `0600`, gitignored). Two gaps:

1. **At rest, the secret is readable by any process running as the user.** A leaked
   file, a backup, or a misbehaving local process exposes it. There is no encryption.
2. **Agents driving maestro (e.g. Claude Code) can read the secret directly** and use
   it outside maestro — e.g. `curl -H "Authorization: $LINEAR_API_KEY"` — which puts
   the value in world-readable process `argv` and bypasses maestro entirely.

The goal: **only the maestro system reads maestro's secrets.** Enforce this so it ships
to future installs, not as a one-off local config.

## Security principle (non-negotiable)

Encryption at rest only adds protection when the **decryption secret lives in a
different trust domain than the ciphertext**. A key sitting on the same disk as the
ciphertext is obfuscation, not protection. Therefore the unlock secret is a
**user passphrase** (in the user's head / their own secret manager), never written
next to the ciphertext.

## Design

### Part 1 — Native encrypted secret store (the cross-process guarantee)

This is the real enforcement: if the store is ciphertext, any non-maestro reader gets
unusable bytes, regardless of OS process permissions.

**New module `src/setup/secret-crypto.mjs`** — Node built-in `crypto`, **zero new deps**:

- KDF: `scrypt` (N=2^15, r=8, p=1, keylen=32), random 16-byte salt.
- Cipher: `aes-256-gcm`, random 12-byte IV, 16-byte auth tag.
- Envelope (JSON, the on-disk format):
  ```json
  {
    "version": 1,
    "kdf": "scrypt",
    "kdfParams": { "N": 32768, "r": 8, "p": 1, "salt": "<b64>" },
    "cipher": "aes-256-gcm",
    "iv": "<b64>",
    "tag": "<b64>",
    "ciphertext": "<b64>"
  }
  ```
- `encryptSecrets(envObj, passphrase) -> envelope`
- `decryptSecrets(envelope, passphrase) -> envObj`
- Wrong passphrase ⇒ GCM auth failure ⇒ throw `secret_decrypt_failed` (no plaintext,
  no oracle detail).

**Passphrase backend abstraction `getPassphrase({ stateDir, interactive })`** — ordered
resolution, pluggable so an OS-keyring backend can slot in later (designed-for, not
built now):

1. `MAESTRO_SECRET_PASSPHRASE` env var, if set (unattended / `serve`).
2. *(future)* OS keyring (libsecret / Keychain / DPAPI).
3. Interactive muted prompt (reuse `questionMuted`) when a TTY is present.
4. Otherwise throw `secret_passphrase_required`.

**Store files** (gitignore already covers `secrets.local*`):

- Encrypted store: `.maestro/secrets.local.enc.json` (mode `0600`).
- Legacy plaintext `.maestro/secrets.local.json` remains **readable for backward
  compatibility**.

**Wire into `src/setup/keys.mjs`:**

- `writeLocalSecrets` — when encryption is active, write the envelope to the `.enc.json`
  file (atomic temp+rename, `0600`); never write plaintext.
- `readLocalSecrets` / `loadLocalSecrets` — resolution order:
  1. If `secrets.local.enc.json` exists → get passphrase → decrypt → return env.
     On failure (no passphrase / bad passphrase): **warn and return `{}`** — do not
     crash startup; secrets are simply unavailable for that run.
  2. Else if legacy plaintext exists → read it (today's behavior).
  - `loadLocalSecrets` keeps its current contract: only fills **unset** env vars
    (real env wins), returns applied key names.
- `maestro setup keys` writes encrypted once encryption is enabled.
- `maestro setup keys --encrypt` — enable encryption (prompt to set a passphrase),
  migrate any existing plaintext store into the encrypted store, then **shred** the
  plaintext file. Idempotent.
- `maestro doctor` — report store mode (`plaintext` | `encrypted`) and whether the
  passphrase resolves, without printing values.

### Part 2 — `maestro setup harden` (agent guardrail installer)

Stops *this class of agent* (Claude Code) from decrypting/exfiltrating the loaded value.
Honest limitation: this constrains Claude Code only, **not arbitrary OS processes** —
Part 1's encryption is the cross-process guarantee; Part 2 is defense-in-depth for the
agent that drives maestro.

- New subcommand merges into the user's **global** `~/.claude/settings.json`:
  - `permissions.deny` rules for the secret-store paths.
  - A `PreToolUse` hook (matcher: `Bash`) invoking a shipped guard script
    `scripts/secret-guard.mjs`. The guard reads the tool input from stdin, and **denies**
    any command that references the secret-store paths or attempts to decrypt the store,
    **unless** the command is a `maestro …` invocation. Commands unrelated to maestro's
    secrets pass untouched.
- Flags: `--dry-run`, `--uninstall`, `--global`/`--project`. Idempotent (keyed merge).
- Ship `scripts/secret-guard.mjs` as part of maestro so future installs get it.

### Tests / docs / changelog

- `test/maestro-secret-crypto.test.mjs` — encrypt→decrypt round-trip, wrong-passphrase
  rejection, envelope shape/version, tamper (bad tag) rejection.
- Extend `test/maestro-setup.test.mjs` — encrypted write/read, plaintext→encrypted
  migration + shred, `loadLocalSecrets` env-wins still holds, malformed envelope is loud.
- Guard-script unit test — denies secret-path commands, allows `maestro …` and unrelated
  commands.
- `docs/configuration.md` — document the encrypted store, `MAESTRO_SECRET_PASSPHRASE`,
  `setup keys --encrypt`, and `setup harden`.
- `CHANGELOG.md` entry.

## Backward compatibility

- Existing plaintext stores keep working untouched until the user runs
  `setup keys --encrypt`.
- No new runtime dependencies.
- `loadLocalSecrets`' "real env wins / only fill unset" contract is preserved, so the
  current env-injection workflow (and `maestro serve`) is unaffected.

## Non-goals

- System-wide mandatory access control over arbitrary OS processes (impossible from
  userland; encryption is the substitute guarantee).
- Building the OS-keyring backend now (interface is designed for it; implementation later).
- Encrypting `config.json` / `config.local.json` (no secrets; they carry `$VAR` refs).
