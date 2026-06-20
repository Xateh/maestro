import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { validateGithubSignature, renderWebhookTemplate } from "../src/http-server.mjs";

// ── signature validation ──────────────────────────────────────────────────────
const SECRET = "my-webhook-secret";
function sign(body) {
  return "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
}

test("validateGithubSignature: valid signature returns true", () => {
  const body = Buffer.from(JSON.stringify({ action: "opened" }));
  const sig = sign(body);
  assert.ok(validateGithubSignature(body, sig, SECRET));
});

test("validateGithubSignature: tampered body returns false", () => {
  const body = Buffer.from(JSON.stringify({ action: "opened" }));
  const sig = sign(Buffer.from("different body"));
  assert.ok(!validateGithubSignature(body, sig, SECRET));
});

test("validateGithubSignature: missing signature returns false", () => {
  assert.ok(!validateGithubSignature(Buffer.from("x"), null, SECRET));
});

test("validateGithubSignature: wrong prefix returns false", () => {
  const body = Buffer.from("x");
  const sig = "md5=" + createHmac("md5", SECRET).update(body).digest("hex");
  assert.ok(!validateGithubSignature(body, sig, SECRET));
});

// ── template rendering ────────────────────────────────────────────────────────
test("renderWebhookTemplate: renders {{payload.pull_request.title}}", () => {
  const payload = { pull_request: { title: "Fix login", body: "Details" } };
  const tmpl = "{{payload.pull_request.title}}\n{{payload.pull_request.body}}";
  const result = renderWebhookTemplate(tmpl, { payload });
  assert.ok(result.includes("Fix login"));
  assert.ok(result.includes("Details"));
});

test("renderWebhookTemplate: missing key renders empty string (not undefined)", () => {
  const result = renderWebhookTemplate("{{payload.no_such_key}}", { payload: {} });
  assert.ok(!result.includes("undefined"), result);
});
