// Minimal TOML-subset reader for ~/.codex/config.toml. Handles [section] /
// [a.b] headers, string/number/boolean scalars, inline arrays of scalars, and
// comments. Anything it cannot parse is skipped — a parse failure degrades to
// a recorded-only manifest entry, never an error. Full TOML (multiline
// strings, dates, inline tables) is intentionally out of scope.

import fs from "node:fs/promises";
import path from "node:path";

function parseScalar(raw) {
  const value = raw.trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(value)) return value.slice(1, -1).replace(/\\(.)/g, "$1");
  if (/^'[^']*'$/.test(value)) return value.slice(1, -1);
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d*\.\d+$/.test(value)) return Number(value);
  return value; // bare string fallback
}

function stripComment(line) {
  let inString = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inString) {
      if (ch === "\\" && inString === '"') i += 1;
      else if (ch === inString) inString = null;
    } else if (ch === '"' || ch === "'") {
      inString = ch;
    } else if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function parseTomlSubset(text) {
  const root = {};
  let current = root;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;

    const sectionMatch = line.match(/^\[\s*(.+?)\s*\]$/);
    if (sectionMatch) {
      // split on dots outside quotes ("/home/u/my.project" stays one key)
      const keys = [];
      let buf = "";
      let quote = null;
      for (const ch of sectionMatch[1]) {
        if (quote) {
          if (ch === quote) quote = null;
          else buf += ch;
        } else if (ch === '"' || ch === "'") {
          quote = ch;
        } else if (ch === ".") {
          keys.push(buf.trim());
          buf = "";
        } else {
          buf += ch;
        }
      }
      keys.push(buf.trim());
      current = root;
      for (const key of keys.filter(Boolean)) {
        if (UNSAFE_KEYS.has(key)) { current = {}; break; } // prototype-pollution guard
        current[key] = current[key] && typeof current[key] === "object" ? current[key] : {};
        current = current[key];
      }
      continue;
    }

    const kvMatch = line.match(/^([A-Za-z0-9_"'-]+)\s*=\s*(.+)$/);
    if (!kvMatch) continue; // unsupported construct — skip
    const key = kvMatch[1].replace(/^["']|["']$/g, "");
    if (UNSAFE_KEYS.has(key)) continue; // prototype-pollution guard
    const rawValue = kvMatch[2].trim();
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      const inner = rawValue.slice(1, -1).trim();
      current[key] = inner === ""
        ? []
        : inner.split(",").map((item) => parseScalar(item));
      continue;
    }
    if (rawValue.startsWith("{") || rawValue.startsWith("[")) continue; // inline table / multiline — skip
    current[key] = parseScalar(rawValue);
  }
  return root;
}

const SECRET_KEY_RE = /(_key|_token|_secret|api_key|apikey|password|passwd|auth)$/i;

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        SECRET_KEY_RE.test(k) && typeof v === "string" ? "[redacted]" : redactSecrets(v),
      ]),
    );
  }
  return value;
}

export async function scanCodexConfig(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  const parsed = redactSecrets(parseTomlSubset(text));
  const mcpServers = parsed.mcp_servers && typeof parsed.mcp_servers === "object" && !Array.isArray(parsed.mcp_servers)
    ? Object.keys(parsed.mcp_servers)
    : [];
  return {
    path: path.resolve(filePath),
    model: typeof parsed.model === "string" ? parsed.model : null,
    modelReasoningEffort: typeof parsed.model_reasoning_effort === "string" ? parsed.model_reasoning_effort : null,
    mcpServers,
  };
}
