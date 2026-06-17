// Command registry — single source of truth for the maestro CLI surface.
//
// The tree drives: generated global + per-command help, unknown-command
// resolution ("did you mean" from the longest valid command prefix, like
// uv/conda), and the LOCAL_COMMANDS set used by bin/maestro.mjs dispatch.

const STATE_DIR_FLAG = { flag: "--state-dir <path>", desc: "override the .maestro state directory" };

export const COMMAND_TREE = {
  name: "maestro",
  summary: "multi-agent plan → execute → review orchestrator",
  synopsis: "maestro <command> [args]",
  flags: [
    STATE_DIR_FLAG,
    { flag: "--config <path>", desc: "config.json path (server mode)" },
    { flag: "--port <n>", desc: "HTTP port (server mode)" },
  ],
  subcommands: [
    {
      name: "task",
      kind: "local",
      synopsis: 'maestro task [flags] "<prompt>"',
      summary: "create + run a task (planner → executor → reviewer)",
      flags: [
        { flag: "--plan-only", desc: "planner only; stops at the plan handoff" },
        { flag: "--mode <name>", desc: "run any mode defined in workflow.json" },
        { flag: "--workflow <name>", desc: "named workflow to run (default: default)" },
        { flag: "--cwd <path>", desc: "working directory for the task" },
        { flag: "--timeout-ms <n>", desc: "per-step timeout (-1 = none)" },
        { flag: "--planner auto|on|off", desc: "planner policy override" },
        { flag: "--review on|off", desc: "reviewer toggle" },
        { flag: "--project <id>", desc: "attach the task to a project" },
        { flag: "--worktree-mode <m>", desc: "current-cwd | project-worktree | new-project | auto" },
        { flag: "--paths <p>", desc: "restrict writes to path (repeatable)" },
        { flag: "--force-parallel", desc: "bypass the parallel-worktree guard" },
        STATE_DIR_FLAG,
        { flag: "--", desc: "end of options; the rest is literal prompt text" },
      ],
    },
    {
      name: "run-task",
      kind: "local",
      synopsis: "maestro run-task <id>",
      summary: "re-run or continue an existing task",
      flags: [STATE_DIR_FLAG],
    },
    {
      name: "status",
      kind: "local",
      synopsis: "maestro status",
      summary: "list tasks",
      flags: [STATE_DIR_FLAG],
    },
    {
      name: "inspect",
      kind: "local",
      synopsis: "maestro inspect <id>",
      summary: "dump full JSON state for a task",
      flags: [
        { flag: "--json", desc: "raw JSON output" },
        { flag: "--color / --no-color", desc: "force color on/off" },
        STATE_DIR_FLAG,
      ],
    },
    {
      name: "events",
      kind: "local",
      synopsis: "maestro events <id> [--json] | maestro events --all [--stage S] [--status S] [--workflow W] [--json]",
      summary: "list per-stage events (live projection per task, or --all cross-task from the materialised table)",
      flags: [
        { flag: "--json", desc: "raw stage_event JSON array" },
        { flag: "--all", desc: "cross-task query over the materialised events table" },
        { flag: "--stage <s>", desc: "filter --all by stage" },
        { flag: "--status <s>", desc: "filter --all by status" },
        { flag: "--workflow <w>", desc: "filter --all by workflow_id" },
        STATE_DIR_FLAG,
      ],
    },
    {
      name: "artifacts",
      kind: "local",
      synopsis: "maestro artifacts <id> [<selector>] [--cat|--tail|--json]",
      summary: "list a run's artifacts (derived from run_dir) or read one",
      flags: [
        { flag: "--cat", desc: "print the whole file" },
        { flag: "--tail", desc: "print the bounded tail of the file" },
        { flag: "--json", desc: "JSON output (full entries, or one entry's metadata)" },
        STATE_DIR_FLAG,
      ],
    },
    {
      name: "rerun",
      kind: "local",
      synopsis: "maestro rerun <id> [--dry-run | --no-run]",
      summary: "recreate + run a task from its run-manifest (pinning the captured workflow snapshot)",
      flags: [
        { flag: "--dry-run", desc: "print the manifest + resolved inputs; create nothing" },
        { flag: "--no-run", desc: "create the task queued and print its id (run later via run-task)" },
        STATE_DIR_FLAG,
      ],
    },
    {
      name: "compare",
      kind: "local",
      synopsis: "maestro compare <id1> <id2> [--json]",
      summary: "diff two runs' artifact sha256s per (role, kind): MATCH / DIFFER / ONLY-1 / ONLY-2",
      flags: [
        { flag: "--json", desc: "JSON output (array of {role, kind, result, sha256_1, sha256_2})" },
        STATE_DIR_FLAG,
      ],
    },
    {
      name: "tui",
      kind: "local",
      synopsis: "maestro tui",
      summary: "interactive terminal UI (MAESTRO_TUI_CLASSIC=1 for the prompt-driven UI)",
      flags: [STATE_DIR_FLAG],
    },
    {
      name: "init",
      kind: "local",
      synopsis: "maestro init [--yes] [--dry-run] [--workflow <name>]",
      summary: "scaffold .maestro/ (config, workflow, dirs) in the current directory",
      flags: [
        { flag: "--yes", desc: "non-interactive: scaffold + detect local runtimes, skip wizards" },
        { flag: "--dry-run", desc: "show what would be created without writing" },
        { flag: "--workflow <name>", desc: "workflow template: default | extended | local | solo | full-audit-sweep | full-audit-sweep-gated | triage | research" },
        STATE_DIR_FLAG,
      ],
    },
    {
      name: "doctor",
      kind: "local",
      synopsis: "maestro doctor [--json]",
      summary: "preflight checks: node version, provider CLIs, herdr, .maestro state",
      flags: [
        { flag: "--json", desc: "JSON output" },
        STATE_DIR_FLAG,
      ],
    },
    {
      name: "message",
      kind: "local",
      synopsis: 'maestro message <id> "<text>"',
      summary: "answer a waiting task",
      flags: [{ flag: "--note <text>", desc: "attach a note" }, STATE_DIR_FLAG],
    },
    {
      name: "approve",
      kind: "local",
      synopsis: "maestro approve <id>",
      summary: "approve a waiting workflow approval",
      flags: [{ flag: "--note <text>", desc: "attach a note" }, STATE_DIR_FLAG],
    },
    {
      name: "deny",
      kind: "local",
      synopsis: 'maestro deny <id> "<reason>"',
      summary: "deny a waiting workflow approval",
      flags: [{ flag: "--note <text>", desc: "attach a note" }, STATE_DIR_FLAG],
    },
    {
      name: "approve-action",
      kind: "local",
      synopsis: "maestro approve-action <id> <action-id>",
      summary: "approve a pending action",
      flags: [{ flag: "--note <text>", desc: "attach a note" }, STATE_DIR_FLAG],
    },
    {
      name: "deny-action",
      kind: "local",
      synopsis: 'maestro deny-action <id> <action-id> "<reason>"',
      summary: "deny a pending action",
      flags: [{ flag: "--note <text>", desc: "attach a note" }, STATE_DIR_FLAG],
    },
    {
      name: "run-action",
      kind: "local",
      synopsis: "maestro run-action <id> <action-id>",
      summary: "run a pending action",
      flags: [{ flag: "--note <text>", desc: "attach a note" }, STATE_DIR_FLAG],
    },
    {
      name: "edit-action",
      kind: "local",
      synopsis: "maestro edit-action <id> <action-id> [flags]",
      summary: "edit a pending action request before running it",
      flags: [
        { flag: "--cwd <path>", desc: "action working directory" },
        { flag: "--type <t>", desc: "action type" },
        { flag: "--git-type <t>", desc: "git action type" },
        { flag: "--command <cmd>", desc: "host command to run" },
        { flag: "--args-json <json>", desc: "argument array (JSON)" },
        { flag: "--env-json <json>", desc: "environment object (JSON)" },
        { flag: "--timeout-ms <n>", desc: "action timeout" },
        { flag: "--note <text>", desc: "attach a note" },
        STATE_DIR_FLAG,
      ],
    },
    {
      name: "retry",
      kind: "local",
      synopsis: "maestro retry <id>",
      summary: "retry a failed task",
      flags: [
        { flag: "--force-parallel", desc: "bypass the parallel-worktree guard" },
        { flag: "--note <text>", desc: "attach a note" },
        STATE_DIR_FLAG,
      ],
    },
    {
      name: "cancel",
      kind: "local",
      synopsis: "maestro cancel <id>",
      summary: "cancel a task",
      flags: [{ flag: "--note <text>", desc: "attach a note" }, STATE_DIR_FLAG],
    },
    {
      name: "mark-done",
      kind: "local",
      synopsis: "maestro mark-done <id> [<action-id>]",
      summary: "mark a task or action as done",
      flags: [
        { flag: "--force", desc: "skip completion checks" },
        { flag: "--note <text>", desc: "attach a note" },
        STATE_DIR_FLAG,
      ],
    },
    {
      name: "extend-timeout",
      kind: "local",
      synopsis: "maestro extend-timeout <id> <ms>",
      summary: "extend a running task's timeout",
      flags: [{ flag: "--note <text>", desc: "attach a note" }, STATE_DIR_FLAG],
    },
    {
      name: "approve-substitution",
      kind: "local",
      synopsis: "maestro approve-substitution <id>",
      summary: "approve an auto provider substitution and continue",
      flags: [{ flag: "--note <text>", desc: "attach a note" }, STATE_DIR_FLAG],
    },
    {
      name: "skip-role",
      kind: "local",
      synopsis: "maestro skip-role <id> [<role>]",
      summary: "skip a role whose provider is unavailable",
      flags: [{ flag: "--note <text>", desc: "attach a note" }, STATE_DIR_FLAG],
    },
    {
      name: "switch-provider",
      kind: "local",
      synopsis: "maestro switch-provider <id> <provider>",
      summary: "switch a blocked role to another provider",
      flags: [{ flag: "--note <text>", desc: "attach a note" }, STATE_DIR_FLAG],
    },
    {
      name: "project",
      kind: "local",
      synopsis: "maestro project <subcommand>",
      summary: "project (multi-task) commands",
      subcommands: [
        {
          name: "create",
          synopsis: "maestro project create <id>",
          summary: "create a project",
          flags: [{ flag: "--target <branch>", desc: "integration target branch" }, STATE_DIR_FLAG],
        },
        { name: "status", synopsis: "maestro project status", summary: "list projects", flags: [STATE_DIR_FLAG] },
        { name: "inspect", synopsis: "maestro project inspect <id>", summary: "dump project JSON", flags: [STATE_DIR_FLAG] },
        { name: "sync-target", synopsis: "maestro project sync-target <id>", summary: "sync the integration branch head", flags: [STATE_DIR_FLAG] },
        {
          name: "close",
          synopsis: "maestro project close <id>",
          summary: "merge and close a project",
          flags: [{ flag: "--merge-mode squash", desc: "merge strategy" }, STATE_DIR_FLAG],
        },
        { name: "cleanup", synopsis: "maestro project cleanup <id>", summary: "remove project worktrees", flags: [STATE_DIR_FLAG] },
      ],
    },
    {
      name: "setup",
      kind: "local",
      synopsis: "maestro setup <subcommand>",
      summary: "configure providers, keys, and imports",
      subcommands: [
        {
          name: "keys",
          synopsis: "maestro setup keys [--var NAME] [--encrypt]",
          summary: "manage optional API keys; --encrypt migrates to the encrypted store",
          flags: [
            { flag: "--var NAME", desc: "set a single variable non-interactively" },
            { flag: "--encrypt", desc: "encrypt the store (scrypt+AES-GCM) and shred plaintext" },
            STATE_DIR_FLAG,
          ],
        },
        {
          name: "harden",
          synopsis: "maestro setup harden [--project] [--dry-run]",
          summary: "install the Claude Code secret guardrail (PreToolUse hook + deny rules)",
          flags: [
            { flag: "--project", desc: "write .claude/settings.json in the cwd (default: global ~/.claude)" },
            { flag: "--dry-run", desc: "show the target without writing" },
          ],
        },
        {
          name: "local",
          synopsis: "maestro setup local",
          summary: "detect local agent runtimes (ollama/pi/hermes/openclaw) → config.local.json",
          flags: [
            { flag: "--yes", desc: "write without confirmation" },
            { flag: "--json", desc: "JSON output" },
            STATE_DIR_FLAG,
          ],
        },
        {
          name: "import",
          synopsis: "maestro setup import [--dry-run]",
          summary: "import skills/subagents/MCP configs into the workflow (credited)",
          flags: [
            { flag: "--dry-run", desc: "show the plan without writing" },
            { flag: "--yes", desc: "apply without confirmation" },
            { flag: "--copy", desc: "snapshot sources into .maestro/imported/" },
            STATE_DIR_FLAG,
          ],
        },
        {
          name: "tracker",
          synopsis: "maestro setup tracker [--project-slug <slug>] [--api-key <key>]",
          summary: "configure the Linear tracker for `maestro serve` (writes server.tracker + chains the LINEAR_API_KEY prompt)",
          flags: [
            { flag: "--project-slug <slug>", desc: "Linear project slug/key" },
            { flag: "--api-key <key>", desc: "store LINEAR_API_KEY non-interactively" },
            { flag: "--var NAME", desc: "env var name for the key (default LINEAR_API_KEY)" },
            STATE_DIR_FLAG,
          ],
        },
      ],
    },
    {
      name: "workflow",
      kind: "local",
      synopsis: "maestro workflow <subcommand>",
      summary: "workflow file commands",
      subcommands: [
        {
          name: "validate",
          synopsis: "maestro workflow validate",
          summary: "check workflow structure + loop termination clauses",
          flags: [
            { flag: "--json", desc: "JSON output" },
            { flag: "--strict", desc: "warnings fail the check" },
            STATE_DIR_FLAG,
          ],
        },
        {
          name: "list",
          synopsis: "maestro workflow list",
          summary: "list available workflows (named + legacy default)",
          flags: [
            { flag: "--json", desc: "JSON output" },
            STATE_DIR_FLAG,
          ],
        },
        {
          name: "use",
          synopsis: "maestro workflow use <name> [--as <slot>]",
          summary: "apply a built-in template (default slot, or --as a named slot)",
          flags: [
            { flag: "--as <name>", desc: "write into workflows/<name>.json instead of the default" },
            STATE_DIR_FLAG,
          ],
        },
      ],
    },
    {
      name: "role",
      kind: "local",
      synopsis: "maestro role <subcommand>",
      summary: "inspect portable role units (.maestro/roles, .claude/agents, skills)",
      subcommands: [
        {
          name: "list",
          synopsis: "maestro role list [--json]",
          summary: "list discoverable role units across .maestro/roles and .claude/agents",
          flags: [{ flag: "--json", desc: "JSON output" }, STATE_DIR_FLAG],
        },
        {
          name: "show",
          synopsis: "maestro role show <unit>",
          summary: "print the normalized RoleDef for a unit",
          flags: [STATE_DIR_FLAG],
        },
        {
          name: "lint",
          synopsis: "maestro role lint <unit>",
          summary: "validate a unit (frontmatter, tool grammar); non-zero exit on error",
          flags: [STATE_DIR_FLAG],
        },
      ],
    },
    {
      name: "import-agent",
      kind: "local",
      synopsis: "maestro import-agent <path>",
      summary: "convert a .claude/agents subagent into a native .maestro/roles unit",
      flags: [STATE_DIR_FLAG],
    },
    {
      name: "export",
      kind: "local",
      synopsis: "maestro export [--out <p>]",
      summary: "package workflow as a shareable bundle",
      flags: [
        { flag: "--name <n>", desc: "bundle name" },
        { flag: "--out <p>", desc: "output path" },
        { flag: "--single-file", desc: "write one JSON file instead of a directory" },
        STATE_DIR_FLAG,
      ],
    },
    {
      name: "import",
      kind: "local",
      synopsis: "maestro import <bundle>",
      summary: "import a bundle (backs up workflow.json)",
      flags: [
        { flag: "--dry-run", desc: "show the plan without writing" },
        { flag: "--force", desc: "overwrite conflicting providers" },
        { flag: "--yes", desc: "apply without confirmation" },
        STATE_DIR_FLAG,
      ],
    },
    {
      name: "serve",
      kind: "local",
      synopsis: "maestro serve <subcommand>",
      summary: "manage background tracker-polling services",
      subcommands: [
        { name: "list", synopsis: "maestro serve list [--json]", summary: "show all services + state" },
        { name: "add", synopsis: "maestro serve add <name> --slug <SLUG> [--port N --workflow W --var NAME --workspace DIR --shared-state]", summary: "register a service" },
        { name: "edit", synopsis: "maestro serve edit <name> [--slug … --port … …]", summary: "update a service definition" },
        { name: "rm", synopsis: "maestro serve rm <name> [--force]", summary: "remove a service" },
        { name: "start", synopsis: "maestro serve start <name|--all>", summary: "start service(s) in the background" },
        { name: "stop", synopsis: "maestro serve stop <name|--all>", summary: "stop service(s)" },
        { name: "pause", synopsis: "maestro serve pause <name>", summary: "stop + mark paused" },
        { name: "resume", synopsis: "maestro serve resume <name>", summary: "clear paused + start" },
        { name: "status", synopsis: "maestro serve status <name>", summary: "detail for one service" },
        { name: "logs", synopsis: "maestro serve logs <name> [-f] [-n N]", summary: "tail a worker log" },
        { name: "adopt", synopsis: "maestro serve adopt [name]", summary: "materialize a legacy tracker as a service" },
        { name: "run", synopsis: "maestro serve run <name> --foreground", summary: "(internal) foreground worker entrypoint" },
      ],
      flags: [STATE_DIR_FLAG],
    },
  ],
};

export const LOCAL_COMMAND_NAMES = COMMAND_TREE.subcommands
  .filter((node) => node.kind === "local")
  .map((node) => node.name);

const LOCAL_COMMAND_SET = new Set(LOCAL_COMMAND_NAMES);

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

export function suggest(input, candidates, maxDistance = 2) {
  return candidates
    .map((candidate) => ({ candidate, distance: levenshtein(input, candidate) }))
    .filter(({ distance }) => distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
    .map(({ candidate }) => candidate);
}

// Walk the tree along command tokens. Stops at the first token that is not a
// known subcommand: if the current node still expects a subcommand the token
// is reported as `unknown`; otherwise it is a positional argument and the walk
// simply ends (longest valid prefix).
export function resolveCommandPath(tokens = []) {
  const matched = [COMMAND_TREE];
  let unknown = null;
  let candidates = [];
  for (const token of tokens) {
    if (token == null || token.startsWith("-")) break;
    const node = matched[matched.length - 1];
    const subcommands = node.subcommands ?? [];
    if (subcommands.length === 0) break;
    const next = subcommands.find((sub) => sub.name === token);
    if (!next) {
      unknown = token;
      candidates = subcommands.map((sub) => sub.name);
      break;
    }
    matched.push(next);
  }
  return { matched, unknown, candidates };
}

function commandPathLabel(matched) {
  return matched.map((node) => node.name).join(" ");
}

export function formatHelp(matched) {
  const node = matched[matched.length - 1];
  const lines = [];
  if (node === COMMAND_TREE) {
    lines.push(`maestro — ${COMMAND_TREE.summary}`, "", "Usage:");
    for (const sub of COMMAND_TREE.subcommands) {
      const left = sub.synopsis.replace(/^maestro /, "  maestro ");
      lines.push(left.length <= 44 ? `${left.padEnd(44)}${sub.summary}` : `${left}\n${" ".repeat(44)}${sub.summary}`);
    }
    lines.push("");
    lines.push(`Global flags: ${COMMAND_TREE.flags.map((f) => f.flag).join("  ")}`);
    lines.push('Run "maestro help <command>" for command details.');
    lines.push("Docs: docs/cli.md, docs/import-export.md");
  } else {
    lines.push(`Usage: ${node.synopsis}`, "", `  ${node.summary}`);
    const subcommands = node.subcommands ?? [];
    if (subcommands.length > 0) {
      lines.push("", "Subcommands:");
      for (const sub of subcommands) {
        const left = `  ${sub.synopsis.replace(/^maestro\s+/, "").replace(`${node.name} `, "")}`;
        lines.push(`${left.padEnd(34)}${sub.summary}`);
      }
    }
    const flags = node.flags ?? [];
    if (flags.length > 0) {
      lines.push("", "Flags:");
      for (const { flag, desc } of flags) {
        lines.push(`  ${flag.padEnd(32)}${desc}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

// Error for a failed/partial command: scoped help from the longest valid
// prefix plus "did you mean" suggestions. Recognized by the cli_usage code.
export function usageError(tokens = []) {
  const cleaned = tokens.filter((token) => token != null && token !== "");
  const { matched, unknown, candidates } = resolveCommandPath(cleaned);
  const node = matched[matched.length - 1];
  const lines = [];
  if (unknown) {
    const prefix = commandPathLabel(matched);
    lines.push(`unknown command: ${prefix} ${unknown}`);
    const suggestions = suggest(unknown, candidates);
    if (suggestions.length > 0) {
      lines.push(`Did you mean: ${suggestions.join(", ")}?`);
    }
  } else if ((node.subcommands ?? []).length > 0) {
    const expected = node.subcommands.map((sub) => sub.name).join(" | ");
    lines.push(`${commandPathLabel(matched)}: missing subcommand (expected: ${expected})`);
  } else {
    lines.push(`invalid usage: ${commandPathLabel(matched)}`);
  }
  const error = new Error(lines[0]);
  error.code = "cli_usage";
  error.cliHelp = `${lines.join("\n")}\n\n${formatHelp(matched)}`;
  return error;
}

function commandTokens(args) {
  const tokens = [];
  for (const arg of args) {
    if (arg.startsWith("-")) break;
    tokens.push(arg);
  }
  return tokens;
}

// Pure routing decision for main().
export function routeCli(rawArgs = []) {
  const dashIndex = rawArgs.indexOf("--");
  const preDashDash = dashIndex === -1 ? rawArgs : rawArgs.slice(0, dashIndex);
  const first = rawArgs[0];

  if (first === "help") {
    const tokens = commandTokens(rawArgs.slice(1));
    const resolved = resolveCommandPath(tokens);
    if (resolved.unknown) {
      return { kind: "error", text: usageError(tokens).cliHelp, exitCode: 1 };
    }
    return { kind: "help", text: formatHelp(resolved.matched), exitCode: 0 };
  }
  // --help anywhere before a "--" separator prints help scoped to the longest
  // valid command prefix; after "--" it is literal prompt text.
  if (preDashDash.includes("--help") || preDashDash.includes("-h")) {
    const resolved = resolveCommandPath(commandTokens(preDashDash));
    return { kind: "help", text: formatHelp(resolved.matched), exitCode: 0 };
  }
  if (LOCAL_COMMAND_SET.has(first)) {
    return { kind: "local" };
  }
  // Bare `maestro` (no args at all) prints help, like git/docker/npm — server
  // mode needs a tracker config, so defaulting to it here only yields a cryptic
  // `unsupported_tracker_kind` error on first run. Flag-only invocations
  // (e.g. `maestro --port 4100`) still mean "start the server".
  if (first === undefined) {
    return { kind: "help", text: formatHelp([COMMAND_TREE]), exitCode: 0 };
  }
  if (first.startsWith("-")) {
    return { kind: "server" };
  }
  return { kind: "error", text: usageError([first]).cliHelp, exitCode: 1 };
}
