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
 * Assert that `child` is strictly inside `parent` after path resolution.
 * Rejects symlink-escape, `..`, and absolute overrides.
 */
export function assertInsideDir(parent, child) {
  const rel = path.relative(parent, child);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path_traversal: ${child} escapes ${parent}`);
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
