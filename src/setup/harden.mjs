// Install the maestro secret guardrail into a Claude Code settings.json:
// a PreToolUse Bash hook backed by scripts/secret-guard.mjs plus deny rules
// for the secret-store paths. Idempotent keyed merge; preserves user settings.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DENY_RULES = [
  "Bash(cat:*secrets.local*.json*)",
  "Bash(gpg:*secrets.local*.json*)",
  "Bash(grep:*secrets.local*.json*)",
];

export function defaultGuardScriptPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../scripts/secret-guard.mjs");
}

function uniq(list) {
  return [...new Set(list)];
}

export function computeHardenedSettings(settings, guardScriptPath) {
  const next = settings && typeof settings === "object" ? { ...settings } : {};
  next.permissions = { ...(next.permissions ?? {}) };
  next.permissions.deny = uniq([...(next.permissions.deny ?? []), ...DENY_RULES]);

  const command = `node ${guardScriptPath}`;
  next.hooks = { ...(next.hooks ?? {}) };
  const pre = Array.isArray(next.hooks.PreToolUse) ? next.hooks.PreToolUse : [];
  const hasGuard = pre.some((entry) =>
    (entry.hooks ?? []).some(
      (h) => typeof h.command === "string" && h.command.includes("secret-guard.mjs"),
    ),
  );
  next.hooks.PreToolUse = hasGuard
    ? pre
    : [...pre, { matcher: "Bash", hooks: [{ type: "command", command }] }];
  return next;
}

export async function applyHarden({ settingsPath, guardScriptPath = defaultGuardScriptPath() }) {
  let current = {};
  try {
    current = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const next = computeHardenedSettings(current, guardScriptPath);
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  return { settingsPath, guardScriptPath };
}
