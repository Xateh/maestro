export function buildAntigravityCommand({
  prompt,
  cwd,
  role = "executor",
  model = null,
  effort = null,
  permission = null,
  alias = null,
  commandName = "antigravity",
} = {}) {
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
