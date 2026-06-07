/**
 * SQLite-backed task store for the LangGraph engine.
 *
 * Replaces scattered .symphony/tasks/*.json files with a single DB at
 * .symphony/symphony.db. Large log blobs stay on disk; DB stores paths.
 *
 * Uses node:sqlite (DatabaseSync, synchronous) — operations are tiny
 * metadata reads/writes so blocking is acceptable.
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

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

CREATE INDEX IF NOT EXISTS handoffs_task_id ON handoffs(task_id);
CREATE INDEX IF NOT EXISTS tasks_status     ON tasks(status);
CREATE INDEX IF NOT EXISTS tasks_created_at ON tasks(created_at);
`;

export class SqliteTaskStore {
  /** @type {DatabaseSync} */
  _db;

  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this._db = new DatabaseSync(dbPath);
    this._db.exec(SCHEMA);
  }

  // ─── task CRUD ─────────────────────────────────────────────────────────────

  createTask(taskObj) {
    const now = new Date().toISOString();
    const data = { ...taskObj, created_at: now, updated_at: now };
    this._db.prepare(
      "INSERT INTO tasks (id, status, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?)",
    ).run(taskObj.id, taskObj.status ?? "queued", now, now, JSON.stringify(data));
    return data;
  }

  getTask(id) {
    const row = this._db.prepare("SELECT data FROM tasks WHERE id = ?").get(id);
    return row ? JSON.parse(row.data) : null;
  }

  /**
   * Update task. patchOrFn is either a plain patch object or a function
   * (current) => patchObject. Returns the updated task.
   */
  updateTask(id, patchOrFn) {
    const current = this.getTask(id);
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
    return rows.map((r) => JSON.parse(r.data));
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

  addHandoff(taskId, { role, provider, payload, logPath }) {
    const now = new Date().toISOString();
    this._db.prepare(
      "INSERT INTO handoffs (task_id, role, provider, payload, log_path, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(taskId, role, provider, JSON.stringify(payload ?? {}), logPath ?? null, now);
  }

  getHandoffs(taskId) {
    const rows = this._db.prepare(
      "SELECT role, provider, payload, log_path FROM handoffs WHERE task_id = ? ORDER BY id ASC",
    ).all(taskId);
    return rows.map((r) => ({
      role: r.role,
      provider: r.provider,
      payload: JSON.parse(r.payload),
      log_path: r.log_path,
    }));
  }

  deleteHandoffsByRole(taskId, role) {
    this._db.prepare("DELETE FROM handoffs WHERE task_id = ? AND role = ?").run(taskId, role);
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

export function openStore(dbPath) {
  const abs = path.resolve(dbPath);
  if (!_instances.has(abs)) _instances.set(abs, new SqliteTaskStore(abs));
  return _instances.get(abs);
}
