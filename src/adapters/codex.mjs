export function buildCodexCommand({
  prompt,
  cwd,
  role = "executor",
  model = null,
  effort = null,
  permission = null,
  alias = null,
  commandName = "codex",
  tools = null,
  deny_tools = null,
} = {}) {
  const command = alias ?? commandName;
  // permission field overrides role-based inference when present. Bash-shaped
  // tool tokens may inform the sandbox profile (§5.2); the conservative hint is
  // currently a no-op override (codexSandboxHint returns null), so the
  // permission→sandbox mapping governs. The non-Bash remainder rides the
  // advisory block injected upstream (D2). tools/deny_tools are accepted for a
  // uniform adapter seam.
  void tools;
  void deny_tools;
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
