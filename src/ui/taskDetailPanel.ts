import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { TaskDetailProjection } from "../modules/orchestration/public";

export type TaskDetailAction = "queue" | "start" | "resume" | "cancel" | "validate" | "changes" | "integrate" | "release";

const allowedActions = new Set<TaskDetailAction>([
  "queue", "start", "resume", "cancel", "validate", "changes", "integrate", "release"
]);

export function showTaskDetailPanel(
  detail: TaskDetailProjection,
  onAction: (action: TaskDetailAction) => void
): void {
  const panel = vscode.window.createWebviewPanel(
    "amazingMultiCodex.taskDetail",
    `MultiCodex: ${detail.task.title}`,
    vscode.ViewColumn.Active,
    { enableScripts: true }
  );
  panel.webview.html = render(detail);
  panel.webview.onDidReceiveMessage(message => {
    if (!message || typeof message !== "object") return;
    const candidate = message as Record<string, unknown>;
    if (candidate.version !== 1 || candidate.type !== "action" || typeof candidate.action !== "string") return;
    if (allowedActions.has(candidate.action as TaskDetailAction)) onAction(candidate.action as TaskDetailAction);
  });
}

function render(detail: TaskDetailProjection): string {
  const nonce = randomBytes(18).toString("base64");
  const task = detail.task;
  const criteria = task.acceptanceCriteria.length
    ? `<ul>${task.acceptanceCriteria.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : '<p class="muted">No acceptance criteria.</p>';
  const prerequisites = detail.prerequisites.length
    ? `<ul>${detail.prerequisites.map(item => `<li>${escapeHtml(item.title)} <span class="badge">${escapeHtml(item.status)}</span></li>`).join("")}</ul>`
    : '<p class="muted">No prerequisites.</p>';
  const execution = detail.latestExecution
    ? `<dl><dt>Status</dt><dd>${escapeHtml(detail.latestExecution.status)}</dd><dt>Branch</dt><dd><code>${escapeHtml(detail.latestExecution.workspace.branch)}</code></dd><dt>Worktree</dt><dd><code>${escapeHtml(detail.latestExecution.workspace.path)}</code></dd></dl>`
    : '<p class="muted">No execution yet.</p>';
  const activity = detail.activity.length
    ? detail.activity.map(item => `<article><header><span class="badge">${escapeHtml(item.kind)}</span><strong>${escapeHtml(item.summary)}</strong><time>${escapeHtml(item.occurredAt.toLocaleString())}</time></header>${item.detail ? `<pre>${escapeHtml(item.detail)}</pre>` : ""}</article>`).join("")
    : '<p class="muted">No activity recorded.</p>';
  const actions = actionsFor(task.status, task.statusReason)
    .map(action => `<button data-action="${action.id}">${escapeHtml(action.label)}</button>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:24px;max-width:980px;margin:auto}h1{margin-bottom:6px}h2{margin-top:28px;border-bottom:1px solid var(--vscode-panel-border);padding-bottom:7px}.meta,.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.actions{margin:18px 0}.actions button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:7px 12px;border-radius:2px;cursor:pointer}.actions button:hover{background:var(--vscode-button-hoverBackground)}.badge{background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-radius:10px;padding:2px 8px;font-size:12px}.muted,time{color:var(--vscode-descriptionForeground)}dl{display:grid;grid-template-columns:max-content 1fr;gap:7px 14px}dt{font-weight:600}dd{margin:0;min-width:0;overflow-wrap:anywhere}article{border-left:2px solid var(--vscode-panel-border);padding:4px 0 12px 14px;margin:12px 0}article header{display:flex;gap:9px;align-items:center}time{margin-left:auto;font-size:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--vscode-textCodeBlock-background);padding:10px;border-radius:4px}code{font-family:var(--vscode-editor-font-family)}
</style></head><body>
<h1>${escapeHtml(task.title)}</h1><div class="meta"><span class="badge">${escapeHtml(task.status)}</span><span>${escapeHtml(task.priority)} priority</span></div>
${task.description ? `<p>${escapeHtml(task.description)}</p>` : ""}<div class="actions">${actions}</div>
<h2>Acceptance criteria</h2>${criteria}<h2>Prerequisites</h2>${prerequisites}<h2>Latest execution</h2>${execution}<h2>Activity</h2>${activity}
<script nonce="${nonce}">const vscode=acquireVsCodeApi();document.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({version:1,type:'action',action:button.dataset.action})));</script>
</body></html>`;
}

function actionsFor(status: TaskDetailProjection["task"]["status"], reason?: string): readonly { id: TaskDetailAction; label: string }[] {
  switch (status) {
    case "draft": case "failed": case "cancelled": return [{ id: "queue", label: "Queue task" }];
    case "blocked": return reason?.startsWith("integration.")
      ? [{ id: "integrate", label: "Retry integration" }]
      : [{ id: "queue", label: "Retry task" }];
    case "queued": return [{ id: "start", label: "Start now" }];
    case "running": return [{ id: "resume", label: "Resume" }, { id: "cancel", label: "Cancel" }];
    case "awaitingApproval": return [{ id: "cancel", label: "Cancel" }];
    case "validating": return [{ id: "validate", label: "Run validation" }, { id: "changes", label: "View changes" }];
    case "readyForReview": return [{ id: "changes", label: "View changes" }, { id: "integrate", label: "Integrate" }];
    case "completed": return [{ id: "changes", label: "View changes" }, { id: "release", label: "Release worktree" }];
    default: return [];
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]!);
}
