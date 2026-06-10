/**
 * Pure workflow → grid-graph renderer.
 *
 * Lays out the workflow's roles as boxes on a grid, main `done` transitions
 * (the handoff path) as horizontal arrows, and every other event transition
 * as labeled branches under each role. Falls back to a vertical layout when
 * the terminal is too narrow for the full row of boxes.
 */

import { ANSI, paint, padLine, visibleWidth, truncateAnsi } from "./layout.mjs";

const SINK_BADGES = {
  $complete: "◎",
  $halt: "■",
  $ask_user: "?",
  $pause: "‖",
  $wait: "…",
};

function sinkLabel(state, color) {
  const badge = SINK_BADGES[state] ?? "•";
  const code = state === "$complete" ? ANSI.green : state === "$halt" ? ANSI.red : ANSI.yellow;
  return paint(`${badge} ${state}`, code, color);
}

/**
 * Order role keys by following `done` transitions from the workflow's initial
 * state. Roles unreachable from the chain are appended so nothing is hidden.
 * Returns { chain, terminal } where terminal is the sink the last role's
 * `done` points at (or null).
 */
export function buildWorkflowChain(workflow, mode = "task") {
  const roles = workflow?.roles ?? {};
  const transitions = workflow?.transitions ?? {};
  const initial = workflow?.modes?.[mode]?.initial ?? workflow?.initial;
  const chain = [];
  const seen = new Set();
  let cursor = initial;
  let terminal = null;
  while (cursor && roles[cursor] && !seen.has(cursor)) {
    chain.push(cursor);
    seen.add(cursor);
    const next = transitions[cursor]?.done;
    if (next && !roles[next]) {
      terminal = next;
      break;
    }
    cursor = next;
  }
  for (const key of Object.keys(roles)) {
    if (!seen.has(key)) chain.push(key);
  }
  return { chain, terminal };
}

/** Non-done transitions for a role, as [event, target] pairs. */
export function branchTransitions(workflow, roleKey) {
  const t = workflow?.transitions?.[roleKey] ?? {};
  return Object.entries(t).filter(([event]) => event !== "done");
}

function roleBoxLines(workflow, roleKey, innerWidth, { color, selected }) {
  const role = workflow?.roles?.[roleKey] ?? {};
  const title = ` ${role.label ?? roleKey} `;
  const agent = `${role.provider ?? "?"}${role.alias ? `:${role.alias}` : ""}`;
  const meta = `${role.permission ?? "-"} · skip:${role.skip ?? "auto"}`;
  const hl = (s) => (selected ? paint(s, ANSI.cyan + ANSI.bold, color) : paint(s, ANSI.bold, color));
  const bar = "─".repeat(Math.max(0, innerWidth - visibleWidth(title)));
  const top = `╭${hl(truncateAnsi(title, innerWidth - 1))}${bar}╮`;
  const row = (text, code = null) => {
    const body = padLine(code ? paint(text, code, color) : text, innerWidth);
    return `│${body}│`;
  };
  const bottom = `╰${"─".repeat(innerWidth)}╯`;
  return [top, row(` ${agent}`, ANSI.cyan), row(` ${meta}`, ANSI.dim), bottom];
}

function mergeColumns(columns, gap = "") {
  const height = Math.max(...columns.map((c) => c.length));
  const lines = [];
  for (let r = 0; r < height; r += 1) {
    lines.push(columns.map((col) => {
      const cell = col[r] ?? padLine("", visibleWidth(col[0] ?? ""));
      return cell;
    }).join(gap));
  }
  return lines;
}

/**
 * Render the workflow as grid lines.
 * options: { width, color, selected } — selected is a role key to highlight.
 * Returns { lines, layout: "grid" | "stack" }.
 */
export function renderWorkflowGraph(workflow, { width = 80, color = false, selected = null, mode = "task" } = {}) {
  const { chain, terminal } = buildWorkflowChain(workflow, mode);
  if (chain.length === 0) return { lines: ["(workflow has no roles)"], layout: "stack" };

  const ARROW_W = 12; // "─handoff──► " segment between boxes
  const TERM_W = terminal ? visibleWidth(terminal) + 8 : 0;
  const minBox = 16;
  const gridNeeded = chain.length * (minBox + 2) + (chain.length - 1) * ARROW_W + TERM_W;

  if (width < gridNeeded) {
    return { lines: renderStack(workflow, chain, terminal, { width, color, selected }), layout: "stack" };
  }

  const boxInner = Math.min(
    30,
    Math.floor((width - (chain.length - 1) * ARROW_W - TERM_W - chain.length * 2) / chain.length),
  );

  const columns = [];
  for (let i = 0; i < chain.length; i += 1) {
    const roleKey = chain[i];
    columns.push(roleBoxLines(workflow, roleKey, boxInner, { color, selected: selected === roleKey }));
    if (i < chain.length - 1) {
      const label = "handoff";
      const pad = ARROW_W - 2 - label.length;
      const arrow = `─${label}${"─".repeat(Math.max(1, pad))}►`;
      columns.push([
        padLine("", ARROW_W),
        paint(padLine(arrow, ARROW_W), ANSI.dim, color),
        padLine(paint("  done", ANSI.dim, color), ARROW_W),
        padLine("", ARROW_W),
      ]);
    }
  }
  if (terminal) {
    columns.push([
      padLine("", TERM_W),
      ` ──► ${sinkLabel(terminal, color)}`,
      padLine("", TERM_W),
      padLine("", TERM_W),
    ]);
  }

  const lines = mergeColumns(columns);

  // Branch rows: each role's non-done transitions, aligned under its column.
  const colOffsets = [];
  let offset = 0;
  for (let i = 0; i < chain.length; i += 1) {
    colOffsets.push(offset);
    offset += boxInner + 2 + (i < chain.length - 1 ? ARROW_W : 0);
  }
  const branchRows = [];
  let rowIdx = 0;
  while (true) {
    let any = false;
    let line = "";
    for (let i = 0; i < chain.length; i += 1) {
      const branches = branchTransitions(workflow, chain[i]);
      const entry = branches[rowIdx];
      const cellWidth = colOffsets[i] - visibleWidth(line);
      if (cellWidth > 0) line += " ".repeat(cellWidth);
      if (entry) {
        any = true;
        const [event, target] = entry;
        line += truncateAnsi(`  ${paint(event, ANSI.yellow, color)} → ${sinkLabel(target, color)}`, boxInner + 2 + ARROW_W);
      }
    }
    if (!any) break;
    branchRows.push(line);
    rowIdx += 1;
  }
  if (branchRows.length > 0) {
    lines.push(paint(`${"┄".repeat(Math.min(width, offset))}`, ANSI.dim, color));
    lines.push(...branchRows);
  }
  return { lines: lines.map((l) => truncateAnsi(l, width)), layout: "grid" };
}

function renderStack(workflow, chain, terminal, { width, color, selected }) {
  const lines = [];
  for (let i = 0; i < chain.length; i += 1) {
    const roleKey = chain[i];
    const role = workflow?.roles?.[roleKey] ?? {};
    const isSel = selected === roleKey;
    const marker = isSel ? paint("▶", ANSI.cyan + ANSI.bold, color) : "●";
    const title = paint(role.label ?? roleKey, isSel ? ANSI.cyan + ANSI.bold : ANSI.bold, color);
    const agent = paint(`${role.provider ?? "?"}${role.alias ? `:${role.alias}` : ""}`, ANSI.cyan, color);
    lines.push(truncateAnsi(`${marker} ${title}  ${agent}`, width));
    lines.push(truncateAnsi(paint(`│   ${role.permission ?? "-"} · skip:${role.skip ?? "auto"}`, ANSI.dim, color), width));
    for (const [event, target] of branchTransitions(workflow, roleKey)) {
      lines.push(truncateAnsi(`│   ${paint(event, ANSI.yellow, color)} → ${sinkLabel(target, color)}`, width));
    }
    if (i < chain.length - 1) {
      lines.push(paint("▼ done (handoff)", ANSI.dim, color));
    } else if (terminal) {
      lines.push(`▼ done ──► ${sinkLabel(terminal, color)}`);
    }
  }
  return lines;
}
