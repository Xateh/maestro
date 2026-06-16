// Shared "keep only the last N bytes of UTF-8 output" helper. Pure, no deps.
// Bounding the byte length can split a multi-byte UTF-8 sequence at the head,
// so we strip a leading replacement char (U+FFFD) produced by that split.

import { StringDecoder } from "node:string_decoder";

export function boundedTail(text, maxBytes) {
  const buffer = Buffer.from(String(text ?? ""), "utf8");
  if (buffer.length <= maxBytes) return buffer.toString("utf8");
  return buffer
    .subarray(buffer.length - maxBytes)
    .toString("utf8")
    .replace(/^�/, "");
}

export function appendBoundedTail(current, chunk, maxBytes) {
  return boundedTail(`${current}${chunk.toString("utf8")}`, maxBytes);
}

// Stateful bounded tail for a *stream* of chunks. Decodes through a
// StringDecoder so a multi-byte UTF-8 codepoint split ACROSS two chunks is
// reassembled rather than mangled (which per-chunk `chunk.toString("utf8")`
// does). Returns an accumulator: push(chunk) folds in a chunk and returns the
// current bounded tail; value() reads it without mutating. (F8)
export function createBoundedTail(maxBytes) {
  const decoder = new StringDecoder("utf8");
  let text = "";
  return {
    push(chunk) {
      text = boundedTail(`${text}${decoder.write(chunk)}`, maxBytes);
      return text;
    },
    value() {
      return text;
    },
  };
}
