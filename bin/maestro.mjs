#!/usr/bin/env node

// Entry shim. The implementation lives in src/cli/ — this file re-exports the
// public surface (package.json `exports["."]` and the test suite import from
// here) and starts the CLI when invoked directly.

import "../src/suppress-sqlite-warning.mjs";
import "../src/telemetry.mjs";

import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli/main.mjs";

export { parseReviewerOutput } from "../src/markers.mjs";
export { parseCliArgs } from "../src/workflow.mjs";
export { canonicalizeActionRequestsForTask } from "../src/cli/action-requests.mjs";
export { runLocalMaestroCommand } from "../src/cli/local-command.mjs";
export { startMaestro } from "../src/cli/runtime.mjs";
export {
  handleApproveAction,
  handleCancelTask,
  handleDenyAction,
  handleEditAction,
  handleExtendTimeout,
  handleMarkDone,
  handleRetryTask,
  handleRunAction,
} from "../src/cli/task-handlers.mjs";
export { resolveWorkspaceLocalInvocation } from "../src/cli/workspace-resolve.mjs";

// argv[1] may be a symlink (npm link / global install); compare real paths.
const invokedAsMain = await (async () => {
  if (!process.argv[1]) return false;
  try {
    return (await fs.realpath(process.argv[1])) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedAsMain) {
  main().catch((error) => {
    if (error?.code === "cli_usage") {
      process.stderr.write(error.cliHelp);
    } else {
      process.stderr.write(`maestro_failed ${error.stack ?? error.message}\n`);
    }
    process.exitCode = 1;
  });
}
