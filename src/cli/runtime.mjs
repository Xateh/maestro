import { startMaestroHttpServer } from "../http-server.mjs";
import { LinearTrackerClient } from "../linear-tracker.mjs";
import { StructuredLogger } from "../logger.mjs";
import { MaestroOrchestrator } from "../orchestrator.mjs";
import { resolveDispatchConfig } from "../dispatch/config.mjs";
import { DispatchRunner } from "../dispatch/runner.mjs";
import { LocalTaskStore } from "../task-store.mjs";

// Parse server-mode args: `maestro serve [--port <n>] [--state-dir <path>]`.
// No WORKFLOW.md, no --workflow-path — the server reads the same
// .maestro/workflow.json + config.json the CLI/TUI use.
export function parseServeArgs(args = []) {
  let port = null;
  let stateDir = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--port") {
      const value = args[index + 1];
      index += 1;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        const error = new Error(`invalid_port: ${value}`);
        error.code = "invalid_port";
        throw error;
      }
      port = parsed;
      continue;
    }
    if (arg === "--state-dir") {
      const value = args[index + 1];
      index += 1;
      if (!value) {
        const error = new Error("missing_state_dir");
        error.code = "missing_state_dir";
        throw error;
      }
      stateDir = value;
      continue;
    }
    const error = new Error(`unknown_cli_arg: ${arg}`);
    error.code = "unknown_cli_arg";
    throw error;
  }
  return { port, stateDir };
}

export async function startMaestro({
  stateDir,
  port = null,
  env = process.env,
  logger = new StructuredLogger(),
  // Test hooks: inject a fake tracker / engine runner instead of the real ones.
  tracker: trackerOverride = null,
  engineRunner = null,
}) {
  const taskStore = new LocalTaskStore({ root: stateDir });
  const config = await taskStore.readConfig();
  let dispatch = resolveDispatchConfig(config, { env });

  const tracker = trackerOverride ?? new LinearTrackerClient({
    endpoint: dispatch.tracker.endpoint,
    apiKey: dispatch.tracker.apiKey,
    projectSlug: dispatch.tracker.projectSlug,
  });
  const runner = new DispatchRunner({
    taskStore,
    tracker,
    dispatch,
    cwd: config.cwd ?? process.cwd(),
    logger,
    runner: engineRunner,
  });
  const orchestrator = new MaestroOrchestrator({ config: dispatch, tracker, runner, logger });

  const effectivePort = port ?? dispatch.server.port;
  const httpServer = effectivePort === null
    ? null
    : await startMaestroHttpServer({
      orchestrator,
      port: effectivePort,
      host: "127.0.0.1",
    });
  if (httpServer) {
    logger.info("maestro_http_started", { host: httpServer.host, port: httpServer.port });
  }

  // Hot-reload: re-read config.json each tick and re-resolve the dispatch block.
  // workflow.json is re-read by the engine on every task run, so no watcher is
  // needed. A bad/incomplete config keeps the previous good one.
  const poll = async () => {
    try {
      const fresh = await taskStore.readConfig();
      dispatch = resolveDispatchConfig(fresh, { env });
      runner.dispatch = dispatch;
      orchestrator.updateConfig(dispatch);
    } catch (error) {
      logger.error("dispatch_config_reload_failed", { error: error.message });
    }
    try {
      await orchestrator.tick();
    } catch (error) {
      logger.error("maestro_tick_failed", { error: error.message });
    }
  };
  const interval = setInterval(() => {
    void poll();
  }, dispatch.polling.intervalMs);
  void poll();

  return {
    taskStore,
    orchestrator,
    httpServer,
    stop: async () => {
      clearInterval(interval);
      await orchestrator.stop();
      if (httpServer) await httpServer.close();
    },
  };
}
