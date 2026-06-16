export function buildClaudeCommand({
  prompt,
  cwd,
  role = "planner",
  model = null,
  effort = null,
  permission = null,
  alias = null,
  commandName = "claude",
} = {}) {
  const command = alias ?? commandName;
  // Write-permission roles can opt into an autonomous permission mode via
  // MAESTRO_CLAUDE_WRITE_MODE (e.g. "acceptEdits" or "bypassPermissions") so a
  // non-interactive claude can apply edits/run commands without a human at the
  // CLI — matching codex's approval_policy=never. Unset ⇒ legacy "default".
  const writeMode = process.env.MAESTRO_CLAUDE_WRITE_MODE || "default";
  // permission field overrides role-based inference when present
  const permMode = permission === "plan" ? "plan"
    : permission === "write" ? writeMode
    : permission ? "default"
    : role === "planner" ? "plan"
    : "default";
  const args = [
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    permMode,
    "--no-session-persistence",
  ];
  if (model) {
    args.push("--model", model);
  }
  if (effort) {
    args.push("--effort", effort);
  }
  return {
    command,
    args,
    cwd,
    stdin: prompt,
  };
}
