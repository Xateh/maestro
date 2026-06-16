// Path-safe filesystem helpers — shared by the MCP server (src/mcp/server.mjs)
// and the artifact index / CLI (src/artifacts.mjs). Extracted verbatim from the
// MCP server so there is one canonical, defensive implementation.
//
// All helpers are total/defensive: a missing directory yields [], a missing
// file yields null, and an oversize read is bounded to a tail. assertInsideDir
// is the one intentional thrower — it rejects path traversal.

import fs from "node:fs/promises";
import path from "node:path";

/**
 * Assert that `child` is strictly inside `parent` after *lexical* path
 * resolution. Rejects `..` traversal and absolute-path overrides.
 *
 * NOTE: this check is purely lexical (path.relative) — it does NOT call
 * realpath, so a symlink located inside `parent` that points outside is NOT
 * detected here. Callers that may receive untrusted symlinks must resolve
 * them (fs.realpath) before relying on this guard. (F2; see F3 for the gap.)
 */
export function assertInsideDir(parent, child) {
  const rel = path.relative(parent, child);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path_traversal: ${child} escapes ${parent}`);
  }
}

/**
 * Like assertInsideDir, but resolves symlinks first — closing the gap where a
 * symlink planted inside `parent` (by, e.g., an agent writing into its own run
 * dir) points outside and is then followed by a read. Both `parent` and `child`
 * are realpath'd, so a legitimately-symlinked root (e.g. macOS /tmp →
 * /private/tmp, or a symlinked state dir) still passes as long as the resolved
 * child stays within the resolved parent. (F3)
 *
 * `child` need not exist: if realpath fails, its parent directory is resolved
 * and the basename re-appended, so a not-yet-created path is still checked.
 */
export async function assertInsideDirReal(parent, child) {
  assertInsideDir(parent, child); // cheap lexical reject for the obvious cases
  const realParent = await fs.realpath(parent);
  let realChild;
  try {
    realChild = await fs.realpath(child);
  } catch {
    const realDir = await fs.realpath(path.dirname(child));
    realChild = path.join(realDir, path.basename(child));
  }
  assertInsideDir(realParent, realChild);
}

/** Non-throwing assertInsideDirReal — true when `child` resolves inside `parent`. */
export async function isInsideDirReal(parent, child) {
  try {
    await assertInsideDirReal(parent, child);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read at most the last `maxBytes` of a file as UTF-8. Returns null if the file
 * does not exist (or cannot be stat'd). Bounds output so a huge log never
 * floods the caller.
 */
export async function tailFile(filePath, maxBytes = 8192) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) return null;
  const fh = await fs.open(filePath, "r");
  try {
    const start = Math.max(0, stat.size - maxBytes);
    const buf = Buffer.alloc(Math.min(maxBytes, stat.size));
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    return buf.slice(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

/**
 * List directory entries. Missing/unreadable directory yields [].
 */
export async function listDir(dir) {
  return fs.readdir(dir).catch(() => []);
}
