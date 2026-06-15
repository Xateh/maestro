import assert from "node:assert/strict";
import { test } from "node:test";

import { trace } from "@opentelemetry/api";

import { validatePayload } from "../src/schemas/index.mjs";
import { buildStageEvent, emitOtelStageEvent, getStageEvents } from "../src/stage-events.mjs";

test("buildStageEvent maps a representative agent step + passes schema", () => {
  const task = { id: "t1", workflow: "full-audit-sweep" };
  const step = {
    role: "executor",
    provider: "claude",
    model: "claude-opus",
    tokens: 1500,
    status: "succeeded",
    started_at: "2026-06-15T00:00:00.000Z",
    completed_at: "2026-06-15T00:00:05.000Z",
    handoff_path: "/runs/t1/executor.json",
    stdout_path: "/runs/t1/executor.out",
    stderr_path: "/runs/t1/executor.err",
  };
  const event = buildStageEvent({ task, step });
  assert.equal(event.workflow_id, "full-audit-sweep");
  assert.equal(event.stage, "executor");
  assert.equal(event.model, "claude-opus");
  assert.equal(event.tokens, 1500);
  assert.equal(event.duration_ms, 5000);
  assert.equal(event.status, "succeeded");
  assert.deepEqual(event.artifacts, [
    "/runs/t1/executor.json",
    "/runs/t1/executor.out",
    "/runs/t1/executor.err",
  ]);
  assert.equal(event.provider, "claude");
  assert.ok(validatePayload("stage_event", event).ok);
});

test("buildStageEvent: non-LLM step ⇒ model:'' tokens:0 duration>0, schema ok", () => {
  const task = { workflow: "default" };
  const step = {
    role: "scoring",
    provider: "scoring",
    status: "succeeded",
    started_at: "2026-06-15T00:00:00.000Z",
    completed_at: "2026-06-15T00:00:00.250Z",
    handoff_path: "/runs/x/scoring.json",
  };
  const event = buildStageEvent({ task, step });
  assert.equal(event.model, "");
  assert.equal(event.tokens, 0);
  assert.equal(event.duration_ms, 250);
  assert.deepEqual(event.artifacts, ["/runs/x/scoring.json"]);
  assert.ok(validatePayload("stage_event", event).ok);
});

test("buildStageEvent: workflow_id defaults to 'default' when task.workflow absent", () => {
  const event = buildStageEvent({ task: {}, step: { role: "planner", status: "succeeded" } });
  assert.equal(event.workflow_id, "default");
});

test("buildStageEvent: partial/garbage/null ⇒ schema-valid defaults, no throw", () => {
  for (const input of [
    {},
    { task: null, step: null },
    { task: undefined, step: undefined },
    { step: { tokens: "lots", started_at: "garbage", completed_at: "also-garbage" } },
    { task: { workflow: 5 }, step: { role: 42, status: {}, model: [] } },
  ]) {
    const event = buildStageEvent(input);
    assert.equal(typeof event.workflow_id, "string");
    assert.equal(typeof event.stage, "string");
    assert.equal(typeof event.model, "string");
    assert.equal(typeof event.tokens, "number");
    assert.equal(typeof event.duration_ms, "number");
    assert.equal(typeof event.status, "string");
    assert.ok(Array.isArray(event.artifacts));
    assert.ok(validatePayload("stage_event", event).ok, JSON.stringify(event));
  }
  // also tolerate zero args
  assert.ok(validatePayload("stage_event", buildStageEvent()).ok);
});

test("buildStageEvent: completed_at before started_at ⇒ duration 0", () => {
  const event = buildStageEvent({
    task: {},
    step: {
      role: "r",
      status: "succeeded",
      started_at: "2026-06-15T00:00:05.000Z",
      completed_at: "2026-06-15T00:00:00.000Z",
    },
  });
  assert.equal(event.duration_ms, 0);
});

test("getStageEvents: one event per step in order incl. a retry, all schema-valid", () => {
  const task = {
    workflow: "default",
    steps: [
      { role: "planner", provider: "claude", status: "succeeded", started_at: "2026-06-15T00:00:00.000Z", completed_at: "2026-06-15T00:00:01.000Z" },
      { role: "executor", provider: "codex", status: "retried", started_at: "2026-06-15T00:00:01.000Z", completed_at: "2026-06-15T00:00:02.000Z" },
      { role: "executor", provider: "codex", status: "succeeded", started_at: "2026-06-15T00:00:02.000Z", completed_at: "2026-06-15T00:00:04.000Z" },
    ],
  };
  const events = getStageEvents(task);
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.stage), ["planner", "executor", "executor"]);
  assert.deepEqual(events.map((e) => e.status), ["succeeded", "retried", "succeeded"]);
  for (const e of events) assert.ok(validatePayload("stage_event", e).ok);
});

test("getStageEvents: missing/garbage steps ⇒ [], no throw", () => {
  assert.deepEqual(getStageEvents(null), []);
  assert.deepEqual(getStageEvents({}), []);
  assert.deepEqual(getStageEvents({ steps: "nope" }), []);
});

test("emitOtelStageEvent: no tracer registered ⇒ no-op, no throw", () => {
  // No SDK registered → @opentelemetry/api returns a no-op tracer.
  assert.doesNotThrow(() =>
    emitOtelStageEvent({
      workflow_id: "default",
      stage: "planner",
      model: "",
      tokens: 0,
      duration_ms: 0,
      status: "succeeded",
      artifacts: [],
    }),
  );
});

test("emitOtelStageEvent: with a stubbed tracer, records one maestro.stage span w/ attrs", () => {
  const recorded = [];
  const stubProvider = {
    getTracer() {
      return {
        startSpan(name) {
          const span = { name, attributes: {} };
          recorded.push(span);
          return {
            setAttributes(attrs) {
              Object.assign(span.attributes, attrs);
              return this;
            },
            end() {},
          };
        },
      };
    },
  };
  try {
    trace.setGlobalTracerProvider(stubProvider);
    emitOtelStageEvent({
      workflow_id: "wf",
      stage: "executor",
      model: "m",
      tokens: 42,
      duration_ms: 1000,
      status: "succeeded",
      provider: "claude",
      artifacts: ["/a"],
    });
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].name, "maestro.stage");
    assert.equal(recorded[0].attributes["maestro.stage"], "executor");
    assert.equal(recorded[0].attributes["maestro.tokens"], 42);
    assert.equal(recorded[0].attributes["maestro.duration_ms"], 1000);
    assert.equal(recorded[0].attributes["maestro.status"], "succeeded");
    assert.equal(recorded[0].attributes["maestro.artifacts"], JSON.stringify(["/a"]));
  } finally {
    trace.disable(); // reset global tracer provider so it does not leak
  }
});
