import { ENV_KEY_DENYLIST } from "../../agent-runner.mjs";

function pad(s, n) { s = String(s); return s + " ".repeat(Math.max(0, n - s.length)); }

export function formatStatusTable(rows) {
  const header = `${pad("NAME", 12)}${pad("SLUG", 10)}${pad("PORT", 8)}STATE`;
  const lines = rows.map((r) => {
    const state = r.state === "running" ? `running (pid ${r.pid})` : r.state === "crashed" ? "crashed (stale)" : r.state;
    return `${pad(r.name, 12)}${pad(r.slug ?? "-", 10)}${pad(r.port ?? "-", 8)}${state}`;
  });
  return [header, ...lines].join("\n") + "\n";
}

export function emptyGuidance() {
  return [
    "No services configured.",
    "  Add one:  maestro serve add <name> --slug <SLUG>",
    "  Then:     maestro serve start <name>",
    "",
  ].join("\n");
}

export function formatStartFeedback({ name, pid, port, slug, intervalMs, stateDir }) {
  const lines = [
    `✓ service '${name}' started`,
    `  pid ${pid} · tracker ${slug} · polling every ${Math.round((intervalMs ?? 30000) / 1000)}s` +
      (port ? ` · HTTP http://127.0.0.1:${port}` : ""),
    `  state: ${stateDir}`,
    `  logs:  maestro serve logs ${name} -f`,
    `  stop:  maestro serve stop ${name}`,
  ];
  return lines.join("\n") + "\n";
}

// Non-fatal advisories surfaced at add/list/start.
export function collectWarnings({ defs, env }) {
  const warnings = [];
  const portMap = new Map();
  for (const d of defs) {
    if (d.port != null) {
      if (portMap.has(d.port)) warnings.push(`port ${d.port} is used by both '${portMap.get(d.port)}' and '${d.name}'`);
      else portMap.set(d.port, d.name);
    }
    const varName = d.var ?? "LINEAR_API_KEY";
    if (ENV_KEY_DENYLIST.test(varName)) warnings.push(`service '${d.name}': api-key var ${varName} is denylisted`);
    else if (!env[varName]) warnings.push(`service '${d.name}': ${varName} is unset - it won't be able to poll`);
    if (!d.slug) warnings.push(`service '${d.name}': missing slug`);
  }
  return warnings;
}
