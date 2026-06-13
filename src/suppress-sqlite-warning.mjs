// Suppresses the node:sqlite ExperimentalWarning that would otherwise print on
// every CLI run (bin/maestro.mjs → src/langgraph/engine.mjs → src/db/store.mjs).
// Import this as the FIRST import of every entry point: warning emission is
// deferred via process.nextTick, so a listener installed during module
// evaluation still catches warnings produced by earlier static imports.
//
// NODE_OPTIONS-based suppression is not an option here — NODE_OPTIONS is in
// ENV_KEY_DENYLIST (src/agent-runner.mjs), and shebang tricks are bypassed by
// `npm run`, detached re-spawns via process.execPath, and MCP clients.

process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && /SQLite/i.test(warning.message)) {
    return;
  }
  // Re-print everything else in node's default format:
  // (node:<pid>) [code] Name: message
  const code = warning.code ? `[${warning.code}] ` : "";
  process.stderr.write(`(node:${process.pid}) ${code}${warning.name}: ${warning.message}\n`);
});
