import { formatFeedbackReceipt } from "../tui.mjs";

import { writeLine } from "./util.mjs";

export function feedbackReceipt({
  kind,
  message,
  executed = false,
  statusBefore = null,
  statusAfter = null,
  status_before = null,
  status_after = null,
  reason = null,
  actionId = null,
  action_id = null,
  detached = false,
  logPaths = [],
  log_paths = [],
  nextActions = [],
  next_actions = [],
} = {}) {
  return {
    kind: kind ?? "action",
    message: message ?? "",
    executed: Boolean(executed),
    status_before: statusBefore ?? status_before ?? null,
    status_after: statusAfter ?? status_after ?? null,
    reason: reason ?? null,
    action_id: actionId ?? action_id ?? null,
    detached: Boolean(detached),
    log_paths: [...new Set([...(logPaths ?? []), ...(log_paths ?? [])].filter(Boolean))],
    next_actions: [...new Set([...(nextActions ?? []), ...(next_actions ?? [])].filter(Boolean))],
  };
}

export function openNextActions(task = {}) {
  return (task.unblock_options ?? [])
    .filter((option) => option.status === "open")
    .map((option) => option.id)
    .filter(Boolean);
}

export function actionResultLogPaths(result = {}) {
  return [result.stdout_path, result.stderr_path].filter(Boolean);
}

export function attachReceipt(result = {}, receipt = null) {
  if (!receipt) return result;
  const task = result?.task ?? null;
  return {
    ...result,
    receipt: feedbackReceipt({
      ...receipt,
      statusAfter: task?.status ?? receipt.status_after ?? receipt.statusAfter ?? null,
      detached: result?.detached === true || receipt.detached === true,
      nextActions: receipt.next_actions?.length ? receipt.next_actions : openNextActions(task ?? {}),
    }),
  };
}

export function withReceipt(task, receipt) {
  return attachReceipt({ task }, receipt);
}

export function writeResultReceipt(stdout, result) {
  if (result?.receipt) writeLine(stdout, formatFeedbackReceipt(result.receipt, { cli: true }));
}
