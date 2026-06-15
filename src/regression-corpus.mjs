// Default fs-backed implementation of the injectable `regressionStore` op
// consumed by the SP4 kind:"regression" node, plus the pure id/shape helpers.
// Mirrors src/command-runner.mjs: NEVER throws on I/O — a parse/read failure is
// collected into loadErrors, a write failure into writeErrors, and the node
// records each as evidence (the stage always proceeds, no gating).

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

// Lowercase, non-alnum → "-", trim leading/trailing "-", cap length. Mirrors
// slugifyTaskTitle (src/task-store.mjs:264) but kept local so this module is
// self-contained and pure-unit-testable. Empty/absent → "case".
export function slug(value) {
  const s = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72)
    .replace(/-+$/g, "");
  return s || "case";
}

// 6-hex-char stable digest of the command string (established short-hash idiom,
// see src/setup/import.mjs:314).
export function shortHash(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 6);
}

// Pure, deterministic, stable across runs. failure shape = an
// evaluation.failures[] entry: { name, run, category, exit_code, ... }.
// distinct `run` ⇒ distinct id; same {name, run} ⇒ same id ⇒ promotion idempotent.
export function deriveCaseId(failure) {
  return `${slug(failure?.name)}-${shortHash(failure?.run)}`;
}

// A loaded case must be an object with a non-empty string `id` and a `command`
// object whose `run` is a non-empty string. Returns true/false (no throw).
function isValidCase(value) {
  if (!value || typeof value !== "object") return false;
  if (typeof value.id !== "string" || value.id.length === 0) return false;
  const command = value.command;
  if (!command || typeof command !== "object") return false;
  if (typeof command.run !== "string" || command.run.length === 0) return false;
  return true;
}

/**
 * Read every *.json case file under `dir`. Missing dir ⇒ empty corpus (no error).
 * A malformed/unreadable/invalid case file is collected into loadErrors and
 * skipped. NEVER throws.
 *
 * @param {string} dir
 * @returns {Promise<{cases: object[], loadErrors: {file: string, error: string}[]}>}
 */
export async function loadCorpus(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if (error?.code === "ENOENT") return { cases: [], loadErrors: [] };
    return { cases: [], loadErrors: [{ file: dir, error: error?.message ?? String(error) }] };
  }

  const cases = [];
  const loadErrors = [];
  const files = entries.filter((f) => f.endsWith(".json")).sort();
  for (const file of files) {
    const full = path.join(dir, file);
    try {
      const raw = await fs.readFile(full, "utf8");
      const parsed = JSON.parse(raw);
      if (!isValidCase(parsed)) {
        loadErrors.push({ file: full, error: "case missing id or command.run" });
        continue;
      }
      cases.push(parsed);
    } catch (error) {
      loadErrors.push({ file: full, error: error?.message ?? String(error) });
    }
  }
  return { cases, loadErrors };
}

/**
 * Derive a case id per failure, skip ids already present (existingIds) and
 * dedup within the batch, then write <dir>/<id>.json (creating dir). A write
 * failure is captured into writeErrors (read-only tree ⇒ stage still succeeds).
 * NEVER throws.
 *
 * @param {object}   opts
 * @param {string}   opts.dir
 * @param {object[]} opts.failures      - evaluation.failures[] (may be empty)
 * @param {Set<string>} [opts.existingIds]
 * @param {string}   [opts.date]        - ISO date for the `added` field
 * @param {string|null} [opts.taskId]   - origin_task
 * @returns {Promise<{promoted: object[], writeErrors: {id: string, error: string}[]}>}
 */
export async function promoteFailures({ dir, failures, existingIds, date, taskId } = {}) {
  const promoted = [];
  const writeErrors = [];
  const list = Array.isArray(failures) ? failures : [];
  // Defensive copy seeded from existingIds so the batch also dedups against itself.
  const seen = new Set(existingIds ?? []);

  for (const failure of list) {
    const id = deriveCaseId(failure);
    if (seen.has(id)) continue;
    const caseObj = {
      id,
      source: "evaluation.failures",
      added: date ?? new Date().toISOString().slice(0, 10),
      origin_task: taskId ?? null,
      category: failure?.category ?? null,
      command: {
        run: failure?.run ?? null,
        timeout_ms: null,
        parser: null,
      },
    };
    const filePath = path.join(dir, `${id}.json`);
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, `${JSON.stringify(caseObj, null, 2)}\n`);
    } catch (error) {
      writeErrors.push({ id, error: error?.message ?? String(error) });
      continue;
    }
    seen.add(id);
    promoted.push({
      id,
      source: "evaluation.failures",
      run: failure?.run ?? null,
      category: failure?.category ?? null,
      path: filePath,
    });
  }
  return { promoted, writeErrors };
}

// The injectable op bundle (default impl).
export const regressionStore = { loadCorpus, promoteFailures, deriveCaseId };
