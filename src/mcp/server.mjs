#!/usr/bin/env node
import "../suppress-sqlite-warning.mjs";
import "../telemetry.mjs";
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

function findMaestroRoot(startDir) {
  let dir = startDir;
  while (true) {
    if (existsSync(path.join(dir, ".maestro"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`No .maestro directory found from ${startDir}`);
    dir = parent;
  }
}

// Resolved lazily (and cached) so importing this module never throws — root
// discovery errors surface on the first tool call with a clear message
// instead of crashing the host process at import time.
let _paths = null;
function maestroPaths() {
  if (!_paths) {
    const ROOT = process.env.MAESTRO_ROOT ?? findMaestroRoot(process.cwd());
    const MAESTRO_DIR = path.join(ROOT, ".maestro");
    _paths = {
      ROOT,
      MAESTRO_DIR,
      TASKS_DIR: path.join(MAESTRO_DIR, "tasks"),
      RUNS_DIR: path.join(MAESTRO_DIR, "runs"),
      DB_PATH: path.join(MAESTRO_DIR, "maestro.db"),
    };
  }
  return _paths;
}

// Modes always accepted; workflow.json may define additional custom modes
// (e.g. imported standalone roles) which are validated at call time.
const VALID_MODES = new Set(["task", "plan-only"]);
const MODE_NAME_RE = /^[a-z0-9_-]+$/;
// Validate the workflow name *shape* here (like mode); existence is deferred to
// the spawned CLI, which raises unknown_workflow. Keeps the MCP server off disk.
const WORKFLOW_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// Build the argv for the spawned `maestro task ...` child. Pure so it can be
// unit-tested without spawning. "--" ends option parsing so prompts that look
// like flags are never interpreted by the child.
function buildTaskArgv(binPath, { mode, workflow, prompt }) {
  return [binPath, "task", "--mode", mode, "--workflow", workflow, "--", prompt];
}

async function resolveValidModes() {
  const modes = new Set(VALID_MODES);
  let workflow = null;
  try {
    const { MAESTRO_DIR } = maestroPaths();
    workflow = await readJSON(path.join(MAESTRO_DIR, "workflow.json")).catch(() => null);
  } catch {
    // no .maestro root discoverable — base modes only
  }
  for (const name of Object.keys(workflow?.modes ?? {})) {
    if (MODE_NAME_RE.test(name)) modes.add(name);
  }
  return modes;
}

// Open store only if the DB file exists (LangGraph engine was used) or DATABASE_URL is set
async function tryOpenStore() {
  const { DB_PATH } = maestroPaths();
  const hasDbUrl = process.env.DATABASE_URL?.startsWith("postgres");
  if (!hasDbUrl && !existsSync(DB_PATH)) return null;
  try { return await openStore(DB_PATH); } catch { return null; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Validate that an MCP-supplied id cannot traverse outside its base directory.
 * Accepts only alphanumeric + [._-], no slashes or dots-at-start.
 */
// Length-bounded so an oversized id can't be used to build huge paths or
// stress downstream lookups.
function isValidId(id) {
  return typeof id === "string" && /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/.test(id);
}

const MAX_PROMPT_BYTES = 100_000;

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
  // Clamp limit to a sane window; reject a malformed status filter early.
  limit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.trunc(limit))) : 20;
  if (status !== undefined && (typeof status !== "string" || status.length > 64)) {
    throw new Error("invalid_status");
  }
  const { TASKS_DIR } = maestroPaths();
  // DB path: use store if available (SQLite or PG)
  const db = await tryOpenStore();
  if (db) {
    const tasks = await db.listTasks({ limit, status });
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
  const { TASKS_DIR, RUNS_DIR } = maestroPaths();
  // DB path: try store first (SQLite or PG)
  const db = await tryOpenStore();
  if (db) {
    const task = await db.getTask(id);
    if (task) {
      const handoffs = await db.getHandoffs(id);
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
  const { RUNS_DIR } = maestroPaths();
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
  const { RUNS_DIR } = maestroPaths();
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

async function createTask({ prompt, mode = "task", workflow = "default" } = {}) {
  if (typeof prompt !== "string" || prompt.length === 0) throw new Error("prompt required");
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) throw new Error("prompt_too_large");
  if (!MODE_NAME_RE.test(mode) || !(await resolveValidModes()).has(mode)) {
    throw new Error(`invalid_mode: ${mode}`);
  }
  if (!WORKFLOW_NAME_RE.test(workflow)) {
    throw new Error(`invalid_workflow: ${workflow}`);
  }
  const { ROOT } = maestroPaths();
  return new Promise((resolve, reject) => {
    // Invoke the bundled bin directly so this package is self-contained
    // (no npm run maestro shim required in the caller's directory).
    const binPath = fileURLToPath(new URL("../../bin/maestro.mjs", import.meta.url));
    // MAESTRO_CALLER_CWD aligns the child's state-dir with ROOT so MCP readers
    // see the same tasks the server does (critical when installed as a dependency).
    const proc = spawn(
      process.execPath,
      buildTaskArgv(binPath, { mode, workflow, prompt }),
      { cwd: ROOT, env: { ...process.env, MAESTRO_CALLER_CWD: ROOT }, stdio: ["ignore", "pipe", "pipe"] },
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
  const { MAESTRO_DIR } = maestroPaths();
  // Try HTTP first (tracker-orchestrator mode)
  const configPath = path.join(MAESTRO_DIR, "config.json");
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
  const workflow = await readJSON(path.join(MAESTRO_DIR, "workflow.json")).catch(() => null);
  let liveTasks = null;
  const db = await tryOpenStore();
  if (db) {
    const running = await db.listTasks({ limit: 10, status: "running" });
    const recent = await db.listTasks({ limit: 5 });
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
  const { MAESTRO_DIR, ROOT } = maestroPaths();
  const workflowPath = path.join(MAESTRO_DIR, "workflow.json");
  const workflow = await readJSON(workflowPath).catch(() => null);
  // WORKFLOW.md lives in .maestro/; fall back to the legacy repo-root location.
  const wfMd = await fs.readFile(path.join(MAESTRO_DIR, "WORKFLOW.md"), "utf8").catch(() => null)
    ?? await fs.readFile(path.join(ROOT, "WORKFLOW.md"), "utf8").catch(() => null);
  return { workflow_json: workflow, workflow_md: wfMd };
}

async function validateWorkflowTool() {
  let MAESTRO_DIR;
  try {
    ({ MAESTRO_DIR } = maestroPaths());
  } catch (error) {
    return { ok: false, errors: [{ code: "missing_workflow", message: error.message }], warnings: [] };
  }
  const workflow = await readJSON(path.join(MAESTRO_DIR, "workflow.json")).catch(() => null);
  if (!workflow) return { ok: false, errors: [{ code: "missing_workflow", message: "no readable .maestro/workflow.json" }], warnings: [] };
  const config = await readJSON(path.join(MAESTRO_DIR, "config.json")).catch(() => null);
  const { validateWorkflow } = await import("../workflow-validate.mjs");
  return validateWorkflow(workflow, { config });
}

// ── MCP server wiring ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "maestro_list_tasks",
    description: "List Maestro tasks. Optionally filter by status (queued/running/waiting_user/succeeded/failed/blocked/cancelled/denied/expired/open/pending/reviewed/system). Returns up to `limit` tasks sorted newest-first.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max tasks to return (default 20)" },
        status: { type: "string", description: "Filter by status" },
      },
    },
  },
  {
    name: "maestro_show_task",
    description: "Show full details for one Maestro task: task JSON, per-role handoffs, and stdout log tails.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Task ID (e.g. 20260513-133611-...)" } },
      required: ["id"],
    },
  },
  {
    name: "maestro_list_runs",
    description: "List recent Maestro run directories sorted by last-modified, newest first.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Max runs to return (default 20)" } },
    },
  },
  {
    name: "maestro_show_run",
    description: "Show all files in one Maestro run: command JSON, handoffs, and stdout/stderr log tails.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Run directory name / task ID" } },
      required: ["id"],
    },
  },
  {
    name: "maestro_create_task",
    description: "Create and start a new Maestro task by prompt. Returns the task ID if parseable from output.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The task prompt" },
        mode: { type: "string", description: "'task' (default) or 'plan-only'" },
        workflow: { type: "string", description: "Named workflow to run (default: 'default'). Must match ^[a-z0-9][a-z0-9_-]{0,63}$." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "maestro_get_state",
    description: "Get Maestro runtime state. Tries the HTTP status endpoint first, falls back to reading config.json + workflow.json.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "maestro_read_workflow",
    description: "Return the current .maestro/workflow.json and WORKFLOW.md template (if present).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "maestro_validate_workflow",
    description: "Validate .maestro/workflow.json: structural errors (bad initial/transitions/modes) and warnings (unreachable roles, unknown providers, cycles without termination clauses). Returns {ok, errors, warnings}.",
    inputSchema: { type: "object", properties: {} },
  },
];

const HANDLERS = {
  maestro_list_tasks: listTasks,
  maestro_show_task: showTask,
  maestro_list_runs: listRuns,
  maestro_show_run: showRun,
  maestro_create_task: createTask,
  maestro_get_state: getState,
  maestro_read_workflow: readWorkflow,
  maestro_validate_workflow: validateWorkflowTool,
};

const server = new Server(
  { name: "maestro", version: "1.0.0" },
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
export { isValidId, assertInsideDir, redactConfig, VALID_MODES, WORKFLOW_NAME_RE, buildTaskArgv, resolveValidModes, createTask, getState, showTask, showRun, listTasks, validateWorkflowTool };

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
