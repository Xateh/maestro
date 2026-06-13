import path from "node:path";

import { StructuredLogger } from "../logger.mjs";
import { loadLocalSecrets } from "../setup/keys.mjs";
import { DEFAULT_LOCAL_STATE_DIR } from "../task-store.mjs";

import { runLocalMaestroCommand } from "./local-command.mjs";
import { routeCli } from "./registry.mjs";
import { parseServeArgs, startMaestro } from "./runtime.mjs";
import { resolveWorkspaceLocalInvocation } from "./workspace-resolve.mjs";

export async function main() {
  const rawArgs = process.argv.slice(2);
  const route = routeCli(rawArgs);
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
    if (invocation.stateDirMissing) {
      process.stderr.write(
        "maestro: no .maestro/ found here — run `maestro init` (or pass --state-dir <path>)\n",
      );
      process.exitCode = 1;
      return;
    }
    await runLocalMaestroCommand(invocation);
    return;
  }

  // Server mode: `maestro serve [...]` or bare server flags (e.g. `--port`).
  const serverArgs = route.kind === "serve" ? route.serverArgs : rawArgs;
  const { port, stateDir } = parseServeArgs(serverArgs);
  const resolvedStateDir = path.resolve(process.cwd(), stateDir ?? DEFAULT_LOCAL_STATE_DIR);
  const logger = new StructuredLogger();
  try {
    await loadLocalSecrets(resolvedStateDir);
  } catch (error) {
    logger.error("secrets_load_failed", { error: error.message });
  }
  const service = await startMaestro({ stateDir: resolvedStateDir, port, logger });
  const shutdown = async () => {
    await service.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
