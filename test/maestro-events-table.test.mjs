// Tests for the materialised events table in src/db/store.mjs (SQLite):
// replaceStageEvents / getStageEventsForTask / queryStageEvents.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { SqliteTaskStore } from "../src/db/store.mjs";

function ev(stage, status, extra = {}) {
  return {
    workflow_id: "default",
    stage,
    model: "claude-opus",
    tokens: 10,
    duration_ms: 5,
    status,
    artifacts: [],
    ...extra,
  };
}

async function withStore(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "events-table-"));
  const store = new SqliteTaskStore(path.join(dir, "maestro.db"));
  try {
    await fn(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("replaceStageEvents then getStageEventsForTask round-trips in seq order with artifacts", async () => {
  await withStore(async (store) => {
    const events = [
      ev("planner", "succeeded", { artifacts: ["/runs/p.json"] }),
      ev("executor", "succeeded", { artifacts: ["/runs/e.out", "/runs/e.err"] }),
      ev("review", "succeeded"),
    ];
    await store.replaceStageEvents("t1", events);
    const rows = await store.getStageEventsForTask("t1");
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.seq), [0, 1, 2]);
    assert.deepEqual(rows.map((r) => r.stage), ["planner", "executor", "review"]);
    assert.deepEqual(rows[1].artifacts, ["/runs/e.out", "/runs/e.err"]);
  });
});

test("replaceStageEvents called twice replaces, no duplicates", async () => {
  await withStore(async (store) => {
    await store.replaceStageEvents("t1", [ev("a", "succeeded"), ev("b", "succeeded")]);
    await store.replaceStageEvents("t1", [ev("c", "succeeded")]);
    const rows = await store.getStageEventsForTask("t1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].stage, "c");
    assert.equal(rows[0].seq, 0);
  });
});

test("queryStageEvents filters by stage and status across tasks", async () => {
  await withStore(async (store) => {
    await store.replaceStageEvents("t1", [ev("scoring", "succeeded"), ev("review", "failed")]);
    await store.replaceStageEvents("t2", [ev("scoring", "failed"), ev("planner", "succeeded")]);

    const byStage = await store.queryStageEvents({ stage: "scoring" });
    assert.equal(byStage.length, 2);
    assert.ok(byStage.every((e) => e.stage === "scoring"));
    assert.deepEqual(new Set(byStage.map((e) => e.task_id)), new Set(["t1", "t2"]));

    const byStatus = await store.queryStageEvents({ status: "failed" });
    assert.equal(byStatus.length, 2);
    assert.ok(byStatus.every((e) => e.status === "failed"));

    const combined = await store.queryStageEvents({ stage: "scoring", status: "failed" });
    assert.equal(combined.length, 1);
    assert.equal(combined[0].task_id, "t2");
  });
});

test("replaceStageEvents swallows a forced insert error and never throws", async () => {
  await withStore(async (store) => {
    const original = store._db.prepare.bind(store._db);
    store._db.prepare = (sql) => {
      if (sql.startsWith("INSERT INTO events")) throw new Error("forced insert failure");
      return original(sql);
    };
    await assert.doesNotReject(() => store.replaceStageEvents("t1", [ev("a", "succeeded")]));
    store._db.prepare = original;
    // Transaction rolled back: nothing materialised.
    const rows = await store.getStageEventsForTask("t1");
    assert.equal(rows.length, 0);
  });
});
