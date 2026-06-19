// Pure helpers for the user-local config overlay (.maestro/config.local.json).
// Local values are merged over config.json at read time and must never be
// written back into shareable files (config.json, export bundles).

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Deep-merge: plain objects merge recursively; arrays and scalars replace.
export function deepMergeConfig(base, overlay) {
  if (!isPlainObject(base) || !isPlainObject(overlay)) {
    return overlay === undefined ? base : overlay;
  }
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      result[key] = deepMergeConfig(base[key], value);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}
