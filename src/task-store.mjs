import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_LOCAL_STATE_DIR = ".maestro";

export const DEFAULT_PROVIDERS = {
  claude: {
    label: "Claude",
    adapter: "built-in:claude",
    default_alias: "claude",
    aliases: ["claude"],
    models: ["opus", "sonnet", "haiku"],
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  codex: {
    label: "Codex",
    adapter: "built-in:codex",
    default_alias: "codex",
    aliases: ["codex"],
    models: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"],
    efforts: ["minimal", "low", "medium", "high", "xhigh"],
  },
  copilot: {
    label: "Copilot",
    adapter: "built-in:copilot",
    default_alias: "copilot",
    aliases: ["copilot"],
    models: [],
    efforts: [],
  },
  gemini: {
    label: "Gemini",
    adapter: "built-in:gemini",
    default_alias: "gemini",
    aliases: ["gemini"],
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
    efforts: [],
  },
  antigravity: {
    label: "Antigravity",
    adapter: "built-in:antigravity",
    default_alias: "antigravity",
    aliases: ["antigravity"],
    models: ["antigravity-pro", "antigravity-flash"],
    efforts: ["low", "medium", "high"],
  },
  ollama: {
    label: "Ollama (local)",
    adapter: "built-in:ollama",
    default_alias: "ollama",
    aliases: ["ollama"],
    models: ["llama3.2", "qwen3", "llama3.2-vision"],
    efforts: [],
  },
};

export const DEFAULT_WORKFLOW = {
  version: 1,
  initial: "planner",
  roles: {
    planner: {
      label: "Planner",
      provider: "claude",
      alias: "claude",
      model: "",
      effort: "",
      permission: "plan",
      prompt_template: "planner",
      skip: "auto",
    },
    executor: {
      label: "Executor",
      provider: "codex",
      alias: "codex",
      model: "",
      effort: "",
      permission: "write",
      prompt_template: "executor",
      skip: "never",
    },
    reviewer: {
      label: "Reviewer",
      provider: "codex",
      alias: "codex",
      model: "",
      effort: "",
      permission: "read",
      prompt_template: "reviewer",
      skip: "auto",
    },
  },
  transitions: {
    planner: { done: "executor", question: "$ask_user", error: "$halt" },
    executor: { done: "reviewer", question: "$ask_user", pause: "$pause", waiting: "$wait", error: "$halt" },
    reviewer: { done: "$complete", question: "$ask_user", error: "$halt" },
  },
  modes: {
    task: { initial: "planner", skip_when_planner_off: "executor" },
    "plan-only": { initial: "planner", terminal_after: ["planner"] },
  },
};

export const DEFAULT_LOCAL_CONFIG_V2 = {
  version: 2,
  cwd: process.cwd(),
  planner_policy: "auto",
  review_enabled: true,
  timeout_ms: 3_600_000,
  worktree_root: ".maestro/worktrees",
  worktree_mode_default: "auto",
  max_parallel_worktrees: 4,
  stream_tail_bytes: 65_536,
  context_retry_limit: 1,
  stale_after_ms: 300_000,
  project_close_merge_mode: "squash",
  delete_closed_project_branches: true,
  local_file_sync_profiles: [],
  max_steps: 20,
  default_role: "executor",
  providers: DEFAULT_PROVIDERS,
  herdr: {
    close_tab_on: "success", // "success" | "terminal" | "never"
  },
  headroom: {
    mode: "light",           // "light" | "heavy"
    extras_light: "proxy,mcp,code",
    extras_heavy: "all",
    proxy_port: 8787,
    swap_gb: 0,              // target TOTAL swap in GiB; 0 = never touch swap
  },
  recent: {
    providers_by_role: {},
    aliases_by_provider: {},
    models_by_provider: {},
    efforts_by_provider: {},
  },
};


function nowIso(clock) {
  return clock().toISOString();
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tempPath, filePath);
}

export function slugifyTaskTitle(value) {
  const slug = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72)
    .replace(/-+$/g, "");
  return slug || "task";
}

export function createTaskId({ prompt, clock = () => new Date() } = {}) {
  const stamp = clock()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "")
    .replace("T", "-");
  return `${stamp}-${slugifyTaskTitle(prompt)}`;
}

// Synthesize legacy flat keys from v2 config + workflow for backward compat.
function shimLegacyKeys(config, workflow) {
  const planner = workflow?.roles?.planner ?? {};
  const executor = workflow?.roles?.executor ?? {};
  const reviewer = workflow?.roles?.reviewer ?? {};
  const claudeDef = config.providers?.claude ?? {};
  const codexDef = config.providers?.codex ?? {};
  const antigravityDef = config.providers?.antigravity ?? {};
  return {
    ...config,
    claude_command: planner.alias || claudeDef.default_alias || "claude",
    codex_command: executor.alias || codexDef.default_alias || "codex",
    antigravity_command: antigravityDef.default_alias || "antigravity",
    planner_model: planner.model || "",
    claude_effort: planner.effort || "",
    executor_model: executor.model || "",
    executor_effort: executor.effort || "",
    reviewer_model: reviewer.model || "",
    reviewer_effort: reviewer.effort || "",
  };
}

// Build v2 config + workflow from a v1 config object.
function buildMigratedV2(v1) {
  const claudeAlias = String(v1.claude_command || "claude").trim();
  const codexAlias = String(v1.codex_command || "codex").trim();
  const antigravityAlias = String(v1.antigravity_command || "antigravity").trim();

  const claudeAliases = [...new Set([claudeAlias, ...DEFAULT_PROVIDERS.claude.aliases])];
  const codexAliases = [...new Set([codexAlias, ...DEFAULT_PROVIDERS.codex.aliases])];
  const antigravityAliases = [...new Set([antigravityAlias, ...DEFAULT_PROVIDERS.antigravity.aliases])];

  const providers = {
    ...structuredClone(DEFAULT_PROVIDERS),
    claude: { ...DEFAULT_PROVIDERS.claude, default_alias: claudeAlias, aliases: claudeAliases },
    codex: { ...DEFAULT_PROVIDERS.codex, default_alias: codexAlias, aliases: codexAliases },
    antigravity: { ...DEFAULT_PROVIDERS.antigravity, default_alias: antigravityAlias, aliases: antigravityAliases },
  };

  const plannerModel = String(v1.planner_model || "").trim();
  const claudeEffort = String(v1.claude_effort || "").trim();
  const executorModel = String(v1.executor_model || "").trim();
  const executorEffort = String(v1.executor_effort || "").trim();
  const reviewerModel = String(v1.reviewer_model || "").trim();
  const reviewerEffort = String(v1.reviewer_effort || "").trim();

  const recentModelsClaudeRaw = [plannerModel].filter(Boolean);
  const recentModelsCodexRaw = [...new Set([executorModel, reviewerModel].filter(Boolean))];
  const recentEffortsClaudeRaw = [claudeEffort].filter(Boolean);
  const recentEffortsCodexRaw = [...new Set([executorEffort, reviewerEffort].filter(Boolean))];

  const recent = {
    providers_by_role: { planner: ["claude"], executor: ["codex"], reviewer: ["codex"] },
    aliases_by_provider: { claude: [claudeAlias], codex: [codexAlias] },
    models_by_provider: {},
    efforts_by_provider: {},
  };
  if (recentModelsClaudeRaw.length > 0) recent.models_by_provider.claude = recentModelsClaudeRaw;
  if (recentModelsCodexRaw.length > 0) recent.models_by_provider.codex = recentModelsCodexRaw;
  if (recentEffortsClaudeRaw.length > 0) recent.efforts_by_provider.claude = recentEffortsClaudeRaw;
  if (recentEffortsCodexRaw.length > 0) recent.efforts_by_provider.codex = recentEffortsCodexRaw;

  const CARRY_KEYS = [
    "cwd", "planner_policy", "review_enabled", "timeout_ms", "worktree_root",
    "worktree_mode_default", "max_parallel_worktrees", "stream_tail_bytes",
    "context_retry_limit", "stale_after_ms", "project_close_merge_mode",
    "delete_closed_project_branches", "local_file_sync_profiles",
  ];
  const carried = {};
  for (const key of CARRY_KEYS) {
    if (key in v1) carried[key] = v1[key];
  }

  const v2 = { ...DEFAULT_LOCAL_CONFIG_V2, ...carried, version: 2, providers, recent };

  const workflow = {
    ...structuredClone(DEFAULT_WORKFLOW),
    roles: {
      planner: { ...DEFAULT_WORKFLOW.roles.planner, alias: claudeAlias, model: plannerModel, effort: claudeEffort },
      executor: { ...DEFAULT_WORKFLOW.roles.executor, alias: codexAlias, model: executorModel, effort: executorEffort },
      reviewer: { ...DEFAULT_WORKFLOW.roles.reviewer, alias: codexAlias, model: reviewerModel, effort: reviewerEffort },
    },
  };

  return { v2, workflow };
}

export class LocalTaskStore {
  constructor({ root = DEFAULT_LOCAL_STATE_DIR, clock = () => new Date() } = {}) {
    this.root = path.resolve(root);
    this.clock = clock;
    this._cachedConfig = null;
    this._cachedWorkflow = null;
    // Serializes concurrent updateTask calls per task id within this process.
    // Mitigates lost-update races between CLI/TUI commands sharing a process.
    // Cross-process races (detached children) are mitigated by SQLite being
    // the execution source of truth for engine-written fields.
    this._updateLocks = new Map();
  }

  get tasksDir() {
    return path.join(this.root, "tasks");
  }

  get runsDir() {
    return path.join(this.root, "runs");
  }

  get projectsDir() {
    return path.join(this.root, "projects");
  }

  get patchesDir() {
    return path.join(this.root, "patches");
  }

  get configPath() {
    return path.join(this.root, "config.json");
  }

  get workflowPath() {
    return path.join(this.root, "workflow.json");
  }

  get migrationLockPath() {
    return path.join(this.root, ".migrating.lock");
  }

  taskPath(id) {
    return path.join(this.tasksDir, `${id}.json`);
  }

  projectPath(id) {
    return path.join(this.projectsDir, `${id}.json`);
  }

  runDir(id) {
    return path.join(this.runsDir, id);
  }

  async init() {
    await fs.mkdir(this.tasksDir, { recursive: true });
    await fs.mkdir(this.runsDir, { recursive: true });
    await fs.mkdir(this.projectsDir, { recursive: true });
    await fs.mkdir(this.patchesDir, { recursive: true });
  }

  async _migrateIfNeeded(parsed) {
    // Acquire lock (best-effort — rename is atomic on POSIX)
    const lockPath = this.migrationLockPath;
    try {
      await fs.writeFile(lockPath, String(process.pid), { flag: "wx" });
    } catch (error) {
      if (error.code === "EEXIST") return null; // Another process is migrating
      throw error;
    }

    try {
      const { v2, workflow } = buildMigratedV2(parsed);

      // Back up old config
      const backupPath = path.join(this.root, "config.v1.bak.json");
      if (!(await pathExists(backupPath))) {
        await writeJsonAtomic(backupPath, parsed);
      }

      await writeJsonAtomic(this.configPath, v2);
      if (!(await pathExists(this.workflowPath))) {
        await writeJsonAtomic(this.workflowPath, workflow);
      }

      return { v2, workflow };
    } finally {
      await fs.unlink(lockPath).catch(() => {});
    }
  }

  async createTask({
    prompt,
    mode = "task",
    cwd = null,
    plannerPolicy = "auto",
    plannerDecision = null,
    plannerReason = null,
    reviewEnabled = true,
    timeoutMs = 3_600_000,
    streamTailBytes = 65_536,
    contextRetryLimit = 1,
    claudeCommand = "claude",
    codexCommand = "codex",
    plannerModel = "",
    claudeEffort = "",
    executorModel = "",
    executorEffort = "",
    reviewerModel = "",
    reviewerEffort = "",
    projectId = null,
    worktreeMode = "current-cwd",
    branch = null,
    worktreePath = null,
    writePaths = [],
    pathConflict = null,
  }) {
    await this.init();
    const baseId = createTaskId({ prompt, clock: this.clock });
    let id = baseId;
    let suffix = 2;
    while (await pathExists(this.taskPath(id))) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    const createdAt = nowIso(this.clock);
    const task = {
      id,
      prompt,
      mode,
      status: "queued",
      cwd,
      planner_policy: plannerPolicy,
      planner_decision: plannerDecision,
      planner_reason: plannerReason,
      review_enabled: reviewEnabled,
      timeout_ms: timeoutMs,
      stream_tail_bytes: streamTailBytes,
      context_retry_limit: contextRetryLimit,
      claude_command: claudeCommand,
      codex_command: codexCommand,
      planner_model: plannerModel,
      claude_effort: claudeEffort,
      executor_model: executorModel,
      executor_effort: executorEffort,
      reviewer_model: reviewerModel,
      reviewer_effort: reviewerEffort,
      project_id: projectId,
      worktree_mode: worktreeMode,
      branch,
      worktree_path: worktreePath,
      write_paths: writePaths,
      path_conflict: pathConflict,
      start_head: null,
      created_at: createdAt,
      updated_at: createdAt,
      run_dir: this.runDir(id),
      active_step: null,
      active_question: null,
      question_answers: [],
      interactions: [],
      unblock_options: [],
      action_requests: [],
      continuation_generation: 0,
      steps: [],
    };
    await fs.mkdir(task.run_dir, { recursive: true });
    await this.writeTask(task);
    return task;
  }

  async createProject(project) {
    await this.init();
    if (await pathExists(this.projectPath(project.id))) {
      throw new Error(`project_exists: ${project.id}`);
    }
    return this.writeProject(project);
  }

  async readConfig() {
    await this.init();

    let parsed = null;
    try {
      const text = await fs.readFile(this.configPath, "utf8");
      parsed = JSON.parse(text);
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }

    // Migrate v1 → v2 (one-shot)
    if (parsed !== null && !parsed.version) {
      const migrated = await this._migrateIfNeeded(parsed);
      if (migrated) {
        this._cachedConfig = migrated.v2;
        this._cachedWorkflow = migrated.workflow;
      }
      // Re-read after migration (another process may have done it)
      try {
        const text = await fs.readFile(this.configPath, "utf8");
        parsed = JSON.parse(text);
      } catch {
        // Fall through to defaults
      }
    }

    const base = {
      ...DEFAULT_LOCAL_CONFIG_V2,
      cwd: path.dirname(this.root),
    };

    if (parsed !== null && parsed.version === 2) {
      const config = { ...base, ...parsed };
      const workflow = await this.readWorkflow();
      return shimLegacyKeys(config, workflow);
    }

    // No config file or unreadable — return defaults with legacy shim
    return shimLegacyKeys(base, DEFAULT_WORKFLOW);
  }

  async readWorkflow() {
    try {
      const text = await fs.readFile(this.workflowPath, "utf8");
      const parsed = JSON.parse(text);
      return { ...DEFAULT_WORKFLOW, ...parsed };
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      return structuredClone(DEFAULT_WORKFLOW);
    }
  }

  async writeWorkflow(workflow) {
    await this.init();
    const next = { ...await this.readWorkflow(), ...workflow };
    await writeJsonAtomic(this.workflowPath, next);
    this._cachedWorkflow = next;
    return next;
  }

  async writeConfig(config) {
    await this.init();
    const current = await this.readConfig();
    const workflow = await this.readWorkflow();

    // Handle legacy key writes by updating the workflow roles
    const workflowPatch = {};
    if (config.claude_command !== undefined || config.codex_command !== undefined
      || config.antigravity_command !== undefined
      || config.planner_model !== undefined || config.claude_effort !== undefined
      || config.executor_model !== undefined || config.executor_effort !== undefined
      || config.reviewer_model !== undefined || config.reviewer_effort !== undefined) {
      const roles = { ...workflow.roles };
      if (config.claude_command !== undefined) {
        roles.planner = { ...roles.planner, alias: String(config.claude_command) };
      }
      if (config.codex_command !== undefined) {
        roles.executor = { ...roles.executor, alias: String(config.codex_command) };
        roles.reviewer = { ...roles.reviewer, alias: String(config.codex_command) };
      }
      if (config.antigravity_command !== undefined) {
        for (const [roleName, roleDef] of Object.entries(roles)) {
          if (roleDef.provider === "antigravity") {
            roles[roleName] = { ...roleDef, alias: String(config.antigravity_command) };
          }
        }
      }
      if (config.planner_model !== undefined) roles.planner = { ...roles.planner, model: String(config.planner_model) };
      if (config.claude_effort !== undefined) roles.planner = { ...roles.planner, effort: String(config.claude_effort) };
      if (config.executor_model !== undefined) roles.executor = { ...roles.executor, model: String(config.executor_model) };
      if (config.executor_effort !== undefined) roles.executor = { ...roles.executor, effort: String(config.executor_effort) };
      if (config.reviewer_model !== undefined) roles.reviewer = { ...roles.reviewer, model: String(config.reviewer_model) };
      if (config.reviewer_effort !== undefined) roles.reviewer = { ...roles.reviewer, effort: String(config.reviewer_effort) };
      workflowPatch.roles = roles;
    }

    // Strip legacy shim keys before writing config.json
    const LEGACY_KEYS = [
      "claude_command", "codex_command", "antigravity_command", "planner_model", "claude_effort",
      "executor_model", "executor_effort", "reviewer_model", "reviewer_effort",
    ];
    const merged = { ...current, ...config };
    const toWrite = Object.fromEntries(
      Object.entries(merged).filter(([k]) => !LEGACY_KEYS.includes(k)),
    );
    if (!toWrite.version) toWrite.version = 2;

    await writeJsonAtomic(this.configPath, toWrite);
    this._cachedConfig = toWrite;

    if (Object.keys(workflowPatch).length > 0) {
      await this.writeWorkflow(workflowPatch);
    }

    return shimLegacyKeys(toWrite, await this.readWorkflow());
  }

  async readTask(id) {
    const text = await fs.readFile(this.taskPath(id), "utf8");
    return JSON.parse(text);
  }

  async writeTask(task) {
    await this.init();
    const updated = {
      ...task,
      updated_at: nowIso(this.clock),
    };
    await writeJsonAtomic(this.taskPath(updated.id), updated);
    return updated;
  }

  async readProject(id) {
    const text = await fs.readFile(this.projectPath(id), "utf8");
    return JSON.parse(text);
  }

  async writeProject(project) {
    await this.init();
    const updated = {
      ...project,
      updated_at: nowIso(this.clock),
    };
    await writeJsonAtomic(this.projectPath(updated.id), updated);
    return updated;
  }

  async updateProject(id, patch) {
    const current = await this.readProject(id);
    return this.writeProject({ ...current, ...patch });
  }

  _withUpdateLock(id, fn) {
    const prev = this._updateLocks.get(id) ?? Promise.resolve();
    const next = prev.then(fn);
    this._updateLocks.set(id, next.catch(() => {}));
    return next;
  }

  async updateTask(id, patch) {
    return this._withUpdateLock(id, async () => {
      const current = await this.readTask(id);
      return this.writeTask({ ...current, ...patch });
    });
  }

  async appendStep(id, step) {
    const current = await this.readTask(id);
    const next = {
      ...current,
      active_step: null,
      steps: [
        ...current.steps,
        {
          ...step,
          completed_at: nowIso(this.clock),
        },
      ],
    };
    return this.writeTask(next);
  }

  async appendInteraction(id, interaction = {}) {
    const current = await this.readTask(id);
    const interactions = current.interactions ?? [];
    const entry = {
      id: interaction.id ?? `i${interactions.length + 1}`,
      type: interaction.type ?? "message",
      actor: interaction.actor ?? "user",
      body: String(interaction.body ?? ""),
      created_at: interaction.created_at ?? nowIso(this.clock),
      ...interaction,
    };
    const updated = await this.writeTask({
      ...current,
      interactions: [
        ...interactions,
        entry,
      ],
    });
    await this.updateProjectTaskRecordForTask(updated, {
      interactions: updated.interactions,
    });
    return updated;
  }

  async updateActionRequest(id, actionId, patch = {}) {
    const current = await this.readTask(id);
    const requests = current.action_requests ?? [];
    const updated = await this.writeTask({
      ...current,
      action_requests: requests.map((request) => (
        request.id === actionId ? { ...request, ...patch } : request
      )),
    });
    await this.updateProjectTaskRecordForTask(updated, {
      action_requests: updated.action_requests,
    });
    return updated;
  }

  async incrementContinuationGeneration(id, patch = {}) {
    const current = await this.readTask(id);
    const updated = await this.writeTask({
      ...current,
      continuation_generation: (current.continuation_generation ?? 0) + 1,
      ...patch,
    });
    await this.updateProjectTaskRecordForTask(updated, {
      status: updated.status,
      continuation_generation: updated.continuation_generation,
    });
    return updated;
  }

  async updateProjectTaskRecordForTask(task, patch = {}) {
    if (!task.project_id) return;
    try {
      const project = await this.readProject(task.project_id);
      await this.writeProject({
        ...project,
        tasks: (project.tasks ?? []).map((record) => (
          record.id === task.id ? { ...record, ...patch } : record
        )),
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async answerQuestion(id, answer) {
    const current = await this.readTask(id);
    if (!current.active_question) {
      throw new Error(`task_not_waiting: ${id}`);
    }
    const answered = {
      ...current.active_question,
      answer,
      answered_at: nowIso(this.clock),
    };
    const updated = await this.writeTask({
      ...current,
      status: "queued",
      active_question: null,
      question_answers: [
        ...(current.question_answers ?? []),
        answered,
      ],
      interactions: [
        ...(current.interactions ?? []),
        {
          id: `i${(current.interactions ?? []).length + 1}`,
          type: "answer",
          actor: "user",
          body: String(answer ?? ""),
          created_at: nowIso(this.clock),
          question_id: current.active_question.id,
        },
      ],
      unblock_options: (current.unblock_options ?? []).map((option) => (
        option.type === "answer" ? { ...option, status: "used" } : option
      )),
      continuation_generation: (current.continuation_generation ?? 0) + 1,
    });
    await this.updateProjectTaskRecordForTask(updated, { status: updated.status });
    return updated;
  }

  async decideApproval(id, { approved = false, note = "" } = {}) {
    const current = await this.readTask(id);
    if (!current.active_approval) {
      throw new Error(`task_not_waiting_approval: ${id}`);
    }
    const decided = {
      ...current.active_approval,
      approved: Boolean(approved),
      note: String(note ?? ""),
      decided_at: nowIso(this.clock),
    };
    const continuation = approved
      ? `Approval granted for: ${decided.action}${decided.note ? `\nApproval note: ${decided.note}` : ""}`
      : `Approval denied for: ${decided.action}${decided.note ? `\nDenial note: ${decided.note}` : ""}\nDo not repeat the denied action unchanged. Reevaluate the next step using this decision.`;
    const updated = await this.writeTask({
      ...current,
      status: "queued",
      active_approval: null,
      continuation_prompt: continuation,
      approval_decisions: [
        ...(current.approval_decisions ?? []),
        decided,
      ],
      interactions: [
        ...(current.interactions ?? []),
        {
          id: `i${(current.interactions ?? []).length + 1}`,
          type: "approval",
          actor: "user",
          body: String(note ?? ""),
          created_at: nowIso(this.clock),
          approval_id: current.active_approval.id,
          approved: Boolean(approved),
        },
      ],
      unblock_options: (current.unblock_options ?? []).map((option) => (
        option.type === "approve_action" ? { ...option, status: "used" } : option
      )),
      continuation_generation: (current.continuation_generation ?? 0) + 1,
    });
    await this.updateProjectTaskRecordForTask(updated, {
      status: updated.status,
      approval_decisions: updated.approval_decisions,
    });
    return updated;
  }

  async listTasks() {
    await this.init();
    const entries = await fs.readdir(this.tasksDir);
    const tasks = [];
    for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
      const id = entry.replace(/\.json$/, "");
      try {
        const text = await fs.readFile(path.join(this.tasksDir, entry), "utf8");
        tasks.push(JSON.parse(text));
      } catch (error) {
        if (error instanceof SyntaxError) {
          tasks.push({
            id,
            status: "unreadable",
            mode: "-",
            planner_policy: "-",
            planner_decision: "-",
            active_step: null,
            steps: [],
            error: `invalid_task_json: ${error.message}`,
          });
          continue;
        }
        throw error;
      }
    }
    return tasks;
  }

  async listProjects() {
    await this.init();
    const entries = await fs.readdir(this.projectsDir);
    const projects = [];
    for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
      const id = entry.replace(/\.json$/, "");
      try {
        const text = await fs.readFile(path.join(this.projectsDir, entry), "utf8");
        projects.push(JSON.parse(text));
      } catch (error) {
        if (error instanceof SyntaxError) {
          projects.push({
            id,
            status: "unreadable",
            error: `invalid_project_json: ${error.message}`,
          });
          continue;
        }
        throw error;
      }
    }
    return projects;
  }
}
