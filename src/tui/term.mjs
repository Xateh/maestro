/**
 * Terminal control layer for the full-screen TUI.
 *
 * Owns the alternate screen buffer, raw-mode input, resize events, and frame
 * blitting. Everything above this layer deals in plain arrays of lines, so
 * the whole app can be driven by a fake terminal in tests.
 */

import { decodeKeys } from "./keys.mjs";

const ENTER_ALT = "\u001b[?1049h";
const LEAVE_ALT = "\u001b[?1049l";
const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";
const CURSOR_HOME = "\u001b[H";
const CLEAR_BELOW = "\u001b[J";

export class FullScreenTerminal {
  constructor({ stdin = process.stdin, stdout = process.stdout } = {}) {
    this.stdin = stdin;
    this.stdout = stdout;
    this._carry = "";
    this._onData = null;
    this._onResize = null;
    this._started = false;
  }

  size() {
    return {
      cols: this.stdout.columns ?? 80,
      rows: this.stdout.rows ?? 24,
    };
  }

  start({ onKey, onResize }) {
    if (this._started) return;
    this._started = true;
    this.stdout.write(ENTER_ALT + HIDE_CURSOR);
    if (this.stdin.setRawMode) this.stdin.setRawMode(true);
    this.stdin.resume?.();
    this._onData = (chunk) => {
      const { keys, rest } = decodeKeys(this._carry + chunk.toString("utf8"));
      this._carry = rest;
      for (const key of keys) onKey(key);
    };
    this.stdin.on("data", this._onData);
    if (onResize) {
      this._onResize = () => onResize(this.size());
      this.stdout.on("resize", this._onResize);
    }
  }

  /** Blit a full frame: lines are pre-padded to the terminal width. */
  draw(lines) {
    const { rows } = this.size();
    const frame = lines.slice(0, rows);
    // \r\n is required in raw mode; trailing newline on the last row would
    // scroll, so rows are joined instead of terminated.
    this.stdout.write(`${CURSOR_HOME}${frame.join("\u001b[K\r\n")}\u001b[K${CLEAR_BELOW}`);
  }

  stop() {
    if (!this._started) return;
    this._started = false;
    if (this._onData) this.stdin.off("data", this._onData);
    if (this._onResize) this.stdout.off("resize", this._onResize);
    if (this.stdin.setRawMode) this.stdin.setRawMode(false);
    this.stdin.pause?.();
    this.stdout.write(SHOW_CURSOR + LEAVE_ALT);
  }
}
