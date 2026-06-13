import fs from "node:fs/promises";
import path from "node:path";

import { usageError } from "./registry.mjs";
import { slugifyTaskTitle } from "../task-store.mjs";

import { buildUnblockOptions } from "./action-requests.mjs";
import { gitStdout, gitSucceeds, runGit } from "./git-exec.mjs";
import { makeStore, normalizeProjectId, parseProjectArgs } from "./parse-args.mjs";
import { exitCodeFromError, isInside, nowIso, pathExists, writeLine } from "./util.mjs";

export function projectWorktreeRoot(cwd, config) {
  return path.resolve(cwd, config.worktree_root ?? ".maestro/worktrees");
}

async function assertMaestroRootIgnored({ gitRunner, cwd }) {
  try {
    await runGit(gitRunner, cwd, ["check-ignore", "-q", ".maestro/"]);
  } catch {
    throw new Error("maestro_root_not_ignored: add .maestro/ to .gitignore before using project worktrees");
  }
}

async function assertCleanTarget({ gitRunner, cwd, targetBranch }) {
  const status = await gitStdout(gitRunner, cwd, ["status", "--porcelain"]);
  if (status) {
    throw new Error(`dirty_target_branch: ${targetBranch} has uncommitted changes; commit first or use current-cwd mode`);
  }
}

export async function assertBranchUnused({ gitRunner, cwd, branch }) {
  const exists = await gitSucceeds(gitRunner, cwd, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  if (exists) throw new Error(`branch_exists: ${branch}`);
}

async function countWorktrees(worktreeRoot) {
  try {
    const projects = await fs.readdir(worktreeRoot, { withFileTypes: true });
    let count = 0;
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const entries = await fs.readdir(path.join(worktreeRoot, project.name), { withFileTypes: true });
      count += entries.filter((entry) => entry.isDirectory()).length;
    }
    return count;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

export async function createProject({ taskStore, id, target, cwd, stdout, gitRunner }) {
  const config = await taskStore.readConfig();
  const projectId = normalizeProjectId(id);
  await assertMaestroRootIgnored({ gitRunner, cwd });
  const currentBranch = await gitStdout(gitRunner, cwd, ["branch", "--show-current"]);
  const targetBranch = target || currentBranch || "main";
  await assertCleanTarget({ gitRunner, cwd, targetBranch });
  const worktreeRoot = projectWorktreeRoot(cwd, config);
  const ownedCount = await countWorktrees(worktreeRoot);
  if (ownedCount >= (config.max_parallel_worktrees ?? 4)) {
    throw new Error(`max_parallel_worktrees_exceeded: ${ownedCount}`);
  }

  const integrationBranch = `maestro/${projectId}/integration`;
  await assertBranchUnused({ gitRunner, cwd, branch: integrationBranch });
  const integrationWorktree = path.join(worktreeRoot, projectId, "integration");
  const targetHead = await gitStdout(gitRunner, cwd, ["rev-parse", "HEAD"]);
  await fs.mkdir(path.dirname(integrationWorktree), { recursive: true });
  await runGit(gitRunner, cwd, ["worktree", "add", "-b", integrationBranch, integrationWorktree, targetBranch]);

  const localFileWarnings = [];
  if (await pathExists(path.join(cwd, ".env"))) {
    localFileWarnings.push({ path: ".env", status: "not_copied", sensitive: true });
  }

  const createdAt = nowIso();
  const project = await taskStore.createProject({
    id: projectId,
    status: "open",
    target_branch: targetBranch,
    target_head: targetHead,
    integration_branch: integrationBranch,
    integration_worktree: integrationWorktree,
    worktree_root: worktreeRoot,
    created_at: createdAt,
    updated_at: createdAt,
    tasks: [],
    path_leases: {},
    blockers: [],
    cleanup_blockers: [],
    local_file_warnings: localFileWarnings,
    ledger: [{
      event: "project_created",
      target_branch: targetBranch,
      target_head: targetHead,
      integration_branch: integrationBranch,
      integration_worktree: integrationWorktree,
      at: createdAt,
    }],
  });
  writeLine(stdout, `project ${project.id} open ${project.integration_branch}`);
  for (const warning of localFileWarnings) {
    writeLine(stdout, `local file ${warning.path} not copied (${warning.sensitive ? "sensitive" : "local"})`);
  }
  return { project };
}

export function conflictingLeases(project, writePaths = [], { ignoreTaskId = null } = {}) {
  const leases = project.path_leases ?? {};
  return writePaths
    .filter((target) => leases[target] && leases[target].task_id !== ignoreTaskId)
    .map((target) => ({ path: target, ...leases[target] }));
}

export function taskAliasForProject(project, prompt) {
  const base = slugifyTaskTitle(prompt).slice(0, 48) || "task";
  const used = new Set((project.tasks ?? []).map((task) => task.alias).filter(Boolean));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export async function addProjectTaskRecord(taskStore, project, record) {
  const next = await taskStore.updateProject(project.id, {
    tasks: [
      ...(project.tasks ?? []),
      record,
    ],
  });
  return next;
}

async function upsertProjectTaskRecord(taskStore, project, record) {
  const records = project.tasks ?? [];
  const exists = records.some((item) => item.id === record.id);
  const tasks = exists
    ? records.map((item) => (item.id === record.id ? { ...item, ...record } : item))
    : [...records, record];
  return taskStore.updateProject(project.id, { tasks });
}

export async function acquirePathLeases(taskStore, projectId, taskId, writePaths) {
  if (writePaths.length === 0) return;
  const project = await taskStore.readProject(projectId);
  const pathLeases = { ...(project.path_leases ?? {}) };
  for (const writePath of writePaths) {
    pathLeases[writePath] = { task_id: taskId, mode: "write" };
  }
  await taskStore.updateProject(projectId, { path_leases: pathLeases });
}

export async function releasePathLeases(taskStore, task) {
  if (!task.project_id || !task.write_paths?.length) return;
  const project = await taskStore.readProject(task.project_id);
  const pathLeases = { ...(project.path_leases ?? {}) };
  for (const writePath of task.write_paths) {
    if (pathLeases[writePath]?.task_id === task.id) delete pathLeases[writePath];
  }
  await taskStore.updateProject(task.project_id, { path_leases: pathLeases });
}

export async function currentPathConflicts(taskStore, task) {
  if (!task.project_id || !task.write_paths?.length) return [];
  const project = await taskStore.readProject(task.project_id);
  return conflictingLeases(project, task.write_paths, { ignoreTaskId: task.id });
}

export async function ensureProjectTaskSetup({ taskStore, task, cwd, gitRunner }) {
  if (!task.project_id) return task;
  let project = await taskStore.readProject(task.project_id);
  const existing = (project.tasks ?? []).find((record) => record.id === task.id) ?? null;
  let branch = task.branch ?? existing?.branch ?? null;
  let worktreePath = task.worktree_path ?? existing?.worktree_path ?? null;
  let taskCwd = task.cwd;
  let alias = existing?.alias ?? (branch ? branch.split("/").at(-1) : null);

  if (task.worktree_mode === "project-worktree" && (!branch || !worktreePath)) {
    alias = alias || taskAliasForProject(project, task.prompt);
    branch = `maestro/${project.id}/task/${alias}`;
    await assertBranchUnused({ gitRunner, cwd, branch });
    worktreePath = path.join(project.worktree_root, project.id, alias);
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await runGit(gitRunner, cwd, ["worktree", "add", "-b", branch, worktreePath, project.integration_branch]);
    taskCwd = worktreePath;
  }

  const patch = {};
  if (branch !== task.branch) patch.branch = branch;
  if (worktreePath !== task.worktree_path) patch.worktree_path = worktreePath;
  if (taskCwd && taskCwd !== task.cwd) patch.cwd = taskCwd;
  if (Object.keys(patch).length > 0) {
    task = await taskStore.updateTask(task.id, patch);
  }

  project = await taskStore.readProject(task.project_id);
  await upsertProjectTaskRecord(taskStore, project, {
    id: task.id,
    alias: alias || slugifyTaskTitle(task.prompt),
    branch,
    worktree_path: worktreePath,
    write_paths: task.write_paths ?? [],
    status: task.status ?? "queued",
  });
  return taskStore.readTask(task.id);
}

export async function markProjectTaskStatus(taskStore, task, status, patch = {}) {
  if (!task.project_id) return null;
  const project = await taskStore.readProject(task.project_id);
  return taskStore.updateProject(task.project_id, {
    tasks: (project.tasks ?? []).map((record) => (
      record.id === task.id ? { ...record, status, ...patch } : record
    )),
  });
}

export async function recordProjectBlocker(taskStore, projectId, blocker) {
  const project = await taskStore.readProject(projectId);
  return taskStore.updateProject(projectId, {
    blockers: [
      ...(project.blockers ?? []),
      { ...blocker, at: nowIso() },
    ],
  });
}

export async function finalizeProjectTask({ taskStore, task, gitRunner, stdout }) {
  if (!task.project_id) return task;
  await releasePathLeases(taskStore, task);
  await markProjectTaskStatus(taskStore, task, "succeeded");
  if (!task.branch || !task.worktree_path) return task;

  const dirty = await gitStdout(gitRunner, task.worktree_path, ["status", "--porcelain"]);
  if (dirty) {
    await runGit(gitRunner, task.worktree_path, ["add", "-A"]);
    await runGit(gitRunner, task.worktree_path, ["commit", "-m", `maestro: ${task.id}`]);
  }
  const project = await taskStore.readProject(task.project_id);
  try {
    await runGit(gitRunner, project.integration_worktree, ["merge", "--no-ff", task.branch, "-m", `maestro: merge ${task.id}`]);
    writeLine(stdout, `task ${task.id} merged into ${project.integration_branch}`);
    return taskStore.updateTask(task.id, {
      blockers: (task.blockers ?? []).filter((blocker) => blocker.code !== "task_merge_conflict"),
      unblock_options: [],
    });
  } catch (error) {
    let abortResult = null;
    try {
      const abort = await runGit(gitRunner, project.integration_worktree, ["merge", "--abort"]);
      abortResult = { code: 0, stdout: abort.stdout ?? "", stderr: abort.stderr ?? "" };
    } catch (abortError) {
      abortResult = { code: exitCodeFromError(abortError), stdout: abortError.stdout ?? "", stderr: abortError.stderr ?? abortError.message };
    }
    const blocker = {
      code: "task_merge_conflict",
      task_id: task.id,
      branch: task.branch,
      integration_worktree: project.integration_worktree,
      error: error.message,
      merge_abort: abortResult,
    };
    await recordProjectBlocker(taskStore, task.project_id, blocker);
    await markProjectTaskStatus(taskStore, task, "waiting_user", { blocker });
    const nextTask = {
      ...task,
      blockers: [
        blocker,
        ...(task.blockers ?? []).filter((item) => item.code !== "task_merge_conflict"),
      ],
    };
    return taskStore.updateTask(task.id, {
      status: "waiting_user",
      active_step: null,
      blockers: nextTask.blockers,
      unblock_options: buildUnblockOptions({
        task: nextTask,
        includeRetry: true,
        includeManualDone: true,
      }),
    });
  }
}

async function closeProject({ taskStore, id, cwd, stdout, gitRunner, mergeMode = "squash" }) {
  const project = await taskStore.readProject(normalizeProjectId(id));
  if (mergeMode !== "squash") throw new Error(`unsupported_project_merge_mode: ${mergeMode}`);
  try {
    await runGit(gitRunner, cwd, ["switch", project.target_branch]);
    await runGit(gitRunner, cwd, ["merge", "--squash", project.integration_branch]);
    await runGit(gitRunner, cwd, ["commit", "-m", `maestro: close ${project.id}`]);
    const targetMergeCommit = await gitStdout(gitRunner, cwd, ["rev-parse", "HEAD"]);
    const closed = await taskStore.updateProject(project.id, {
      status: "closed",
      target_merge_commit: targetMergeCommit,
      ledger: [
        ...(project.ledger ?? []),
        {
          event: "project_closed",
          mode: "squash",
          target_merge_commit: targetMergeCommit,
          at: nowIso(),
        },
      ],
    });
    writeLine(stdout, `project ${project.id} closed ${targetMergeCommit}`);
    return { project: closed };
  } catch (error) {
    const mergeFix = await taskStore.createTask({
      prompt: `Resolve Maestro merge conflict for project ${project.id}`,
      mode: "merge-fix",
      cwd: project.integration_worktree,
      plannerPolicy: "off",
      reviewEnabled: true,
      projectId: project.id,
      worktreeMode: "current-cwd",
    });
    const blocked = await taskStore.updateProject(project.id, {
      status: "close_blocked",
      blockers: [
        ...(project.blockers ?? []),
        {
          code: "target_merge_conflict",
          task_id: mergeFix.id,
          error: error.message,
          at: nowIso(),
        },
      ],
      tasks: [
        ...(project.tasks ?? []),
        {
          id: mergeFix.id,
          alias: "merge-fix",
          branch: project.integration_branch,
          worktree_path: project.integration_worktree,
          status: "queued",
        },
      ],
    });
    writeLine(stdout, `project ${project.id} close blocked: merge conflict`);
    return { project: blocked, task: mergeFix };
  }
}

async function cleanupProject({ taskStore, id, cwd, stdout, gitRunner }) {
  const project = await taskStore.readProject(normalizeProjectId(id));
  const cleanupBlockers = [];
  const cleaned = [];
  for (const task of project.tasks ?? []) {
    if (!task.worktree_path) continue;
    if (!isInside(project.worktree_root, task.worktree_path)) {
      cleanupBlockers.push({
        task_id: task.id,
        code: "worktree_outside_project_root",
        worktree_path: task.worktree_path,
      });
      continue;
    }
    const status = await gitStdout(gitRunner, task.worktree_path, ["status", "--porcelain"]);
    if (status) {
      const patch = await gitStdout(gitRunner, task.worktree_path, ["diff"]);
      const patchPath = path.join(taskStore.patchesDir, `${task.id}.patch`);
      await fs.writeFile(patchPath, `${patch}${patch.endsWith("\n") ? "" : "\n"}`);
      cleanupBlockers.push({
        task_id: task.id,
        code: "dirty_worktree",
        worktree_path: task.worktree_path,
        patch_path: patchPath,
      });
      continue;
    }
    await runGit(gitRunner, cwd, ["worktree", "remove", task.worktree_path]);
    if (project.delete_closed_project_branches !== false && task.branch) {
      const mergedIntoIntegration = await gitSucceeds(gitRunner, cwd, ["merge-base", "--is-ancestor", task.branch, project.integration_branch]);
      if (mergedIntoIntegration) {
        await runGit(gitRunner, cwd, ["branch", "-d", task.branch]);
      }
    }
    cleaned.push(task.id);
  }
  if (cleanupBlockers.length === 0 && project.target_merge_commit && project.integration_worktree) {
    if (!isInside(project.worktree_root, project.integration_worktree)) {
      cleanupBlockers.push({
        code: "integration_worktree_outside_project_root",
        worktree_path: project.integration_worktree,
      });
    } else {
      const integrationStatus = await gitStdout(gitRunner, project.integration_worktree, ["status", "--porcelain"]);
      if (integrationStatus) {
        const patch = await gitStdout(gitRunner, project.integration_worktree, ["diff"]);
        const patchPath = path.join(taskStore.patchesDir, `${project.id}-integration.patch`);
        await fs.writeFile(patchPath, `${patch}${patch.endsWith("\n") ? "" : "\n"}`);
        cleanupBlockers.push({
          code: "dirty_integration_worktree",
          worktree_path: project.integration_worktree,
          patch_path: patchPath,
        });
      } else {
        await runGit(gitRunner, cwd, ["worktree", "remove", project.integration_worktree]);
        await runGit(gitRunner, cwd, ["branch", "-D", project.integration_branch]);
      }
    }
  }
  const nextStatus = cleanupBlockers.length > 0 ? "cleanup_blocked" : project.status;
  const updated = await taskStore.updateProject(project.id, {
    status: nextStatus,
    cleanup_blockers: cleanupBlockers,
    cleaned_worktrees: cleaned,
  });
  writeLine(stdout, `project ${project.id} cleanup ${nextStatus}`);
  return { project: updated };
}

export async function runProjectCommand({ args, cwd, stdout, store, gitRunner }) {
  const parsed = parseProjectArgs(args, cwd);
  const taskStore = makeStore(parsed, store);
  const projectId = parsed.positional[0];
  if (parsed.action === "create") {
    if (!projectId) throw new Error("missing_project_id");
    return createProject({
      taskStore,
      id: projectId,
      target: parsed.target,
      cwd,
      stdout,
      gitRunner,
    });
  }
  if (parsed.action === "status") {
    const projects = await taskStore.listProjects();
    if (projects.length === 0) {
      writeLine(stdout, "No Maestro projects");
    }
    for (const project of projects) {
      writeLine(stdout, `${project.id} ${project.status} ${project.target_branch ?? "-"}`);
    }
    return { projects };
  }
  if (parsed.action === "inspect") {
    if (!projectId) throw new Error("missing_project_id");
    const project = await taskStore.readProject(normalizeProjectId(projectId));
    writeLine(stdout, JSON.stringify(project, null, 2));
    return { project };
  }
  if (parsed.action === "sync-target") {
    if (!projectId) throw new Error("missing_project_id");
    const project = await taskStore.readProject(normalizeProjectId(projectId));
    const targetHead = await gitStdout(gitRunner, cwd, ["rev-parse", "HEAD"]);
    const updated = await taskStore.updateProject(project.id, {
      target_head: targetHead,
      target_synced_at: nowIso(),
    });
    writeLine(stdout, `project ${project.id} target ${targetHead}`);
    return { project: updated };
  }
  if (parsed.action === "close") {
    if (!projectId) throw new Error("missing_project_id");
    const config = await taskStore.readConfig();
    return closeProject({
      taskStore,
      id: projectId,
      cwd,
      stdout,
      gitRunner,
      mergeMode: parsed.mergeMode ?? config.project_close_merge_mode ?? "squash",
    });
  }
  if (parsed.action === "cleanup") {
    if (!projectId) throw new Error("missing_project_id");
    return cleanupProject({ taskStore, id: projectId, cwd, stdout, gitRunner });
  }
  throw usageError(["project", parsed.action]);
}
