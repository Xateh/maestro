// End-of-run summary: one line per executed step (role, provider, status,
// duration, stdout size) printed after a task run returns. Read-only — sizes
// come from fs.stat on the step's stdout log; anything missing degrades to "-".

import fs from "node:fs/promises";

import { createTheme } from "./tui.mjs";

export function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1_000) return "<1s";
  const totalSeconds = Math.round(ms / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m${String(totalSeconds % 60).padStart(2, "0")}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h${String(totalMinutes % 60).padStart(2, "0")}m`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1_024) return `${bytes}B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)}KB`;
  return `${(bytes / 1_048_576).toFixed(1)}MB`;
}

export async function buildRunSummary(task, { stat = fs.stat } = {}) {
  const rows = [];
  for (const step of task.steps ?? []) {
    const durationMs = step.started_at && step.completed_at
      ? Date.parse(step.completed_at) - Date.parse(step.started_at)
      : null;
    let stdoutBytes = null;
    if (step.stdout_path) {
      try {
        stdoutBytes = (await stat(step.stdout_path)).size;
      } catch { /* log file missing — leave "-" */ }
    }
    rows.push({
      role: step.role ?? "-",
      provider: step.provider ?? "-",
      status: step.status ?? "-",
      duration_ms: durationMs,
      stdout_bytes: stdoutBytes,
    });
  }
  return { task_id: task.id, status: task.status, run_dir: task.run_dir ?? null, rows };
}

export function formatRunSummary(summary, { color = false } = {}) {
  const theme = createTheme({ color });
  const lines = [`run summary: ${summary.task_id} ${theme.status(summary.status, summary.status)}`];
  for (const row of summary.rows) {
    lines.push([
      `  ${String(row.role).padEnd(10)}`,
      String(row.provider).padEnd(8),
      theme.status(row.status, String(row.status).padEnd(10)),
      formatDurationMs(row.duration_ms).padStart(6),
      ` ${formatBytes(row.stdout_bytes)}`,
    ].join(" "));
  }
  if (summary.run_dir) lines.push(`  ${theme.dim("run dir:")} ${summary.run_dir}`);
  return lines.join("\n");
}
