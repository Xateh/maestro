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
