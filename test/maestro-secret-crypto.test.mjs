import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decryptSecrets,
  encryptSecrets,
  isEncryptedEnvelope,
} from "../src/setup/secret-crypto.mjs";
import { getPassphrase } from "../src/setup/secret-passphrase.mjs";

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
