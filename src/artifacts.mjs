// Derived artifact index — a read-only view over the files each run already
// writes to run_dir. There is no persisted manifest and no artifacts table:
// the index is recomputed by scanning run_dir, so it can never drift from disk
// (the same projection principle SP6a uses for stage events).
//
// classifyArtifact / buildArtifactIndex / resolveArtifact are TOTAL: a missing
// run_dir yields [], a per-file stat/hash error degrades that field to null,
// and a bad/traversing selector yields null. They never throw.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { assertInsideDir, listDir } from "./fs-safe.mjs";

/**
 * Map a run_dir filename to { role, kind }. Suffix checks are ordered most- to
 * least-specific. Anything unrecognised is still listed as
 * { role: null, kind: "other" } — never hidden.
 */
export function classifyArtifact(filename) {
  const name = typeof filename === "string" ? filename : "";
  if (name.startsWith("handoff.") && name.endsWith(".json")) {
    return { role: name.slice("handoff.".length, -".json".length), kind: "handoff" };
  }
  if (name.endsWith(".stdout.log")) {
    return { role: name.slice(0, -".stdout.log".length), kind: "stdout" };
  }
  if (name.endsWith(".stderr.log")) {
    return { role: name.slice(0, -".stderr.log".length), kind: "stderr" };
  }
  if (name.endsWith(".command.json")) {
    return { role: name.slice(0, -".command.json".length), kind: "command" };
  }
  if (name.endsWith(".prompt.txt")) {
    return { role: name.slice(0, -".prompt.txt".length), kind: "prompt" };
  }
  if (name.endsWith(".exit.txt")) {
    return { role: name.slice(0, -".exit.txt".length), kind: "exit" };
  }
  return { role: null, kind: "other" };
}

/**
 * Stream a file through SHA-256, returning the hex digest. Any error (missing
 * file, read error) resolves to null — the default `hash` injection point for
 * buildArtifactIndex.
 */
export function sha256File(filePath) {
  return new Promise((resolve) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", () => resolve(null));
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

// Build a role -> status map from task.steps; later steps win (a retry's final
// status reflects the latest attempt).
function statusByRole(task) {
  const map = new Map();
  const steps = Array.isArray(task?.steps) ? task.steps : [];
  for (const step of steps) {
    if (step && typeof step.role === "string") map.set(step.role, step.status ?? null);
  }
  return map;
}

/**
 * Scan task.run_dir and return one ArtifactEntry per file. Total: a missing
 * run_dir yields []; a per-file stat/hash failure degrades that entry's field
 * to null rather than throwing.
 *
 * @param {object} task                 task object carrying run_dir + steps
 * @param {object} [opts]
 * @param {(p:string)=>Promise<string|null>} [opts.hash] hash fn (default sha256File)
 * @returns {Promise<Array<{role,kind,name,path,bytes,modified,sha256,status}>>}
 */
export async function buildArtifactIndex(task, { hash = sha256File } = {}) {
  const runDir = typeof task?.run_dir === "string" ? task.run_dir : null;
  if (!runDir) return [];
  const names = (await listDir(runDir)).slice().sort();
  const statuses = statusByRole(task);
  const entries = [];
  for (const name of names) {
    const filePath = path.join(runDir, name);
    const { role, kind } = classifyArtifact(name);
    let bytes = null;
    let modified = null;
    try {
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) continue;
      bytes = stat.size;
      modified = stat.mtime.toISOString();
    } catch {
      /* leave bytes/modified null */
    }
    let sha256 = null;
    try {
      sha256 = await hash(filePath);
    } catch {
      sha256 = null;
    }
    const status = role != null && statuses.has(role) ? statuses.get(role) : null;
    entries.push({ role, kind, name, path: filePath, bytes, modified, sha256, status });
  }
  return entries;
}

/**
 * Resolve a selector to an artifact entry. Accepts a raw filename or a
 * `<role>.<kind>` selector. Returns { path, entry } or null. Always runs
 * assertInsideDir(run_dir, path) before returning, so a traversing/raw-path
 * selector resolves to null rather than escaping run_dir. Total: never throws.
 */
export async function resolveArtifact(task, selector) {
  if (typeof selector !== "string" || selector.length === 0) return null;
  const runDir = typeof task?.run_dir === "string" ? task.run_dir : null;
  if (!runDir) return null;
  const entries = await buildArtifactIndex(task);
  let entry = entries.find((e) => e.name === selector);
  if (!entry) {
    const dot = selector.lastIndexOf(".");
    if (dot > 0) {
      const role = selector.slice(0, dot);
      const kind = selector.slice(dot + 1);
      entry = entries.find((e) => e.role === role && e.kind === kind);
    }
  }
  if (!entry) return null;
  try {
    assertInsideDir(runDir, entry.path);
  } catch {
    return null;
  }
  return { path: entry.path, entry };
}
