import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

import { createRateLimiter } from "./http-rate-limit.mjs";

// Per-route token-bucket budgets. Reads are generous (the dashboard polls
// /api/v1/state every 5s); writes are tight (refresh triggers real work).
const RATE_LIMITS = {
  read: { capacity: 120, refillPerSec: 2 }, // ~120/min, burst 120
  write: { capacity: 12, refillPerSec: 0.2 }, // ~12/min, burst 12
};
// Identifiers come from the URL path. Allow only a bounded, slash-free charset
// so nothing reaches the orchestrator that could be a traversal or injection.
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_POST_BODY_BYTES = 1024; // refresh carries no body; reject anything large

/**
 * Validate a GitHub webhook HMAC-SHA256 signature.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function validateGithubSignature(body, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  if (!sigHeader.startsWith("sha256=")) return false;
  const digest = createHmac("sha256", secret).update(body).digest("hex");
  const expected = Buffer.from(`sha256=${digest}`, "utf8");
  const received = Buffer.from(sigHeader, "utf8");
  if (expected.length !== received.length) return false;
  try {
    return timingSafeEqual(expected, received);
  } catch {
    return false;
  }
}

/**
 * Minimal Liquid-style template renderer: {{a.b.c}} → nested property lookup.
 * Falls back to empty string for missing keys. No loops/conditionals needed.
 */
export function renderWebhookTemplate(template, context) {
  return String(template).replace(/\{\{([^}]+)\}\}/g, (_, expr) => {
    const parts = expr.trim().split(".");
    let value = context;
    for (const part of parts) {
      if (value == null || typeof value !== "object") return "";
      value = value[part];
    }
    return value == null ? "" : String(value);
  });
}

// Decode + validate a URL path identifier. Returns the clean value, or null
// when the encoding is malformed or the value is outside the allowed shape.
export function sanitizeIdentifier(rawSegment) {
  let decoded;
  try {
    decoded = decodeURIComponent(rawSegment);
  } catch {
    return null;
  }
  return IDENTIFIER_PATTERN.test(decoded) ? decoded : null;
}

function clientKey(request, fallback) {
  return request.socket?.remoteAddress || fallback || "unknown";
}

function oversizedPostBody(request) {
  const len = Number.parseInt(request.headers?.["content-length"] ?? "", 10);
  return Number.isFinite(len) && len > MAX_POST_BODY_BYTES;
}

function tooManyRequests(response, retryAfterMs) {
  const retryAfter = Math.max(1, Math.ceil((retryAfterMs || 1000) / 1000));
  sendJson(response, 429, {
    error: { code: "rate_limited", message: "Too many requests — slow down." },
  }, { "retry-after": String(retryAfter) });
}

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
  // Escape every "<" as a JS unicode escape so attacker-influenced snapshot
  // content (e.g. issue titles/descriptions) can never break out of this
  // <script> block — neutralizes "</script>" in ANY case as well as "<!--".
  // (A case-sensitive "</script>" replace missed variants like "</Script>".) (F1)
  const initialJson = JSON.stringify(snapshot).replace(/</g, "\\u003c");

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
      --danger: #f85149; --warn: #d29922; --ok: #3fb950;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body { background: var(--bg); color: var(--text); font-family: var(--font); font-size: 14px; display: flex; min-height: 100vh; overflow: hidden; }

    /* ── sidebar ── */
    nav { width: 220px; min-height: 100vh; background: var(--surface); border-right: 1px solid var(--border); padding: 1.5rem 1rem; flex-shrink: 0; display: flex; flex-direction: column; gap: 0; }
    nav h1 { font-size: 15px; font-weight: 700; color: var(--accent); margin-bottom: 1.5rem; letter-spacing: .02em; }
    .nav-section { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 1rem 0 .3rem; }
    .nav-stat { display: flex; justify-content: space-between; align-items: center; padding: .3rem .5rem; border-radius: 6px; color: var(--muted); font-size: 13px; }
    .nav-stat strong { color: var(--text); font-variant-numeric: tabular-nums; }
    .nav-link { display: block; padding: .35rem .5rem; border-radius: 6px; color: var(--muted); text-decoration: none; font-size: 13px; cursor: pointer; border: none; background: none; width: 100%; text-align: left; }
    .nav-link:hover { background: #21262d; color: var(--text); }
    .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; flex-shrink: 0; }
    .dot-run { background: var(--accent); } .dot-wait { background: var(--warn); } .dot-done { background: var(--ok); }
    #tick-age { font-size: 12px; color: var(--muted); margin-top: auto; padding-top: 1rem; }

    /* ── main content ── */
    .content { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
    .toolbar { display: flex; align-items: center; justify-content: space-between; padding: 1.25rem 1.5rem; border-bottom: 1px solid var(--border); gap: 1rem; flex-shrink: 0; }
    .toolbar h2 { font-size: 17px; font-weight: 600; }
    .toolbar-right { display: flex; align-items: center; gap: .75rem; }

    /* filter tabs */
    .tabs { display: flex; gap: .25rem; }
    .tab { padding: .3rem .75rem; border-radius: 6px; font-size: 13px; cursor: pointer; border: 1px solid transparent; color: var(--muted); background: none; transition: background .1s, color .1s; }
    .tab:hover { background: #21262d; color: var(--text); }
    .tab.active { background: #1c2128; border-color: var(--border); color: var(--text); }

    /* buttons */
    .btn { border: none; border-radius: 6px; padding: .38rem .9rem; font-size: 13px; cursor: pointer; display: inline-flex; align-items: center; gap: .4rem; transition: opacity .1s; }
    .btn:disabled { opacity: .5; cursor: not-allowed; }
    .btn-primary { background: #238636; color: #fff; }
    .btn-primary:hover:not(:disabled) { background: #2ea043; }
    .btn-ghost { background: #21262d; color: var(--text); border: 1px solid var(--border); }
    .btn-ghost:hover:not(:disabled) { background: #30363d; }

    /* spinner */
    @keyframes spin { to { transform: rotate(360deg); } }
    .spinner { width: 12px; height: 12px; border: 2px solid rgba(255,255,255,.3); border-top-color: #fff; border-radius: 50%; animation: spin .6s linear infinite; }

    /* table area */
    .table-wrap { flex: 1; overflow: auto; padding: 1.25rem 1.5rem; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th { background: #0d1117; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; padding: .55rem 1rem; text-align: left; border-bottom: 1px solid var(--border); }
    td { padding: .6rem 1rem; border-bottom: 1px solid #21262d; vertical-align: middle; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    tr:last-child td { border-bottom: none; }
    tbody tr { cursor: pointer; transition: background .1s; }
    tbody tr:hover td { background: #1c2128; }
    tbody tr.selected td { background: #1c2128; border-left: 2px solid var(--accent); }
    td.col-id { font-family: monospace; color: var(--accent); font-size: 13px; width: 160px; }
    td.col-ts { color: var(--muted); font-size: 12px; font-family: monospace; width: 160px; }
    td.col-state { color: var(--muted); width: 180px; }
    td.col-attempt { width: 70px; color: var(--muted); }
    .badge { display: inline-block; padding: .15rem .5rem; border-radius: 12px; font-size: 11px; font-weight: 600; color: #fff; white-space: nowrap; }
    .empty { text-align: center; color: var(--muted); padding: 3rem; font-size: 13px; }

    /* ── detail panel ── */
    .panel-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.4); opacity: 0; pointer-events: none; transition: opacity .2s; z-index: 10; }
    .panel-overlay.open { opacity: 1; pointer-events: auto; }
    .panel { position: fixed; top: 0; right: 0; width: 420px; max-width: 100vw; height: 100vh; background: var(--surface); border-left: 1px solid var(--border); display: flex; flex-direction: column; transform: translateX(100%); transition: transform .22s cubic-bezier(.4,0,.2,1); z-index: 11; }
    .panel.open { transform: translateX(0); }
    .panel-header { display: flex; align-items: center; justify-content: space-between; padding: 1rem 1.25rem; border-bottom: 1px solid var(--border); flex-shrink: 0; }
    .panel-title { font-size: 15px; font-weight: 600; font-family: monospace; color: var(--accent); }
    .panel-close { background: none; border: none; color: var(--muted); font-size: 20px; cursor: pointer; padding: .2rem .4rem; border-radius: 4px; line-height: 1; }
    .panel-close:hover { background: #21262d; color: var(--text); }
    .panel-body { flex: 1; overflow-y: auto; padding: 1.25rem; }
    .panel-loading { display: flex; align-items: center; justify-content: center; height: 120px; color: var(--muted); gap: .5rem; }
    .panel-loading .spinner { border-top-color: var(--muted); }
    .detail-section { margin-bottom: 1.25rem; }
    .detail-label { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin-bottom: .4rem; }
    .detail-value { font-size: 13px; color: var(--text); word-break: break-word; }
    .detail-value.mono { font-family: monospace; font-size: 12px; }
    .detail-value.pre { white-space: pre-wrap; background: #0d1117; border: 1px solid var(--border); border-radius: 6px; padding: .6rem .8rem; font-size: 12px; font-family: monospace; max-height: 200px; overflow: auto; }
    .panel-actions { display: flex; gap: .5rem; padding: 1rem 1.25rem; border-top: 1px solid var(--border); flex-shrink: 0; }

    /* ── toasts ── */
    #toasts { position: fixed; bottom: 1.25rem; right: 1.25rem; display: flex; flex-direction: column; gap: .5rem; z-index: 20; }
    .toast { background: #21262d; border: 1px solid var(--border); border-radius: 8px; padding: .6rem 1rem; font-size: 13px; min-width: 200px; animation: slide-in .2s ease; }
    .toast.ok { border-color: var(--ok); color: var(--ok); }
    .toast.err { border-color: var(--danger); color: var(--danger); }
    @keyframes slide-in { from { transform: translateY(8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

    /* ── pulse indicator ── */
    .pulse { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--ok); animation: pulse 2s infinite; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
  </style>
</head>
<body>

<nav>
  <h1>🎼 Maestro</h1>
  <div class="nav-section">Live Status</div>
  <div class="nav-stat"><span><span class="dot dot-run"></span>Running</span><strong id="cnt-running">0</strong></div>
  <div class="nav-stat"><span><span class="dot dot-wait"></span>Retrying</span><strong id="cnt-retrying">0</strong></div>
  <div class="nav-stat"><span><span class="dot dot-done"></span>Completed</span><strong id="cnt-completed">0</strong></div>
  <div class="nav-section">Tokens</div>
  <div class="nav-stat"><span>Total</span><strong id="cnt-tokens">0</strong></div>
  <div class="nav-stat"><span>Input</span><strong id="cnt-input">0</strong></div>
  <div class="nav-stat"><span>Output</span><strong id="cnt-output">0</strong></div>
  <div class="nav-section">Links</div>
  <a class="nav-link" href="/api/v1/state" target="_blank">JSON State ↗</a>
  <div id="tick-age">Last tick: —</div>
</nav>

<div class="content">
  <div class="toolbar">
    <div style="display:flex;align-items:center;gap:.75rem">
      <h2>Tasks</h2>
      <span class="pulse" id="live-dot" title="Live polling"></span>
    </div>
    <div class="toolbar-right">
      <div class="tabs">
        <button class="tab active" data-filter="all">All</button>
        <button class="tab" data-filter="running">Running</button>
        <button class="tab" data-filter="retrying">Retrying</button>
        <button class="tab" data-filter="completed">Completed</button>
      </div>
      <button class="btn btn-ghost" id="poll-btn" title="Force poll now">↺ Poll</button>
      <button class="btn btn-primary" id="refresh-btn">Trigger Refresh</button>
    </div>
  </div>

  <div class="table-wrap">
    <div class="card">
      <div id="table-container"></div>
    </div>
  </div>
</div>

<!-- detail panel -->
<div class="panel-overlay" id="overlay"></div>
<div class="panel" id="panel">
  <div class="panel-header">
    <span class="panel-title" id="panel-title">—</span>
    <button class="panel-close" id="panel-close">×</button>
  </div>
  <div class="panel-body" id="panel-body"></div>
  <div class="panel-actions" id="panel-actions"></div>
</div>

<div id="toasts"></div>

<script>
(function () {
  // ── initial data ──────────────────────────────────────────────────────────
  let state = ${initialJson};
  let activeFilter = 'all';
  let selectedId = null;
  let pollTimer = null;

  // ── helpers ───────────────────────────────────────────────────────────────
  const STATUS_MAP = {
    running:   { color: '#0052cc', label: 'Running'  },
    retrying:  { color: '#974f0c', label: 'Retrying' },
    succeeded: { color: '#1a7f37', label: 'Done'     },
    failed:    { color: '#cf222e', label: 'Failed'   },
  };

  function badge(status) {
    const { color, label } = STATUS_MAP[status] ?? { color: '#6e7781', label: status };
    return \`<span class="badge" style="background:\${color}">\${label}</span>\`;
  }

  function esc(v) {
    return String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function ts(v) {
    return (v ?? '').replace('T', ' ').slice(0, 19);
  }

  function toast(msg, kind = 'ok') {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = msg;
    document.getElementById('toasts').append(el);
    setTimeout(() => el.remove(), 3500);
  }

  // ── sidebar ───────────────────────────────────────────────────────────────
  function updateSidebar(s) {
    const c = s.counts ?? {};
    document.getElementById('cnt-running').textContent   = c.running   ?? 0;
    document.getElementById('cnt-retrying').textContent  = c.retrying  ?? 0;
    document.getElementById('cnt-completed').textContent = c.completed ?? 0;
    const tot = s.codex_totals ?? {};
    document.getElementById('cnt-tokens').textContent = (tot.total_tokens  ?? 0).toLocaleString();
    document.getElementById('cnt-input').textContent  = (tot.input_tokens  ?? 0).toLocaleString();
    document.getElementById('cnt-output').textContent = (tot.output_tokens ?? 0).toLocaleString();
    const age = s.last_tick_at
      ? Math.round((Date.now() - Date.parse(s.last_tick_at)) / 1000) + 's ago'
      : '—';
    document.getElementById('tick-age').textContent = 'Last tick: ' + age;
  }

  // ── table ─────────────────────────────────────────────────────────────────
  function allTasks(s) {
    return [
      ...(s.running   ?? []).map(t => ({ ...t, _status: 'running'  })),
      ...(s.retrying  ?? []).map(t => ({ ...t, _status: 'retrying' })),
      ...(s.completed ?? []).map(t => ({ ...t, _status: t.status ?? 'succeeded' })),
    ];
  }

  function renderTable(s) {
    const tasks = allTasks(s).filter(t =>
      activeFilter === 'all' ||
      (activeFilter === 'running'   && t._status === 'running') ||
      (activeFilter === 'retrying'  && t._status === 'retrying') ||
      (activeFilter === 'completed' && (t._status === 'succeeded' || t._status === 'failed'))
    );

    const container = document.getElementById('table-container');
    if (!tasks.length) {
      container.innerHTML = '<div class="empty">No tasks — start a run via <code>maestro run</code>.</div>';
      return;
    }

    const rows = tasks.map(t => {
      const id  = esc(t.issue_identifier ?? '—');
      const st  = esc(t.state ?? t.reason ?? '—');
      const att = t.attempt != null ? '#' + t.attempt : '—';
      const ts_ = ts(t.started_at ?? t.due_at ?? t.completed_at);
      const sel = t.issue_identifier === selectedId ? ' selected' : '';
      return \`<tr class="task-row\${sel}" data-id="\${id}" title="Click to view details">
        <td class="col-id">\${id}</td>
        <td>\${badge(t._status)}</td>
        <td class="col-state">\${st}</td>
        <td class="col-attempt">\${att}</td>
        <td class="col-ts">\${ts_}</td>
      </tr>\`;
    }).join('');

    container.innerHTML = \`<table>
      <thead><tr>
        <th style="width:150px">Identifier</th>
        <th style="width:100px">Status</th>
        <th>State / Reason</th>
        <th style="width:75px">Attempt</th>
        <th style="width:155px">Timestamp</th>
      </tr></thead>
      <tbody>\${rows}</tbody>
    </table>\`;

    container.querySelectorAll('.task-row').forEach(row => {
      row.addEventListener('click', () => openPanel(row.dataset.id));
    });
  }

  // ── polling ───────────────────────────────────────────────────────────────
  function scheduleNext() {
    const active = (state.counts?.running ?? 0) + (state.counts?.retrying ?? 0);
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, active > 0 ? 5000 : 30000);
  }

  async function poll() {
    try {
      const res  = await fetch('/api/v1/state');
      if (!res.ok) throw new Error(res.status);
      const next = await res.json();
      state = next;
      updateSidebar(state);
      renderTable(state);
      if (selectedId) refreshPanelData(selectedId);
    } catch { /* network glitch — retry next cycle */ }
    scheduleNext();
  }

  document.getElementById('poll-btn').addEventListener('click', async () => {
    clearTimeout(pollTimer);
    await poll();
    toast('Polled');
  });

  // ── refresh trigger ───────────────────────────────────────────────────────
  document.getElementById('refresh-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Refreshing…';
    try {
      await fetch('/api/v1/refresh', { method: 'POST' });
      toast('Refresh triggered');
      clearTimeout(pollTimer);
      await poll();
    } catch { toast('Refresh failed', 'err'); }
    finally {
      btn.disabled = false;
      btn.innerHTML = 'Trigger Refresh';
    }
  });

  // ── filter tabs ───────────────────────────────────────────────────────────
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeFilter = tab.dataset.filter;
      renderTable(state);
    });
  });

  // ── detail panel ──────────────────────────────────────────────────────────
  function openPanel(identifier) {
    selectedId = identifier;
    renderTable(state);           // mark row selected
    document.getElementById('panel-title').textContent = identifier;
    document.getElementById('panel-body').innerHTML =
      '<div class="panel-loading"><span class="spinner"></span> Loading…</div>';
    document.getElementById('panel-actions').innerHTML = '';
    document.getElementById('panel').classList.add('open');
    document.getElementById('overlay').classList.add('open');
    refreshPanelData(identifier);
  }

  async function refreshPanelData(identifier) {
    try {
      const res = await fetch('/api/v1/' + encodeURIComponent(identifier));
      if (res.status === 404) { renderPanelNotFound(identifier); return; }
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      renderPanel(data);
    } catch (err) {
      document.getElementById('panel-body').innerHTML =
        '<div class="panel-loading" style="color:var(--danger)">Failed to load details</div>';
    }
  }

  function renderPanelNotFound(id) {
    document.getElementById('panel-body').innerHTML =
      '<div class="panel-loading" style="color:var(--muted)">No runtime details for ' + esc(id) + '</div>';
  }

  function field(label, value, mono = false) {
    if (value == null || value === '') return '';
    const cls = mono ? ' mono' : '';
    return \`<div class="detail-section">
      <div class="detail-label">\${label}</div>
      <div class="detail-value\${cls}">\${esc(String(value))}</div>
    </div>\`;
  }

  function preField(label, value) {
    if (value == null) return '';
    const txt = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return \`<div class="detail-section">
      <div class="detail-label">\${label}</div>
      <div class="detail-value pre">\${esc(txt)}</div>
    </div>\`;
  }

  function renderPanel(data) {
    const issue = data.issue ?? {};
    let html = '';
    html += field('Status',      data.status);
    html += field('Identifier',  data.issue_identifier, true);
    html += field('State',       issue.state ?? data.status);
    html += field('Attempt',     data.attempt != null ? '#' + data.attempt : null);
    html += field('Started',     ts(data.started_at));
    html += field('Due / Retry', ts(data.due_at));
    html += field('Completed',   ts(data.completed_at));
    html += field('Reason',      data.reason);
    if (issue.title) html += field('Title', issue.title);
    if (issue.description) html += preField('Description', issue.description.slice(0, 600));
    if (issue.priority != null) html += field('Priority', issue.priority);
    if (issue.assignee)  html += field('Assignee', issue.assignee?.name ?? issue.assignee);
    if (Object.keys(issue).length > 0) html += preField('Full Issue', issue);
    document.getElementById('panel-body').innerHTML = html || '<div class="panel-loading" style="color:var(--muted)">No detail fields</div>';

    // action buttons
    const actions = document.getElementById('panel-actions');
    actions.innerHTML = '';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn btn-ghost';
    copyBtn.textContent = 'Copy JSON';
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(JSON.stringify(data, null, 2))
        .then(() => toast('Copied to clipboard'))
        .catch(() => toast('Copy failed', 'err'));
    };
    actions.append(copyBtn);

    const rawBtn = document.createElement('a');
    rawBtn.className = 'btn btn-ghost';
    rawBtn.textContent = 'Raw ↗';
    rawBtn.href = '/api/v1/' + encodeURIComponent(data.issue_identifier ?? '');
    rawBtn.target = '_blank';
    actions.append(rawBtn);
  }

  function closePanel() {
    selectedId = null;
    document.getElementById('panel').classList.remove('open');
    document.getElementById('overlay').classList.remove('open');
    renderTable(state);
  }

  document.getElementById('panel-close').addEventListener('click', closePanel);
  document.getElementById('overlay').addEventListener('click', closePanel);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel(); });

  // ── boot ──────────────────────────────────────────────────────────────────
  updateSidebar(state);
  renderTable(state);
  scheduleNext();
})();
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

export function createMaestroHttpHandler({ orchestrator, host = "127.0.0.1", rateLimit, dispatchFn, taskStore, config } = {}) {
  // rateLimit: pass a limiter to inject one (tests), `false`/env to disable,
  // or omit for the default in-memory token bucket.
  const limiter = rateLimit === false || process.env.MAESTRO_HTTP_RATELIMIT === "off"
    ? null
    : (rateLimit || createRateLimiter());

  return async function maestroHttpHandler(request, response) {
    const url = new URL(request.url ?? "/", `http://${host}`);

    // Rate limit every endpoint (including 404s, to blunt enumeration floods).
    // Writes and reads draw from separate per-client budgets.
    if (limiter) {
      const isWrite = request.method === "POST" && url.pathname === "/api/v1/refresh";
      const cls = isWrite ? "write" : "read";
      const { allowed, retryAfterMs } = limiter.check(`${clientKey(request, host)}:${cls}`, RATE_LIMITS[cls]);
      if (!allowed) return tooManyRequests(response, retryAfterMs);
    }

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
        if (oversizedPostBody(request)) {
          return sendJson(response, 413, {
            error: { code: "payload_too_large", message: "Request body too large." },
          });
        }
        sendJson(response, 202, await orchestrator.refresh());
        return;
      }

      const detailMatch = url.pathname.match(/^\/api\/v1\/([^/]+)$/);
      if (detailMatch) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const identifier = sanitizeIdentifier(detailMatch[1]);
        if (identifier === null) {
          return sendJson(response, 400, {
            error: { code: "bad_request", message: "Invalid issue identifier." },
          });
        }
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

      // POST /api/v1/webhook/:kind
      if (request.method === "POST" && url.pathname.startsWith("/api/v1/webhook/")) {
        const kind = url.pathname.slice("/api/v1/webhook/".length);
        if (!["github", "generic"].includes(kind)) {
          return sendJson(response, 404, { error: { code: "not_found" } });
        }

        // Read body (bounded to 1 MB)
        const MAX_WEBHOOK_BYTES = 1024 * 1024;
        const contentLen = Number.parseInt(request.headers["content-length"] ?? "", 10);
        if (Number.isFinite(contentLen) && contentLen > MAX_WEBHOOK_BYTES) {
          return sendJson(response, 413, { error: { code: "payload_too_large" } });
        }
        const chunks = [];
        let received = 0;
        for await (const chunk of request) {
          received += chunk.length;
          if (received > MAX_WEBHOOK_BYTES) {
            return sendJson(response, 413, { error: { code: "payload_too_large" } });
          }
          chunks.push(chunk);
        }
        const rawBody = Buffer.concat(chunks);

        const serverConfig = config?.server ?? {};

        // Auth / signature check
        if (kind === "github") {
          const secret = serverConfig.webhook_secret;
          if (!secret) return sendJson(response, 500, { error: { code: "webhook_secret_not_configured" } });
          const sig = request.headers["x-hub-signature-256"] ?? null;
          if (!validateGithubSignature(rawBody, sig, secret)) {
            return sendJson(response, 400, { error: { code: "invalid_signature" } });
          }
        } else if (kind === "generic") {
          const expectedToken = serverConfig.webhook_bearer_token;
          if (!expectedToken) return sendJson(response, 404, { error: { code: "not_found" } });
          const authHeader = request.headers.authorization ?? "";
          if (!authHeader.startsWith("Bearer ")) {
            return sendJson(response, 401, { error: { code: "unauthorized" } });
          }
          const receivedToken = Buffer.from(authHeader.slice(7), "utf8");
          const expectedTokenBuf = Buffer.from(expectedToken, "utf8");
          if (receivedToken.length !== expectedTokenBuf.length || !timingSafeEqual(receivedToken, expectedTokenBuf)) {
            return sendJson(response, 401, { error: { code: "unauthorized" } });
          }
        }

        // Parse payload + render template
        let payload;
        try { payload = JSON.parse(rawBody.toString("utf8")); } catch {
          return sendJson(response, 400, { error: { code: "invalid_json" } });
        }
        const template = serverConfig.webhook_template;
        if (!template) return sendJson(response, 422, { error: { code: "webhook_template_not_configured" } });
        const taskTitle = renderWebhookTemplate(template, { payload });
        if (!taskTitle.trim()) return sendJson(response, 422, { error: { code: "empty_task_title" } });

        // Dispatch to orchestrator
        const workflow = serverConfig.workflow ?? "default";
        const dispatch = dispatchFn ?? (
          taskStore
            ? ({ title, workflow: wf }) => taskStore.createTask({ prompt: title, workflow: wf }).then((t) => t.id)
            : null
        );
        if (typeof dispatch !== "function") {
          return sendJson(response, 500, { error: { code: "dispatch_not_configured" } });
        }
        try {
          const taskId = await dispatch({ title: taskTitle, workflow });
          return sendJson(response, 202, { task_id: taskId });
        } catch (err) {
          return sendJson(response, 500, { error: { code: "dispatch_failed", message: err?.message } });
        }
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

export async function startMaestroHttpServer({ orchestrator, taskStore, port, host = "127.0.0.1", config }) {
  const server = http.createServer(createMaestroHttpHandler({ orchestrator, taskStore, host, config }));

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
