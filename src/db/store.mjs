/**
 * SQLite-backed task store for the LangGraph engine.
 *
 * Replaces scattered .maestro/tasks/*.json files with a single DB at
 * .maestro/maestro.db. Large log blobs stay on disk; DB stores paths.
 *
 * Uses node:sqlite (DatabaseSync, synchronous) — operations are tiny
 * metadata reads/writes so blocking is acceptable.
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { openPgStore } from "./pg-store.mjs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  status      TEXT NOT NULL DEFAULT 'queued',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  data        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS handoffs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  role        TEXT NOT NULL,
  provider    TEXT NOT NULL,
  payload     TEXT NOT NULL,
  log_path    TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  workflow_id TEXT,
  stage       TEXT,
  model       TEXT,
  tokens      INTEGER,
  duration_ms INTEGER,
  status      TEXT,
  artifacts   TEXT,
  created_at  TEXT
);

CREATE INDEX IF NOT EXISTS handoffs_task_id ON handoffs(task_id);
CREATE INDEX IF NOT EXISTS tasks_status     ON tasks(status);
CREATE INDEX IF NOT EXISTS tasks_created_at ON tasks(created_at);
CREATE INDEX IF NOT EXISTS events_task_id   ON events(task_id);
CREATE INDEX IF NOT EXISTS events_stage     ON events(stage);
`;

// Map an events-table row to a stage_event-shaped object (artifacts parsed).
function _rowToStageEvent(r) {
  let artifacts = [];
  try { artifacts = r.artifacts == null ? [] : JSON.parse(r.artifacts); } catch { artifacts = []; }
  return {
    seq: r.seq,
    workflow_id: r.workflow_id,
    stage: r.stage,
    model: r.model,
    tokens: r.tokens,
    duration_ms: r.duration_ms,
    status: r.status,
    artifacts,
    created_at: r.created_at,
  };
}

export class SqliteTaskStore {
  /** @type {DatabaseSync} */
  _db;

  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this._db = new DatabaseSync(dbPath);
    this._db.exec(SCHEMA);
    this._migrate();
  }

  // Idempotent guarded migrations for columns added after the initial schema.
  // node:sqlite lacks "ADD COLUMN IF NOT EXISTS", so probe pragma first.
  _migrate() {
    const cols = this._db.prepare("PRAGMA table_info(handoffs)").all();
    if (!cols.some((c) => c.name === "schema_validation")) {
      this._db.exec("ALTER TABLE handoffs ADD COLUMN schema_validation TEXT");
    }
  }

  // ─── task CRUD ─────────────────────────────────────────────────────────────

  createTask(taskObj) {
    const now = new Date().toISOString();
    const data = { ...taskObj, created_at: now, updated_at: now };
    this._db.prepare(
      "INSERT INTO tasks (id, status, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?)",
    ).run(taskObj.id, taskObj.status ?? "queued", now, now, JSON.stringify(data));
    return Promise.resolve(data);
  }

  getTask(id) {
    const row = this._db.prepare("SELECT data FROM tasks WHERE id = ?").get(id);
    return Promise.resolve(row ? JSON.parse(row.data) : null);
  }

  /**
   * Update task. patchOrFn is either a plain patch object or a function
   * (current) => patchObject. Returns the updated task.
   */
  async updateTask(id, patchOrFn) {
    const current = await this.getTask(id);
    if (!current) throw new Error(`task_not_found: ${id}`);
    const now = new Date().toISOString();
    const patch = typeof patchOrFn === "function" ? patchOrFn(current) : patchOrFn;
    const updated = { ...current, ...patch, updated_at: now };
    this._db.prepare(
      "UPDATE tasks SET status = ?, updated_at = ?, data = ? WHERE id = ?",
    ).run(updated.status ?? current.status, now, JSON.stringify(updated), id);
    return updated;
  }

  listTasks({ limit = 50, status = null } = {}) {
    const rows = status
      ? this._db.prepare(
          "SELECT data FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?",
        ).all(status, limit)
      : this._db.prepare(
          "SELECT data FROM tasks ORDER BY created_at DESC LIMIT ?",
        ).all(limit);
    return Promise.resolve(rows.map((r) => JSON.parse(r.data)));
  }

  // ─── step management ───────────────────────────────────────────────────────

  appendStep(taskId, stepData) {
    const now = new Date().toISOString();
    const step = { ...stepData, completed_at: now };
    return this.updateTask(taskId, (current) => ({
      steps: [...(current.steps ?? []), step],
      active_step:
        stepData.status === "succeeded" || stepData.status === "failed"
          ? null
          : { role: stepData.role, provider: stepData.provider, status: stepData.status },
    }));
  }

  // ─── handoffs (compact typed, no raw stdout) ────────────────────────────────

  addHandoff(taskId, { role, provider, payload, logPath, schemaValidation = null }) {
    const now = new Date().toISOString();
    this._db.prepare(
      "INSERT INTO handoffs (task_id, role, provider, payload, log_path, schema_validation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      taskId,
      role,
      provider,
      JSON.stringify(payload ?? {}),
      logPath ?? null,
      schemaValidation == null ? null : JSON.stringify(schemaValidation),
      now,
    );
    return Promise.resolve();
  }

  getHandoffs(taskId) {
    const rows = this._db.prepare(
      "SELECT role, provider, payload, log_path, schema_validation FROM handoffs WHERE task_id = ? ORDER BY id ASC",
    ).all(taskId);
    return Promise.resolve(rows.map((r) => ({
      role: r.role,
      provider: r.provider,
      payload: JSON.parse(r.payload),
      log_path: r.log_path,
      ...(r.schema_validation == null ? {} : { schema_validation: JSON.parse(r.schema_validation) }),
    })));
  }

  deleteHandoffsByRole(taskId, role) {
    this._db.prepare("DELETE FROM handoffs WHERE task_id = ? AND role = ?").run(taskId, role);
    return Promise.resolve();
  }

  // ─── events (materialised stage_event projection) ────────────────────────────
  // The events table is a regenerable cache of getStageEvents(task): written
  // once per run at the engine seam via delete-then-insert, never dual-written.
  // All methods are best-effort — a failure logs and never propagates, so
  // observability can never break a run.

  replaceStageEvents(taskId, events) {
    const list = Array.isArray(events) ? events : [];
    try {
      this._db.exec("BEGIN");
      this._db.prepare("DELETE FROM events WHERE task_id = ?").run(taskId);
      const insert = this._db.prepare(
        "INSERT INTO events (task_id, seq, workflow_id, stage, model, tokens, duration_ms, status, artifacts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const now = new Date().toISOString();
      list.forEach((e, index) => {
        insert.run(
          taskId,
          index,
          typeof e?.workflow_id === "string" ? e.workflow_id : null,
          typeof e?.stage === "string" ? e.stage : null,
          typeof e?.model === "string" ? e.model : null,
          Number.isFinite(e?.tokens) ? e.tokens : null,
          Number.isFinite(e?.duration_ms) ? e.duration_ms : null,
          typeof e?.status === "string" ? e.status : null,
          JSON.stringify(e?.artifacts ?? []),
          now,
        );
      });
      this._db.exec("COMMIT");
    } catch (err) {
      try { this._db.exec("ROLLBACK"); } catch {}
      console.error(`replaceStageEvents failed for ${taskId}: ${err?.message ?? err}`);
    }
    return Promise.resolve();
  }

  getStageEventsForTask(taskId) {
    try {
      const rows = this._db.prepare(
        "SELECT seq, workflow_id, stage, model, tokens, duration_ms, status, artifacts, created_at FROM events WHERE task_id = ? ORDER BY seq ASC",
      ).all(taskId);
      return Promise.resolve(rows.map(_rowToStageEvent));
    } catch {
      return Promise.resolve([]);
    }
  }

  queryStageEvents({ stage, status, workflow_id, limit = 100 } = {}) {
    try {
      const where = [];
      const params = [];
      if (stage != null) { where.push("stage = ?"); params.push(stage); }
      if (status != null) { where.push("status = ?"); params.push(status); }
      if (workflow_id != null) { where.push("workflow_id = ?"); params.push(workflow_id); }
      const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
      const lim = Number.isFinite(limit) ? Math.min(1000, Math.max(1, Math.trunc(limit))) : 100;
      const rows = this._db.prepare(
        `SELECT task_id, seq, workflow_id, stage, model, tokens, duration_ms, status, artifacts, created_at FROM events ${clause} ORDER BY created_at DESC, id DESC LIMIT ?`,
      ).all(...params, lim);
      return Promise.resolve(rows.map((r) => ({ task_id: r.task_id, ..._rowToStageEvent(r) })));
    } catch {
      return Promise.resolve([]);
    }
  }

  // ─── raw DB handle (for ad-hoc queries) ──────────────────────────────────────
  // Note: LangGraph uses MemorySaver (in-process); resume is driven by stored
  // handoffs (getHandoffs) + priorHandoffs, not SQLite checkpoints.

  get db() { return this._db; }

  close() {
    try { this._db.close(); } catch {}
  }
}

// Singleton per dbPath — one connection per DB file.
const _instances = new Map();

/**
 * Open the task store. When DATABASE_URL is set to a postgres(ql):// URI,
 * returns a PostgresTaskStore (async init). Otherwise returns SqliteTaskStore.
 *
 * Returns a Promise so callers can `await openStore(...)` regardless of backend.
 */
export async function openStore(dbPath, { env = process.env } = {}) {
  const dbUrl = env.DATABASE_URL ?? "";
  if (dbUrl.startsWith("postgres://") || dbUrl.startsWith("postgresql://")) {
    return openPgStore(dbUrl);
  }
  const abs = path.resolve(dbPath);
  if (!_instances.has(abs)) _instances.set(abs, new SqliteTaskStore(abs));
  return _instances.get(abs);
}
