import path from "node:path";
import { createRequire } from "node:module";

import { DEFAULT_LOCAL_STATE_DIR } from "../../task-store.mjs";
import { startMaestro } from "../runtime.mjs";
import { StructuredLogger } from "../../logger.mjs";

import {
  ensureServicesDir, writeDefinition, readDefinition, listDefinitions, servicePaths, removeFile, removeDir, writePidRecord, assertValidServiceName,
} from "./store.mjs";
import { validateOverlayFields, buildOverlay } from "./resolve.mjs";
import {
  startService, stopService, pauseService, resumeService, isRunning, serviceStatus, listStatuses, tailServiceLog,
} from "./lifecycle.mjs";
import { formatStatusTable, emptyGuidance, formatStartFeedback, collectWarnings } from "./format.mjs";

const require = createRequire(import.meta.url);

function typedError(code, detail) { const e = new Error(detail ? `${code}: ${detail}` : code); e.code = code; return e; }

function parse(args) {
  const rest = args.slice(1); // everything after "serve"
  let stateRoot = path.resolve(process.cwd(), DEFAULT_LOCAL_STATE_DIR);
  const positional = [];
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === "--state-dir") { stateRoot = path.resolve(process.cwd(), rest[++i] ?? ""); continue; }
    if (a === "--slug") { flags.slug = rest[++i]; continue; }
    if (a === "--port") { flags.port = Number(rest[++i]); continue; }
    if (a === "--workflow") { flags.workflow = rest[++i]; continue; }
    if (a === "--var") { flags.var = rest[++i]; continue; }
    if (a === "--workspace") { flags.workspace = rest[++i]; continue; }
    if (a === "--shared-state") { flags.shared_state = true; continue; }
    if (a === "--force") { flags.force = true; continue; }
    if (a === "--all") { flags.all = true; continue; }
    if (a === "-f" || a === "--follow") { flags.follow = true; continue; }
    if (a === "-n") { flags.lines = Number(rest[++i]); continue; }
    if (a === "--foreground") { continue; }
    if (a === "--json") { flags.json = true; continue; }
    positional.push(a);
  }
  return { stateRoot, sub: positional[0], rest: positional.slice(1), flags };
}

function requireName(rest) { if (!rest[0]) throw typedError("usage", "a service name is required"); return rest[0]; }

async function pickStartable(stateRoot) {
  const rows = await listStatuses(stateRoot);
  return rows.filter((r) => !r.paused && r.state !== "running").map((r) => r.name);
}

export async function runServeCommand({ args, stdout = process.stdout, stderr = process.stderr, env = process.env, spawnProcess, waitForPid, logger } = {}) {
  const { stateRoot, sub, rest, flags } = parse(args);
  await ensureServicesDir(stateRoot);
  const write = (s) => stdout.write(s);
  const writeErr = (s) => stderr.write(s);

  if (sub === undefined || sub === "list") {
    let rows = await listStatuses(stateRoot);
    if (rows.length === 0) {
      const adopted = await tryAutoAdopt({ stateRoot, write, writeErr });
      if (adopted) rows = await listStatuses(stateRoot);
    }
    if (flags.json) { write(JSON.stringify(rows, null, 2) + "\n"); return {}; }
    if (rows.length === 0) { write(emptyGuidance()); return {}; }
    write(formatStatusTable(rows));
    const defs = await Promise.all((await listDefinitions(stateRoot)).map(async (n) => ({ name: n, ...(await readDefinition(stateRoot, n)) })));
    for (const w of collectWarnings({ defs, env })) writeErr(`warning: ${w}\n`);
    return {};
  }

  if (sub === "add") {
    const name = rest[0];
    if (!name) throw typedError("usage", "maestro serve add <name> --slug <SLUG>");
    assertValidServiceName(name);
    const def = {
      slug: flags.slug,
      ...(flags.port != null ? { port: flags.port } : {}),
      ...(flags.workflow ? { workflow: flags.workflow } : {}),
      ...(flags.var ? { var: flags.var } : {}),
      ...(flags.workspace ? { workspace: flags.workspace } : {}),
      ...(flags.shared_state ? { shared_state: true } : {}),
      paused: false,
    };
    validateOverlayFields(def);
    if (await readDefinition(stateRoot, name)) throw typedError("service_exists", name);
    await writeDefinition(stateRoot, name, def);
    write(`✓ service '${name}' added (${def.slug})\n  start it:  maestro serve start ${name}\n`);
    for (const w of collectWarnings({ defs: [{ name, ...def }], env })) writeErr(`warning: ${w}\n`);
    return {};
  }

  if (sub === "edit") {
    const name = rest[0];
    const cur = await readDefinition(stateRoot, name);
    if (!cur) throw typedError("unknown_service", name);
    const next = { ...cur };
    if (flags.slug != null) next.slug = flags.slug;
    if (flags.port != null) next.port = flags.port;
    if (flags.workflow != null) next.workflow = flags.workflow;
    if (flags.var != null) next.var = flags.var;
    if (flags.workspace != null) next.workspace = flags.workspace;
    if (flags.shared_state) next.shared_state = true;
    validateOverlayFields(next);
    await writeDefinition(stateRoot, name, next);
    write(`✓ service '${name}' updated\n`);
    if (await isRunning(stateRoot, name)) writeErr(`warning: '${name}' is running — restart to apply: maestro serve stop ${name} && maestro serve start ${name}\n`);
    return {};
  }

  if (sub === "rm") {
    const name = rest[0];
    if (!(await readDefinition(stateRoot, name))) throw typedError("unknown_service", name);
    if (await isRunning(stateRoot, name)) {
      if (!flags.force) throw typedError("service_running", `${name} is running — stop it first or pass --force`);
      await stopService({ stateRoot, name });
    }
    const p = servicePaths(stateRoot, name);
    for (const f of [p.def, p.pid, p.log, `${p.pid}.lock`]) await removeFile(f);
    await removeDir(p.stateDir);
    write(`✓ service '${name}' removed\n`);
    return {};
  }

  if (sub === "start") {
    const targets = flags.all ? await pickStartable(stateRoot) : [requireName(rest)];
    for (const name of targets) {
      const res = await startService({ stateRoot, name, spawnProcess, waitForPid });
      const status = await serviceStatus(stateRoot, name);
      write(formatStartFeedback({ name, pid: res.pid, port: res.port, slug: status?.slug, intervalMs: 30000, stateDir: servicePaths(stateRoot, name).stateDir }));
    }
    return {};
  }

  if (sub === "stop") {
    const targets = flags.all ? await listDefinitions(stateRoot) : [requireName(rest)];
    for (const name of targets) {
      const res = await stopService({ stateRoot, name });
      write(`${res.stopped ? "✓ stopped" : "— not running"} '${name}'${res.reason === "stale" ? " (stale record cleaned)" : ""}\n`);
    }
    return {};
  }

  if (sub === "pause") { await pauseService({ stateRoot, name: requireName(rest) }); write(`✓ service '${rest[0]}' paused\n`); return {}; }

  if (sub === "resume") {
    const name = requireName(rest);
    const res = await resumeService({ stateRoot, name, spawnProcess, waitForPid });
    const status = await serviceStatus(stateRoot, name);
    write(formatStartFeedback({ name, pid: res.pid, port: res.port, slug: status?.slug, intervalMs: 30000, stateDir: servicePaths(stateRoot, name).stateDir }));
    return {};
  }

  if (sub === "status") {
    const s = await serviceStatus(stateRoot, requireName(rest));
    if (!s) throw typedError("unknown_service", rest[0]);
    write(formatStatusTable([s]));
    return {};
  }

  if (sub === "logs") {
    const name = requireName(rest);
    write(await tailServiceLog({ stateRoot, name, lines: flags.lines ?? 40 }) + "\n");
    if (flags.follow) await followLog({ stateRoot, name, write });
    return {};
  }

  if (sub === "adopt") { return runAdopt({ stateRoot, rest, write, writeErr }); }

  if (sub === "run") {
    const name = requireName(rest);
    return runWorker({ stateRoot, name, env, logger });
  }

  throw typedError("usage", `unknown serve subcommand: ${sub}`);
}

async function followLog({ stateRoot, name, write }) {
  const fs = await import("node:fs");
  const { log } = servicePaths(stateRoot, name);
  return new Promise(() => {
    let size = 0;
    try { size = fs.statSync(log).size; } catch {}
    fs.watch(log, { persistent: true }, () => {
      try {
        const cur = fs.statSync(log).size;
        if (cur > size) { const buf = Buffer.alloc(cur - size); const fd = fs.openSync(log, "r"); fs.readSync(fd, buf, 0, buf.length, size); fs.closeSync(fd); write(buf.toString("utf8")); size = cur; }
      } catch {}
    });
  });
}

// The worker process: write our own pid record FIRST (orphan-safe), install
// signal handlers that clean it up, then run the existing poller via the
// startMaestro overlay seam.
async function runWorker({ stateRoot, name, env, logger = new StructuredLogger() }) {
  const def = await readDefinition(stateRoot, name);
  if (!def) throw typedError("unknown_service", name);
  const { serverOverlay, stateDir } = buildOverlay({ name, def, stateRoot });

  const { readStartTime } = await import("./proc.mjs");
  await writePidRecord(stateRoot, name, {
    pid: process.pid,
    startTimeMs: readStartTime(process.pid),
    argv0: process.execPath,
    port: def.port ?? null,
  });
  const cleanup = () => { try { require("node:fs").rmSync(servicePaths(stateRoot, name).pid, { force: true }); } catch {} };
  process.on("exit", cleanup);

  const service = await startMaestro({ stateDir, overlay: serverOverlay, env, logger });
  const shutdown = async () => { try { await service.stop(); } finally { cleanup(); process.exit(0); } };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return new Promise(() => {});
}

async function tryAutoAdopt({ stateRoot, write, writeErr }) {
  const { LocalTaskStore } = await import("../../task-store.mjs");
  const store = new LocalTaskStore({ root: stateRoot });
  await store.init();
  const tracker = (await store.readConfig()).server?.tracker;
  if (!tracker?.project_slug) return false;
  await writeDefinition(stateRoot, "default", { slug: tracker.project_slug, paused: false });
  write(`Found a configured tracker with no named service.\nTreating it as service 'default' (${tracker.project_slug}).\n  Make it explicit: maestro serve adopt default\n\n`);
  return true;
}

async function runAdopt({ stateRoot, rest, write, writeErr }) {
  const name = rest[0] ?? "default";
  const { LocalTaskStore } = await import("../../task-store.mjs");
  const store = new LocalTaskStore({ root: stateRoot });
  await store.init();
  const cfg = await store.readConfig();
  const tracker = cfg.server?.tracker;
  if (!tracker?.project_slug) throw typedError("nothing_to_adopt", "no configured server.tracker found");
  if (await readDefinition(stateRoot, name)) throw typedError("service_exists", name);
  await writeDefinition(stateRoot, name, { slug: tracker.project_slug, paused: false });
  write(`✓ adopted legacy tracker as service '${name}' (${tracker.project_slug})\n`);
  if (cfg.server?.hooks && Object.values(cfg.server.hooks).some((v) => typeof v === "string" && v)) {
    writeErr(`warning: this config defines hooks that run via the shell — review before \`maestro serve start ${name}\`\n`);
  }
  return {};
}
