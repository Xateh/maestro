/**
 * PostgreSQL-backed task store — drop-in replacement for SqliteTaskStore.
 *
 * Activated when DATABASE_URL is set to a postgres:// or postgresql:// URI.
 * Schema mirrors SQLite: same tables, JSONB data column instead of TEXT.
 */

import pg from "pg";
const { Pool } = pg;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  status      TEXT NOT NULL DEFAULT 'queued',
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL,
  data        JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS handoffs (
  id          SERIAL PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  role        TEXT NOT NULL,
  provider    TEXT NOT NULL,
  payload     JSONB NOT NULL,
  log_path    TEXT,
  schema_validation JSONB,
  created_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS handoffs_task_id ON handoffs(task_id);
CREATE INDEX IF NOT EXISTS tasks_status     ON tasks(status);
CREATE INDEX IF NOT EXISTS tasks_created_at ON tasks(created_at);
`;

// Idempotent guarded migration for tables created before schema_validation was
// added. Postgres supports ADD COLUMN IF NOT EXISTS directly.
const MIGRATIONS = `
ALTER TABLE handoffs ADD COLUMN IF NOT EXISTS schema_validation JSONB;
`;

export class PostgresTaskStore {
  /** @type {import('pg').Pool} */
  _pool;

  constructor(connectionString) {
    this._pool = new Pool({ connectionString });
  }

  async _init() {
    await this._pool.query(SCHEMA);
    await this._pool.query(MIGRATIONS);
  }

  // ─── task CRUD ──────────────────────────────────────────────────────────────

  async createTask(taskObj) {
    const now = new Date().toISOString();
    const data = { ...taskObj, created_at: now, updated_at: now };
    await this._pool.query(
      "INSERT INTO tasks (id, status, created_at, updated_at, data) VALUES ($1, $2, $3, $4, $5)",
      [taskObj.id, taskObj.status ?? "queued", now, now, JSON.stringify(data)],
    );
    return data;
  }

  async getTask(id) {
    const { rows } = await this._pool.query("SELECT data FROM tasks WHERE id = $1", [id]);
    return rows[0] ? rows[0].data : null;
  }

  async updateTask(id, patchOrFn) {
    const current = await this.getTask(id);
    if (!current) throw new Error(`task_not_found: ${id}`);
    const now = new Date().toISOString();
    const patch = typeof patchOrFn === "function" ? patchOrFn(current) : patchOrFn;
    const updated = { ...current, ...patch, updated_at: now };
    await this._pool.query(
      "UPDATE tasks SET status = $1, updated_at = $2, data = $3 WHERE id = $4",
      [updated.status ?? current.status, now, JSON.stringify(updated), id],
    );
    return updated;
  }

  async listTasks({ limit = 50, status = null } = {}) {
    const { rows } = status
      ? await this._pool.query(
          "SELECT data FROM tasks WHERE status = $1 ORDER BY created_at DESC LIMIT $2",
          [status, limit],
        )
      : await this._pool.query(
          "SELECT data FROM tasks ORDER BY created_at DESC LIMIT $1",
          [limit],
        );
    return rows.map((r) => r.data);
  }

  // ─── step management ────────────────────────────────────────────────────────

  async appendStep(taskId, stepData) {
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

  // ─── handoffs ───────────────────────────────────────────────────────────────

  async addHandoff(taskId, { role, provider, payload, logPath, schemaValidation = null }) {
    const now = new Date().toISOString();
    await this._pool.query(
      "INSERT INTO handoffs (task_id, role, provider, payload, log_path, schema_validation, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [
        taskId,
        role,
        provider,
        JSON.stringify(payload ?? {}),
        logPath ?? null,
        schemaValidation == null ? null : JSON.stringify(schemaValidation),
        now,
      ],
    );
  }

  async getHandoffs(taskId) {
    const { rows } = await this._pool.query(
      "SELECT role, provider, payload, log_path, schema_validation FROM handoffs WHERE task_id = $1 ORDER BY id ASC",
      [taskId],
    );
    return rows.map((r) => ({
      role: r.role,
      provider: r.provider,
      payload: r.payload,
      log_path: r.log_path,
      ...(r.schema_validation == null ? {} : { schema_validation: r.schema_validation }),
    }));
  }

  async deleteHandoffsByRole(taskId, role) {
    await this._pool.query("DELETE FROM handoffs WHERE task_id = $1 AND role = $2", [taskId, role]);
  }

  async close() {
    try { await this._pool.end(); } catch {}
  }
}

const _pgInstances = new Map();

export async function openPgStore(connectionString) {
  if (!_pgInstances.has(connectionString)) {
    const store = new PostgresTaskStore(connectionString);
    await store._init();
    _pgInstances.set(connectionString, store);
  }
  return _pgInstances.get(connectionString);
}
