/**
 * Pure screen renderers for the full-screen TUI.
 *
 * Every renderer takes (model, size) and returns an array of strings exactly
 * `size.rows` long, each padded/clipped to `size.cols` visible cells — the
 * terminal layer just blits them. Keeping these pure makes every screen
 * testable at any terminal size.
 */

import { ANSI, paint, padLine, truncateAnsi, computeColumns, formatRow, wrapText } from "./layout.mjs";
import {
  BUILTIN_ADAPTERS, PERMISSIONS, PROMPT_TEMPLATES, SKIP_VALUES,
} from "./edit-core.mjs";
import { renderWorkflowGraph, buildWorkflowChain, branchTransitions } from "./graph.mjs";
import { aliasNames } from "../providers.mjs";

export const TASK_VIEWS = ["active", "needs-human", "blocked", "incomplete", "failed", "done", "all"];

export const STATUS_STYLE = {
  running: ANSI.cyan,
  queued: ANSI.blue,
  waiting_user: ANSI.yellow,
  waiting_approval: ANSI.yellow,
  needs_review: ANSI.magenta,
  succeeded: ANSI.green,
  failed: ANSI.red,
  cancelled: ANSI.gray,
};

const STATUS_ICON = {
  running: "▶",
  queued: "·",
  waiting_user: "?",
  waiting_approval: "!",
  needs_review: "‼",
  succeeded: "✔",
  failed: "✘",
  cancelled: "—",
};

export function statusCell(status, color) {
  const icon = STATUS_ICON[status] ?? "·";
  return paint(`${icon} ${status ?? "-"}`, STATUS_STYLE[status] ?? "", color);
}

export function formatAge(iso, now = Date.now()) {
  const t = Date.parse(iso ?? "");
  if (Number.isNaN(t)) return "-";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

function shortId(id) {
  return String(id ?? "").replace(/^\d{8}-\d{6}-/, "");
}

// ── chrome ────────────────────────────────────────────────────────────────────

const SCREEN_TABS = [
  ["tasks", "1 Tasks"],
  ["graph", "2 Workflow"],
  ["settings", "3 Settings"],
  ["providers", "4 Providers"],
];

// Sub-screens reached from a tab; the parent tab stays highlighted and
// number/tab navigation is disabled while one is open.
const TAB_FOR_SUBSCREEN = {
  detail: "tasks",
  "role-edit": "graph",
  "provider-edit": "providers",
};

export function renderHeader(model, size) {
  const { color } = model;
  const brand = paint(" Maestro ♪ ", ANSI.bold + ANSI.cyan, color);
  const tabs = SCREEN_TABS.map(([key, label]) => {
    const active = model.screen === key || TAB_FOR_SUBSCREEN[model.screen] === key;
    return active ? paint(` ${label} `, ANSI.inverse, color) : paint(` ${label} `, ANSI.dim, color);
  }).join("");
  const right = paint(`${model.stateLabel ?? ""} `, ANSI.dim, color);
  const left = `${brand}${tabs}`;
  const gap = Math.max(1, size.cols - (visible(left) + visible(right)));
  return padLine(`${left}${" ".repeat(gap)}${right}`, size.cols);
}

function visible(s) {
  return s.replace(/\u001b\[[0-9;]*m/g, "").length;
}

export function renderFooter(model, size) {
  const { color } = model;
  if (model.input) {
    const value = model.input.value ?? "";
    const caret = paint("▏", ANSI.cyan, color);
    return padLine(` ${paint(model.input.label, ANSI.bold, color)} ${value}${caret}`, size.cols);
  }
  const hints = FOOTER_HINTS[model.screen] ?? FOOTER_HINTS.tasks;
  const msg = model.message ? `${paint(model.message, ANSI.yellow, color)}  ` : "";
  return padLine(` ${msg}${paint(hints, ANSI.dim, color)}`, size.cols);
}

const FOOTER_HINTS = {
  tasks: "↑↓ move · ⏎ open · n new · v view · r refresh · 1-4 screens · q quit",
  detail: "↑↓ scroll · [ ] pick action · a approve · d deny · m message · R retry · c cancel · x done · o resume · e extend · esc back",
  graph: "←→ role · ⏎ edit role · a add role · i initial · ↑↓ scroll · r refresh · 1-4 screens · q quit",
  settings: "↑↓ select · ⏎ edit/cycle · r reload · 1-4 screens · q quit",
  providers: "↑↓ select · ⏎ edit · n add · D delete · r refresh · 1-4 screens · q quit",
  "provider-edit": "↑↓ select · ⏎ edit/cycle · e type value · D delete provider · esc back",
  "role-edit": "↑↓ select · ⏎ edit/cycle · e type value · a add transition · D delete transition · esc back",
};

function frame(model, size, bodyLines) {
  const rows = Math.max(3, size.rows);
  const body = bodyLines.slice(0, rows - 2).map((l) => padLine(l, size.cols));
  while (body.length < rows - 2) body.push(padLine("", size.cols));
  return [renderHeader(model, size), ...body, renderFooter(model, size)];
}

// ── tasks screen ──────────────────────────────────────────────────────────────

export function renderTasksScreen(model, size) {
  const { color } = model;
  const body = [];
  const viewTabs = TASK_VIEWS.map((v) => (
    v === model.view ? paint(`[${v}]`, ANSI.bold + ANSI.cyan, color) : paint(` ${v} `, ANSI.dim, color)
  )).join("");
  body.push(truncateAnsi(` ${viewTabs}`, size.cols));
  body.push("");

  const tasks = model.tasks ?? [];
  if (tasks.length === 0) {
    body.push(paint(`  No ${model.view} tasks. The stage is quiet.`, ANSI.dim, color));
    return frame(model, size, body);
  }

  const widths = computeColumns(
    [
      { min: 14, flex: 0 },           // status
      { min: 16, flex: 2 },           // id
      { min: 4, flex: 0 },            // age
      { min: 16, flex: 5 },           // prompt
    ],
    size.cols - 2 - 3,                // margin + 3 gutters
  );
  body.push(` ${paint(formatRow(["STATUS", "TASK", "AGE", "PROMPT"], widths), ANSI.dim + ANSI.bold, color)}`);

  const listHeight = Math.max(1, size.rows - 2 - body.length);
  const sel = Math.min(model.sel ?? 0, tasks.length - 1);
  const top = Math.max(0, Math.min(model.scrollTop ?? 0, tasks.length - listHeight));
  for (let i = top; i < Math.min(tasks.length, top + listHeight); i += 1) {
    const t = tasks[i];
    const row = formatRow(
      [statusCell(t.status, color), shortId(t.id), formatAge(t.created_at, model.now), t.prompt ?? ""],
      widths,
    );
    body.push(i === sel ? paint(`▸${truncateAnsi(row, size.cols - 1)}`, ANSI.inverse, color) : ` ${row}`);
  }
  return frame(model, size, body);
}

/** Keep the selected row visible; returns the new scrollTop. */
export function clampScroll(sel, scrollTop, listHeight, total) {
  let top = scrollTop;
  if (sel < top) top = sel;
  if (sel >= top + listHeight) top = sel - listHeight + 1;
  return Math.max(0, Math.min(top, Math.max(0, total - listHeight)));
}

// ── detail screen ─────────────────────────────────────────────────────────────

export function renderDetailScreen(model, size) {
  const { color } = model;
  const body = [];
  const task = model.task;
  if (!task) {
    body.push(paint("  (task vanished — esc to go back)", ANSI.dim, color));
    return frame(model, size, body);
  }

  const pending = (task.action_requests ?? []).filter((r) => r.status === "pending");
  if (pending.length > 0) {
    const sel = Math.min(model.actionSel ?? 0, pending.length - 1);
    body.push(paint(` Pending actions (${pending.length}) — a approve · d deny:`, ANSI.bold + ANSI.yellow, color));
    pending.forEach((r, i) => {
      const label = `${r.id ?? `act-${i + 1}`} ${r.provider ?? "host"}: ${r.command ?? ""} ${(r.args ?? []).join(" ")}`;
      body.push(truncateAnsi(i === sel ? paint(` ▸ ${label}`, ANSI.inverse, color) : `   ${label}`, size.cols));
    });
    body.push("");
  }

  const detail = (model.detailLines ?? []).map((l) => truncateAnsi(l, size.cols - 2));
  const viewport = Math.max(1, size.rows - 2 - body.length);
  const maxScroll = Math.max(0, detail.length - viewport);
  const at = Math.min(model.detailScroll ?? 0, maxScroll);
  for (const line of detail.slice(at, at + viewport)) body.push(` ${line}`);
  if (maxScroll > 0) {
    const pct = Math.round((at / maxScroll) * 100);
    body[body.length - 1] = padLine(paint(` ── ${pct}% ──`, ANSI.dim, color), size.cols);
  }
  return frame(model, size, body);
}

// ── workflow graph screen ─────────────────────────────────────────────────────

export function renderGraphScreen(model, size) {
  const { color } = model;
  const workflow = model.workflow;
  const body = [];
  if (!workflow) {
    body.push(paint("  No workflow loaded.", ANSI.dim, color));
    return frame(model, size, body);
  }
  const { chain } = buildWorkflowChain(workflow);
  const selectedKey = chain[Math.min(model.graphSel ?? 0, Math.max(0, chain.length - 1))] ?? null;

  body.push(paint(" Workflow — transitions & handoff paths", ANSI.bold, color));
  body.push("");
  const graph = renderWorkflowGraph(workflow, { width: size.cols - 2, color, selected: selectedKey });
  for (const line of graph.lines) body.push(` ${line}`);

  if (selectedKey) {
    const role = workflow.roles?.[selectedKey] ?? {};
    body.push("");
    body.push(paint(` ── ${role.label ?? selectedKey} ──`, ANSI.bold + ANSI.cyan, color));
    body.push(`   provider ${paint(role.provider ?? "-", ANSI.cyan, color)}   alias ${role.alias || "-"}   model ${role.model || "(default)"}   effort ${role.effort || "(default)"}`);
    body.push(`   permission ${role.permission ?? "-"}   prompt_template ${role.prompt_template ?? "-"}   skip ${role.skip ?? "auto"}`);
    const branches = branchTransitions(workflow, selectedKey)
      .map(([e, t]) => `${e} → ${t}`).join(" · ");
    const done = workflow.transitions?.[selectedKey]?.done;
    body.push(`   on done → ${paint(done ?? "-", ANSI.green, color)}${branches ? `   ${paint(branches, ANSI.dim, color)}` : ""}`);
  }

  // Scrollable when the graph outgrows the viewport.
  const viewport = Math.max(1, size.rows - 2);
  if (body.length > viewport) {
    const at = Math.min(model.graphScroll ?? 0, body.length - viewport);
    return frame(model, size, body.slice(at, at + viewport));
  }
  return frame(model, size, body);
}

// ── settings screen ───────────────────────────────────────────────────────────

export const SETTINGS_FIELDS = [
  { path: ["planner_policy"], label: "Planner policy", type: "cycle", options: ["auto", "on", "off"] },
  { path: ["review_enabled"], label: "Review enabled", type: "toggle" },
  { path: ["timeout_ms"], label: "Timeout (ms)", type: "number" },
  { path: ["max_steps"], label: "Max steps", type: "number" },
  { path: ["default_role"], label: "Default role", type: "text" },
  { path: ["worktree_mode_default"], label: "Worktree mode", type: "cycle", options: ["auto", "none", "isolated", "shared"] },
  { path: ["herdr", "close_tab_on"], label: "Herdr tab close", type: "cycle", options: ["success", "terminal", "never"] },
];

export function getConfigValue(config, fieldPath) {
  return fieldPath.reduce((acc, k) => (acc == null ? acc : acc[k]), config);
}

export function settingsPatch(fieldPath, value) {
  if (fieldPath.length === 1) return { [fieldPath[0]]: value };
  return { [fieldPath[0]]: { [fieldPath[1]]: value } };
}

export function renderSettingsScreen(model, size) {
  const { color } = model;
  const body = [];
  body.push(paint(" Settings — .maestro/config.json", ANSI.bold, color));
  body.push("");
  const config = model.config ?? {};
  const sel = Math.min(model.settingsSel ?? 0, SETTINGS_FIELDS.length - 1);
  SETTINGS_FIELDS.forEach((field, i) => {
    const value = getConfigValue(config, field.path);
    const hint = field.type === "cycle" ? paint(` (${field.options.join("/")})`, ANSI.dim, color)
      : field.type === "toggle" ? paint(" (on/off)", ANSI.dim, color)
      : "";
    const line = `${padLine(field.label, 20)} ${paint(String(value ?? "-"), ANSI.cyan, color)}${hint}`;
    body.push(truncateAnsi(i === sel ? paint(` ▸ ${line}`, ANSI.inverse, color) : `   ${line}`, size.cols));
  });
  body.push("");
  const roles = Object.entries(model.workflow?.roles ?? {});
  if (roles.length > 0) {
    body.push(paint(" Role seating (⏎ on a role in the Workflow screen to edit)", ANSI.bold, color));
    for (const [key, role] of roles) {
      body.push(`   ${padLine(role.label ?? key, 12)} ${paint(`${role.provider}${role.alias ? `:${role.alias}` : ""}`, ANSI.cyan, color)} ${paint(role.permission ?? "-", ANSI.dim, color)}`);
    }
  }
  return frame(model, size, body);
}

// ── providers + role editors ──────────────────────────────────────────────────

// Field descriptors share the SETTINGS_FIELDS grammar; `options` may be a
// function of (subject, model) so cycles can follow live config (e.g. a
// role's alias options come from its current provider).

export const PROVIDER_FIELDS = [
  { path: ["label"], label: "Label", type: "text" },
  { path: ["adapter"], label: "Adapter", type: "cycle", options: () => [...BUILTIN_ADAPTERS, "custom"] },
  { path: ["custom", "command_template"], label: "Custom template", type: "text" },
  { path: ["custom", "prompt_via"], label: "Prompt via", type: "cycle", options: () => ["stdin", "arg"] },
  { path: ["default_alias"], label: "Default alias", type: "cycle", options: (def) => aliasNames(def), recent: "aliases_by_provider" },
  { path: ["aliases"], label: "Aliases", type: "list" },
  { path: ["models"], label: "Models", type: "list" },
  { path: ["efforts"], label: "Efforts", type: "list" },
];

export const ROLE_FIELDS = [
  { path: ["label"], label: "Label", type: "text" },
  { path: ["provider"], label: "Provider", type: "cycle", options: (_role, model) => Object.keys(model?.config?.providers ?? {}), recent: "providers_by_role" },
  { path: ["alias"], label: "Alias", type: "cycle", options: (role, model) => aliasNames(model?.config?.providers?.[role?.provider]), recent: "aliases_by_provider" },
  { path: ["model"], label: "Model", type: "cycle", options: (role, model) => ["", ...(model?.config?.providers?.[role?.provider]?.models ?? [])], recent: "models_by_provider" },
  { path: ["effort"], label: "Effort", type: "cycle", options: (role, model) => ["", ...(model?.config?.providers?.[role?.provider]?.efforts ?? [])], recent: "efforts_by_provider" },
  { path: ["permission"], label: "Permission", type: "cycle", options: () => PERMISSIONS },
  { path: ["prompt_template"], label: "Prompt template", type: "cycle", options: () => PROMPT_TEMPLATES },
  { path: ["skip"], label: "Skip", type: "cycle", options: () => SKIP_VALUES },
];

function fieldValueText(value) {
  if (Array.isArray(value)) return value.join(", ") || "(none)";
  if (value === "" || value == null) return "(default)";
  return String(value);
}

function renderFieldRows(body, { fields, subject, model, sel, size }) {
  const { color } = model;
  fields.forEach((field, i) => {
    const value = getConfigValue(subject ?? {}, field.path);
    const options = typeof field.options === "function" ? field.options(subject, model) : field.options;
    const hint = field.type === "cycle" && options?.length
      ? paint(` (${options.map((o) => o || "default").join("/")})`, ANSI.dim, color)
      : field.type === "list" ? paint(" (comma-separated)", ANSI.dim, color) : "";
    const line = `${padLine(field.label, 18)} ${paint(fieldValueText(value), ANSI.cyan, color)}${hint}`;
    body.push(truncateAnsi(i === sel ? paint(` ▸ ${line}`, ANSI.inverse, color) : `   ${line}`, size.cols));
  });
}

export function renderProvidersScreen(model, size) {
  const { color } = model;
  const body = [];
  body.push(paint(" Providers — .maestro/config.json", ANSI.bold, color));
  body.push("");
  const entries = Object.entries(model.config?.providers ?? {});
  if (entries.length === 0) {
    body.push(paint("  No providers configured — press n to add one.", ANSI.dim, color));
    return frame(model, size, body);
  }
  const sel = Math.min(model.providersSel ?? 0, entries.length - 1);
  entries.forEach(([key, def], i) => {
    const aliases = (def.aliases ?? []).length;
    const models = (def.models ?? []).length;
    const line = `${padLine(key, 14)} ${paint(def.adapter ?? "?", ANSI.cyan, color)} ${paint(`(${aliases} alias${aliases === 1 ? "" : "es"}, ${models} model${models === 1 ? "" : "s"})`, ANSI.dim, color)}`;
    body.push(truncateAnsi(i === sel ? paint(` ▸ ${line}`, ANSI.inverse, color) : `   ${line}`, size.cols));
  });
  return frame(model, size, body);
}

export function renderProviderEditScreen(model, size) {
  const { color } = model;
  const body = [];
  const key = model.providerKey;
  const def = model.config?.providers?.[key];
  body.push(paint(` Provider: ${key ?? "?"}`, ANSI.bold, color));
  body.push("");
  if (!def) {
    body.push(paint("  (provider vanished — esc to go back)", ANSI.dim, color));
    return frame(model, size, body);
  }
  renderFieldRows(body, {
    fields: PROVIDER_FIELDS, subject: def, model,
    sel: Math.min(model.providerFieldSel ?? 0, PROVIDER_FIELDS.length - 1), size,
  });
  return frame(model, size, body);
}

export function renderRoleEditScreen(model, size) {
  const { color } = model;
  const body = [];
  const key = model.roleKey;
  const role = model.workflow?.roles?.[key];
  body.push(paint(` Role: ${key ?? "?"}`, ANSI.bold, color));
  body.push("");
  if (!role) {
    body.push(paint("  (role vanished — esc to go back)", ANSI.dim, color));
    return frame(model, size, body);
  }
  const transitions = Object.entries(model.workflow?.transitions?.[key] ?? {});
  const sel = Math.min(model.roleFieldSel ?? 0, ROLE_FIELDS.length + transitions.length - 1);
  renderFieldRows(body, { fields: ROLE_FIELDS, subject: role, model, sel, size });
  body.push("");
  body.push(paint(" Transitions (⏎ cycle target · a add · D delete)", ANSI.bold, color));
  if (transitions.length === 0) {
    body.push(paint("   (none)", ANSI.dim, color));
  }
  transitions.forEach(([event, target], i) => {
    const itemSel = ROLE_FIELDS.length + i === sel;
    const line = `${padLine(event, 10)} → ${paint(target, ANSI.cyan, color)}`;
    body.push(truncateAnsi(itemSel ? paint(` ▸ ${line}`, ANSI.inverse, color) : `   ${line}`, size.cols));
  });
  body.push("");
  body.push(paint(` Initial role: ${model.workflow?.initial ?? "planner"} (press i on the Workflow screen to change)`, ANSI.dim, color));
  return frame(model, size, body);
}

// ── dispatch ──────────────────────────────────────────────────────────────────

export function renderScreen(model, size) {
  switch (model.screen) {
    case "detail": return renderDetailScreen(model, size);
    case "graph": return renderGraphScreen(model, size);
    case "settings": return renderSettingsScreen(model, size);
    case "providers": return renderProvidersScreen(model, size);
    case "provider-edit": return renderProviderEditScreen(model, size);
    case "role-edit": return renderRoleEditScreen(model, size);
    default: return renderTasksScreen(model, size);
  }
}

export function wrapPrompt(prompt, width) {
  return wrapText(prompt, width);
}
