// Read a secret from a TTY, echoing a mask character per keystroke. The prompt
// and any instructions are written normally (visible); only the typed value is
// masked. Raw-mode, char-by-char so masking and backspace are exact — readline's
// line-refresh batching makes per-char masking unreliable.

const CTRL_C = "\u0003";
const BACKSPACE = "\u007f"; // DEL, what most terminals send for Backspace

export function readSecretMasked({
  stdin = process.stdin,
  stdout = process.stdout,
  prompt = "",
  mask = "*",
} = {}) {
  return new Promise((resolve, reject) => {
    if (prompt) stdout.write(prompt); // instructions stay visible
    const wasRaw = Boolean(stdin.isRaw);
    if (typeof stdin.setRawMode === "function") stdin.setRawMode(true);
    if (typeof stdin.resume === "function") stdin.resume();

    let value = "";
    const cleanup = () => {
      stdin.removeListener("data", onData);
      if (typeof stdin.setRawMode === "function") stdin.setRawMode(wasRaw);
      if (typeof stdin.pause === "function") stdin.pause();
    };
    const onData = (chunk) => {
      const s = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === CTRL_C) {
          // abort without leaking what was typed
          cleanup();
          stdout.write("\n");
          reject(new Error("secret_input_aborted"));
          return;
        }
        if (ch === BACKSPACE || ch === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            stdout.write("\b \b"); // erase one mask glyph
          }
          continue;
        }
        if (ch < " ") continue; // ignore other control chars
        value += ch;
        stdout.write(mask);
      }
    };
    stdin.on("data", onData);
  });
}
