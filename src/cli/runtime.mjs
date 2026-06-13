import { CodexAgentRunner } from "../codex-client.mjs";
import { startMaestroHttpServer } from "../http-server.mjs";
import { LinearTrackerClient } from "../linear-tracker.mjs";
import { StructuredLogger } from "../logger.mjs";
import { MaestroOrchestrator } from "../orchestrator.mjs";
import { WorkflowStore, validateDispatchConfig } from "../workflow.mjs";
import { WorkspaceManager } from "../workspace.mjs";

function buildTracker(config) {
  return new LinearTrackerClient({
    endpoint: config.tracker.endpoint,
    apiKey: config.tracker.apiKey,
    projectSlug: config.tracker.projectSlug,
  });
}

function buildWorkspaceManager(config, logger) {
  return new WorkspaceManager({
    root: config.workspace.root,
    hooks: config.hooks,
    logger,
  });
}

function buildRuntime({ workflowStore, logger }) {
  const { config } = workflowStore.current;
  const tracker = buildTracker(config);
  const workspaceManager = buildWorkspaceManager(config, logger);
  const runner = new CodexAgentRunner({
    workflowStore,
    workspaceManager,
    tracker,
    logger,
  });
  const orchestrator = new MaestroOrchestrator({
    config,
    tracker,
    runner,
    workspaceManager,
    logger,
  });
  return { tracker, workspaceManager, runner, orchestrator };
}

async function applyReload({ workflowStore, runtime, logger, previous }) {
  const { config } = workflowStore.current;
  try {
    validateDispatchConfig(config);
  } catch (error) {
    workflowStore.current = previous;
    logger.error("workflow_reload_rejected", { error: error.message });
    return false;
  }

  runtime.tracker = buildTracker(config);
  runtime.workspaceManager = buildWorkspaceManager(config, logger);
  runtime.runner.tracker = runtime.tracker;
  runtime.runner.workspaceManager = runtime.workspaceManager;
  runtime.orchestrator.tracker = runtime.tracker;
  runtime.orchestrator.workspaceManager = runtime.workspaceManager;
  runtime.orchestrator.updateConfig(config);
  logger.info("workflow_reload_applied", { workflow_path: workflowStore.workflowPath });
  return true;
}

export async function startMaestro({ workflowPath, port = null, env = process.env, logger = new StructuredLogger() }) {
  const workflowStore = new WorkflowStore({ workflowPath, env, logger });
  await workflowStore.loadInitial();
  validateDispatchConfig(workflowStore.current.config);

  const runtime = buildRuntime({ workflowStore, logger });
  let stopWatch = () => {};
  stopWatch = workflowStore.watch((next, previous) => {
    workflowStore.current = next;
    void applyReload({ workflowStore, runtime, logger, previous });
  });

  const effectivePort = port ?? workflowStore.current.config.server.port;
  const httpServer = effectivePort === null
    ? null
    : await startMaestroHttpServer({
      orchestrator: runtime.orchestrator,
      port: effectivePort,
      host: "127.0.0.1",
    });
  if (httpServer) {
    logger.info("maestro_http_started", { host: httpServer.host, port: httpServer.port });
  }

  const poll = async () => {
    const previous = workflowStore.current;
    const reload = await workflowStore.reloadIfChanged();
    if (reload.changed) {
      logger.info("workflow_reload_seen", { workflow_path: workflowStore.workflowPath, previous_ok: Boolean(previous) });
    }
    try {
      validateDispatchConfig(workflowStore.current.config);
      await runtime.orchestrator.tick();
    } catch (error) {
      logger.error("maestro_tick_failed", { error: error.message });
    }
  };
  const interval = setInterval(() => {
    void poll();
  }, workflowStore.current.config.polling.intervalMs);
  void poll();

  return {
    workflowStore,
    runtime,
    httpServer,
    stop: async () => {
      clearInterval(interval);
      stopWatch();
      await runtime.orchestrator.stop();
      if (httpServer) await httpServer.close();
    },
  };
}
