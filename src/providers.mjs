// Alias normalization for provider configs.
//
// An entry in providers.<p>.aliases is either a bare string (the command name,
// which doubles as the account identity) or an object describing a named
// account: { name, command?, env? }. normalizeAlias collapses both forms to one
// internal shape { name, command, env } so the rest of the code never branches
// on string-vs-object. A bare string "claude" is exactly { name:"claude",
// command:"claude", env:{} }, and an object whose env is empty and whose command
// equals its name collapses back to a bare string on save (see aliasToConfig).

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

// providerBase is the binary an account runs when it declares no explicit
// `command` — the provider key for built-ins (e.g. "claude").
export function normalizeAlias(entry, providerBase = "") {
  const base = String(providerBase ?? "").trim();
  if (typeof entry === "string") {
    const name = entry.trim();
    return { name, command: name, env: {} };
  }
  if (isPlainObject(entry)) {
    const name = String(entry.name ?? "").trim();
    // No explicit command → run the provider base binary (the whole point: an
    // account "work" with no command still runs real "claude"). Fall back to the
    // name only when no base is known (e.g. aliasNames() called without context).
    const command = String(entry.command ?? "").trim() || base || name;
    const env = isPlainObject(entry.env) ? { ...entry.env } : {};
    return { name, command, env };
  }
  return { name: "", command: base, env: {} };
}

// The selectable account names for a provider, in order. Used by every picker
// and summary that used to read the bare-string aliases array directly.
export function aliasNames(def) {
  return (def?.aliases ?? [])
    .map((entry) => normalizeAlias(entry).name)
    .filter(Boolean);
}

// Resolve a chosen alias NAME to its { name, command, env }. A name not present
// in the list (e.g. a role.alias pointing at a bare command, or a legacy
// default) synthesizes a bare alias so behavior matches a plain string — the
// command equals the name, preserving the pre-feature spawn path.
export function resolveAlias(def, name, providerKey = "") {
  const base = String(providerKey || def?.default_alias || "").trim();
  const list = (def?.aliases ?? []).map((entry) => normalizeAlias(entry, base));
  const wanted = String(name ?? "").trim();
  if (wanted) {
    const found = list.find((alias) => alias.name === wanted);
    if (found) return found;
    return { name: wanted, command: wanted, env: {} };
  }
  const fallback = String(def?.default_alias ?? base).trim();
  return list.find((alias) => alias.name === fallback)
    ?? { name: fallback, command: fallback || base, env: {} };
}

// Inverse of normalizeAlias for persistence: collapse a fully-default account
// back to a bare string so configs stay tidy and round-trip losslessly.
export function aliasToConfig(alias, providerBase = "") {
  const base = String(providerBase ?? "").trim();
  const name = String(alias?.name ?? "").trim();
  const command = String(alias?.command ?? "").trim() || name || base;
  const env = isPlainObject(alias?.env) ? alias.env : {};
  const envEmpty = Object.keys(env).length === 0;
  if (envEmpty && command === name) return name;
  return { name, command, ...(envEmpty ? {} : { env }) };
}
