import assert from "node:assert/strict";
import { test } from "node:test";
import { sendNotification, buildSlackMessage, buildGenericMessage } from "../src/notify.mjs";

const task = {
  id: "task-1",
  status: "succeeded",
  workflow: "full-audit-sweep",
  review: { summary: "All checks passed." },
};

// ── message builders ──────────────────────────────────────────────────────────
test("buildSlackMessage: returns object with blocks array", () => {
  const msg = buildSlackMessage("completed", task);
  assert.ok(Array.isArray(msg.blocks), "blocks must be array");
  const text = JSON.stringify(msg);
  assert.ok(text.includes("task-1"), "must include task id");
  assert.ok(text.includes("full-audit-sweep"), "must include workflow");
});

test("buildGenericMessage: includes event, task_id, workflow, status, summary", () => {
  const msg = buildGenericMessage("completed", task);
  assert.equal(msg.event, "completed");
  assert.equal(msg.task_id, "task-1");
  assert.equal(msg.workflow, "full-audit-sweep");
  assert.equal(msg.status, "succeeded");
  assert.ok(typeof msg.summary === "string");
});

// ── sendNotification ──────────────────────────────────────────────────────────
test("sendNotification: posts Slack message to URL", async () => {
  let posted = null;
  const fetchImpl = async (url, opts) => {
    posted = { url, body: JSON.parse(opts.body) };
    return { ok: true };
  };
  const config = { on: ["completed"], url: "https://hooks.slack.example/xyz", format: "slack" };
  await sendNotification("completed", task, config, { fetchImpl, stderr: { write: () => {} } });
  assert.ok(posted !== null, "fetch should have been called");
  assert.ok(Array.isArray(posted.body.blocks));
});

test("sendNotification: skips when event not in config.on", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true }; };
  const config = { on: ["halted"], url: "https://hooks.slack.example/xyz", format: "slack" };
  await sendNotification("completed", task, config, { fetchImpl, stderr: { write: () => {} } });
  assert.ok(!called, "fetch must not be called when event not in on[]");
});

test("sendNotification: fetch failure is non-fatal (no throw)", async () => {
  const config = { on: ["completed"], url: "https://hooks.slack.example/xyz", format: "slack" };
  const fetchImpl = async () => { throw new Error("network error"); };
  const errors = [];
  const stderr = { write: (s) => errors.push(s) };
  await assert.doesNotReject(() => sendNotification("completed", task, config, { fetchImpl, stderr }));
  assert.ok(errors.some((e) => e.includes("notify")), "error should be logged to stderr");
});

test("sendNotification: generic format posts JSON payload", async () => {
  let posted = null;
  const fetchImpl = async (url, opts) => {
    posted = { url, body: JSON.parse(opts.body) };
    return { ok: true };
  };
  const config = { on: ["completed"], url: "https://example.com/webhook", format: "generic" };
  await sendNotification("completed", task, config, { fetchImpl, stderr: { write: () => {} } });
  assert.equal(posted.body.event, "completed");
  assert.equal(posted.body.task_id, "task-1");
});
