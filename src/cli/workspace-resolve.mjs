import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LOCAL_COMMAND_NAMES } from "./registry.mjs";
import { DEFAULT_LOCAL_STATE_DIR } from "../task-store.mjs";

const LOCAL_COMMANDS = new Set(LOCAL_COMMAND_NAMES);
// This file lives in src/cli/, two levels below the package root.
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function hasStateDir(args) {
  return args.includes("--state-dir");
}

// Commands that always operate on the caller's directory — never the package
// checkout's state. `init` scaffolds .maestro/ where the user is standing.
const CALLER_STATE_DIR_COMMANDS = new Set(["init"]);

function findStateDirUpwards(startDir, exists) {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, DEFAULT_LOCAL_STATE_DIR);
    if (exists(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function resolveWorkspaceLocalInvocation({
  args = process.argv.slice(2),
  env = process.env,
  processCwd = process.cwd(),
  exists = existsSync,
} = {}) {
  const callerCwd = env.MAESTRO_CALLER_CWD || env.INIT_CWD || processCwd;
  const nextArgs = [...args];
  let usedPackageFallback = false;
  if (LOCAL_COMMANDS.has(nextArgs[0]) && !hasStateDir(nextArgs) && !CALLER_STATE_DIR_COMMANDS.has(nextArgs[0])) {
    // Prefer an initialized .maestro/ in (or above) the caller's directory;
    // fall back to the package checkout's state dir (historical default).
    const discovered = findStateDirUpwards(callerCwd, exists);
    usedPackageFallback = discovered === null;
    nextArgs.push("--state-dir", discovered ?? path.join(PACKAGE_ROOT, DEFAULT_LOCAL_STATE_DIR));
  }
  return {
    args: nextArgs,
    cwd: callerCwd,
    usedPackageFallback,
  };
}
