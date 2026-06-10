// Reusable layered picker: shows current value, recent list, all options, and a custom entry.
export async function pickFromList({
  ask,
  output,
  label,
  options = [],
  current = "",
  recent = [],
  allowCustom = true,
  allowDefault = true,
}) {
  const recentUniq = [...new Set(recent.filter(Boolean))].slice(0, 3);
  const allUniq = [...new Set(options.filter(Boolean))];

  const lines = [`\n${label}`];
  if (current) lines.push(`Current: ${current}`);
  if (recentUniq.length > 0) {
    lines.push(`Recent: ${recentUniq.map((v, i) => `${i + 1}) ${v}`).join("  ")}`);
  }
  if (allUniq.length > 0) {
    const letters = "abcdefghijklmnopqrstuvwxyz";
    lines.push(`All:    ${allUniq.map((v, i) => `${letters[i] ?? i}) ${v}`).join("  ")}`);
  }
  if (allowCustom) lines.push("+ custom");
  if (allowDefault) lines.push("0 <cli default>");
  lines.push("Enter to keep current");
  output.write(`${lines.join("\n")}\n`);

  const raw = String(await ask("> ") ?? "").trim();
  if (!raw) return current;
  if ((raw === "0" || raw.toLowerCase() === "default") && allowDefault) return "";
  if (raw === "+") {
    const custom = String(await ask("Custom value: ") ?? "").trim();
    return custom || current;
  }

  // Check recent by number
  const num = Number(raw);
  if (Number.isInteger(num) && num >= 1 && num <= recentUniq.length) {
    return recentUniq[num - 1];
  }

  // Check all options by letter
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const letterIndex = letters.indexOf(raw.toLowerCase());
  if (letterIndex !== -1 && letterIndex < allUniq.length) {
    return allUniq[letterIndex];
  }

  // Check all options by number (fallback, for lists with no recent)
  if (Number.isInteger(num) && num >= 1 && num <= allUniq.length) {
    return allUniq[num - 1];
  }

  // Treat as custom value
  return raw;
}

// Update a "recent" bucket: prepend value, dedup, cap at 3.
export function pushRecent(bucket = [], value) {
  if (!value) return bucket;
  return [...new Set([value, ...bucket])].slice(0, 3);
}

// Apply a recent-update to a config's recent.* sub-object.
export function applyRecentUpdate(config, { kind, key, value }) {
  const recent = config.recent ?? {};
  const bucket = recent[kind]?.[key] ?? [];
  return {
    ...config,
    recent: {
      ...recent,
      [kind]: {
        ...(recent[kind] ?? {}),
        [key]: pushRecent(bucket, value),
      },
    },
  };
}
