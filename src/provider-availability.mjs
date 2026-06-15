// Shared provider-availability resolver. Single source of truth for deciding
// which provider a role actually runs on, given live machine availability and a
// shared fallback policy (role.fallback) + opt-out (provider.enabled === false).
//
// Design: availability is machine-local (probed at run time), policy is shared
// (lives in config.json / workflow.json). The resolver never spawns the agent;
// it only decides what to spawn, or why nothing can be.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { directCommandExists } from "./agent-runner.mjs";

const execFileAsync = promisify(execFile);

// Same guard used by the bash-alias path in agent-runner.mjs — keep an alias
// off the shell unless it is a plain command token.
const SAFE_SHELL_COMMAND = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Accurate availability probe. directCommandExists only walks PATH, but Maestro
 * intentionally supports shell aliases/functions via `bash -ic`. So an alias
 * that is not on PATH may still resolve in an interactive shell — confirm with
 * `command -v`. Results are memoized per-alias via the passed `cache` Map.
 */
export async function commandAvailable(alias, { cwd, env = process.env, cache, exec = execFileAsync } = {}) {
  const name = String(alias ?? "").trim();
  if (!name) return false;
  if (cache?.has(name)) return cache.get(name);

  const compute = async () => {
    if (await directCommandExists(name, { cwd, env })) return true;
    // Path-shaped names that failed the PATH/exec check won't be shell aliases.
    if (name.includes("/") || !SAFE_SHELL_COMMAND.test(name)) return false;
    try {
      await exec("bash", ["-ic", `command -v ${name}`], { cwd, env, timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  };

  const result = await compute();
  cache?.set(name, result);
  return result;
}

/**
 * Resolve the provider a role should run on.
 *
 * Walks [role.provider, ...role.fallback], skipping providers that are
 * unconfigured, disabled, or whose command does not resolve. role.alias and
 * role.model only bind the PRIMARY provider; any substitution uses the fallback
 * provider's own default_alias and default model. An available primary with an
 * unavailable model drops to that provider's default model rather than failing.
 *
 * @returns {Promise<{ok:true, provider, providerDef, alias, model, substituted, modelDefaulted}
 *                   | {ok:false, reasons:Array<{provider, code, alias?, model?, available?}>}>}
 */
export async function resolveRoleProvider({
  roleDef,
  config,
  cwd = process.cwd(),
  env = process.env,
  cache = new Map(),
  exclude = new Set(),
  probe = (alias) => commandAvailable(alias, { cwd, env, cache }),
}) {
  const providers = config?.providers ?? {};
  const chain = [roleDef?.provider, ...(Array.isArray(roleDef?.fallback) ? roleDef.fallback : [])]
    .filter((key) => typeof key === "string" && key.length > 0);
  const reasons = [];

  for (let i = 0; i < chain.length; i += 1) {
    const key = chain[i];
    const def = providers[key];
    const isPrimary = i === 0;

    // Caller-excluded (e.g. usage-limited this run) — skip without re-probing.
    if (exclude.has(key)) {
      reasons.push({ provider: key, code: "usage_limited" });
      continue;
    }
    if (!def) {
      reasons.push({ provider: key, code: "unknown_provider" });
      continue;
    }
    if (def.enabled === false) {
      reasons.push({ provider: key, code: "provider_disabled" });
      continue;
    }

    const roleAlias = isPrimary && roleDef?.alias ? String(roleDef.alias) : null;
    const alias = roleAlias || def.default_alias || key;
    if (!(await probe(alias))) {
      const aliasOverridden = roleAlias && roleAlias !== (def.default_alias || key);
      reasons.push({ provider: key, code: aliasOverridden ? "alias_unresolved" : "provider_missing", alias });
      continue;
    }

    // Model only applies to the primary; substitutes use the provider default.
    let model = isPrimary ? String(roleDef?.model ?? "") : "";
    let modelDefaulted = false;
    if (isPrimary && model && Array.isArray(def.models) && def.models.length > 0 && !def.models.includes(model)) {
      model = "";
      modelDefaulted = true;
    }

    return { ok: true, provider: key, providerDef: def, alias, model, substituted: i > 0, modelDefaulted };
  }

  return { ok: false, reasons };
}

/**
 * Distinct, actionable message per availability-failure code. `reason` is one
 * entry from resolveRoleProvider's `reasons` (or a synthesized usage_limited).
 */
export function describeAvailabilityFailure(reason = {}, { role = "role" } = {}) {
  const { provider = "?", alias, model, available } = reason;
  switch (reason.code) {
    case "provider_missing":
      return `Provider "${provider}" (command "${alias ?? provider}") is not installed or not on PATH. `
        + "Install it, run `maestro setup local`, or set a fallback for this role.";
    case "alias_unresolved":
      return `Role "${role}" alias "${alias ?? "?"}" did not resolve to an executable. `
        + "Fix the alias in workflow.json or run `maestro doctor`.";
    case "provider_disabled":
      return `Provider "${provider}" is disabled (enabled:false in config.local.json). `
        + "Re-enable it or set a fallback for this role.";
    case "model_unavailable":
      return `Model "${model ?? "?"}" is not available for provider "${provider}". `
        + `Available: ${(available ?? []).join(", ") || "(provider default only)"}. `
        + "Clear the model to use the default, or pick another.";
    case "unknown_provider":
      return `Role "${role}" references provider "${provider}" which is not configured.`;
    case "usage_limited":
      return `Provider "${provider}" hit a usage/quota limit. `
        + "Wait and retry, switch provider, or set a fallback for this role.";
    default:
      return `Provider "${provider}" is unavailable for role "${role}".`;
  }
}
