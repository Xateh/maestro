#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { openStore } from "../db/store.mjs";

// ── Root discovery ────────────────────────────────────────────────────────────

function findSymphonyRoot(startDir) {
  let dir = startDir;
  while (true) {
    if (existsSync(path.join(dir, ".symphony"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("No .symphony directory found from " + startDir);
    dir = parent;
  }
}

const ROOT = process.env.SYMPHONY_ROOT ?? findSymphonyRoot(process.cwd());
const SYMPHONY_DIR = path.join(ROOT, ".symphony");
const TASKS_DIR = path.join(SYMPHONY_DIR, "tasks");
const RUNS_DIR = path.join(SYMPHONY_DIR, "runs");
const DB_PATH = path.join(SYMPHONY_DIR, "symphony.db");

const VALID_MODES = new Set(["task", "plan-only"]);

// Open SQLite store only if the DB file exists (LangGraph engine was used)
function tryOpenStore() {
  if (existsSync(DB_PATH)) {
    try { return openStore(DB_PATH); } catch { return null; }
  }
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Validate that an MCP-supplied id cannot traverse outside its base directory.
 * Accepts only alphanumeric + [._-], no slashes or dots-at-start.
 */
function isValidId(id) {
  return typeof id === "string" && /^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(id);
}

/**
 * Assert that `child` is strictly inside `parent` after path resolution.
 * Rejects symlink-escape, `..`, and absolute overrides.
 */
function assertInsideDir(parent, child) {
  const rel = path.relative(parent, child);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path_traversal: ${child} escapes ${parent}`);
  }
}

async function readJSON(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function tailFile(filePath, maxBytes = 8192) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) return null;
  const fh = await fs.open(filePath, "r");
  try {
    const start = Math.max(0, stat.size - maxBytes);
    const buf = Buffer.alloc(Math.min(maxBytes, stat.size));
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    return buf.slice(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

async function listDir(dir) {
  return fs.readdir(dir).catch(() => []);
}

// ── Tool implementations ──────────────────────────────────────────────────────

async function listTasks({ limit = 20, status } = {}) {
  // DB path: use SQLite store if available
  const db = tryOpenStore();
  if (db) {
    const tasks = db.listTasks({ limit, status });
    return tasks.map((t) => ({
      id: t.id,
      prompt: t.prompt?.slice(0, 120),
      status: t.status,
      created_at: t.created_at,
      mode: t.mode,
      engine: "langgraph",
    }));
  }
  // Legacy path: read from JSON files
  const files = await listDir(TASKS_DIR);
  const tasks = await Promise.all(
    files.filter((f) => f.endsWith(".json")).map(async (f) => {
      const data = await readJSON(path.join(TASKS_DIR, f));
      return {
        id: data.id,
        prompt: data.prompt?.slice(0, 120),
        status: data.status,
        created_at: data.created_at,
        mode: data.mode,
      };
    })
  );
  const sorted = tasks.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return status ? sorted.filter((t) => t.status === status).slice(0, limit) : sorted.slice(0, limit);
}

async function showTask({ id } = {}) {
  if (!id) throw new Error("id required");
  if (!isValidId(id)) throw new Error(`invalid_id: ${id}`);
  // DB path: try SQLite first
  const db = tryOpenStore();
  if (db) {
    const task = db.getTask(id);
    if (task) {
      const handoffs = db.getHandoffs(id);
      const runDir = task.run_dir ?? path.join(RUNS_DIR, id);
      assertInsideDir(RUNS_DIR, runDir);
      const logs = {};
      const files = await listDir(runDir);
      for (const f of files) {
        if (f.endsWith(".stdout.log")) {
          logs[f.replace(".stdout.log", "")] = await tailFile(path.join(runDir, f));
        }
      }
      return { task, handoffs, logs, engine: "langgraph" };
    }
  }
  // Legacy path: read from JSON files
  const taskPath = path.join(TASKS_DIR, `${id}.json`);
  assertInsideDir(TASKS_DIR, taskPath);
  const task = await readJSON(taskPath);
  const runDir = path.join(RUNS_DIR, id);
  assertInsideDir(RUNS_DIR, runDir);
  const files = await listDir(runDir);
  const handoffs = {};
  const logs = {};
  for (const f of files) {
    if (f.startsWith("handoff.") && f.endsWith(".json")) {
      const role = f.replace(/^handoff\.|\.json$/g, "");
      handoffs[role] = await readJSON(path.join(runDir, f)).catch(() => null);
    }
    if (f.endsWith(".stdout.log")) {
      const key = f.replace(".stdout.log", "");
      logs[key] = await tailFile(path.join(runDir, f));
    }
  }
  return { task, handoffs, logs };
}

async function listRuns({ limit = 20 } = {}) {
  const entries = await listDir(RUNS_DIR);
  const runs = await Promise.all(
    entries.map(async (name) => {
      const stat = await fs.stat(path.join(RUNS_DIR, name)).catch(() => null);
      return stat ? { name, mtime: stat.mtime.toISOString() } : null;
    })
  );
  return runs
    .filter(Boolean)
    .sort((a, b) => b.mtime.localeCompare(a.mtime))
    .slice(0, limit);
}

async function showRun({ id } = {}) {
  if (!id) throw new Error("id required");
  if (!isValidId(id)) throw new Error(`invalid_id: ${id}`);
  const runDir = path.join(RUNS_DIR, id);
  assertInsideDir(RUNS_DIR, runDir);
  const files = await listDir(runDir);
  const result = { id, files: {} };
  for (const f of files) {
    const full = path.join(runDir, f);
    if (f.endsWith(".json")) {
      result.files[f] = await readJSON(full).catch(() => null);
    } else if (f.endsWith(".log")) {
      result.files[f] = await tailFile(full);
    }
  }
  return result;
}

async function createTask({ prompt, mode = "task" } = {}) {
  if (!prompt) throw new Error("prompt required");
  if (!VALID_MODES.has(mode)) throw new Error(`invalid_mode: ${mode}`);
  return new Promise((resolve, reject) => {
    // Invoke the bundled bin directly so this package is self-contained
    // (no npm run symphony shim required in the caller's directory).
    const binPath = fileURLToPath(new URL("../../bin/symphony.mjs", import.meta.url));
    // "--" ends option parsing so a prompt like "--timeout-ms 1 do X" is never
    // interpreted as CLI flags by the spawned process.
    // SYMPHONY_CALLER_CWD aligns the child's state-dir with ROOT so MCP readers
    // see the same tasks the server does (critical when installed as a dependency).
    const proc = spawn(
      process.execPath,
      [binPath, mode, "--", prompt],
      { cwd: ROOT, env: { ...process.env, SYMPHONY_CALLER_CWD: ROOT }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", () => {}); // discard
    proc.on("close", (code) => {
      const idMatch = stdout.match(/task[:\s]+([0-9]{8}-[0-9]{6}-\S+)/i) ?? stdout.match(/([0-9]{8}-[0-9]{6}-\S+)/);
      const taskId = idMatch?.[1] ?? null;
      resolve({ exitCode: code, taskId, stdout: stdout.slice(0, 2000) });
    });
    proc.on("error", reject);
  });
}

// Redact sensitive leaves (api keys, tokens, secrets) before exposing config to MCP clients.
function redactConfig(cfg) {
  if (!cfg || typeof cfg !== "object") return cfg;
  const SENSITIVE = /(_key|_token|_secret|api_key|apikey|password|passwd)$/i;
  return JSON.parse(JSON.stringify(cfg, (key, value) => {
    if (key && SENSITIVE.test(key) && typeof value === "string" && value.length > 0) {
      return "[redacted]";
    }
    return value;
  }));
}

async function getState() {
  // Try HTTP first (tracker-orchestrator mode)
  const configPath = path.join(SYMPHONY_DIR, "config.json");
  const config = await readJSON(configPath).catch(() => null);
  const port = config?.http_port ?? config?.port;
  if (port) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      const res = await fetch(`http://localhost:${port}/api/v1/state`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) return { source: "http", state: await res.json() };
    } catch { /* fall through */ }
  }
  // Fallback: return config + workflow + live task state from SQLite (task mode)
  const workflow = await readJSON(path.join(SYMPHONY_DIR, "workflow.json")).catch(() => null);
  let liveTasks = null;
  const db = tryOpenStore();
  if (db) {
    const running = db.listTasks({ limit: 10, status: "running" });
    const recent = db.listTasks({ limit: 5 });
    liveTasks = {
      running: running.map((t) => ({
        id: t.id,
        status: t.status,
        current_state: t.current_state ?? null,
        active_step: t.active_step ?? null,
        prompt: t.prompt?.slice(0, 120),
        updated_at: t.updated_at,
      })),
      recent: recent.map((t) => ({
        id: t.id,
        status: t.status,
        prompt: t.prompt?.slice(0, 120),
        updated_at: t.updated_at,
      })),
    };
  }
  return { source: "files", config: redactConfig(config), workflow, live_tasks: liveTasks };
}

async function readWorkflow() {
  const workflowPath = path.join(SYMPHONY_DIR, "workflow.json");
  const workflow = await readJSON(workflowPath).catch(() => null);
  const wfMdPath = path.join(ROOT, "WORKFLOW.md");
  const wfMd = await fs.readFile(wfMdPath, "utf8").catch(() => null);
  return { workflow_json: workflow, workflow_md: wfMd };
}

// ── MCP server wiring ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "symphony_list_tasks",
    description: "List Symphony tasks. Optionally filter by status (queued/running/waiting_user/succeeded/failed/blocked/cancelled/denied/expired/open/pending/reviewed/system). Returns up to `limit` tasks sorted newest-first.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max tasks to return (default 20)" },
        status: { type: "string", description: "Filter by status" },
      },
    },
  },
  {
    name: "symphony_show_task",
    description: "Show full details for one Symphony task: task JSON, per-role handoffs, and stdout log tails.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Task ID (e.g. 20260513-133611-...)" } },
      required: ["id"],
    },
  },
  {
    name: "symphony_list_runs",
    description: "List recent Symphony run directories sorted by last-modified, newest first.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Max runs to return (default 20)" } },
    },
  },
  {
    name: "symphony_show_run",
    description: "Show all files in one Symphony run: command JSON, handoffs, and stdout/stderr log tails.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Run directory name / task ID" } },
      required: ["id"],
    },
  },
  {
    name: "symphony_create_task",
    description: "Create and start a new Symphony task by prompt. Returns the task ID if parseable from output.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The task prompt" },
        mode: { type: "string", description: "'task' (default) or 'plan-only'" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "symphony_get_state",
    description: "Get Symphony runtime state. Tries the HTTP status endpoint first, falls back to reading config.json + workflow.json.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "symphony_read_workflow",
    description: "Return the current .symphony/workflow.json and WORKFLOW.md template (if present).",
    inputSchema: { type: "object", properties: {} },
  },
];

const HANDLERS = {
  symphony_list_tasks: listTasks,
  symphony_show_task: showTask,
  symphony_list_runs: listRuns,
  symphony_show_run: showRun,
  symphony_create_task: createTask,
  symphony_get_state: getState,
  symphony_read_workflow: readWorkflow,
};

const server = new Server(
  { name: "symphony", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  const result = await handler(args ?? {});
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

// Export helpers for testing without starting the server.
export { isValidId, assertInsideDir, redactConfig, VALID_MODES, createTask, getState, showTask, showRun, listTasks };

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
