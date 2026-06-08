import { buildClaudeCommand } from "./claude.mjs";
import { buildCodexCommand } from "./codex.mjs";
import { buildCopilotCommand } from "./copilot.mjs";
import { buildGeminiCommand } from "./gemini.mjs";
import { buildAntigravityCommand } from "./antigravity.mjs";

const BUILTIN_ADAPTERS = {
  "built-in:claude": buildClaudeCommand,
  "built-in:codex": buildCodexCommand,
  "built-in:copilot": buildCopilotCommand,
  "built-in:gemini": buildGeminiCommand,
  "built-in:antigravity": buildAntigravityCommand,
};

// Tokenize a custom command template: "{alias} --model {model}" etc.
// Unrecognized or empty-valued tokens drop the preceding flag + value pair.
function buildCustomCommand(providerDef, { prompt, cwd, alias, model, effort, permission, role } = {}) {
  const custom = providerDef.custom ?? {};
  const template = String(custom.command_template ?? "{alias}");
  const values = { alias, model, effort, permission, role, cwd };

  // Split template into tokens
  const tokens = template.split(/\s+/);
  const resolvedArgs = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const placeholderMatch = token.match(/^\{(\w+)\}$/);
    if (placeholderMatch) {
      const val = values[placeholderMatch[1]];
      if (!val) {
        // Drop this token and the preceding flag if any
        if (resolvedArgs.length > 0 && resolvedArgs.at(-1).startsWith("-")) {
          resolvedArgs.pop();
        }
        continue;
      }
      resolvedArgs.push(val);
    } else {
      resolvedArgs.push(token);
    }
  }

  const command = resolvedArgs.shift() ?? (alias || "custom");
  const stdinMode = custom.prompt_via ?? "stdin";
  if (stdinMode === "arg") {
    resolvedArgs.push(prompt ?? "");
  }

  return {
    command,
    args: resolvedArgs,
    cwd,
    stdin: stdinMode === "stdin" ? prompt : null,
  };
}

export function resolveAdapter(providerDef) {
  const adapterId = String(providerDef?.adapter ?? "");
  if (adapterId.startsWith("built-in:")) {
    const fn = BUILTIN_ADAPTERS[adapterId];
    if (!fn) {
      const error = new Error(`unknown_builtin_adapter: ${adapterId}`);
      error.code = "unknown_builtin_adapter";
      throw error;
    }
    return fn;
  }
  if (adapterId === "custom" || adapterId.startsWith("custom:")) {
    return buildCustomCommand.bind(null, providerDef);
  }
  const error = new Error(`unknown_adapter_binding: ${adapterId}`);
  error.code = "unknown_adapter_binding";
  throw error;
}
