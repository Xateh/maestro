import fs from "node:fs";

// process.kill(pid, 0) probes existence without signaling. EPERM means the
// process exists but is owned by someone else (treated as alive but foreign).
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// Linux /proc/<pid>/stat field 22 (1-indexed) is starttime in clock ticks.
// The comm field (2) is wrapped in parens and may contain spaces/parens, so
// parse from the LAST ')' to avoid splitting on it. Returns clock-tick count
// (stable per-boot identity), or null on any non-linux / read failure.
export function readStartTime(pid) {
  if (process.platform !== "linux") return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const rparen = stat.lastIndexOf(")");
    const fields = stat.slice(rparen + 2).split(" ");
    // After ") ", fields[0] is state (field 3). starttime is field 22 -> index 19.
    const starttime = Number(fields[19]);
    return Number.isFinite(starttime) ? starttime : null;
  } catch {
    return null;
  }
}

function cmdlineMatches(pid, name) {
  if (process.platform !== "linux") return true; // cannot verify; don't block
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    const parts = raw.split("\0").filter(Boolean);
    return parts.includes("serve") && parts.includes(name) && parts.includes("--foreground");
  } catch {
    return false;
  }
}

// True only if pid is alive AND (where /proc is available) its boot-stable
// starttime matches the recorded value. When starttime cannot be read, falls
// back to cmdline check as a secondary guard. On platforms without /proc,
// falls back to liveness only (documented residual TOCTOU risk - spec C1).
//
// NOTE: the field name `startTimeMs` is a slight misnomer — on Linux it stores
// clock ticks (from /proc/stat field 22), not milliseconds. The name is kept
// stable across the codebase; treat it as an opaque boot-stable token.
export function verifyIdentity(record, name) {
  if (!record || !isAlive(record.pid)) return false;
  if (process.platform !== "linux") return true;
  const live = readStartTime(record.pid);
  if (live === null || record.startTimeMs == null) {
    // /proc/stat unreadable or record has no starttime — fall back to cmdline
    return cmdlineMatches(record.pid, name);
  }
  if (live !== record.startTimeMs) return false;
  // starttime matched: that is the primary identity proof; no cmdline check needed.
  return true;
}
