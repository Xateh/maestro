export function buildCopilotCommand({
  prompt,
  cwd,
  alias = "copilot",
  model = null,
  mode = "interactive",
} = {}) {
  const args = ["-p", prompt, "--output-format", "json", "--mode", mode];
  if (model) {
    args.push("--model", model);
  }
  return {
    command: alias,
    args,
    cwd,
    stdin: null,
  };
}
