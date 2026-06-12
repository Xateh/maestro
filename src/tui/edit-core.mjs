// Pure provider/workflow edit logic shared by the classic prompt TUI
// (tui-providers.mjs / tui-workflow.mjs) and the full-screen TUI editors.
// Every builder returns the object to pass to store.writeConfig /
// store.writeWorkflow — no I/O here.

import { DEFAULT_PROVIDERS } from "../task-store.mjs";

export const BUILTIN_ADAPTERS = [
  "built-in:claude",
  "built-in:codex",
  "built-in:copilot",
  "built-in:gemini",
  "built-in:antigravity",
  "built-in:ollama",
];

export const PROMPT_TEMPLATES = ["planner", "executor", "reviewer", "generic"];
export const PERMISSIONS = ["plan", "read", "write", "default"];
export const SKIP_VALUES = ["auto", "always", "never"];
export const TRANSITION_EVENTS = ["done", "error", "question", "pause", "waiting"];
export const TRANSITION_TARGETS_BUILTIN = ["$complete", "$halt", "$ask_user", "$pause", "$wait"];

// Provider edits persist into the shareable config.json, so the write base
// must be the RAW config providers — building a patch from the effective
// (overlay-merged) view would leak config.local.json values into config.json.
export function shareableDef(providers, key, effectiveDef = null) {
  return providers[key] ?? structuredClone(DEFAULT_PROVIDERS[key] ?? effectiveDef ?? {});
}

export function providerPatch(rawProviders, key, partial, effectiveDef = null) {
  const providers = structuredClone(rawProviders ?? DEFAULT_PROVIDERS);
  providers[key] = { ...shareableDef(providers, key, effectiveDef), ...partial };
  return { providers };
}

// Set one field (possibly nested, e.g. ["custom","command_template"]) on a
// provider. Nested merges use the shareable base, not the effective view.
export function providerFieldPatch(rawProviders, key, fieldPath, value, effectiveDef = null) {
  const providers = structuredClone(rawProviders ?? DEFAULT_PROVIDERS);
  const base = shareableDef(providers, key, effectiveDef);
  const partial = fieldPath.length === 1
    ? { [fieldPath[0]]: value }
    : { [fieldPath[0]]: { ...(base[fieldPath[0]] ?? {}), [fieldPath[1]]: value } };
  providers[key] = { ...base, ...partial };
  return { providers };
}

export function removeProviderPatch(rawProviders, key) {
  const providers = structuredClone(rawProviders ?? DEFAULT_PROVIDERS);
  delete providers[key];
  return { providers };
}

export function newProviderDef({
  key,
  label = "",
  adapter,
  default_alias = "",
  aliases = [],
  models = [],
  efforts = [],
  custom = null,
}) {
  const alias = default_alias || key;
  return {
    label: label || key,
    adapter,
    default_alias: alias,
    aliases: aliases.length > 0 ? aliases : [alias],
    models,
    efforts,
    ...(custom ? { custom } : {}),
  };
}

export function parseStringList(raw, fallback = []) {
  const text = String(raw ?? "").trim();
  if (!text) return fallback;
  return text.split(",").map((item) => item.trim()).filter(Boolean);
}

export function rolePatch(workflow, roleKey, partial) {
  const role = workflow.roles?.[roleKey] ?? {};
  return { roles: { ...workflow.roles, [roleKey]: { ...role, ...partial } } };
}

export function addRolePatch(workflow, key, provider, providerDef = null) {
  const newRole = {
    label: key.charAt(0).toUpperCase() + key.slice(1),
    provider,
    alias: providerDef?.default_alias ?? provider,
    model: "",
    effort: "",
    permission: "default",
    prompt_template: "generic",
    skip: "auto",
  };
  return {
    roles: { ...workflow.roles, [key]: newRole },
    transitions: {
      ...workflow.transitions,
      [key]: { done: "$complete", error: "$halt", question: "$ask_user" },
    },
  };
}

export function setTransitionPatch(workflow, roleKey, event, target) {
  return {
    transitions: {
      ...workflow.transitions,
      [roleKey]: { ...(workflow.transitions?.[roleKey] ?? {}), [event]: target },
    },
  };
}

export function deleteTransitionPatch(workflow, roleKey, event) {
  const next = { ...(workflow.transitions?.[roleKey] ?? {}) };
  delete next[event];
  return { transitions: { ...workflow.transitions, [roleKey]: next } };
}

// Returns { initial } or null when the key is not a defined role.
export function setInitialPatch(workflow, key) {
  if (!Object.hasOwn(workflow.roles ?? {}, key)) return null;
  return { initial: key };
}

export function transitionTargets(workflow) {
  return [...TRANSITION_TARGETS_BUILTIN, ...Object.keys(workflow.roles ?? {})];
}
