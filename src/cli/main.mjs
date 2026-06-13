import { existsSync } from "node:fs";
import path from "node:path";

import { StructuredLogger } from "../logger.mjs";
import { loadLocalSecrets } from "../setup/keys.mjs";
import { DEFAULT_LOCAL_STATE_DIR } from "../task-store.mjs";
import { parseCliArgs } from "../workflow.mjs";

import { runLocalMaestroCommand } from "./local-command.mjs";
import { routeCli } from "./registry.mjs";
import { startMaestro } from "./runtime.mjs";
import { resolveWorkspaceLocalInvocation } from "./workspace-resolve.mjs";

export async function main() {
  const rawArgs = process.argv.slice(2);
  const route = routeCli(rawArgs, {
    fileExists: (candidate) => existsSync(path.resolve(process.cwd(), candidate)),
  });
  if (route.kind === "help") {
    process.stdout.write(route.text);
    return;
  }
  if (route.kind === "error") {
    process.stderr.write(route.text);
    process.exitCode = route.exitCode;
    return;
  }
  if (route.kind === "local") {
    const invocation = resolveWorkspaceLocalInvocation({ args: rawArgs });
    await runLocalMaestroCommand(invocation);
    return;
  }
  if (route.kind === "server-deprecated") {
    process.stderr.write(`note: "maestro <file.md>" is deprecated; use: maestro serve ${route.workflowPath}\n`);
  }
  const serverArgv = route.kind === "serve"
    ? [process.argv[0], process.argv[1], ...route.serverArgs]
    : process.argv;
  const args = parseCliArgs(serverArgv);
  const logger = new StructuredLogger();
  try {
    await loadLocalSecrets(path.resolve(process.cwd(), DEFAULT_LOCAL_STATE_DIR));
  } catch (error) {
    logger.error("secrets_load_failed", { error: error.message });
  }
  const service = await startMaestro({ ...args, logger });
  const shutdown = async () => {
    await service.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
