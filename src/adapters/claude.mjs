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
  // permission field overrides role-based inference when present
  const permMode = permission === "plan" ? "plan"
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
