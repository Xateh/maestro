/**
 * Pure terminal key decoder for the full-screen TUI.
 *
 * decodeKeys(input) consumes a string of raw terminal bytes and returns
 * { keys, rest } where `keys` is an array of key events and `rest` is any
 * trailing incomplete escape sequence to carry into the next chunk.
 *
 * Key event shape: { name, ch? }
 *   name ∈ "up" | "down" | "left" | "right" | "pageup" | "pagedown"
 *        | "home" | "end" | "delete" | "enter" | "tab" | "shift-tab"
 *        | "backspace" | "escape" | "ctrl-c" | "char"
 *   ch is set only for name === "char" (a single printable character).
 */

const ESC = "\u001b";

const CSI_FINAL = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  Z: "shift-tab",
};

const CSI_TILDE = {
  1: "home",
  3: "delete",
  4: "end",
  5: "pageup",
  6: "pagedown",
  7: "home",
  8: "end",
};

const SS3_FINAL = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
};

// Returns true when the string could still grow into a full escape sequence.
function isIncompleteEscape(s) {
  if (s === "" || s === "[" || s === "O") return true;
  if (s.startsWith("[")) return /^\[[0-9;]*$/.test(s);
  return false;
}

export function decodeKeys(input) {
  const keys = [];
  let i = 0;
  const s = String(input);

  while (i < s.length) {
    const c = s[i];

    if (c === ESC) {
      const remainder = s.slice(i + 1);
      // CSI sequence: ESC [ params final
      const csi = remainder.match(/^\[([0-9;]*)([A-Za-z~])/);
      if (csi) {
        const [seq, params, final] = csi;
        if (final === "~") {
          const name = CSI_TILDE[Number(params.split(";")[0])];
          if (name) keys.push({ name });
        } else if (CSI_FINAL[final]) {
          keys.push({ name: CSI_FINAL[final] });
        }
        i += 1 + seq.length;
        continue;
      }
      // SS3 sequence: ESC O final (application cursor mode)
      const ss3 = remainder.match(/^O([A-Za-z])/);
      if (ss3) {
        const name = SS3_FINAL[ss3[1]];
        if (name) keys.push({ name });
        i += 1 + ss3[0].length;
        continue;
      }
      if (isIncompleteEscape(remainder)) {
        return { keys, rest: s.slice(i) };
      }
      // Lone ESC (or unrecognized sequence start): treat as escape.
      keys.push({ name: "escape" });
      i += 1;
      continue;
    }

    if (c === "\u0003") keys.push({ name: "ctrl-c" });
    else if (c === "\r" || c === "\n") keys.push({ name: "enter" });
    else if (c === "\t") keys.push({ name: "tab" });
    else if (c === "\u007f" || c === "\b") keys.push({ name: "backspace" });
    else if (c >= " ") keys.push({ name: "char", ch: c });
    // other control characters: ignored
    i += 1;
  }

  return { keys, rest: "" };
}
