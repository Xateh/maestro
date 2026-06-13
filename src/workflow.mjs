// Prompt rendering + shared constants. Historically this module also parsed a
// server-only WORKFLOW.md and built the dispatch config; that fork was removed
// when `maestro serve` was unified onto the same workflow.json/config.json the
// CLI/TUI use (see src/dispatch/). What remains here is the Liquid prompt
// renderer (used to seed dispatched tasks) and a couple of small helpers still
// consumed across the codebase.

import { Liquid } from "liquidjs";

export const DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"];
export const DEFAULT_TERMINAL_STATES = ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"];

const PROMPT_ENGINE = new Liquid({
  strictFilters: true,
  strictVariables: true,
});

function typedError(code, message = code, cause = null) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

// "$NAME" → env.NAME (empty/missing → null); any other string passes through.
export function resolveDollarValue(value, env) {
  if (typeof value !== "string") return value;
  if (!value.startsWith("$") || value.length === 1) return value;
  const resolved = env[value.slice(1)] ?? "";
  return resolved || null;
}

export async function renderPrompt(template, context) {
  const source = template?.trim() || "You are working on an issue from Linear.";
  try {
    return await PROMPT_ENGINE.parseAndRender(source, context);
  } catch (error) {
    throw typedError("template_render_error", error.message, error);
  }
}
