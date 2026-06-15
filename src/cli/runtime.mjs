// Server runtime wiring. Reads config.json ONCE at startup (live reload dropped,
// decision SP0b#2), resolves the `server` block via resolveServerConfig, and
// constructs the unified dispatch path:
//   LinearTrackerClient -> MaestroOrchestrator -> TaskGraphRunner -> runTaskGraph
// (the same graph-engine bundle used by the CLI and MCP spawn paths).

import { defaultGitRunner } from "./git-exec.mjs";
import { runTaskGraph } from "./tasks-run.mjs";
import { startMaestroHttpServer } from "../http-server.mjs";
import { LinearTrackerClient } from "../linear-tracker.mjs";
import { StructuredLogger } from "../logger.mjs";
import { MaestroOrchestrator } from "../orchestrator.mjs";
import { resolveServerConfig, validateServerConfig } from "../setup/server-config.mjs";
import { TaskGraphRunner } from "../task-graph-runner.mjs";
import { DEFAULT_LOCAL_STATE_DIR, LocalTaskStore } from "../task-store.mjs";
import { WorkspaceManager } from "../workspace.mjs";

function buildTracker(serverConfig, deps = {}) {
  if (deps.tracker) return deps.tracker;
  return new LinearTrackerClient({
    endpoint: serverConfig.tracker.endpoint,
    apiKey: serverConfig.tracker.apiKey,
    projectSlug: serverConfig.tracker.projectSlug,
  });
}

function buildWorkspaceManager(serverConfig, logger) {
  return new WorkspaceManager({
    root: serverConfig.workspace.root,
    hooks: serverConfig.hooks,
    logger,
  });
}

export async function startMaestro({
  configPath = null,
  stateDir = DEFAULT_LOCAL_STATE_DIR,
  port = null,
  env = process.env,
  logger = new StructuredLogger(),
  // Test seams — production leaves these defaulted.
  deps = {},
} = {}) {
  const root = configPath ?? stateDir ?? DEFAULT_LOCAL_STATE_DIR;
  const taskStore = deps.taskStore ?? new LocalTaskStore({ root });
  await taskStore.init();

  // Read config ONCE (no watch). resolveServerConfig works off config.json's
  // `server` block; baseDir is the state dir's parent so relative workspace.root
  // values resolve the same way the old dispatch config path did.
  const config = await taskStore.readConfig();
  const serverConfig = resolveServerConfig(config, {
    env,
    baseDir: deps.baseDir ?? taskStore.root,
  });
  validateServerConfig(serverConfig);

  const tracker = buildTracker(serverConfig, deps);
  const workspaceManager = deps.workspaceManager ?? buildWorkspaceManager(serverConfig, logger);

  const gitRunner = deps.gitRunner ?? defaultGitRunner;
  const runTask = deps.runTask
    ?? ((taskId, opts = {}) => runTaskGraph({
      taskStore,
      taskId,
      stdout: opts.stdout,
      stderr: opts.stderr,
      runner: opts.runner ?? null,
      gitRunner,
      availabilityProbe: opts.availabilityProbe ?? null,
    }));

  const runner = deps.runner ?? new TaskGraphRunner({
    taskStore,
    serverConfig,
    workspaceManager,
    runTask,
    gitRunner,
    logger,
  });

  const orchestrator = new MaestroOrchestrator({
    config: serverConfig,
    tracker,
    runner,
    workspaceManager,
    logger,
  });

  const effectivePort = port ?? serverConfig.port;
  const httpServer = (effectivePort === null || effectivePort === undefined)
    ? null
    : await startMaestroHttpServer({
      orchestrator,
      port: effectivePort,
      host: "127.0.0.1",
    });
  if (httpServer) {
    logger.info("maestro_http_started", { host: httpServer.host, port: httpServer.port });
  }

  const poll = async () => {
    try {
      await orchestrator.tick();
    } catch (error) {
      logger.error("maestro_tick_failed", { error: error.message });
    }
  };
  const interval = setInterval(() => {
    void poll();
  }, serverConfig.polling.intervalMs);
  if (typeof interval.unref === "function") interval.unref();
  void poll();

  return {
    taskStore,
    serverConfig,
    tracker,
    workspaceManager,
    runner,
    orchestrator,
    httpServer,
    stop: async () => {
      clearInterval(interval);
      await orchestrator.stop();
      if (httpServer) await httpServer.close();
    },
  };
}
