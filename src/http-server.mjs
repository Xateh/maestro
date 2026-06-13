import http from "node:http";

function sendJson(response, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  response.end(payload);
}

function buildDashboardHtml(snapshot) {
  const { counts = {}, running = [], retrying = [], completed = [], last_tick_at, codex_totals } = snapshot;

  const badge = (text, color) =>
    `<span class="badge" style="background:${color}">${text}</span>`;

  const statusBadge = (status) => {
    const map = {
      running: ["#0052cc", "Running"],
      retrying: ["#974f0c", "Retrying"],
      succeeded: ["#1a7f37", "Done"],
      failed: ["#cf222e", "Failed"],
    };
    const [color, label] = map[status] ?? ["#6e7781", status];
    return badge(label, color);
  };

  const taskRow = (item, status) => `
    <tr>
      <td class="id">${item.issue_identifier ?? "—"}</td>
      <td>${statusBadge(status)}</td>
      <td>${item.state ?? item.reason ?? "—"}</td>
      <td>${item.attempt != null ? `#${item.attempt}` : "—"}</td>
      <td class="ts">${(item.started_at ?? item.due_at ?? item.completed_at ?? "").replace("T", " ").slice(0, 19)}</td>
    </tr>`;

  const rows = [
    ...running.map((t) => taskRow(t, "running")),
    ...retrying.map((t) => taskRow(t, "retrying")),
    ...completed.map((t) => taskRow(t, t.status ?? "succeeded")),
  ].join("");

  const totalTokens = codex_totals?.total_tokens ?? 0;
  const tickAge = last_tick_at
    ? `${Math.round((Date.now() - Date.parse(last_tick_at)) / 1000)}s ago`
    : "—";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Maestro</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0d1117; --surface: #161b22; --border: #30363d;
      --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body { background: var(--bg); color: var(--text); font-family: var(--font); font-size: 14px; display: flex; min-height: 100vh; }

    /* sidebar */
    nav { width: 220px; min-height: 100vh; background: var(--surface); border-right: 1px solid var(--border); padding: 1.5rem 1rem; flex-shrink: 0; }
    nav h1 { font-size: 15px; font-weight: 700; color: var(--accent); margin-bottom: 1.5rem; letter-spacing: .02em; }
    nav .section { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 1.2rem 0 .4rem; }
    nav .stat { display: flex; justify-content: space-between; padding: .3rem .5rem; border-radius: 6px; color: var(--muted); font-size: 13px; }
    nav .stat strong { color: var(--text); }
    .nav-item { display: block; padding: .35rem .5rem; border-radius: 6px; color: var(--muted); text-decoration: none; font-size: 13px; }
    .nav-item:hover { background: #21262d; color: var(--text); }
    .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
    .dot-run { background: #58a6ff; } .dot-wait { background: #d29922; } .dot-done { background: #3fb950; }

    /* main */
    main { flex: 1; padding: 2rem; overflow: auto; }
    .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem; }
    .header h2 { font-size: 18px; font-weight: 600; }
    .header small { color: var(--muted); font-size: 12px; }
    .meta { color: var(--muted); font-size: 12px; margin-bottom: 1.5rem; }

    /* table */
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #0d1117; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; padding: .6rem 1rem; text-align: left; border-bottom: 1px solid var(--border); }
    td { padding: .65rem 1rem; border-bottom: 1px solid #21262d; vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #1c2128; }
    td.id { font-family: monospace; color: var(--accent); font-size: 13px; }
    td.ts { color: var(--muted); font-size: 12px; font-family: monospace; }
    .empty { text-align: center; color: var(--muted); padding: 3rem; }

    /* badges */
    .badge { display: inline-block; padding: .15rem .5rem; border-radius: 12px; font-size: 11px; font-weight: 600; color: #fff; white-space: nowrap; }

    /* refresh button */
    .btn { background: #238636; color: #fff; border: none; border-radius: 6px; padding: .4rem .9rem; font-size: 13px; cursor: pointer; }
    .btn:hover { background: #2ea043; }
    .btn:active { opacity: .8; }
  </style>
</head>
<body>
  <nav>
    <h1>🎼 Maestro</h1>
    <div class="section">Status</div>
    <div class="stat"><span><span class="dot dot-run"></span>Running</span><strong>${counts.running ?? 0}</strong></div>
    <div class="stat"><span><span class="dot dot-wait"></span>Retrying</span><strong>${counts.retrying ?? 0}</strong></div>
    <div class="stat"><span><span class="dot dot-done"></span>Completed</span><strong>${counts.completed ?? 0}</strong></div>
    <div class="section">Tokens</div>
    <div class="stat"><span>Total</span><strong>${totalTokens.toLocaleString()}</strong></div>
    <div class="section">Links</div>
    <a class="nav-item" href="/api/v1/state" target="_blank">JSON State ↗</a>
    <a class="nav-item" href="#" id="refresh-link">↺ Refresh</a>
  </nav>
  <main>
    <div class="header">
      <h2>Tasks</h2>
      <div>
        <small style="margin-right:1rem">Last tick: ${tickAge}</small>
        <button class="btn" id="refresh-btn">Trigger Refresh</button>
      </div>
    </div>
    <div class="card">
      ${rows
        ? `<table>
            <thead><tr>
              <th>Identifier</th><th>Status</th><th>State / Reason</th><th>Attempt</th><th>Timestamp</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>`
        : `<div class="empty">No tasks in memory — start a run via <code>maestro run</code>.</div>`}
    </div>
  </main>
  <script>
    async function triggerRefresh() {
      await fetch('/api/v1/refresh', { method: 'POST' });
      location.reload();
    }
    document.getElementById('refresh-btn').addEventListener('click', triggerRefresh);
    document.getElementById('refresh-link').addEventListener('click', (e) => { e.preventDefault(); location.reload(); });
    // Auto-refresh every 10 s when tasks are running
    if (${counts.running ?? 0} > 0 || ${counts.retrying ?? 0} > 0) {
      setTimeout(() => location.reload(), 10000);
    }
  </script>
</body>
</html>`;
}

function sendHtml(response, snapshot) {
  const body = buildDashboardHtml(snapshot);
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function methodNotAllowed(response, allowed) {
  sendJson(response, 405, {
    error: { code: "method_not_allowed", message: `Allowed methods: ${allowed.join(", ")}` },
  }, { allow: allowed.join(", ") });
}

export function createMaestroHttpHandler({ orchestrator, host = "127.0.0.1" }) {
  return async function maestroHttpHandler(request, response) {
    const url = new URL(request.url ?? "/", `http://${host}`);
    try {
      if (url.pathname === "/") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        sendHtml(response, orchestrator.snapshot());
        return;
      }

      if (url.pathname === "/api/v1/state") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        sendJson(response, 200, orchestrator.snapshot());
        return;
      }

      if (url.pathname === "/api/v1/refresh") {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        sendJson(response, 202, await orchestrator.refresh());
        return;
      }

      const detailMatch = url.pathname.match(/^\/api\/v1\/([^/]+)$/);
      if (detailMatch) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const identifier = decodeURIComponent(detailMatch[1]);
        const details = orchestrator.issueDetails(identifier);
        if (!details) {
          sendJson(response, 404, {
            error: { code: "issue_not_found", message: `No Maestro state for ${identifier}` },
          });
          return;
        }
        sendJson(response, 200, details);
        return;
      }

      sendJson(response, 404, {
        error: { code: "not_found", message: url.pathname },
      });
    } catch (error) {
      sendJson(response, 500, {
        error: { code: "internal_error", message: error.message },
      });
    }
  };
}

export async function startMaestroHttpServer({ orchestrator, port, host = "127.0.0.1" }) {
  const server = http.createServer(createMaestroHttpHandler({ orchestrator, host }));

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    server,
    host,
    port: server.address().port,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}
