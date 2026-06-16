// `maestro setup tracker` — configure the Linear tracker for `maestro serve`.
// Writes the server.tracker block into config.json (keeping the api_key as a
// "$VAR" reference, never the literal key) and chains the LINEAR_API_KEY prompt
// through the keys wizard so the secret lands in secrets.local.json / encrypted
// store. Idempotent: existing server.* fields survive the merge.

import path from "node:path";
import readline from "node:readline";
import { Readable } from "node:stream";

import {
  DEFAULT_LOCAL_CONFIG_V2,
  DEFAULT_SERVER_CONFIG,
  LocalTaskStore,
} from "../task-store.mjs";
import { runKeysWizard } from "./keys.mjs";

function typedError(code, detail) {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

// Mirror the defaultAsk pattern from init.mjs:45-53 — only prompts on a TTY.
function defaultAsk(stdin, stdout) {
  if (stdin.isTTY !== true) return null;
  return async (question) => {
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
    const answer = await new Promise((resolve) => rl.question(question, resolve));
    rl.close();
    return answer;
  };
}

function flagValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

export async function runTrackerWizard({
  stateDir,
  args = [],
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
}) {
  const slugFlag = flagValue(args, "--project-slug");
  const apiKey = flagValue(args, "--api-key");
  const varName = flagValue(args, "--var") ?? "LINEAR_API_KEY";
  const endpoint = flagValue(args, "--endpoint") ?? null;
  const kind = flagValue(args, "--kind") ?? "linear";

  const store = new LocalTaskStore({ root: stateDir });

  // Read current raw config (config.json only — no local overlay leakage).
  let raw = await store.readConfigRaw();
  if (raw === null) {
    raw = structuredClone(DEFAULT_LOCAL_CONFIG_V2);
    raw.cwd = path.dirname(path.resolve(stateDir));
  }

  let slug = slugFlag;
  if (!slug) {
    const ask = defaultAsk(stdin, stdout);
    if (ask) {
      slug = String((await ask("Linear project slug/key: ")) ?? "").trim();
    }
  }
  if (!slug) {
    throw typedError("missing_tracker_project_slug");
  }

  // Build the merged server block. Spread raw.server so unrelated server.*
  // fields (polling, workspace, hooks, agent, …) survive the write, then
  // overlay the tracker sub-object the same way.
  const server = {
    ...(raw.server ?? DEFAULT_SERVER_CONFIG),
    tracker: {
      ...((raw.server?.tracker) ?? DEFAULT_SERVER_CONFIG.tracker),
      kind,
      api_key: "$" + varName,
      project_slug: slug,
      endpoint: endpoint ?? (kind === "linear" ? null : null),
    },
  };

  // writeConfig shallow-merges top-level keys; passing the whole merged server
  // object means other server.* fields are preserved (we spread raw.server).
  await store.writeConfig({ server });

  // Chain the key prompt.
  let keyNote = null;
  if (apiKey !== undefined) {
    // Feed the value through the keys wizard's --var path non-interactively.
    await runKeysWizard({
      stateDir,
      args: ["--var", varName],
      env,
      stdin: Readable.from([apiKey + "\n"]),
      stdout,
    });
  } else if (stdin.isTTY === true) {
    await runKeysWizard({ stateDir, args: [], env, stdin, stdout });
  } else if (env[varName]) {
    keyNote = `${varName} already set in env — skipping key prompt`;
  } else {
    keyNote = `no key provided; set ${varName} or run \`maestro setup keys --var ${varName}\``;
  }

  stdout.write(`tracker configured: ${kind} / ${slug}\n`);
  if (keyNote) stdout.write(`${keyNote}\n`);
  stdout.write(`run \`maestro serve\` to start polling the tracker\n`);

  return { kind, slug, varName };
}
