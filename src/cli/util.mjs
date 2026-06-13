import fs from "node:fs/promises";
import path from "node:path";

import { ENV_KEY_DENYLIST } from "../agent-runner.mjs";

export const REVIEW_MAX_STRING_BYTES = 2_000;
export const REVIEW_MAX_CONTINUATIONS = 1;

export function writeLine(stream, text) {
  stream.write(`${text}\n`);
}

export function nowIso() {
  return new Date().toISOString();
}

export async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function exitCodeFromError(error) {
  return Number.isInteger(error?.code) ? error.code : 1;
}

function trimUtf8Bytes(value, maxBytes = REVIEW_MAX_STRING_BYTES) {
  const buffer = Buffer.from(String(value ?? ""), "utf8");
  if (buffer.length <= maxBytes) return buffer.toString("utf8").trim();
  return buffer.subarray(0, maxBytes).toString("utf8").replace(/�$/g, "").trim();
}

export function sanitizeReviewString(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return trimUtf8Bytes(value, REVIEW_MAX_STRING_BYTES) || fallback;
}

export function sanitizeEnvObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 24)
      .map(([key, entry]) => [sanitizeReviewString(key), sanitizeReviewString(entry, "")])
      .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !ENV_KEY_DENYLIST.test(key)),
  );
}
