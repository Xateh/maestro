// Best-effort outbound notifications on run lifecycle events.
// Never throws; one attempt per event; logs to stderr on failure.

export function buildSlackMessage(event, task) {
  const emoji = task.status === "succeeded" ? ":white_check_mark:" : ":x:";
  const summary = task.review?.summary ?? "";
  return {
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${emoji} *Maestro run ${event}*\nTask: \`${task.id}\` | Workflow: \`${task.workflow ?? "default"}\` | Status: \`${task.status}\``,
        },
      },
      ...(summary ? [{
        type: "section",
        text: { type: "mrkdwn", text: summary },
      }] : []),
    ],
  };
}

export function buildGenericMessage(event, task) {
  return {
    event,
    task_id: task.id,
    workflow: task.workflow ?? null,
    status: task.status ?? null,
    summary: task.review?.summary ?? "",
  };
}

/**
 * Send a lifecycle notification. Best-effort: one attempt, non-fatal on failure.
 * @param {string} event - "completed" | "halted" | "approval_needed"
 * @param {object} task
 * @param {object} notifyConfig - { on: string[], url: string, format: "slack"|"generic" }
 * @param {object} [opts] - { fetchImpl?, stderr? }
 */
export async function sendNotification(event, task, notifyConfig, {
  fetchImpl = fetch,
  stderr = process.stderr,
} = {}) {
  const { on = [], url, format = "generic" } = notifyConfig ?? {};
  if (!on.includes(event) || !url) return;

  const body = format === "slack"
    ? buildSlackMessage(event, task)
    : buildGenericMessage(event, task);

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      try { stderr.write(`notify: non-ok response ${response.status} for event ${event}\n`); } catch {}
    }
  } catch (err) {
    try { stderr.write(`notify: failed to send notification for event ${event}: ${err?.message ?? err}\n`); } catch {}
  }
}
