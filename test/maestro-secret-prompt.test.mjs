import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { readSecretMasked } from "../src/setup/secret-prompt.mjs";

function fakeTTY() {
  const s = new EventEmitter();
  s.isTTY = true;
  s.isRaw = false;
  s.setRawMode = (v) => {
    s.isRaw = v;
    return s;
  };
  s.resume = () => {};
  s.pause = () => {};
  return s;
}

function fakeStdout() {
  const writes = [];
  return { writes, write: (str) => writes.push(str) };
}

test("readSecretMasked shows the prompt, masks the value, returns input", async () => {
  const stdin = fakeTTY();
  const stdout = fakeStdout();
  const p = readSecretMasked({ stdin, stdout, prompt: "passphrase: " });
  stdin.emit("data", Buffer.from("ab"));
  stdin.emit("data", Buffer.from("c"));
  stdin.emit("data", Buffer.from("\r"));
  const value = await p;

  assert.equal(value, "abc");
  const out = stdout.writes.join("");
  assert.ok(out.startsWith("passphrase: ")); // instruction visible
  assert.ok(!out.includes("abc")); // secret never echoed
  assert.equal((out.match(/\*/g) || []).length, 3); // one mask per char
});

test("backspace erases a masked character and the underlying value", async () => {
  const stdin = fakeTTY();
  const stdout = fakeStdout();
  const p = readSecretMasked({ stdin, stdout });
  stdin.emit("data", Buffer.from("ax"));
  stdin.emit("data", Buffer.from("")); // DEL removes the x
  stdin.emit("data", Buffer.from("b"));
  stdin.emit("data", Buffer.from("\n"));

  assert.equal(await p, "ab");
});

test("raw mode is enabled during entry and restored afterward", async () => {
  const stdin = fakeTTY();
  const stdout = fakeStdout();
  assert.equal(stdin.isRaw, false);
  const p = readSecretMasked({ stdin, stdout, prompt: "x" });
  assert.equal(stdin.isRaw, true); // raw while reading
  stdin.emit("data", Buffer.from("s\n"));
  await p;
  assert.equal(stdin.isRaw, false); // restored
});

test("Ctrl-C rejects without leaking the typed value", async () => {
  const stdin = fakeTTY();
  const stdout = fakeStdout();
  const p = readSecretMasked({ stdin, stdout });
  stdin.emit("data", Buffer.from("secre"));
  stdin.emit("data", Buffer.from(""));
  await assert.rejects(() => p, /secret_input_aborted/);
  assert.ok(!stdout.writes.join("").includes("secre"));
});
