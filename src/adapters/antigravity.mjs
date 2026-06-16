export function buildAntigravityCommand({
  prompt,
  cwd,
  role = "executor",
  model = null,
  effort = null,
  permission = null,
  alias = null,
  commandName = "antigravity",
  // Advisory only: tool policy is injected upstream as a prompt block (D2).
  tools = null,
  deny_tools = null,
} = {}) {
  void tools;
  void deny_tools;
  const command = alias ?? commandName;
  const args = ["-p", prompt, "--output-format", "json"];
  if (role) {
    args.push("--role", role);
  }
  if (model) {
    args.push("--model", model);
  }
  if (effort) {
    args.push("--effort", effort);
  }
  if (permission) {
    args.push("--permission", permission);
  }
  return {
    command,
    args,
    cwd,
    stdin: null,
  };
}
