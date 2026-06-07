export function buildCodexCommand({
  prompt,
  cwd,
  role = "executor",
  model = null,
  effort = null,
  permission = null,
  alias = null,
  commandName = "codex",
} = {}) {
  const command = alias ?? commandName;
  // permission field overrides role-based inference when present
  const sandbox = permission === "read" ? "read-only"
    : permission === "write" ? "workspace-write"
    : role === "reviewer" ? "read-only"
    : "workspace-write";
  const args = [
    "exec",
    "--json",
    "-c",
    "approval_policy=\"never\"",
    "--sandbox",
    sandbox,
    "--cd",
    cwd,
  ];
  if (model) {
    args.push("--model", model);
  }
  if (effort) {
    args.push("-c", `model_reasoning_effort="${effort}"`);
  }
  return {
    command,
    args,
    cwd,
    stdin: prompt,
  };
}
