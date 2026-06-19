import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { buildArtifactIndex, compareArtifactIndexes, resolveArtifact } from "../artifacts.mjs";
import { openStore } from "../db/store.mjs";
import { tailFile } from "../fs-safe.mjs";
import { usageError } from "./registry.mjs";
import { loadLocalSecrets, runKeysWizard } from "../setup/keys.mjs";
import { runLocalSetup } from "../setup/local.mjs";
import { loadRole } from "../setup/role-loader.mjs";
import { subagentToNativeUnit } from "../setup/role-convert.mjs";
import { parseSubagent, scanSubagents, slugifyRoleName } from "../setup/scanners/claude.mjs";
import { DEFAULT_LOCAL_STATE_DIR } from "../task-store.mjs";
import { manifestToTaskInputs, sanitizeRerunWorkflowName } from "../run-manifest.mjs";
import { formatDurationMs } from "../run-summary.mjs";
import { getStageEvents } from "../stage-events.mjs";
import { formatTaskDetails, runMaestroTui } from "../tui.mjs";
import { formatValidation, validateWorkflow } from "../workflow-validate.mjs";

import { defaultGitRunner, defaultHostRunner } from "./git-exec.mjs";
import {
  findUnknownFlags,
  makeStore,
  parseActionArgs,
  parseArtifactsArgs,
  parseCompareArgs,
  parseEditActionArgs,
  parseEventsArgs,
  parseInspectArgs,
  parseRerunArgs,
  parseSharedStateArgs,
  parseTaskArgs,
} from "./parse-args.mjs";
import { runProjectCommand } from "./projects.mjs";
import { attachReceipt, feedbackReceipt, withReceipt, writeResultReceipt } from "./receipts.mjs";
import {
  handleApproveAction,
  handleApproveSubstitution,
  handleCancelTask,
  handleDenyAction,
  handleEditAction,
  handleExtendTimeout,
  handleMarkDone,
  handleRetryTask,
  handleRunAction,
  handleSkipRole,
  handleSwitchProvider,
} from "./task-handlers.mjs";
import {
  createLocalTaskFromParsed,
  recoverStaleRunningTasks,
  runCreatedLocalTask,
  startDetachedExistingTask,
  startDetachedLocalTask,
} from "./tasks-run.mjs";
import { writeLine } from "./util.mjs";

function warnFlags(flags, command, stderr) {
  for (const f of flags) {
    writeLine(stderr, `warning: unknown flag for '${command}': ${f}`);
  }
}

export async function runLocalMaestroCommand({
  args,
  cwd = process.cwd(),
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  store = null,
  runner = null,
  availabilityProbe = null,
  gitRunner = defaultGitRunner,
  hostRunner = defaultHostRunner,
  onTaskCreated = null,
  spawnProcess = spawn,
} = {}) {
  const command = args[0];

  // Load .maestro/secrets.local.json into the env (real env vars win) so
  // "$VAR" references in shareable config resolve without exported keys.
  {
    const flagIndex = args.indexOf("--state-dir");
    const secretsStateDir = flagIndex !== -1 && args[flagIndex + 1]
      ? path.resolve(cwd, args[flagIndex + 1])
      : path.resolve(cwd, DEFAULT_LOCAL_STATE_DIR);
    try {
      await loadLocalSecrets(secretsStateDir);
    } catch (error) {
      writeLine(stderr, `warning: could not load secrets.local.json: ${error.message}`);
    }
  }

  if (command === "project") {
    return runProjectCommand({ args, cwd, stdout, stderr, store, gitRunner });
  }

  if (command === "serve") {
    const { runServeCommand } = await import("./serve/commands.mjs");
    return runServeCommand({ args, stdout, stderr, env: process.env, spawnProcess });
  }

  if (command === "tui") {
    const parsed = parseSharedStateArgs(args, cwd);
    warnFlags(findUnknownFlags(parsed.positional, new Set()), "tui", stderr);
    const taskStore = makeStore(parsed, store);
    return runMaestroTui({
      cwd,
      stdout,
      stdin,
      store: taskStore,
      runTask: (form, callbacks = {}) => startDetachedLocalTask({
        form,
        cwd,
        taskStore,
        spawnProcess,
        onTaskCreated: callbacks.onTaskCreated,
        gitRunner,
      }),
      resumeTask: (task) => startDetachedExistingTask({
        task,
        cwd,
        taskStore,
        spawnProcess,
      }),
      approveAction: (task, actionId, note) => handleApproveAction({
        taskStore,
        taskId: task.id,
        actionId,
        note,
        cwd,
        stdout,
        stderr,
        runner,
        gitRunner,
        hostRunner,
        resumeMode: "detached",
        spawnProcess,
      }),
      runAction: (task, actionId, note) => handleRunAction({
        taskStore,
        taskId: task.id,
        actionId,
        note,
        cwd,
        stdout,
        stderr,
        runner,
        gitRunner,
        hostRunner,
        resumeMode: "detached",
        spawnProcess,
      }),
      denyAction: (task, actionId, note) => handleDenyAction({
        taskStore,
        taskId: task.id,
        actionId,
        note,
        cwd,
        stdout,
        stderr,
        runner,
        gitRunner,
        resumeMode: "detached",
        spawnProcess,
      }),
      editAction: (task, actionId, patch, note) => handleEditAction({
        taskStore,
        taskId: task.id,
        actionId,
        patch,
        note,
        stdout,
      }),
      messageTask: async (task, note) => {
        const statusBefore = task.status;
        let updated = await taskStore.appendInteraction(task.id, {
          type: "message",
          actor: "user",
          body: note,
        });
        if (updated.status !== "running") {
          updated = await taskStore.incrementContinuationGeneration(task.id, {
            status: "queued",
            continuation_prompt: note ? `User message:\n${note}` : null,
          });
          const result = startDetachedExistingTask({
            task: updated,
            cwd,
            taskStore,
            spawnProcess,
          });
          return attachReceipt(result, feedbackReceipt({
            kind: "message",
            message: "message queued",
            executed: false,
            statusBefore,
            statusAfter: result.task?.status,
            detached: result.detached === true,
          }));
        }
        const result = { task: updated };
        return attachReceipt(result, feedbackReceipt({
          kind: "message",
          message: updated.status === "running" ? "message queued for continuation" : "message queued",
          executed: false,
          statusBefore,
          statusAfter: result.task?.status,
          detached: result.detached === true,
        }));
      },
      markDone: async (task, actionId, note, options = {}) => {
        const result = await handleMarkDone({
          taskStore,
          taskId: task.id,
          actionId,
          note,
          force: options.force === true,
          cwd,
          stdout,
          stderr,
          runner,
          gitRunner,
          resumeMode: "detached",
          spawnProcess,
        });
        return result.receipt ? result : attachReceipt(result, feedbackReceipt({
          kind: "mark-done",
          message: options.force === true ? "manual completion force-marked" : "manual completion checked",
          executed: false,
          statusBefore: task.status,
          statusAfter: result.task?.status,
          actionId,
          detached: result.detached === true,
        }));
      },
      extendTimeout: (task, timeoutMs, note) => handleExtendTimeout({
        taskStore,
        taskId: task.id,
        timeoutMs,
        note,
        cwd,
        stdout,
        stderr,
        runner,
        gitRunner,
        resumeMode: "detached",
        spawnProcess,
      }),
      retryTask: (task, note, options = {}) => handleRetryTask({
        taskStore,
        taskId: task.id,
        note,
        forceParallel: options.forceParallel === true,
        cwd,
        stdout,
        stderr,
        runner,
        gitRunner,
        resumeMode: "detached",
        spawnProcess,
      }),
      cancelTask: (task, note) => handleCancelTask({
        taskStore,
        taskId: task.id,
        note,
        stdout,
      }),
      approveSubstitution: (task, note) => handleApproveSubstitution({
        taskStore,
        taskId: task.id,
        note,
        cwd,
        stdout,
        stderr,
        runner,
        gitRunner,
        resumeMode: "detached",
        spawnProcess,
      }),
      skipRole: (task, role, note) => handleSkipRole({
        taskStore,
        taskId: task.id,
        role,
        note,
        cwd,
        stdout,
        stderr,
        runner,
        gitRunner,
        resumeMode: "detached",
        spawnProcess,
      }),
      switchProvider: (task, provider, note) => handleSwitchProvider({
        taskStore,
        taskId: task.id,
        provider,
        note,
        cwd,
        stdout,
        stderr,
        runner,
        gitRunner,
        resumeMode: "detached",
        spawnProcess,
      }),
    });
  }

  if (command === "task") {
    const parsed = parseTaskArgs(args, cwd);
    const taskStore = makeStore(parsed, store);
    const defaults = await taskStore.readConfig();
    const workflowName = parsed.workflow ?? "default";
    const workflow = await taskStore.readWorkflow(workflowName);
    // Non-default names have no implicit fallback — a missing file is an error.
    if (!workflow) {
      throw new Error(`unknown_workflow: ${workflowName}`);
    }
    if (parsed.mode !== "task") {
      if (!workflow.modes?.[parsed.mode]) {
        throw new Error(`unknown_mode: ${parsed.mode} (defined modes: ${Object.keys(workflow.modes ?? {}).join(", ")})`);
      }
    }
    const task = await createLocalTaskFromParsed({ parsed, taskStore, defaults, cwd, gitRunner, stdout });
    if (onTaskCreated) {
      onTaskCreated(task);
    }
    return runCreatedLocalTask({ taskStore, taskId: task.id, cwd, stdout, stderr, runner, gitRunner, availabilityProbe });
  }

  if (command === "run-task") {
    const parsed = parseSharedStateArgs(args, cwd);
    warnFlags(findUnknownFlags(parsed.positional.slice(1), new Set()), "run-task", stderr);
    const taskId = parsed.positional[0];
    if (!taskId) throw new Error("missing_task_id");
    const taskStore = makeStore(parsed, store);
    return runCreatedLocalTask({ taskStore, taskId, cwd, stdout, stderr, runner, gitRunner, availabilityProbe });
  }

  if (command === "approve" || command === "deny") {
    const parsed = parseActionArgs(args, cwd);
    warnFlags(parsed.unknownFlags, command, stderr);
    const taskId = parsed.positional[0];
    if (!taskId) throw new Error("missing_task_id");
    const taskStore = makeStore(parsed, store);
    const approved = command === "approve";
    const before = await taskStore.readTask(taskId);
    const task = await taskStore.decideApproval(taskId, { approved, note: parsed.note });
    writeLine(stdout, `task ${task.id} approval ${approved ? "approved" : "denied"}`);
    let result = { task };
    if (task.status === "queued") {
      result = await runCreatedLocalTask({ taskStore, taskId, cwd, stdout, stderr, runner, gitRunner, availabilityProbe });
    }
    result = attachReceipt(result, feedbackReceipt({
      kind: command,
      message: `approval ${approved ? "approved" : "denied"}`,
      executed: false,
      statusBefore: before.status,
      statusAfter: result.task?.status,
      reason: approved ? null : "denied",
    }));
    writeResultReceipt(stdout, result);
    return result;
  }

  if (command === "approve-action" || command === "deny-action" || command === "run-action") {
    const parsed = parseActionArgs(args, cwd);
    warnFlags(parsed.unknownFlags, command, stderr);
    const [taskId, actionId] = parsed.positional;
    if (!taskId) throw new Error("missing_task_id");
    if (!actionId) throw new Error("missing_action_id");
    const taskStore = makeStore(parsed, store);
    let result;
    if (command === "deny-action") {
      result = await handleDenyAction({ taskStore, taskId, actionId, note: parsed.note, cwd, stdout, stderr, runner, gitRunner });
      writeResultReceipt(stdout, result);
      return result;
    }
    if (command === "run-action") {
      result = await handleRunAction({
        taskStore,
        taskId,
        actionId,
        note: parsed.note,
        cwd,
        gitRunner,
        hostRunner,
        stdout,
        stderr,
        runner,
      });
      writeResultReceipt(stdout, result);
      return result;
    }
    result = await handleApproveAction({
      taskStore,
      taskId,
      actionId,
      note: parsed.note,
      cwd,
      gitRunner,
      hostRunner,
      stdout,
      stderr,
      runner,
    });
    writeResultReceipt(stdout, result);
    return result;
  }

  if (command === "edit-action") {
    const parsed = parseEditActionArgs(args, cwd);
    warnFlags(parsed.unknownFlags, "edit-action", stderr);
    const [taskId, actionId] = parsed.positional;
    if (!taskId) throw new Error("missing_task_id");
    if (!actionId) throw new Error("missing_action_id");
    const taskStore = makeStore(parsed, store);
    const result = await handleEditAction({
      taskStore,
      taskId,
      actionId,
      patch: parsed.patch,
      note: parsed.note,
      stdout,
    });
    writeResultReceipt(stdout, result);
    return result;
  }

  if (command === "message") {
    const parsed = parseActionArgs(args, cwd);
    warnFlags(parsed.unknownFlags, "message", stderr);
    const taskId = parsed.positional[0];
    if (!taskId) throw new Error("missing_task_id");
    const taskStore = makeStore(parsed, store);
    const before = await taskStore.readTask(taskId);
    let task = await taskStore.appendInteraction(taskId, {
      type: "message",
      actor: "user",
      body: parsed.note,
    });
    if (task.status === "running") {
      writeLine(stdout, `task ${task.id} message queued for continuation`);
      const result = withReceipt(task, feedbackReceipt({
        kind: "message",
        message: "message queued for continuation",
        executed: false,
        statusBefore: before.status,
        statusAfter: task.status,
      }));
      writeResultReceipt(stdout, result);
      return result;
    }
    task = await taskStore.incrementContinuationGeneration(taskId, {
      status: "queued",
      continuation_prompt: parsed.note ? `User message:\n${parsed.note}` : null,
    });
    writeLine(stdout, `task ${task.id} queued with message`);
    const resumed = await runCreatedLocalTask({ taskStore, taskId, cwd, stdout, stderr, runner, gitRunner, availabilityProbe });
    const result = attachReceipt(resumed, feedbackReceipt({
      kind: "message",
      message: "message queued",
      executed: false,
      statusBefore: before.status,
      statusAfter: resumed.task?.status,
    }));
    writeResultReceipt(stdout, result);
    return result;
  }

  if (command === "retry") {
    const parsed = parseActionArgs(args, cwd);
    warnFlags(parsed.unknownFlags, "retry", stderr);
    const taskId = parsed.positional[0];
    if (!taskId) throw new Error("missing_task_id");
    const taskStore = makeStore(parsed, store);
    const result = await handleRetryTask({
      taskStore,
      taskId,
      note: parsed.note,
      forceParallel: parsed.forceParallel,
      cwd,
      stdout,
      stderr,
      runner,
      gitRunner,
    });
    writeResultReceipt(stdout, result);
    return result;
  }

  if (command === "extend-timeout") {
    const parsed = parseActionArgs(args, cwd);
    warnFlags(parsed.unknownFlags, "extend-timeout", stderr);
    const taskId = parsed.positional[0];
    if (!taskId) throw new Error("missing_task_id");
    if (parsed.timeoutMs === null) throw new Error("missing_timeout_ms");
    const taskStore = makeStore(parsed, store);
    const before = await taskStore.readTask(taskId);
    const result = await handleExtendTimeout({
      taskStore,
      taskId,
      timeoutMs: parsed.timeoutMs,
      note: parsed.note,
      cwd,
      stdout,
      stderr,
      runner,
      gitRunner,
    });
    const withFallback = result.receipt ? result : attachReceipt(result, feedbackReceipt({
      kind: "extend-timeout",
      message: "timeout extended",
      executed: false,
      statusBefore: before.status,
      statusAfter: result.task?.status,
    }));
    writeResultReceipt(stdout, withFallback);
    return withFallback;
  }

  if (command === "mark-done") {
    const parsed = parseActionArgs(args, cwd);
    warnFlags(parsed.unknownFlags, "mark-done", stderr);
    const taskId = parsed.positional[0];
    if (!taskId) throw new Error("missing_task_id");
    const actionId = parsed.positional[1] ?? null;
    const taskStore = makeStore(parsed, store);
    const before = await taskStore.readTask(taskId);
    const result = await handleMarkDone({
      taskStore,
      taskId,
      actionId,
      note: parsed.note,
      force: parsed.force,
      cwd,
      stdout,
      stderr,
      runner,
      gitRunner,
    });
    const withFallback = result.receipt ? result : attachReceipt(result, feedbackReceipt({
      kind: "mark-done",
      message: parsed.force ? "manual completion force-marked" : "manual completion checked",
      executed: false,
      statusBefore: before.status,
      statusAfter: result.task?.status,
      actionId,
    }));
    writeResultReceipt(stdout, withFallback);
    return withFallback;
  }

  if (command === "cancel") {
    const parsed = parseActionArgs(args, cwd);
    warnFlags(parsed.unknownFlags, "cancel", stderr);
    const taskId = parsed.positional[0];
    if (!taskId) throw new Error("missing_task_id");
    const taskStore = makeStore(parsed, store);
    const result = await handleCancelTask({ taskStore, taskId, note: parsed.note, stdout });
    writeResultReceipt(stdout, result);
    return result;
  }

  if (command === "approve-substitution") {
    const parsed = parseActionArgs(args, cwd);
    warnFlags(parsed.unknownFlags, "approve-substitution", stderr);
    const taskId = parsed.positional[0];
    if (!taskId) throw new Error("missing_task_id");
    const taskStore = makeStore(parsed, store);
    const result = await handleApproveSubstitution({
      taskStore, taskId, note: parsed.note, cwd, stdout, stderr, runner, gitRunner, availabilityProbe,
    });
    writeResultReceipt(stdout, result);
    return result;
  }

  if (command === "skip-role") {
    const parsed = parseActionArgs(args, cwd);
    warnFlags(parsed.unknownFlags, "skip-role", stderr);
    const taskId = parsed.positional[0];
    if (!taskId) throw new Error("missing_task_id");
    const role = parsed.positional[1] ?? null;
    const taskStore = makeStore(parsed, store);
    const result = await handleSkipRole({
      taskStore, taskId, role, note: parsed.note, cwd, stdout, stderr, runner, gitRunner, availabilityProbe,
    });
    writeResultReceipt(stdout, result);
    return result;
  }

  if (command === "switch-provider") {
    const parsed = parseActionArgs(args, cwd);
    warnFlags(parsed.unknownFlags, "switch-provider", stderr);
    const taskId = parsed.positional[0];
    if (!taskId) throw new Error("missing_task_id");
    const provider = parsed.positional[1];
    if (!provider) throw new Error("missing_provider");
    const taskStore = makeStore(parsed, store);
    const result = await handleSwitchProvider({
      taskStore, taskId, provider, note: parsed.note, cwd, stdout, stderr, runner, gitRunner, availabilityProbe,
    });
    writeResultReceipt(stdout, result);
    return result;
  }

  if (command === "status") {
    const parsed = parseSharedStateArgs(args, cwd);
    warnFlags(findUnknownFlags(parsed.positional, new Set()), "status", stderr);
    const taskStore = makeStore(parsed, store);
    const tasks = await recoverStaleRunningTasks(taskStore);
    if (tasks.length === 0) {
      writeLine(stdout, "No Maestro tasks");
    }
    for (const task of tasks) {
      writeLine(stdout, `${task.id} ${task.status} ${task.mode}`);
    }
    return { tasks };
  }

  if (command === "inspect") {
    const parsed = parseInspectArgs(args, cwd, stdout);
    warnFlags(parsed.unknownFlags, "inspect", stderr);
    const id = parsed.positional[0];
    if (!id) throw new Error("missing_task_id");
    const taskStore = makeStore(parsed, store);
    const task = await taskStore.readTask(id);
    writeLine(stdout, parsed.json
      ? JSON.stringify(task, null, 2)
      : formatTaskDetails(task, { color: parsed.color, sections: true }));
    return { task };
  }

  if (command === "events") return handleEventsCommand();
  if (command === "artifacts") return handleArtifactsCommand();
  if (command === "rerun") return handleRerunCommand();

  if (command === "compare") {
    const parsed = parseCompareArgs(args, cwd);
    warnFlags(parsed.unknownFlags, "compare", stderr);
    const [id1, id2] = parsed.positional;
    if (!id1 || !id2) throw new Error("missing_task_id");
    const taskStore = makeStore(parsed, store);
    const indexFor = async (id) => {
      const task = await taskStore.readTask(id).catch(() => null);
      const runDir = task?.run_dir ?? path.join(taskStore.root, "runs", id);
      return buildArtifactIndex({ ...(task ?? {}), run_dir: runDir });
    };
    const [a, b] = await Promise.all([indexFor(id1), indexFor(id2)]);
    const rows = compareArtifactIndexes(a, b);
    if (parsed.json) {
      writeLine(stdout, JSON.stringify(rows, null, 2));
    } else {
      for (const r of rows) {
        writeLine(stdout, `${`${r.role ?? "-"}.${r.kind ?? "-"}`.padEnd(28)} ${r.result}`);
      }
    }
    return { rows };
  }

  if (command === "init") {
    const parsed = parseSharedStateArgs(args, cwd);
    warnFlags(findUnknownFlags(parsed.positional, new Set(["--yes", "--dry-run", "--workflow"])), "init", stderr);
    const { runInitWizard } = await import("../setup/init.mjs");
    return runInitWizard({
      stateDir: parsed.stateDir,
      cwd,
      args: parsed.positional,
      stdin,
      stdout,
      stderr,
      store,
    });
  }

  if (command === "doctor") {
    const parsed = parseSharedStateArgs(args, cwd);
    warnFlags(findUnknownFlags(parsed.positional, new Set(["--json"])), "doctor", stderr);
    const { runDoctor, formatDoctorReport } = await import("../setup/doctor.mjs");
    const result = await runDoctor({ stateDir: parsed.stateDir, cwd });
    writeLine(stdout, parsed.positional.includes("--json")
      ? JSON.stringify(result, null, 2)
      : formatDoctorReport(result, { color: stdout.isTTY === true }));
    if (!result.ok) process.exitCode = 1;
    return result;
  }

  if (command === "setup") {
    const parsed = parseSharedStateArgs(args, cwd);
    const [action, ...rest] = parsed.positional;
    if (action === "keys") {
      warnFlags(findUnknownFlags(rest, new Set(["--var", "--encrypt"])), "setup keys", stderr);
      await runKeysWizard({ stateDir: parsed.stateDir, args: rest, env: process.env, stdin, stdout });
      return {};
    }
    if (action === "harden") {
      warnFlags(
        findUnknownFlags(rest, new Set(["--dry-run", "--global", "--project"])),
        "setup harden",
        stderr,
      );
      const { applyHarden, defaultGuardScriptPath } = await import("../setup/harden.mjs");
      const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
      const scope = rest.includes("--project") ? "project" : "global";
      const settingsPath =
        scope === "project"
          ? path.resolve(cwd, ".claude/settings.json")
          : path.join(home, ".claude", "settings.json");
      if (rest.includes("--dry-run")) {
        writeLine(stdout, `would harden ${settingsPath} (guard: ${defaultGuardScriptPath()})`);
        return {};
      }
      const res = await applyHarden({ settingsPath });
      writeLine(stdout, `hardened ${res.settingsPath} — maestro secret guard installed`);
      return {};
    }
    if (action === "local") {
      warnFlags(findUnknownFlags(rest, new Set(["--yes", "--json"])), "setup local", stderr);
      const taskStore = makeStore(parsed, store);
      return runLocalSetup({ store: taskStore, args: rest, stdin, stdout });
    }
    if (action === "import") {
      warnFlags(findUnknownFlags(rest, new Set(["--dry-run", "--yes", "--copy"])), "setup import", stderr);
      const taskStore = makeStore(parsed, store);
      const { runImportWizard } = await import("../setup/import.mjs");
      return runImportWizard({ store: taskStore, stateDir: parsed.stateDir, args: rest, stdin, stdout, stderr });
    }
    if (action === "tracker") {
      warnFlags(
        findUnknownFlags(
          rest,
          new Set(["--project-slug", "--api-key", "--var", "--endpoint", "--kind", "--yes"]),
        ),
        "setup tracker",
        stderr,
      );
      const { runTrackerWizard } = await import("../setup/tracker.mjs");
      await runTrackerWizard({ stateDir: parsed.stateDir, args: rest, env: process.env, stdin, stdout });
      return {};
    }
    throw usageError(["setup", action]);
  }

  if (command === "export") {
    const parsed = parseSharedStateArgs(args, cwd);
    const rest = parsed.positional;
    warnFlags(findUnknownFlags(rest, new Set(["--name", "--out", "--single-file"])), "export", stderr);
    const { buildBundle, writeBundleDir, writeBundleFile } = await import("../setup/export.mjs");
    const nameIndex = rest.indexOf("--name");
    const outIndex = rest.indexOf("--out");
    const bundle = await buildBundle({
      stateDir: parsed.stateDir,
      name: nameIndex !== -1 ? rest[nameIndex + 1] : null,
    });
    const out = outIndex !== -1 && rest[outIndex + 1]
      ? path.resolve(cwd, rest[outIndex + 1])
      : path.resolve(cwd, `${bundle.manifest.name}-bundle`);
    const written = rest.includes("--single-file")
      ? await writeBundleFile(bundle, out)
      : await writeBundleDir(bundle, out);
    writeLine(stdout, `exported workflow bundle "${bundle.manifest.name}" → ${written}`);
    writeLine(stdout, `credits: ${bundle.manifest.credits.length}, files: ${Object.keys(bundle.files).length} (local config/secrets excluded)`);
    return { bundle, written };
  }

  if (command === "import") return handleImportCommand();
  if (command === "workflow") return handleWorkflowCommand();
  if (command === "role") return handleRoleCommand();

  if (command === "import-agent") {
    const parsed = parseSharedStateArgs(args, cwd);
    const source = parsed.positional[0];
    if (!source) throw usageError(["import-agent"]);
    const sourcePath = path.resolve(cwd, source);
    const text = await fs.readFile(sourcePath, "utf8");
    const subagent = parseSubagent(text, sourcePath);
    if (!subagent) throw new Error(`not a valid subagent (missing name): ${source}`);
    const md = subagentToNativeUnit(subagent);
    const roleName = slugifyRoleName(subagent.name);
    const rolesDir = path.join(parsed.stateDir, "roles");
    await fs.mkdir(rolesDir, { recursive: true });
    const destPath = path.join(rolesDir, `${roleName}.md`);
    await fs.writeFile(destPath, md, "utf8");

    const manifestPath = path.join(parsed.stateDir, "import-manifest.json");
    let manifest = { imports: [] };
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      if (!Array.isArray(manifest.imports)) manifest.imports = [];
    } catch {
      // no manifest yet — start fresh
    }
    manifest.imports = manifest.imports.filter((entry) => entry.name !== roleName);
    manifest.imports.push({
      name: roleName,
      source: sourcePath,
      dest: destPath,
      hash: subagent.hash,
      imported_at: new Date().toISOString(),
    });
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    writeLine(stdout, `imported ${source} → ${destPath}`);
    return { roleName, destPath, manifestPath };
  }

  throw usageError([command]);

  // ── command handlers (inner closures) ─────────────────────────────────────
  // These close over runLocalMaestroCommand's parameters (args, cwd, stdout,
  // stderr, store, stdin, runner, gitRunner, availabilityProbe, …). Declared
  // as function declarations so they hoist above the dispatch block above.

  async function handleEventsCommand() {
    const parsed = parseEventsArgs(args, cwd);
    warnFlags(parsed.unknownFlags, "events", stderr);
    const taskStore = makeStore(parsed, store);

    // Cross-task query over the materialised events table (--all). No task id.
    if (parsed.all) {
      let events = [];
      try {
        const db = store && typeof store.queryStageEvents === "function"
          ? store
          : await openStore(path.join(taskStore.root, "maestro.db"));
        events = await db.queryStageEvents({
          stage: parsed.stage ?? undefined,
          status: parsed.status ?? undefined,
          workflow_id: parsed.workflow ?? undefined,
        });
      } catch {
        events = [];
      }
      if (parsed.json) {
        writeLine(stdout, JSON.stringify(events, null, 2));
      } else {
        for (const event of events) {
          const artifacts = (event.artifacts ?? []).length > 0 ? `  ${event.artifacts.join(" ")}` : "";
          writeLine(stdout, [
            String(event.task_id ?? "-").padEnd(20),
            String(event.stage ?? "").padEnd(12),
            String(event.status ?? "").padEnd(10),
            String(event.model || "-").padEnd(16),
            `${event.tokens ?? 0}t`.padStart(8),
            formatDurationMs(event.duration_ms ?? 0).padStart(6),
            artifacts,
          ].join(" "));
        }
      }
      return { events };
    }

    // Per-task live projection (correct even before materialisation / mid-run).
    const id = parsed.positional[0];
    if (!id) throw new Error("missing_task_id");
    const task = await taskStore.readTask(id);
    const events = getStageEvents(task);
    if (parsed.json) {
      writeLine(stdout, JSON.stringify(events, null, 2));
    } else {
      for (const event of events) {
        const artifacts = event.artifacts.length > 0 ? `  ${event.artifacts.join(" ")}` : "";
        writeLine(stdout, [
          String(event.stage).padEnd(12),
          String(event.status).padEnd(10),
          String(event.model || "-").padEnd(16),
          `${event.tokens}t`.padStart(8),
          formatDurationMs(event.duration_ms).padStart(6),
          artifacts,
        ].join(" "));
      }
    }
    return { task, events };
  }

  async function handleArtifactsCommand() {
    const parsed = parseArtifactsArgs(args, cwd);
    warnFlags(parsed.unknownFlags, "artifacts", stderr);
    const id = parsed.positional[0];
    if (!id) throw new Error("missing_task_id");
    const taskStore = makeStore(parsed, store);
    const task = await taskStore.readTask(id).catch(() => null);
    const runDir = task?.run_dir ?? path.join(taskStore.root, "runs", id);
    const taskForIndex = { ...(task ?? {}), run_dir: runDir };
    const selector = parsed.positional[1];

    if (!selector) {
      const entries = await buildArtifactIndex(taskForIndex);
      if (parsed.json) {
        writeLine(stdout, JSON.stringify(entries, null, 2));
      } else {
        for (const e of entries) {
          writeLine(stdout, [
            String(e.role ?? "-").padEnd(14),
            String(e.kind).padEnd(8),
            String(e.bytes ?? "-").padStart(9),
            String(e.modified ?? "-").padEnd(26),
            String(e.sha256 ?? "-").slice(0, 12).padEnd(12),
            e.name,
          ].join(" "));
        }
      }
      return { entries };
    }

    const resolved = await resolveArtifact(taskForIndex, selector);
    if (!resolved) throw new Error(`unknown_artifact: ${selector}`);
    if (parsed.json) {
      writeLine(stdout, JSON.stringify(resolved.entry, null, 2));
    } else if (parsed.tail) {
      const text = await tailFile(resolved.path);
      writeLine(stdout, text ?? "");
    } else if (parsed.cat || (!parsed.tail && !parsed.json)) {
      const text = await fs.readFile(resolved.path, "utf8").catch(() => "");
      writeLine(stdout, text);
    }
    return { entry: resolved.entry, path: resolved.path };
  }

  async function handleRerunCommand() {
    const parsed = parseRerunArgs(args, cwd);
    warnFlags(parsed.unknownFlags, "rerun", stderr);
    const id = parsed.positional[0];
    if (!id) throw new Error("missing_task_id");
    const taskStore = makeStore(parsed, store);
    const srcTask = await taskStore.readTask(id).catch(() => null);
    const runDir = srcTask?.run_dir ?? path.join(taskStore.root, "runs", id);
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(path.join(runDir, "run-manifest.json"), "utf8"));
    } catch {
      throw new Error(`no_run_manifest: ${id}`);
    }
    const inputs = manifestToTaskInputs(manifest);

    if (parsed.dryRun) {
      // Print the manifest + resolved inputs; create nothing.
      writeLine(stdout, JSON.stringify({ manifest, inputs }, null, 2));
      return { manifest, inputs };
    }

    // Pin the captured workflow snapshot under a sanitized name so a later edit
    // to the original workflow cannot change what this replay runs. writeWorkflow
    // shallow-merges over DEFAULT_WORKFLOW; harmless here as the snapshot is a
    // full resolved workflow object (first pin of a complete snapshot).
    const name = sanitizeRerunWorkflowName(id);
    await taskStore.writeWorkflow(name, manifest.workflow_snapshot ?? {});
    const newTask = await taskStore.createTask({ ...inputs, workflow: name });

    if (parsed.noRun) {
      writeLine(stdout, newTask.id);
      return { task: newTask };
    }
    writeLine(stdout, newTask.id);
    return runCreatedLocalTask({
      taskStore,
      taskId: newTask.id,
      cwd,
      stdout,
      stderr,
      runner,
      gitRunner,
      availabilityProbe,
    });
  }

  async function handleImportCommand() {
    const parsed = parseSharedStateArgs(args, cwd);
    const [bundlePath, ...rest] = parsed.positional;
    if (!bundlePath) throw new Error("missing_bundle_path (usage: maestro import <bundle-dir-or-file> [--dry-run] [--force] [--yes])");
    warnFlags(findUnknownFlags(rest, new Set(["--dry-run", "--force", "--yes"])), "import", stderr);
    const { readBundle, importBundle } = await import("../setup/export.mjs");
    const bundle = await readBundle(path.resolve(cwd, bundlePath));
    const taskStore = makeStore(parsed, store);

    // Surface provider definitions the bundle would install — these execute
    // commands on later task runs, so they must be visible before import.
    let incomingProviders;
    try {
      incomingProviders = JSON.parse(bundle.files["providers.json"] ?? "{}");
    } catch (error) {
      throw new Error(`bundle_providers_malformed: providers.json is not valid JSON (${error.message})`);
    }
    const currentProviders = (await taskStore.readConfigRaw())?.providers ?? {};
    const force = rest.includes("--force");
    const providerChanges = Object.entries(incomingProviders).filter(([key, def]) => {
      const existing = currentProviders[key];
      if (!existing) return true;
      return force && JSON.stringify(existing) !== JSON.stringify(def);
    });
    writeLine(stdout, `bundle "${bundle.manifest.name}": ${Object.keys(bundle.files).length} files, ${bundle.manifest.credits?.length ?? 0} credits`);
    for (const [key, def] of providerChanges) {
      const template = def?.custom?.command_template ?? "-";
      const envKeys = Object.keys(def?.env ?? {});
      writeLine(stdout, `  provider ${key}: adapter=${def?.adapter ?? "?"} command_template=${template} env_keys=[${envKeys.join(", ")}]`);
    }
    if (rest.includes("--dry-run")) {
      writeLine(stdout, "dry run — nothing written");
      return { bundle, applied: false };
    }
    if (providerChanges.length > 0 && !rest.includes("--yes")) {
      if (stdin.isTTY !== true) {
        writeLine(stdout, "non-interactive session and bundle changes providers — re-run with --yes to apply (nothing written)");
        return { bundle, applied: false };
      }
      const readline = await import("node:readline");
      const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
      const answer = await new Promise((resolve) => rl.question(
        `bundle installs/changes ${providerChanges.length} provider definition(s) (commands above run on future tasks). Continue? [y/N]: `,
        resolve,
      ));
      rl.close();
      if (!/^y(es)?$/i.test(String(answer).trim())) {
        writeLine(stdout, "aborted — nothing written");
        return { bundle, applied: false };
      }
    }
    const result = await importBundle({
      bundle,
      stateDir: parsed.stateDir,
      store: taskStore,
      force,
    });
    for (const warning of result.validation.warnings) {
      writeLine(stderr, `workflow warning [${warning.code}]: ${warning.message}`);
    }
    writeLine(stdout, `imported bundle "${bundle.manifest.name}" into ${parsed.stateDir} (workflow.json backed up to workflow.json.bak)`);
    return { bundle, applied: true };
  }

  async function handleWorkflowCommand() {
    const parsed = parseSharedStateArgs(args, cwd);
    const [action, ...rest] = parsed.positional;
    if (action === "validate") {
      warnFlags(findUnknownFlags(rest, new Set(["--json", "--strict"])), "workflow validate", stderr);
      const taskStore = makeStore(parsed, store);
      const [workflow, config] = await Promise.all([
        taskStore.readWorkflow(),
        taskStore.readConfig(),
      ]);
      const result = validateWorkflow(workflow, { config });
      writeLine(stdout, rest.includes("--json")
        ? JSON.stringify(result, null, 2)
        : formatValidation(result));
      const strict = rest.includes("--strict");
      if (!result.ok || (strict && result.warnings.length > 0)) {
        process.exitCode = 1;
      }
      return result;
    }
    if (action === "list") {
      warnFlags(findUnknownFlags(rest, new Set(["--json"])), "workflow list", stderr);
      const taskStore = makeStore(parsed, store);
      const workflows = await taskStore.listWorkflows();
      if (rest.includes("--json")) {
        writeLine(stdout, JSON.stringify(workflows, null, 2));
      } else if (workflows.length === 0) {
        writeLine(stdout, "no workflows (run 'maestro init' or 'maestro workflow use <name>')");
      } else {
        for (const wf of workflows) {
          writeLine(stdout, `${wf.name} (${wf.source})`);
        }
      }
      return { workflows };
    }
    if (action === "use") {
      warnFlags(findUnknownFlags(rest, new Set(["--as"])), "workflow use", stderr);
      const positional = [];
      let asName = null;
      let asSeen = false;
      for (let index = 0; index < rest.length; index += 1) {
        if (rest[index] === "--as") {
          asSeen = true;
          index += 1;
          asName = rest[index] ?? "";
          continue;
        }
        if (!rest[index].startsWith("-")) positional.push(rest[index]);
      }
      // A bare "--as" with no value must error, not silently fall back to the
      // legacy default-slot path.
      if (asSeen && !asName) throw usageError(["workflow", "use"]);
      const name = positional[0];
      if (!name) throw usageError(["workflow", "use"]);
      // With --as: write into a named slot (workflows/<as>.json). Without:
      // legacy behavior — replace the default workflow.json via the module path.
      if (asName) {
        const taskStore = makeStore(parsed, store);
        const result = await taskStore.applyWorkflowTemplate({ name, as: asName });
        const roles = Object.entries(result.workflow.roles)
          .map(([role, def]) => `${role}(${def.provider})`)
          .join(" → ");
        writeLine(stdout, `workflow "${asName}" now uses template "${name}": ${roles}`);
        writeLine(stdout, `modes: ${Object.keys(result.workflow.modes ?? {}).join(", ")}`);
        return result;
      }
      const { applyWorkflowTemplate } = await import("../setup/workflow-templates.mjs");
      const result = await applyWorkflowTemplate({ name, stateDir: parsed.stateDir });
      if (result.backupPath) {
        writeLine(stdout, `backed up previous workflow → ${result.backupPath}`);
      }
      const roles = Object.entries(result.workflow.roles)
        .map(([role, def]) => `${role}(${def.provider})`)
        .join(" → ");
      writeLine(stdout, `workflow.json now uses template "${name}": ${roles}`);
      writeLine(stdout, `modes: ${Object.keys(result.workflow.modes ?? {}).join(", ")}`);
      return result;
    }
    throw usageError(["workflow", action]);
  }

  async function handleRoleCommand() {
    const parsed = parseSharedStateArgs(args, cwd);
    const [action, ...rest] = parsed.positional;
    const unit = rest.find((token) => !token.startsWith("-"));

    if (action === "list") {
      const roles = [];
      const rolesDir = path.join(parsed.stateDir, "roles");
      try {
        const entries = await fs.readdir(rolesDir);
        for (const entry of entries.filter((name) => name.endsWith(".md")).sort()) {
          roles.push({ name: path.basename(entry, ".md"), kind: "native", path: path.join(rolesDir, entry) });
        }
      } catch {
        // no native roles dir — skip
      }
      const subagents = await scanSubagents(path.join(cwd, ".claude", "agents"));
      for (const sub of subagents) {
        roles.push({ name: slugifyRoleName(sub.name), kind: "claude-subagent", path: sub.path });
      }
      if (rest.includes("--json")) {
        writeLine(stdout, JSON.stringify(roles, null, 2));
      } else if (roles.length === 0) {
        writeLine(stdout, "no role units (looked in .maestro/roles and .claude/agents)");
      } else {
        for (const role of roles) writeLine(stdout, `${role.name} (${role.kind})`);
      }
      return { roles };
    }

    if (action === "show") {
      if (!unit) throw usageError(["role", "show"]);
      const result = await loadRole(unit, { cwd });
      if (!result.ok) {
        writeLine(stderr, `role show failed: ${result.error.message}`);
        process.exitCode = 1;
        return result;
      }
      writeLine(stdout, JSON.stringify(result.roleDef, null, 2));
      return result;
    }

    if (action === "lint") {
      if (!unit) throw usageError(["role", "lint"]);
      const result = await loadRole(unit, { cwd });
      if (!result.ok) {
        writeLine(stderr, `${result.error.code}: ${result.error.message}`);
        process.exitCode = 1;
      } else {
        writeLine(stdout, `ok: ${unit}`);
      }
      return result;
    }

    throw usageError(["role", action]);
  }
}
