import { resolveCapabilities } from "./adapters/capabilities.mjs";
import { BUILTIN_PROVIDER_NAMES, resolveAdapter } from "./adapters/registry.mjs";
import { ENV_KEY_DENYLIST } from "./agent-runner.mjs";
import { commandAvailable } from "./provider-availability.mjs";
import { resolveAlias } from "./providers.mjs";
import { resolveAliasEnv, resolveProviderEnv } from "./setup/keys.mjs";
import { PERMISSIONS } from "./tui/edit-core.mjs";

const DEFAULT_PERMISSION = "read";
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function providerEntries(config) {
  const providers = config?.providers;
  return isPlainObject(providers) ? Object.entries(providers) : [];
}

function adapterIdFor(provider, providerDef) {
  const configured = String(providerDef?.adapter ?? "").trim();
  if (configured) return configured;
  return BUILTIN_PROVIDER_NAMES.has(provider) ? `built-in:${provider}` : "custom";
}

function defaultAliasFor(provider, providerDef) {
  return String(providerDef?.default_alias ?? provider).trim();
}

function permissionFor(providerDef) {
  const mode = String(providerDef?.permission ?? DEFAULT_PERMISSION);
  return PERMISSIONS.includes(mode) ? mode : DEFAULT_PERMISSION;
}

function declaredEnvMap(map) {
  if (!isPlainObject(map)) return {};
  return Object.fromEntries(
    Object.entries(map).filter(([key]) => ENV_NAME_RE.test(key) && !ENV_KEY_DENYLIST.test(key)),
  );
}

function effectiveDeclaredEnv(providerDef, aliasName, providerKey) {
  const aliasDef = resolveAlias(providerDef, aliasName, providerKey);
  return {
    ...declaredEnvMap(providerDef?.env),
    ...declaredEnvMap(aliasDef.env),
  };
}

function credentialsResolvable(providerDef, aliasName, providerKey, env) {
  const declared = effectiveDeclaredEnv(providerDef, aliasName, providerKey);
  const requiredKeys = Object.keys(declared);
  if (requiredKeys.length === 0) return true;

  const resolved = {
    ...resolveProviderEnv(providerDef, env),
    ...resolveAliasEnv(providerDef, aliasName, providerKey, env),
  };
  return requiredKeys.every((key) => typeof resolved[key] === "string" && resolved[key] !== "");
}

async function preflightStatus({ provider, providerDef, adapterId, defaultAlias, cwd, env, cache, probe }) {
  if (providerDef?.enabled === false) return "disabled";

  let command;
  try {
    resolveAdapter({ ...providerDef, adapter: adapterId });
    command = resolveAlias(providerDef, defaultAlias, provider).command;
  } catch {
    return "unknown";
  }

  let cliAvailable;
  try {
    cliAvailable = await probe(command, { cwd, env, cache, provider, alias: defaultAlias });
  } catch {
    return "unknown";
  }
  if (!cliAvailable) return "missing_cli";

  try {
    return credentialsResolvable(providerDef, defaultAlias, provider, env) ? "ready" : "missing_creds";
  } catch {
    return "unknown";
  }
}

export async function listProviders({
  config,
  cwd = process.cwd(),
  env = process.env,
  cache = new Map(),
  probe = (command, opts = {}) => commandAvailable(command, opts),
} = {}) {
  const providers = [];

  for (const [provider, providerDef] of providerEntries(config)) {
    const adapter = adapterIdFor(provider, providerDef);
    const default_alias = defaultAliasFor(provider, providerDef);
    providers.push({
      provider,
      adapter,
      default_alias,
      models: Array.isArray(providerDef?.models) ? [...providerDef.models] : [],
      capabilities: resolveCapabilities(providerDef, adapter),
      permission: permissionFor(providerDef),
      status: await preflightStatus({
        provider,
        providerDef,
        adapterId: adapter,
        defaultAlias: default_alias,
        cwd,
        env,
        cache,
        probe,
      }),
    });
  }

  return { providers };
}
