/**
 * Pure text-layout helpers for the full-screen TUI.
 *
 * All functions are ANSI-aware: visible width is measured with escape
 * sequences stripped, and truncation never cuts a sequence in half.
 * Width math assumes single-cell characters (no CJK wide-char handling).
 */

export const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  inverse: "\u001b[7m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
  cyan: "\u001b[36m",
  gray: "\u001b[90m",
};

const ANSI_RE = /\u001b\[[0-9;]*m/g;

export function stripAnsi(s) {
  return String(s ?? "").replace(ANSI_RE, "");
}

export function visibleWidth(s) {
  return stripAnsi(s).length;
}

/** Apply `code` around `text` when color is on; otherwise return text as-is. */
export function paint(text, code, color) {
  return color && code ? `${code}${text}${ANSI.reset}` : String(text);
}

/**
 * Truncate to `width` visible cells, appending `…` when content was cut.
 * ANSI sequences are preserved and a reset is appended after a cut so styling
 * never bleeds into the next cell.
 */
export function truncateAnsi(s, width) {
  const str = String(s ?? "");
  if (width <= 0) return "";
  if (visibleWidth(str) <= width) return str;
  let out = "";
  let visible = 0;
  let i = 0;
  const limit = width - 1; // reserve one cell for the ellipsis
  let hadAnsi = false;
  while (i < str.length && visible < limit) {
    if (str[i] === "\u001b") {
      const seq = str.slice(i).match(/^\u001b\[[0-9;]*m/);
      if (seq) {
        out += seq[0];
        i += seq[0].length;
        hadAnsi = true;
        continue;
      }
    }
    out += str[i];
    visible += 1;
    i += 1;
  }
  return `${out}…${hadAnsi ? ANSI.reset : ""}`;
}

/** Pad with spaces (or truncate) to exactly `width` visible cells. */
export function padLine(s, width) {
  const str = String(s ?? "");
  const w = visibleWidth(str);
  if (w === width) return str;
  if (w < width) return str + " ".repeat(width - w);
  return truncateAnsi(str, width);
}

/** Word-wrap plain text to `width`; long words are hard-broken. */
export function wrapText(s, width) {
  if (width <= 0) return [];
  const out = [];
  for (const para of String(s ?? "").split(/\r?\n/)) {
    if (para.length <= width) {
      out.push(para);
      continue;
    }
    let line = "";
    for (const word of para.split(/\s+/)) {
      let w = word;
      while (w.length > width) {
        if (line) { out.push(line); line = ""; }
        out.push(w.slice(0, width));
        w = w.slice(width);
      }
      if (!line) line = w;
      else if (line.length + 1 + w.length <= width) line += ` ${w}`;
      else { out.push(line); line = w; }
    }
    out.push(line);
  }
  return out;
}

/**
 * Distribute `total` cells across column specs.
 * Spec: { min, flex } — fixed columns use flex 0 and get `min`;
 * flexible columns share the remainder proportionally to `flex`,
 * never dropping below their `min`. One space gutter between columns
 * is the caller's concern (pass total minus gutters).
 */
export function computeColumns(specs, total) {
  const widths = specs.map((s) => s.min ?? 0);
  let used = widths.reduce((a, b) => a + b, 0);
  const spare = Math.max(0, total - used);
  const flexTotal = specs.reduce((a, s) => a + (s.flex ?? 0), 0);
  if (flexTotal > 0 && spare > 0) {
    let assigned = 0;
    specs.forEach((s, i) => {
      if (!s.flex) return;
      const add = Math.floor((spare * s.flex) / flexTotal);
      widths[i] += add;
      assigned += add;
    });
    // hand leftover cells to the last flex column
    const lastFlex = specs.map((s, i) => (s.flex ? i : -1)).filter((i) => i >= 0).pop();
    if (lastFlex !== undefined) widths[lastFlex] += spare - assigned;
  }
  // If total is too small for the minimums, shrink flex columns first.
  used = widths.reduce((a, b) => a + b, 0);
  let overflow = used - total;
  if (overflow > 0) {
    for (let i = specs.length - 1; i >= 0 && overflow > 0; i -= 1) {
      if (!specs[i].flex) continue;
      const take = Math.min(overflow, widths[i] - 1);
      widths[i] -= take;
      overflow -= take;
    }
  }
  return widths;
}

/** Render one table row: cells padded to widths, joined by single spaces. */
export function formatRow(cells, widths) {
  return cells.map((cell, i) => padLine(cell, widths[i] ?? 0)).join(" ");
}
