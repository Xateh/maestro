import { spawn } from "node:child_process";
import path from "node:path";

import { usageError } from "./registry.mjs";
import { loadLocalSecrets, runKeysWizard } from "../setup/keys.mjs";
import { runLocalSetup } from "../setup/local.mjs";
import { DEFAULT_LOCAL_STATE_DIR } from "../task-store.mjs";
import { formatTaskDetails, runMaestroTui } from "../tui.mjs";
import { formatValidation, validateWorkflow } from "../workflow-validate.mjs";

import { defaultGitRunner, defaultHostRunner } from "./git-exec.mjs";
import {
  makeStore,
  parseActionArgs,
  parseEditActionArgs,
  parseInspectArgs,
  parseSharedStateArgs,
  parseTaskArgs,
} from "./parse-args.mjs";
import { runProjectCommand } from "./projects.mjs";
import { attachReceipt, feedbackReceipt, withReceipt, writeResultReceipt } from "./receipts.mjs";
import {
  handleApproveAction,
  handleCancelTask,
  handleDenyAction,
  handleEditAction,
  handleExtendTimeout,
  handleMarkDone,
  handleRetryTask,
  handleRunAction,
} from "./task-handlers.mjs";
import {
  createLocalTaskFromParsed,
  recoverStaleRunningTasks,
  runCreatedLocalTask,
  startDetachedExistingTask,
  startDetachedLocalTask,
} from "./tasks-run.mjs";
import { writeLine } from "./util.mjs";

export async function runLocalMaestroCommand({
  args,
  cwd = process.cwd(),
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  store = null,
  runner = null,
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
    return runProjectCommand({ args, cwd, stdout, store, gitRunner });
  }

  if (command === "tui") {
    const parsed = parseSharedStateArgs(args, cwd);
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
    });
  }

  if (command === "task") {
    const parsed = parseTaskArgs(args, cwd);
    const taskStore = makeStore(parsed, store);
    const defaults = await taskStore.readConfig();
    if (parsed.mode !== "task") {
      const workflow = await taskStore.readWorkflow();
      if (!workflow.modes?.[parsed.mode]) {
        throw new Error(`unknown_mode: ${parsed.mode} (defined modes: ${Object.keys(workflow.modes ?? {}).join(", ")})`);
      }
    }
    const task = await createLocalTaskFromParsed({ parsed, taskStore, defaults, cwd, gitRunner, stdout });
    if (onTaskCreated) {
      onTaskCreated(task);
    }
    return runCreatedLocalTask({ taskStore, taskId: task.id, cwd, stdout, stderr, runner, gitRunner });
  }

  if (command === "run-task") {
    const parsed = parseSharedStateArgs(args, cwd);
    const taskId = parsed.positional[0];
    if (!taskId) throw new Error("missing_task_id");
    const taskStore = makeStore(parsed, store);
    return runCreatedLocalTask({ taskStore, taskId, cwd, stdout, stderr, runner, gitRunner });
  }

  if (command === "approve" || command === "deny") {
    const parsed = parseActionArgs(args, cwd);
    const taskId = parsed.positional[0];
    if (!taskId) throw new Error("missing_task_id");
    const taskStore = makeStore(parsed, store);
    const approved = command === "approve";
    const before = await taskStore.readTask(taskId);
    const task = await taskStore.decideApproval(taskId, { approved, note: parsed.note });
    writeLine(stdout, `task ${task.id} approval ${approved ? "approved" : "denied"}`);
    let result = { task };
    if (task.status === "queued") {
      result = await runCreatedLocalTask({ taskStore, taskId, cwd, stdout, stderr, runner, gitRunner });
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
    const resumed = await runCreatedLocalTask({ taskStore, taskId, cwd, stdout, stderr, runner, gitRunner });
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
    const taskId = parsed.positional[0];
    if (!taskId) throw new Error("missing_task_id");
    const taskStore = makeStore(parsed, store);
    const result = await handleCancelTask({ taskStore, taskId, note: parsed.note, stdout });
    writeResultReceipt(stdout, result);
    return result;
  }

  if (command === "status") {
    const parsed = parseSharedStateArgs(args, cwd);
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
    const id = parsed.positional[0];
    if (!id) throw new Error("missing_task_id");
    const taskStore = makeStore(parsed, store);
    const task = await taskStore.readTask(id);
    writeLine(stdout, parsed.json
      ? JSON.stringify(task, null, 2)
      : formatTaskDetails(task, { color: parsed.color, sections: true }));
    return { task };
  }

  if (command === "init") {
    const parsed = parseSharedStateArgs(args, cwd);
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
      await runKeysWizard({ stateDir: parsed.stateDir, args: rest, stdin, stdout });
      return {};
    }
    if (action === "local") {
      const taskStore = makeStore(parsed, store);
      return runLocalSetup({ store: taskStore, args: rest, stdin, stdout });
    }
    if (action === "import") {
      const taskStore = makeStore(parsed, store);
      const { runImportWizard } = await import("../setup/import.mjs");
      return runImportWizard({ store: taskStore, stateDir: parsed.stateDir, args: rest, stdin, stdout, stderr });
    }
    throw usageError(["setup", action]);
  }

  if (command === "export") {
    const parsed = parseSharedStateArgs(args, cwd);
    const rest = parsed.positional;
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

  if (command === "import") {
    const parsed = parseSharedStateArgs(args, cwd);
    const [bundlePath, ...rest] = parsed.positional;
    if (!bundlePath) throw new Error("missing_bundle_path (usage: maestro import <bundle-dir-or-file> [--dry-run] [--force] [--yes])");
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

  if (command === "workflow") {
    const parsed = parseSharedStateArgs(args, cwd);
    const [action, ...rest] = parsed.positional;
    if (action === "validate") {
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
    if (action === "use") {
      const name = rest.find((arg) => !arg.startsWith("-"));
      if (!name) throw usageError(["workflow", "use"]);
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

  throw usageError([command]);
}
