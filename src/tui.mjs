import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

import { isValidWorkflowName } from "./task-store.mjs";
import { runWorkflowMenu } from "./tui-workflow.mjs";
import { runProvidersMenu } from "./tui-providers.mjs";

function normalizeChoice(value, fallback, allowed) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  return allowed.includes(normalized) ? normalized : fallback;
}

function parsePositiveInteger(value, fallback) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return fallback;
  const parsed = Number(normalized);
  return Number.isInteger(parsed) && (parsed > 0 || parsed === -1) ? parsed : fallback;
}

const SAFE_SHELL_COMMAND = /^[A-Za-z0-9_@%+=:,./-]+$/;

async function canExecute(filePath) {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function shellCommandExists(commandName, { cwd = process.cwd(), env = process.env } = {}) {
  const command = String(commandName ?? "").trim();
  if (!SAFE_SHELL_COMMAND.test(command)) return false;
  return new Promise((resolve) => {
    const child = spawn("bash", [
      "-ic",
      "type -t \"$1\" >/dev/null",
      "bash",
      command,
    ], {
      cwd,
      env,
      stdio: "ignore",
    });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

export async function defaultCommandExists(commandName, { cwd = process.cwd(), env = process.env } = {}) {
  const command = String(commandName ?? "").trim();
  if (!command) return false;
  if (command.includes("/") || command.includes(path.sep)) {
    const target = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    return canExecute(target);
  }
  for (const directory of String(env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    if (await canExecute(path.join(directory, command))) return true;
  }
  return shellCommandExists(command, { cwd, env });
}

function formatSettingValue(key, value) {
  if (key.endsWith("_model") || key.endsWith("_effort")) return value ? String(value) : "<cli default>";
  return String(value ?? "");
}

const SETTINGS_FIELDS = [
  {
    key: "cwd",
    label: "Default cwd",
    prompt: (defaults) => `Default cwd [${defaults.cwd}]: `,
    parse: (value, defaults) => String(value ?? "").trim() || defaults.cwd,
  },
  {
    key: "timeout_ms",
    label: "Default timeout ms",
    prompt: (defaults) => `Default timeout ms (-1 disables timeout) [${defaults.timeout_ms}]: `,
    parse: (value, defaults) => parsePositiveInteger(value, defaults.timeout_ms),
  },
];

const TASK_FIELDS = [
  {
    key: "prompt",
    label: "Prompt",
    prompt: () => "Task prompt: ",
    parse: (value, defaults) => String(value ?? "").trim() || defaults.prompt,
  },
  {
    key: "cwd",
    label: "Working directory",
    prompt: (defaults) => `Working directory [${defaults.cwd}]: `,
    parse: (value, defaults) => String(value ?? "").trim() || defaults.cwd,
  },
  {
    key: "mode",
    label: "Mode",
    prompt: (defaults) => `Mode task|plan-only [${defaults.mode}]: `,
    parse: (value, defaults) => normalizeChoice(value, defaults.mode, ["task", "plan-only"]),
  },
  {
    key: "workflow",
    label: "Workflow",
    prompt: (defaults) => `Workflow [${defaults.workflow ?? "default"}]: `,
    parse: (value, defaults) => {
      const next = String(value ?? "").trim();
      if (!next) return defaults.workflow ?? "default";
      return isValidWorkflowName(next) ? next : (defaults.workflow ?? "default");
    },
  },
  {
    key: "timeout_ms",
    label: "Timeout ms",
    prompt: (defaults) => `Timeout ms (-1 disables timeout) [${defaults.timeout_ms}]: `,
    parse: (value, defaults) => parsePositiveInteger(value, defaults.timeout_ms),
  },
];

function formatTaskValue(key, value) {
  if (key === "prompt") return value ? String(value) : "<required>";
  return String(value ?? "");
}

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  cyan: "\u001b[36m",
  magenta: "\u001b[35m",
};

export function formatPageHeader(title, { color = false, accent = ANSI.cyan } = {}) {
  const text = `== ${title} ==`;
  return color ? `${accent}${ANSI.bold}${text}${ANSI.reset}` : text;
}

export function createTheme({ color = false } = {}) {
  const paint = (code) => (text) => color ? `${code}${text}${ANSI.reset}` : text;
  return {
    heading: paint(ANSI.bold),
    dim: paint(ANSI.dim),
    label: paint(ANSI.dim),
    id: paint(ANSI.yellow),
    path: paint(ANSI.cyan),
    blocker: paint(ANSI.red),
    status: (status, text = status) => {
      if (!color) return text;
      if (status === "succeeded") return `${ANSI.green}${text}${ANSI.reset}`;
      if (["failed", "unreadable", "blocked", "needs_review", "needs-review-agent-commit", "blocked_git_publish", "merge_blocked"].includes(status)) return `${ANSI.red}${text}${ANSI.reset}`;
      if (["waiting", "waiting_user", "waiting_approval"].includes(status)) return `${ANSI.magenta}${text}${ANSI.reset}`;
      if (status === "running") return `${ANSI.cyan}${text}${ANSI.reset}`;
      if (["queued", "incomplete", "partial_success", "queued_path_conflict"].includes(status)) return `${ANSI.yellow}${text}${ANSI.reset}`;
      return text;
    },
  };
}

function kvLine(label, value, theme) {
  return `${theme.label(`${label}:`)} ${value}`;
}

export function formatFeedbackReceipt(receipt = null, { color = false, cli = false } = {}) {
  if (!receipt) return "";
  const theme = createTheme({ color });
  const prefix = cli ? `receipt ${receipt.kind ?? "action"}:` : "Receipt:";
  let message = receipt.message ?? "";
  if (!cli) {
    if (receipt.kind === "approve-action" && receipt.executed === true && receipt.action_id) {
      message = `Approved ${receipt.action_id}. ${message}`;
    } else if (receipt.kind === "run-action" && receipt.executed === true && receipt.action_id) {
      message = `Ran ${receipt.action_id}. ${message}`;
    } else if (receipt.kind === "deny-action" && receipt.action_id) {
      message = `Denied ${receipt.action_id}. ${message}`;
    } else if (receipt.kind === "retry" && message === "retry queued") {
      message = "Retry queued. retry queued";
    } else if (receipt.kind === "retry" && message === "force retry queued") {
      message = "Force retry queued. force retry queued";
    } else if (receipt.kind === "mark-done" && message === "manual completion checked") {
      message = "Manual completion checked. manual completion checked";
    } else if (receipt.kind === "mark-done" && message === "manual completion force-marked") {
      message = "Manual completion force-marked. manual completion force-marked";
    }
  }
  const suffix = receipt.detached === true ? " Task resumed in background." : "";
  const status = receipt.status_before && receipt.status_after && receipt.status_before !== receipt.status_after
    ? ` (${receipt.status_before} -> ${receipt.status_after})`
    : "";
  const text = `${prefix} ${message}${suffix}${status}`;
  return cli ? text : theme.heading(text);
}

function stripTaskTimestamp(id = "") {
  return String(id).replace(/^\d{8}-\d{6}-/, "");
}

function formatTaskTimestamp(task = {}) {
  const createdAt = String(task.created_at ?? "");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(createdAt)) {
    return createdAt.slice(0, 16).replace("T", " ");
  }
  const match = String(task.id ?? "").match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}`;
  }
  return "-";
}

function truncateText(value, width) {
  const text = String(value ?? "");
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  return `${text.slice(0, width - 1)}…`;
}

function padText(value, width) {
  const text = String(value ?? "");
  return text.length >= width ? text : `${text}${" ".repeat(width - text.length)}`;
}

function formatStepStatus(status) {
  if (status === "succeeded") return "ok";
  if (status === "running") return "running";
  if (status === "failed") return "failed";
  if (status === "waiting") return "waiting";
  return status ?? "done";
}

function formatTaskActivity(task = {}) {
  if (task.active_question) return `needs ${task.active_question.id}`;
  if (task.active_approval) return `approval ${task.active_approval.id}`;
  if (task.active_step) return `${task.active_step.role} ${task.active_step.status ?? "running"}`;
  const steps = task.steps ?? [];
  const last = steps.at(-1);
  if (last) return `${last.role} ${formatStepStatus(last.status)}`;
  if (task.status === "queued") return "queued";
  return "-";
}

function formatTaskFlow(task = {}) {
  if (task.mode === "plan-only") return "plan-only";
  const roleSkips = task.role_skips;
  if (roleSkips && Object.keys(roleSkips).length > 0) {
    return Object.entries(roleSkips)
      .filter(([, v]) => v && v !== "auto")
      .map(([k, v]) => `${k}=${v}`)
      .join(" ") || "default";
  }
  // Legacy display
  const plan = task.planner_decision
    ? `planner ${task.planner_decision}`
    : `planner ${task.planner_policy ?? "auto"}`;
  const review = task.review_enabled === false ? "review off" : "review on";
  return `${plan}, ${review}`;
}

function formatGitArgs(args = []) {
  return `git ${args.map((arg) => String(arg)).join(" ")}`;
}

function formatInteractionNote(entry = {}) {
  const body = String(entry.body ?? "").trim();
  if (!body) return null;
  if (entry.type === "approval") {
    const decision = entry.approved === false ? "denied" : "approved";
    return `approval ${decision}${entry.action_id ? ` ${entry.action_id}` : ""}: ${body}`;
  }
  if (entry.type === "retry") {
    return `retry${entry.force_parallel ? " force" : ""}: ${body}`;
  }
  if (entry.type === "extend_timeout") {
    return `extend_timeout${entry.timeout_ms ? ` ${entry.timeout_ms}` : ""}: ${body}`;
  }
  if (entry.type === "run_anyway") {
    return `run_anyway${entry.action_id ? ` ${entry.action_id}` : ""}: ${body}`;
  }
  if (entry.type === "manual_done") {
    return `manual_done${entry.action_id ? ` ${entry.action_id}` : ""}: ${body}`;
  }
  if (entry.type === "cancel") {
    return `cancel: ${body}`;
  }
  if (entry.type === "message") {
    return `message: ${body}`;
  }
  return null;
}

export function formatTaskDraft(form, { color = false } = {}) {
  const roleSkipEntries = form.role_skips ? Object.entries(form.role_skips) : [];
  const roleSkipLines = roleSkipEntries.map(([k, v], i) =>
    `${TASK_FIELDS.length + i + 1}. ${k} skip: ${v ?? "auto"}`,
  );
  return [
    formatPageHeader("New Task", { color, accent: ANSI.magenta }),
    "Task draft",
    ...TASK_FIELDS.map((field, index) => (
      `${index + 1}. ${field.label}: ${formatTaskValue(field.key, form[field.key])}`
    )),
    ...roleSkipLines,
    "s. Submit task",
    "b. Back",
  ].join("\n");
}

async function collectTaskFieldChange({ ask, form, choice, roleEntries = [] }) {
  const normalized = String(choice ?? "").trim().toLowerCase();
  if (!normalized || ["b", "q"].includes(normalized)) return { action: "back" };
  if (normalized === "s") return { action: "submit" };
  const index = Number(normalized);
  if (!Number.isInteger(index) || index < 1) return { action: "invalid" };

  // Static task fields
  if (index <= TASK_FIELDS.length) {
    const field = TASK_FIELDS[index - 1];
    const value = field.parse(await ask(field.prompt(form)), form);
    return { action: "update", patch: { [field.key]: value } };
  }

  // Dynamic role skip fields
  const skipIndex = index - TASK_FIELDS.length - 1;
  if (skipIndex >= 0 && skipIndex < roleEntries.length) {
    const [roleKey] = roleEntries[skipIndex];
    const current = form.role_skips?.[roleKey] ?? "auto";
    const raw = String(await ask(`${roleKey} skip auto|always|never [${current}]: `) ?? "").trim().toLowerCase();
    const v = ["auto", "always", "never"].includes(raw) ? raw : current;
    return { action: "update", patch: { role_skips: { ...(form.role_skips ?? {}), [roleKey]: v } } };
  }

  return { action: "invalid" };
}

export async function collectNewTaskForm({ ask, defaults, output = null, color = false, workflow = null }) {
  const roleEntries = workflow ? Object.entries(workflow.roles ?? {}) : [];
  const defaultRoleSkips = roleEntries.length > 0
    ? Object.fromEntries(roleEntries.map(([k, r]) => [k, r.skip ?? "auto"]))
    : null;

  const prompt = String(await ask("Task prompt: ") ?? "").trim();
  if (!prompt) {
    if (output) output.write("Task prompt required.\n");
    return {
      prompt: "",
      cwd: defaults.cwd,
      mode: defaults.mode ?? "task",
      workflow: defaults.workflow ?? "default",
      timeout_ms: defaults.timeout_ms,
      ...(defaultRoleSkips ? { role_skips: defaultRoleSkips } : {}),
      cancelled: true,
    };
  }
  let form = {
    prompt,
    cwd: defaults.cwd,
    mode: defaults.mode ?? "task",
    workflow: defaults.workflow ?? "default",
    timeout_ms: defaults.timeout_ms,
    ...(defaultRoleSkips ? { role_skips: defaultRoleSkips } : {}),
  };

  while (true) {
    if (output) output.write(`\n${formatTaskDraft(form, { color })}\n`);
    const change = await collectTaskFieldChange({
      ask,
      form,
      choice: await ask("Pick task setting to change, s to submit, or b to return: "),
      roleEntries,
    });
    if (change.action === "back") return { ...form, cancelled: true };
    if (change.action === "invalid") {
      if (output) output.write("Unknown task setting.\n");
      continue;
    }
    if (change.action === "submit") {
      if (!form.prompt) {
        if (output) output.write("Task prompt required.\n");
        continue;
      }
      return form;
    }
    form = { ...form, ...change.patch };
  }
}

export function formatSettingsList(config, { color = false } = {}) {
  return [
    formatPageHeader("Settings", { color, accent: ANSI.yellow }),
    ...SETTINGS_FIELDS.map((field, index) => (
      `${index + 1}. ${field.label}: ${formatSettingValue(field.key, config[field.key])}`
    )),
    "b. Back",
  ].join("\n");
}

async function collectSettingChange({ ask, defaults, choice, output = null, extraItems = [], totalLegacy = SETTINGS_FIELDS.length }) {
  const normalized = String(choice ?? "").trim().toLowerCase();
  if (!normalized || ["b", "q"].includes(normalized)) return { action: "back" };
  const index = Number(normalized);
  if (!Number.isInteger(index) || index < 1) return { action: "invalid" };

  if (index <= totalLegacy) {
    const field = SETTINGS_FIELDS[index - 1];
    if (field.optionsHelp && output) {
      output.write(`${field.optionsHelp()}\n`);
    }
    const value = field.parse(await ask(field.prompt(defaults)), defaults);
    return { action: "update", patch: { [field.key]: value } };
  }

  const extraIndex = index - totalLegacy - 1;
  if (extraIndex >= 0 && extraIndex < extraItems.length) {
    const item = extraItems[extraIndex];
    if (item.drill) return { action: `drill_${item.drill}` };
    const value = item.parse(await ask(item.prompt(defaults)), defaults);
    return { action: "update", patch: { [item.key]: value } };
  }

  return { action: "invalid" };
}

async function runSettingsMenu({ ask, output, store, color = false }) {
  // Extra items appended after the legacy SETTINGS_FIELDS
  const EXTRA_ITEMS = [
    { label: "Default role",     key: "default_role", prompt: (d) => `Default role [${d.default_role ?? "executor"}]: `, parse: (v, d) => String(v ?? "").trim() || d.default_role || "executor" },
    { label: "Roles & workflow", drill: "workflow" },
    { label: "Providers",        drill: "providers" },
  ];
  const totalLegacy = SETTINGS_FIELDS.length;

  let done = false;
  while (!done) {
    const current = await store.readConfig();
    const lines = [
      formatPageHeader("Settings", { color, accent: ANSI.yellow }),
      ...SETTINGS_FIELDS.map((field, i) => `${i + 1}. ${field.label}: ${formatSettingValue(field.key, current[field.key])}`),
      ...EXTRA_ITEMS.map((item, i) => `${totalLegacy + i + 1}. ${item.label}${item.drill ? " ->" : `: ${formatSettingValue(item.key, current[item.key])}`}`),
      "b. Back",
    ];
    output.write(`\n${lines.join("\n")}\n`);

    const rawChoice = await ask("Pick setting to change, or b to return: ");
    const change = await collectSettingChange({ ask, defaults: current, choice: rawChoice, output, extraItems: EXTRA_ITEMS, totalLegacy });

    if (change.action === "back") { done = true; continue; }
    if (change.action === "invalid") { output.write("Unknown setting.\n"); continue; }
    if (change.action === "drill_workflow") { await runWorkflowMenu({ ask, output, store }); continue; }
    if (change.action === "drill_providers") { await runProvidersMenu({ ask, output, store }); continue; }

    await store.writeConfig(change.patch);
    output.write("Setting saved.\n");
  }
}

export function formatTaskList(tasks = [], { emptyMessage = "No Maestro tasks yet.", color = false } = {}) {
  if (tasks.length === 0) return emptyMessage;
  const theme = createTheme({ color });
  const widths = {
    alias: 3,
    status: 9,
    created: 16,
    task: 58,
    activity: 24,
  };
  const header = [
    padText("#", widths.alias),
    padText("Status", widths.status),
    padText("Created", widths.created),
    padText("Task", widths.task),
    "Activity",
  ].join("  ");
  const rows = tasks.map((task, index) => {
    const status = String(task.status ?? "-");
    const statusText = padText(status, widths.status);
    return [
      padText(String(index + 1), widths.alias),
      theme.status(status, statusText),
      padText(formatTaskTimestamp(task), widths.created),
      padText(truncateText(stripTaskTimestamp(task.id), widths.task), widths.task),
      truncateText(formatTaskActivity(task), widths.activity),
    ].join("  ");
  });
  return [theme.heading(header), ...rows].join("\n");
}

export function formatProjectList(projects = [], { emptyMessage = "No Maestro projects yet.", color = false } = {}) {
  if (projects.length === 0) return emptyMessage;
  const theme = createTheme({ color });
  const widths = {
    alias: 3,
    status: 15,
    target: 14,
    project: 34,
    blockers: 12,
  };
  const header = [
    padText("#", widths.alias),
    padText("Status", widths.status),
    padText("Target", widths.target),
    padText("Project", widths.project),
    "Blockers",
  ].join("  ");
  const rows = projects.map((project, index) => {
    const blockerCount = (project.blockers ?? []).length + (project.cleanup_blockers ?? []).length;
    const blockerText = blockerCount === 1 ? "1 blocker" : `${blockerCount} blockers`;
    const status = String(project.status ?? "-");
    return [
      padText(String(index + 1), widths.alias),
      theme.status(status, padText(status, widths.status)),
      padText(truncateText(project.target_branch ?? "-", widths.target), widths.target),
      padText(truncateText(project.id ?? "-", widths.project), widths.project),
      blockerText,
    ].join("  ");
  });
  return [theme.heading(header), ...rows].join("\n");
}

export function formatProjectDetails(project = {}, { alias = null, color = false } = {}) {
  const theme = createTheme({ color });
  const title = alias ? `Project ${alias}: ${project.id ?? "-"}` : `Project: ${project.id ?? "-"}`;
  const lines = [
    formatPageHeader(title, { color, accent: ANSI.cyan }),
    `Status: ${theme.status(project.status, project.status ?? "-")}`,
    `Target: ${project.target_branch ?? "-"}`,
    `Integration: ${project.integration_branch ?? "-"}`,
    `Integration worktree: ${project.integration_worktree ?? "-"}`,
  ];
  const tasks = project.tasks ?? [];
  lines.push(`Tasks: ${tasks.length}`);
  if (tasks.length > 0) {
    for (const task of tasks) {
      lines.push(`- ${task.id}: ${task.status ?? "-"}${task.branch ? ` (${task.branch})` : ""}`);
    }
  }
  const leases = Object.entries(project.path_leases ?? {});
  lines.push("Leases:");
  if (leases.length === 0) {
    lines.push("- none");
  } else {
    for (const [leasePath, lease] of leases) {
      lines.push(`- ${leasePath} -> ${lease.task_id ?? "-"} (${lease.mode ?? "write"})`);
    }
  }
  const blockers = [...(project.blockers ?? []), ...(project.cleanup_blockers ?? [])];
  lines.push("Blockers:");
  if (blockers.length === 0) {
    lines.push("- none");
  } else {
    for (const blocker of blockers) {
      lines.push(`- ${blocker.code ?? "blocker"}${blocker.task_id ? ` (${blocker.task_id})` : ""}`);
    }
  }
  if (alias) {
    lines.push(`Use \`json ${alias}\` for full JSON.`);
  }
  return lines.join("\n");
}

function appendSection(lines, title, body = [], theme = createTheme()) {
  if (lines.length > 0) lines.push("");
  lines.push(theme.heading(title));
  lines.push(...body);
}

function compactResultText(value = "", maxLength = 180) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

export function formatTaskDetails(task = {}, { alias = null, color = false, sections = false } = {}) {
  const theme = createTheme({ color });
  const shortId = stripTaskTimestamp(task.id);
  const title = alias ? `Task ${alias}: ${shortId}` : `Task: ${shortId}`;
  const lines = [formatPageHeader(title, { color, accent: ANSI.green })];
  const summary = [
    kvLine("Status", theme.status(task.status, task.status ?? "-"), theme),
    kvLine("Created", formatTaskTimestamp(task), theme),
    kvLine("Full id", theme.id(task.id ?? "-"), theme),
    kvLine("Prompt", task.prompt ?? "-", theme),
    kvLine("Cwd", theme.path(task.cwd ?? "-"), theme),
    kvLine("Flow", formatTaskFlow(task), theme),
    kvLine("Activity", formatTaskActivity(task), theme),
  ];
  if (sections) appendSection(lines, "Summary", summary, theme);
  else lines.push(...summary);
  if (task.active_question) {
    lines.push(`${theme.label("Question")} ${theme.id(task.active_question.id)}: ${task.active_question.question}`);
  }
  if (task.active_approval) {
    lines.push(`${theme.label("Approval")} ${theme.id(task.active_approval.id)}: ${task.active_approval.action}`);
    if (task.active_approval.reason) lines.push(kvLine("Approval reason", task.active_approval.reason, theme));
  }
  const openOptions = (task.unblock_options ?? []).filter((option) => option.status === "open");
  if (openOptions.length > 0) {
    if (sections) appendSection(lines, "Available Actions", [], theme);
    else lines.push("Unblock options:");
    for (const option of openOptions) {
      lines.push(`- ${theme.id(option.id)} ${option.type}: ${option.label}`);
    }
  }
  const blockers = task.blockers ?? task.review?.blockers ?? [];
  if (sections) {
    appendSection(lines, "Current Blockers", [], theme);
    if (blockers.length === 0) {
      lines.push("- none");
    } else {
      for (const blocker of blockers) {
        lines.push(`- ${theme.blocker(blocker.code ?? blocker.type ?? "blocker")}${blocker.reason ? `: ${blocker.reason}` : ""}${blocker.error ? `: ${blocker.error}` : ""}`);
      }
    }
  }
  const actionRequests = task.action_requests ?? [];
  if (actionRequests.length > 0) {
    if (sections) appendSection(lines, "Action Requests", [], theme);
    else lines.push("Action requests:");
    for (const request of actionRequests) {
      lines.push(`- ${theme.id(request.id)} ${request.type} ${theme.status(request.status, request.status ?? "-")}`);
      if (request.cwd) lines.push(`  ${theme.label("cwd:")} ${theme.path(request.cwd)}`);
      if (Array.isArray(request.normalized_args)) lines.push(`  args: ${formatGitArgs(request.normalized_args)}`);
      if (request.command) lines.push(`  command: ${[request.command, ...(request.args ?? [])].join(" ")}`);
      if (request.result) {
        if (request.result.stdout) lines.push(`  stdout: ${sections ? compactResultText(request.result.stdout) : request.result.stdout}`);
        if (request.result.stderr) lines.push(`  stderr: ${sections ? compactResultText(request.result.stderr) : request.result.stderr}`);
        if (request.result.stdout_path) lines.push(`  ${theme.label("stdout log:")} ${theme.path(request.result.stdout_path)}`);
        if (request.result.stderr_path) lines.push(`  ${theme.label("stderr log:")} ${theme.path(request.result.stderr_path)}`);
      }
    }
  }
  lines.push(...formatTaskActionLegend(task));
  const recentNotes = (task.interactions ?? [])
    .map((entry) => formatInteractionNote(entry))
    .filter(Boolean)
    .slice(-5);
  if (recentNotes.length > 0) {
    if (sections) {
      appendSection(lines, "Recent Notes", [], theme);
      lines.push("Recent notes:");
    } else {
      lines.push("Recent notes:");
    }
    for (const note of recentNotes) {
      lines.push(`- ${note}`);
    }
  }
  const messages = (task.interactions ?? []).filter((entry) => ["message", "manual_done", "retry", "cancel"].includes(entry.type));
  if (messages.length > 0) {
    lines.push("Messages:");
    for (const entry of messages.slice(-5)) {
      lines.push(`- ${entry.type}: ${entry.body}`);
    }
  }
  if (task.review) {
    if (sections) appendSection(lines, "Review", [], theme);
    lines.push(kvLine("Review", `${task.review.status ?? "-"} ${task.review.completion_state ?? "-"}`, theme));
    if (task.review.required_action) lines.push(kvLine("Required action", task.review.required_action, theme));
    if (task.review.risk_level) lines.push(kvLine("Risk", `${task.review.risk_level}${task.review.confidence ? ` (${task.review.confidence})` : ""}`, theme));
    if (task.review.summary) lines.push(kvLine("Review summary", task.review.summary, theme));
    const reviewBlockers = task.review.blockers ?? task.blockers ?? [];
    if (reviewBlockers.length > 0) {
      lines.push("Review blockers:");
      for (const blocker of reviewBlockers) {
        lines.push(`- ${theme.blocker(blocker.code ?? blocker.type ?? blocker.summary ?? "blocker")}${blocker.reason ? `: ${blocker.reason}` : ""}`);
      }
    }
  }
  const steps = task.steps ?? [];
  if (sections) appendSection(lines, "Steps", [], theme);
  if (steps.length > 0) {
    if (!sections) lines.push("Steps:");
    for (const step of steps) {
      lines.push(`- ${step.role} (${step.provider ?? "-"}): ${theme.status(step.status, step.status ?? "done")}`);
      if (step.error) lines.push(`  Error: ${step.error}`);
      if (step.stdout_path) lines.push(`  ${theme.label("stdout:")} ${theme.path(step.stdout_path)}`);
      if (step.stderr_path) lines.push(`  ${theme.label("stderr:")} ${theme.path(step.stderr_path)}`);
    }
  } else {
    lines.push(sections ? "- none" : "Steps: -");
  }
  if (sections) {
    appendSection(lines, "Logs", [], theme);
    const logs = steps.flatMap((step) => [step.stdout_path, step.stderr_path]).filter(Boolean);
    if (logs.length === 0 && actionRequests.every((request) => !request.result?.stdout_path && !request.result?.stderr_path)) {
      lines.push("- none");
    } else {
      for (const logPath of logs) lines.push(`- ${theme.path(logPath)}`);
      for (const request of actionRequests) {
        if (request.result?.stdout_path) lines.push(`- ${theme.path(request.result.stdout_path)}`);
        if (request.result?.stderr_path) lines.push(`- ${theme.path(request.result.stderr_path)}`);
      }
    }
  }
  if (alias) {
    lines.push(`Use \`json ${alias}\` for full JSON.`);
  }
  return lines.join("\n");
}

export function resolveTaskSelection(value, tasks = []) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.toLowerCase() === "q") return { action: "back" };

  const alias = normalized.startsWith("#") ? normalized.slice(1) : normalized;
  const maxAliasLength = String(tasks.length).length;
  if (/^\d+$/.test(alias) && (normalized.startsWith("#") || alias.length <= maxAliasLength)) {
    const index = Number(alias) - 1;
    if (index >= 0 && index < tasks.length) {
      return { action: "select", id: tasks[index].id };
    }
    return { action: "invalid", error: "not_found" };
  }

  const exact = tasks.find((task) => task.id === normalized);
  if (exact) return { action: "select", id: exact.id };

  const matches = tasks.filter((task) => task.id.startsWith(normalized));
  if (matches.length === 1) return { action: "select", id: matches[0].id };
  if (matches.length > 1) return { action: "invalid", error: "ambiguous" };
  return { action: "invalid", error: "not_found" };
}

function parseTaskInspectSelection(value) {
  const normalized = String(value ?? "").trim();
  const match = normalized.match(/^(?:json|j)\s+(.+)$/i);
  if (!match) return { mode: "summary", selection: normalized };
  return { mode: "json", selection: match[1].trim() };
}

const TASK_VIEW_STATUSES = {
  active: new Set(["waiting", "waiting_user", "waiting_approval", "running", "queued"]),
  "needs-human": new Set(["waiting", "waiting_user", "waiting_approval"]),
  blocked: new Set(["blocked", "blocked_git_publish", "merge_blocked", "queued_path_conflict", "needs-review-agent-commit", "needs_review"]),
  incomplete: new Set(["incomplete", "partial_success"]),
  done: new Set(["succeeded"]),
  waiting: new Set(["waiting", "waiting_user", "waiting_approval"]),
  running: new Set(["running"]),
  queued: new Set(["queued"]),
  failed: new Set(["failed"]),
  succeeded: new Set(["succeeded"]),
};

function normalizeTaskView(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["a", "all"].includes(normalized)) return "all";
  if (["v", "active"].includes(normalized)) return "active";
  if (["fail", "failed", "error", "errors"].includes(normalized)) return "failed";
  if (["ok", "done", "success", "succeeded"].includes(normalized)) return "done";
  if (["human", "needs-human", "needs_human", "approval", "approvals"].includes(normalized)) return "needs-human";
  if (["block", "blocked", "blockers"].includes(normalized)) return "blocked";
  if (["incomplete", "partial", "partial_success"].includes(normalized)) return "incomplete";
  if (["run", "running"].includes(normalized)) return "running";
  if (["wait", "waiting", "question", "questions"].includes(normalized)) return "waiting";
  if (["queue", "queued"].includes(normalized)) return "queued";
  return null;
}

function taskCreatedTime(task = {}) {
  const created = Date.parse(task.created_at ?? "");
  if (Number.isFinite(created)) return created;
  const match = String(task.id ?? "").match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (!match) return 0;
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
}

export function filterTasksForView(tasks = [], view = "active") {
  const normalizedView = normalizeTaskView(view) ?? view;
  const statuses = TASK_VIEW_STATUSES[normalizedView] ?? null;
  return [...tasks]
    .filter((task) => normalizedView === "all" || !statuses || statuses.has(task.status))
    .sort((left, right) => {
      const created = taskCreatedTime(right) - taskCreatedTime(left);
      if (created !== 0) return created;
      return String(right.id).localeCompare(String(left.id));
    });
}

async function readPipedInputLines(input) {
  let text = "";
  for await (const chunk of input) {
    text += chunk.toString("utf8");
  }
  return text.split(/\r?\n/);
}

function parseTaskActionCommand(value = "") {
  const parts = String(value ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { action: "back" };
  const verb = parts[0].toLowerCase();
  if (["b", "back", "q", "quit"].includes(verb)) return { action: "back" };
  if (["a", "approve"].includes(verb)) return { action: "approve", actionId: parts[1] ?? "" };
  if (["x", "run", "run-action", "outside"].includes(verb)) return { action: "run", actionId: parts[1] ?? "" };
  if (["d", "deny"].includes(verb)) return { action: "deny", actionId: parts[1] ?? "" };
  if (["e", "edit", "edit-action"].includes(verb)) return { action: "edit", actionId: parts[1] ?? "" };
  if (["i", "instruct", "message"].includes(verb)) return { action: "instruct" };
  if (["t", "timeout", "extend-timeout"].includes(verb)) return { action: "extend_timeout" };
  if (["mf", "mark-force", "mark-done-force", "force-mark-done"].includes(verb)) return { action: "mark_done", actionId: parts[1] ?? "", force: true };
  if (["m", "mark", "mark-done"].includes(verb)) return { action: "mark_done", actionId: parts[1] ?? "" };
  if (["r", "retry"].includes(verb)) return { action: "retry", forceParallel: false };
  if (["f", "force", "force-retry"].includes(verb)) return { action: "retry", forceParallel: true };
  if (["c", "cancel"].includes(verb)) return { action: "cancel" };
  return { action: "invalid" };
}

function formatTaskActionLegend(task = {}) {
  const openOptionTypes = new Set(
    (task.unblock_options ?? [])
      .filter((option) => option.status === "open")
      .map((option) => option.type),
  );
  const pendingActions = (task.action_requests ?? []).filter((request) => ["pending", "failed", "expired"].includes(request.status));
  if (openOptionTypes.size === 0 && pendingActions.length === 0) return [];
  const hasExternalRun = openOptionTypes.has("run_external")
    || pendingActions.some((request) => request.type === "external_cwd_git" || request.external_cwd === true);
  const runLabel = hasExternalRun ? "run outside sandbox" : "run anyway";

  const lines = ["Available actions:"];
  if (pendingActions.length > 0 || openOptionTypes.has("approve_action")) {
    const actionIds = pendingActions.length > 0 ? pendingActions.map((request) => request.id) : ["<action-id>"];
    for (const actionId of actionIds) {
      lines.push(`- (a)pprove ${actionId}`);
      lines.push(`- (x) ${runLabel} ${actionId}`);
      lines.push(`- (d)eny ${actionId}`);
      lines.push(`- (e)dit ${actionId}`);
    }
  }
  if (pendingActions.length > 0 || openOptionTypes.has("manual_done")) {
    const actionIds = pendingActions.length > 0 ? pendingActions.map((request) => `[${request.id}]`) : ["[action-id]"];
    for (const actionId of actionIds) {
      lines.push(`- (m)ark-done ${actionId}`);
      lines.push(`- (mf)orce mark-done ${actionId}`);
    }
  }
  if (openOptionTypes.has("extend_timeout")) {
    lines.push("- (t)imeout");
  }
  if (openOptionTypes.has("retry")) {
    lines.push("- (r)etry");
    lines.push("- (f)orce retry");
  }
  if (openOptionTypes.has("instruct") || openOptionTypes.has("retry")) {
    lines.push("- (i)nstruct");
  }
  if (openOptionTypes.has("cancel")) {
    lines.push("- (c)ancel");
  }
  return lines;
}

function formatTaskActionPrompt(task = {}) {
  const actionRequests = (task.action_requests ?? []).filter((request) => ["pending", "failed", "expired"].includes(request.status));
  const openOptionTypes = new Set(
    (task.unblock_options ?? [])
      .filter((option) => option.status === "open")
      .map((option) => option.type),
  );
  const hasExternalRun = openOptionTypes.has("run_external")
    || actionRequests.some((request) => request.type === "external_cwd_git" || request.external_cwd === true);
  const runLabel = hasExternalRun ? "run outside sandbox" : "run anyway";
  return `Action (a)pprove <action-id>, (x) ${runLabel} <action-id>, (d)eny <action-id>, (e)dit <action-id>, (i)nstruct, (m)ark-done [action-id], (mf)orce mark-done [action-id], (t)imeout, (r)etry, (f)orce retry, (c)ancel, or blank: `;
}

function requestById(task = {}, actionId = "") {
  return (task.action_requests ?? []).find((request) => request.id === actionId) ?? null;
}

export async function runMaestroTui({
  cwd,
  stdout = process.stdout,
  stdin = process.stdin,
  store,
  runTask,
  resumeTask = null,
  approveAction = null,
  runAction = null,
  denyAction = null,
  editAction = null,
  markDone = null,
  extendTimeout = null,
  messageTask = null,
  retryTask = null,
  cancelTask = null,
  approveSubstitution = null,
  skipRole = null,
  switchProvider = null,
  ask: injectedAsk = null,
} = {}) {
  // Full-screen TUI on real terminals; the classic prompt-driven TUI remains
  // for pipes, injected ask functions (tests), and MAESTRO_TUI_CLASSIC=1.
  if (!injectedAsk && stdin.isTTY === true && stdout.isTTY === true && process.env.MAESTRO_TUI_CLASSIC !== "1") {
    const { runFullScreenTui } = await import("./tui/app.mjs");
    return runFullScreenTui({
      stdin,
      stdout,
      store,
      cwd,
      callbacks: {
        runTask, resumeTask, approveAction, runAction, denyAction, editAction,
        markDone, extendTimeout, messageTask, retryTask, cancelTask,
        approveSubstitution, skipRole, switchProvider,
      },
      formatDetails: (task, opts = {}) => formatTaskDetails(task, { ...opts, sections: true }),
      filterTasks: filterTasksForView,
    });
  }

  let rl = null;
  let ask = injectedAsk;
  const activeRuns = new Map();
  const color = stdout.isTTY === true && !process.env.NO_COLOR;
  const receiptNotice = (result, fallback) => (
    result?.receipt ? formatFeedbackReceipt(result.receipt, { color }) : fallback
  );
  if (!ask && stdin.isTTY !== true) {
    const lines = await readPipedInputLines(stdin);
    ask = async (question) => {
      stdout.write(question);
      return lines.shift() ?? "q";
    };
  }
  if (!ask) {
    rl = createInterface({ input: stdin, output: stdout });
    ask = async (question) => {
      try {
        return await rl.question(question);
      } catch (error) {
        if (error.code === "ERR_USE_AFTER_CLOSE") return "q";
        throw error;
      }
    };
  }

  try {
    let done = false;
    while (!done) {
      stdout.write(`\n${formatPageHeader("Maestro", { color, accent: ANSI.cyan })}\n1. New task\n2. Tasks\n3. Settings\n4. Projects\nq. Quit\n`);
      if (activeRuns.size > 0) {
        stdout.write(`Active tasks: ${activeRuns.size}\n`);
      }
      const choice = String(await ask("> ") ?? "").trim().toLowerCase();
      if (!["1", "2", "3", "4", "q"].includes(choice)) {
        stdout.write("Unknown menu choice.\n");
        continue;
      }

      if (choice === "1") {
        const [config, workflow] = await Promise.all([store.readConfig(), store.readWorkflow()]);
        const defaults = { ...config, cwd, mode: "task" };
        const form = await collectNewTaskForm({ ask, defaults, output: stdout, color, workflow });
        if (form.cancelled) {
          continue;
        }
        const runForm = form;
        let startTask = null;
        const started = new Promise((resolve) => {
          startTask = resolve;
        });
        const key = Symbol("task");
        const record = {
          taskId: null,
          status: "starting",
        };
        activeRuns.set(key, record);
        let reportedTaskId = null;
        const reportTaskId = (taskId) => {
          if (taskId && taskId !== reportedTaskId) {
            reportedTaskId = taskId;
            record.taskId = taskId;
            stdout.write(`Task id: ${taskId}\n`);
          }
          if (taskId) startTask({ taskId });
          return taskId;
        };
        const taskPromise = Promise.resolve()
          .then(() => runTask(runForm, {
            onTaskCreated: (task) => reportTaskId(task.id),
          }));
        taskPromise
          .then((result) => {
            const taskId = reportTaskId(result?.task?.id);
            if (result?.detached === true) {
              return;
            }
            const status = result?.task?.status ?? "succeeded";
            if (taskId) {
              stdout.write(`Task ${taskId} finished: ${status}\n`);
            }
          })
          .catch((error) => {
            const taskId = reportTaskId(error.taskId);
            if (taskId) {
              stdout.write(`Task ${taskId} failed: ${error.message}\n`);
            } else {
              stdout.write(`Task failed: ${error.message}\n`);
            }
          })
          .finally(() => {
            activeRuns.delete(key);
          });

        const initial = await Promise.race([
          started,
          taskPromise.then(
            (result) => ({
              completed: true,
              detached: result?.detached === true,
              taskId: result?.task?.id,
            }),
            (error) => ({ completed: true, taskId: error.taskId }),
          ),
        ]);
        if (!initial.completed || initial.detached) {
          stdout.write("Task started in background. Open Tasks to inspect.\n");
        }
        continue;
      }

      if (choice === "2") {
        let view = "active";
        let leaveTasks = false;
        while (!leaveTasks) {
          const allTasks = await store.listTasks();
          if (allTasks.length === 0) {
            stdout.write(`\n${formatPageHeader("Tasks (active)", { color, accent: ANSI.blue })}\nNo Maestro tasks yet.\n`);
            break;
          }
          const tasks = filterTasksForView(allTasks, view);
          const emptyMessage = view === "active"
            ? "No active Maestro tasks. Type all to see completed and failed tasks."
            : "No Maestro tasks yet.";
          stdout.write(`\n${formatPageHeader(`Tasks (${view}, newest first)`, { color, accent: ANSI.blue })}\n${formatTaskList(tasks, { emptyMessage, color })}\n`);
          const selection = String(await ask("Inspect alias/id, json <alias/id>, filter active|needs-human|blocked|incomplete|failed|done|all, or blank: ")).trim();
          const normalized = selection.toLowerCase();
          if (!normalized || normalized === "q") {
            leaveTasks = true;
            continue;
          }
          const selectedView = normalizeTaskView(normalized);
          if (selectedView) {
            view = selectedView;
            continue;
          }

          const inspected = parseTaskInspectSelection(selection);
          const resolved = resolveTaskSelection(inspected.selection, tasks);
          if (resolved.action === "back") {
            leaveTasks = true;
            continue;
          }
          if (resolved.action === "invalid") {
            const hint = resolved.error === "ambiguous"
              ? "Selection is ambiguous; use a numeric alias or full task id."
              : `Could not find task alias/id ${selection}.`;
            stdout.write(`${hint}\n`);
            continue;
          }
          if (resolved.id) {
            try {
              const task = await store.readTask(resolved.id);
              if (["waiting", "waiting_user"].includes(task.status) && task.active_question) {
                stdout.write(`\n${formatPageHeader(`Question for ${stripTaskTimestamp(task.id)}`, { color, accent: ANSI.magenta })}\n${task.active_question.question}\n`);
                const answer = String(await ask("Answer question, or blank to return: ")).trim();
                if (answer) {
                  const statusBefore = task.status;
                  const answered = await store.answerQuestion(task.id, answer);
                  let result = { task: answered };
                  if (resumeTask) {
                    result = await resumeTask(answered);
                  }
                  const receipt = {
                    kind: "answer",
                    message: "answer saved; task queued",
                    executed: false,
                    status_before: statusBefore,
                    status_after: result.task?.status ?? answered.status,
                    detached: result.detached === true,
                    next_actions: [],
                  };
                  stdout.write(`${formatFeedbackReceipt(receipt, { color })}\n`);
                }
                continue;
              }
              if (task.status === "waiting_approval" && task.active_approval) {
                stdout.write(`\n${formatPageHeader(`Approval for ${stripTaskTimestamp(task.id)}`, { color, accent: ANSI.magenta })}\n${task.active_approval.action}\n`);
                if (task.active_approval.reason) stdout.write(`${task.active_approval.reason}\n`);
                const decision = String(await ask("Approve and resume? y|n [n]: ")).trim().toLowerCase();
                const approved = ["y", "yes"].includes(decision);
                const statusBefore = task.status;
                const decided = await store.decideApproval(task.id, { approved, note: approved ? "approved via TUI" : "denied via TUI" });
                let result = { task: decided };
                if (resumeTask) {
                  result = await resumeTask(decided);
                }
                const refreshed = await store.readTask(task.id);
                const receipt = {
                  kind: "approval",
                  message: `approval ${approved ? "approved" : "denied"}; task queued`,
                  executed: false,
                  status_before: statusBefore,
                  status_after: result.task?.status ?? decided.status,
                  reason: approved ? null : "denied",
                  detached: result.detached === true,
                  next_actions: [],
                };
                stdout.write(`${formatFeedbackReceipt(receipt, { color })}\n`);
                stdout.write(`${formatTaskDetails(refreshed, { color })}\n`);
                continue;
              }
              if (inspected.mode === "json") {
                stdout.write(`${JSON.stringify(task, null, 2)}\n`);
              } else {
                const alias = tasks.findIndex((item) => item.id === task.id) + 1;
                let detailTask = task;
                let forceDetailPrompt = false;
                let detailNotice = "";
                let leaveDetail = false;
                while (!leaveDetail) {
                  stdout.write(`${formatTaskDetails(detailTask, { alias, color, sections: true })}\n`);
                  if (detailNotice) {
                    stdout.write(`${detailNotice}\n`);
                    detailNotice = "";
                  }
                  const hasOpenOptions = (detailTask.unblock_options ?? []).some((option) => option.status === "open");
                  const hasPendingActions = (detailTask.action_requests ?? []).some((request) => ["pending", "failed", "expired"].includes(request.status));
                  if (!hasOpenOptions && !hasPendingActions && !forceDetailPrompt) {
                    break;
                  }
                  const prompt = hasOpenOptions || hasPendingActions
                    ? formatTaskActionPrompt(detailTask)
                    : "Blank to return: ";
                  const commandText = String(await ask(prompt)).trim();
                  const parsedAction = parseTaskActionCommand(commandText);
                  if (parsedAction.action === "back") {
                    leaveDetail = true;
                    continue;
                  }
                  if (parsedAction.action === "invalid") {
                    stdout.write("Unknown task action.\n");
                    continue;
                  }
                  const needsActionId = ["approve", "run", "deny", "edit"].includes(parsedAction.action);
                  if (needsActionId && !parsedAction.actionId) {
                    stdout.write("Action id required.\n");
                    continue;
                  }
                  let timeoutMs = null;
                  if (parsedAction.action === "extend_timeout") {
                    const timeoutText = String(await ask("Timeout ms (-1 disables timeout): ")).trim();
                    timeoutMs = Number(timeoutText);
                    if (!Number.isInteger(timeoutMs) || (timeoutMs <= 0 && timeoutMs !== -1)) {
                      stdout.write("Invalid timeout.\n");
                      continue;
                    }
                  }
                  const note = String(await ask("Note (optional): ")).trim();
                  if (parsedAction.action === "approve") {
                    if (!approveAction) {
                      stdout.write("Approve action unavailable.\n");
                      continue;
                    }
                    const result = await approveAction(detailTask, parsedAction.actionId, note);
                    detailNotice = receiptNotice(result, `Approved ${parsedAction.actionId}.${result?.detached === true ? " Task resumed in background." : ""}`);
                    detailTask = await store.readTask(detailTask.id);
                    forceDetailPrompt = true;
                    continue;
                  }
                  if (parsedAction.action === "run") {
                    if (!runAction) {
                      stdout.write("Run action unavailable.\n");
                      continue;
                    }
                    const result = await runAction(detailTask, parsedAction.actionId, note);
                    detailNotice = receiptNotice(result, `Ran ${parsedAction.actionId}.${result?.detached === true ? " Task resumed in background." : ""}`);
                    detailTask = await store.readTask(detailTask.id);
                    forceDetailPrompt = true;
                    continue;
                  }
                  if (parsedAction.action === "deny") {
                    if (!denyAction) {
                      stdout.write("Deny action unavailable.\n");
                      continue;
                    }
                    const result = await denyAction(detailTask, parsedAction.actionId, note);
                    detailNotice = receiptNotice(result, `Denied ${parsedAction.actionId}.${result?.detached === true ? " Task resumed in background." : ""}`);
                    detailTask = await store.readTask(detailTask.id);
                    forceDetailPrompt = true;
                    continue;
                  }
                  if (parsedAction.action === "edit") {
                    if (!editAction) {
                      stdout.write("Edit action unavailable.\n");
                      continue;
                    }
                    const request = requestById(detailTask, parsedAction.actionId);
                    if (!request) {
                      stdout.write("Action not found.\n");
                      continue;
                    }
                    const patch = {};
                    try {
                      if (request.provider === "host" || request.type === "host_command") {
                        const command = String(await ask(`Command [${request.command ?? ""}]: `)).trim();
                        const argsJson = String(await ask("Args JSON (blank keep): ")).trim();
                        patch.provider = "host";
                        patch.type = "host_command";
                        if (command) patch.command = command;
                        if (argsJson) patch.args = JSON.parse(argsJson);
                        const envJson = String(await ask("Env JSON (blank keep): ")).trim();
                        if (envJson) patch.env = JSON.parse(envJson);
                        const timeoutText = String(await ask(`Timeout ms (-1 disables timeout) [${request.timeout_ms ?? ""}]: `)).trim();
                        if (timeoutText) {
                          const parsedTimeout = Number(timeoutText);
                          if (!Number.isInteger(parsedTimeout) || (parsedTimeout <= 0 && parsedTimeout !== -1)) {
                            stdout.write("Invalid timeout.\n");
                            continue;
                          }
                          patch.timeout_ms = parsedTimeout;
                        }
                        const nextCwd = String(await ask(`Cwd [${request.cwd ?? ""}]: `)).trim();
                        if (nextCwd) patch.cwd = nextCwd;
                      } else {
                        const argsJson = String(await ask("Args JSON (blank keep): ")).trim();
                        if (argsJson) patch.normalized_args = JSON.parse(argsJson);
                        const nextCwd = String(await ask("Cwd (blank keep): ")).trim();
                        const gitType = String(await ask(`Git type (blank keep) [${request.git_type ?? request.type ?? ""}]: `)).trim();
                        if (nextCwd) patch.cwd = nextCwd;
                        if (gitType) patch.git_type = gitType;
                      }
                    } catch (error) {
                      if (error instanceof SyntaxError) {
                        detailNotice = `Invalid JSON: ${error.message}`;
                        forceDetailPrompt = true;
                        continue;
                      }
                      throw error;
                    }
                    const result = await editAction(detailTask, parsedAction.actionId, patch, note);
                    detailNotice = receiptNotice(result, `Edited ${parsedAction.actionId}.`);
                    detailTask = await store.readTask(detailTask.id);
                    forceDetailPrompt = true;
                    continue;
                  }
                  if (parsedAction.action === "instruct") {
                    if (!messageTask) {
                      stdout.write("Instruct unavailable.\n");
                      continue;
                    }
                    const result = await messageTask(detailTask, note);
                    detailNotice = receiptNotice(result, `Instruction queued.${result?.detached === true ? " Task resumed in background." : ""}`);
                    detailTask = await store.readTask(detailTask.id);
                    forceDetailPrompt = true;
                    continue;
                  }
                  if (parsedAction.action === "mark_done") {
                    if (!markDone) {
                      stdout.write("Mark done unavailable.\n");
                      continue;
                    }
                    const result = await markDone(detailTask, parsedAction.actionId || null, note, { force: parsedAction.force === true });
                    detailNotice = receiptNotice(result, `${parsedAction.force ? "Manual completion force-marked." : "Manual completion checked."}${result?.detached === true ? " Task resumed in background." : ""}`);
                    detailTask = await store.readTask(detailTask.id);
                    forceDetailPrompt = true;
                    continue;
                  }
                  if (parsedAction.action === "extend_timeout") {
                    if (!extendTimeout) {
                      stdout.write("Extend timeout unavailable.\n");
                      continue;
                    }
                    const result = await extendTimeout(detailTask, timeoutMs, note);
                    detailNotice = receiptNotice(result, `Timeout extended.${result?.detached === true ? " Task resumed in background." : ""}`);
                    detailTask = await store.readTask(detailTask.id);
                    forceDetailPrompt = true;
                    continue;
                  }
                  if (parsedAction.action === "retry") {
                    if (!retryTask) {
                      stdout.write("Retry unavailable.\n");
                      continue;
                    }
                    const result = await retryTask(detailTask, note, { forceParallel: parsedAction.forceParallel === true });
                    detailNotice = receiptNotice(result, `${parsedAction.forceParallel ? "Force retry queued." : "Retry queued."}${result?.detached === true ? " Task resumed in background." : ""}`);
                    detailTask = await store.readTask(detailTask.id);
                    forceDetailPrompt = true;
                    continue;
                  }
                  if (parsedAction.action === "cancel") {
                    if (!cancelTask) {
                      stdout.write("Cancel unavailable.\n");
                      continue;
                    }
                    const result = await cancelTask(detailTask, note);
                    detailNotice = receiptNotice(result, "Task cancelled.");
                    detailTask = await store.readTask(detailTask.id);
                    forceDetailPrompt = true;
                  }
                }
              }
            } catch (error) {
              stdout.write(`Could not inspect task ${resolved.id}: ${error.message}\n`);
            }
          }
        }
        continue;
      }

      if (choice === "3") {
        await runSettingsMenu({ ask, output: stdout, store, color });
        continue;
      }

      if (choice === "4") {
        let leaveProjects = false;
        while (!leaveProjects) {
          const projects = await store.listProjects();
          stdout.write(`\n${formatPageHeader("Projects", { color, accent: ANSI.cyan })}\n${formatProjectList(projects, { color })}\n`);
          if (projects.length === 0) {
            break;
          }
          const selection = String(await ask("Inspect alias/id, json <alias/id>, or blank: ")).trim();
          if (!selection || selection.toLowerCase() === "q") {
            leaveProjects = true;
            continue;
          }
          const inspected = parseTaskInspectSelection(selection);
          const resolved = resolveTaskSelection(inspected.selection, projects);
          if (resolved.action === "invalid") {
            stdout.write(`Could not find project alias/id ${selection}.\n`);
            continue;
          }
          if (resolved.action === "back") {
            leaveProjects = true;
            continue;
          }
          try {
            const project = await store.readProject(resolved.id);
            if (inspected.mode === "json") {
              stdout.write(`${JSON.stringify(project, null, 2)}\n`);
            } else {
              const alias = projects.findIndex((item) => item.id === project.id) + 1;
              stdout.write(`${formatProjectDetails(project, { alias, color })}\n`);
            }
          } catch (error) {
            stdout.write(`Could not inspect project ${resolved.id}: ${error.message}\n`);
          }
        }
        continue;
      }

      done = true;
    }
  } finally {
    if (rl) rl.close();
  }

  return { ok: true, cwd };
}
