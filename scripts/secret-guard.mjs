// Claude Code PreToolUse guard: deny any Bash command that reads/decrypts
// maestro's secret store unless it is a `maestro` invocation. Everything else
// passes. Pure decision in evaluateGuard(); the CLI wrapper handles stdio.

const SECRET_PATH_RE = /secrets\.local(\.enc)?\.json/;

export function evaluateGuard(payload) {
  if (!payload || payload.tool_name !== "Bash") return { decision: "allow" };
  const command = String(payload.tool_input?.command ?? "");
  if (!SECRET_PATH_RE.test(command)) return { decision: "allow" };
  // References the store. Allow only if this is a maestro invocation.
  if (/(^|[\s;&|(])maestro(\s|$)/.test(command.trim())) return { decision: "allow" };
  return {
    decision: "deny",
    reason:
      "maestro's secret store is maestro-only. Use `maestro setup keys` to manage it and `maestro` to consume it; do not read .maestro/secrets.local*.json directly.",
  };
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let payload = {};
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    process.exit(0); // fail open on unparseable input — don't wedge the agent
  }
  const result = evaluateGuard(payload);
  if (result.decision === "deny") {
    process.stderr.write(`${result.reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}

// Only run as a CLI, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) main();
