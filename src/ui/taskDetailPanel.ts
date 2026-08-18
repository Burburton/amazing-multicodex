import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { TaskDetailProjection } from "../modules/orchestration/public";
import { TaskId, TaskProps } from "../modules/tasks/public";
import { AgentPlanProps } from "../modules/agents/public";
import { taskPriorityLabel, taskStatusLabel } from "./taskPresentation";

export type TaskDetailAction = "edit" | "configureAgents" | "queue" | "start" | "resume" | "steer" | "cancel" | "validate" | "changes" | "integrate" | "recoverIntegration" | "release" | "delete";

export interface TaskDetailViewModel extends TaskDetailProjection { readonly agentPlan?: AgentPlanProps }

const allowedActions = new Set<TaskDetailAction>([
  "edit", "configureAgents", "queue", "start", "resume", "steer", "cancel", "validate", "changes", "integrate", "recoverIntegration", "release", "delete"
]);

export class TaskDetailPanelManager implements vscode.Disposable {
  private readonly panels = new Map<TaskId, vscode.WebviewPanel>();
  private readonly actionsInFlight = new Set<TaskId>();

  constructor(
    private readonly load: (taskId: TaskId) => Promise<TaskDetailViewModel | undefined>,
    private readonly onAction: (action: TaskDetailAction, task: TaskProps) => Promise<void>,
    private readonly onError: (message: string, cause: unknown) => void = () => undefined
  ) {}

  async show(taskId: TaskId): Promise<void> {
    const existing = this.panels.get(taskId);
    if (existing) {
      existing.reveal(vscode.ViewColumn.Active);
      await this.refreshPanel(taskId, existing);
      return;
    }
    const detail = await this.load(taskId);
    if (!detail) return;
    const panel = vscode.window.createWebviewPanel(
      "amazingMultiCodex.taskDetail",
      `MultiCodex: ${detail.task.title}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panels.set(taskId, panel);
    panel.webview.html = render(detail);
    panel.onDidDispose(() => this.panels.delete(taskId));
    panel.onDidChangeViewState(event => {
      if (event.webviewPanel.visible) void this.refreshPanel(taskId, panel);
    });
    panel.webview.onDidReceiveMessage(async message => {
      if (!isActionMessage(message) || this.actionsInFlight.has(taskId)) return;
      this.actionsInFlight.add(taskId);
      try {
        const current = await this.load(taskId);
        if (!current) return;
        await this.onAction(message.action, current.task);
      } catch (cause) {
        this.onError("MultiCodex task action failed.", cause);
      } finally {
        this.actionsInFlight.delete(taskId);
        await this.refreshPanel(taskId, panel);
      }
    });
  }

  async refresh(taskId: TaskId): Promise<void> {
    const panel = this.panels.get(taskId);
    if (panel) await this.refreshPanel(taskId, panel);
  }

  dispose(): void {
    for (const panel of this.panels.values()) panel.dispose();
    this.panels.clear();
    this.actionsInFlight.clear();
  }

  private async refreshPanel(taskId: TaskId, panel: vscode.WebviewPanel): Promise<void> {
    const detail = await this.load(taskId);
    if (!detail) {
      if (this.panels.has(taskId)) panel.dispose();
      return;
    }
    if (!this.panels.has(taskId)) return;
    panel.title = `MultiCodex: ${detail.task.title}`;
    panel.webview.html = render(detail);
  }
}

function isActionMessage(message: unknown): message is { version: 1; type: "action"; action: TaskDetailAction } {
  if (!message || typeof message !== "object") return false;
  const candidate = message as Record<string, unknown>;
  return candidate.version === 1 && candidate.type === "action" && typeof candidate.action === "string"
    && allowedActions.has(candidate.action as TaskDetailAction);
}

function render(detail: TaskDetailViewModel): string {
  const nonce = randomBytes(18).toString("base64");
  const task = detail.task;
  const criteria = task.acceptanceCriteria.length
    ? `<ul>${task.acceptanceCriteria.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : '<p class="muted">No acceptance criteria.</p>';
  const prerequisites = detail.prerequisites.length
    ? `<ul>${detail.prerequisites.map(item => `<li>${escapeHtml(item.title)} <span class="badge">${escapeHtml(item.status)}</span></li>`).join("")}</ul>`
    : '<p class="muted">No prerequisites.</p>';
  const execution = detail.latestExecution
    ? `<dl><dt>Status</dt><dd>${escapeHtml(detail.latestExecution.status)}</dd>${detail.latestExecution.stage ? `<dt>Agent stage</dt><dd>${escapeHtml(roleLabel(detail.latestExecution.stage.role))} · ${detail.latestExecution.stage.index + 1} of ${detail.latestExecution.stage.total}</dd><dt>Completed stages</dt><dd>${detail.latestExecution.previousAgents?.length ?? 0}</dd>` : ""}<dt>Branch</dt><dd><code>${escapeHtml(detail.latestExecution.workspace.branch)}</code></dd><dt>Worktree</dt><dd><code>${escapeHtml(detail.latestExecution.workspace.path)}</code></dd></dl>`
    : '<p class="muted">No execution yet.</p>';
  const agentPlan = detail.agentPlan?.stages.length
    ? `<ol>${detail.agentPlan.stages.map(stage => `<li><strong>${escapeHtml(roleLabel(stage.role))}</strong><div class="muted">${escapeHtml(stage.objective)}</div></li>`).join("")}</ol>`
    : '<p class="muted">Single Implementer agent (default). Configure a planned role pipeline while this task is a draft.</p>';
  const activity = detail.activity.length
    ? detail.activity.map(item => `<article><header><span class="badge">${escapeHtml(item.kind)}</span><strong>${escapeHtml(item.summary)}</strong><time>${escapeHtml(item.occurredAt.toLocaleString())}</time></header>${item.detail ? `<pre>${escapeHtml(item.detail)}</pre>` : ""}</article>`).join("")
    : '<p class="muted">No activity recorded.</p>';
  const actions = actionsFor(task.status, task.statusReason, !!detail.latestExecution)
    .map(action => `<button data-action="${action.id}"${action.id === "delete" ? ' class="danger"' : ""}>${escapeHtml(action.label)}</button>`).join("");
  const statusReason = task.statusReason
    ? `<aside role="status"><strong>Current status:</strong> ${escapeHtml(task.statusReason)}</aside>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width,initial-scale=1">
<style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:24px;max-width:980px;margin:auto}h1{margin-bottom:6px}h2{margin-top:28px;border-bottom:1px solid var(--vscode-panel-border);padding-bottom:7px}.meta,.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.actions{margin:18px 0}.actions button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:7px 12px;border-radius:2px;cursor:pointer}.actions button:hover{background:var(--vscode-button-hoverBackground)}.actions button.danger{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);outline:1px solid var(--vscode-inputValidation-errorBorder)}.actions button.danger:hover{background:var(--vscode-button-secondaryHoverBackground)}.actions button:disabled{opacity:.65;cursor:wait}.badge{background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-radius:10px;padding:2px 8px;font-size:12px}.muted,time{color:var(--vscode-descriptionForeground)}aside{border-left:3px solid var(--vscode-editorWarning-foreground);background:var(--vscode-textBlockQuote-background);padding:10px 12px;margin:16px 0}dl{display:grid;grid-template-columns:max-content 1fr;gap:7px 14px}dt{font-weight:600}dd{margin:0;min-width:0;overflow-wrap:anywhere}article{border-left:2px solid var(--vscode-panel-border);padding:4px 0 12px 14px;margin:12px 0}article header{display:flex;gap:9px;align-items:center}time{margin-left:auto;font-size:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--vscode-textCodeBlock-background);padding:10px;border-radius:4px}code{font-family:var(--vscode-editor-font-family)}
</style></head><body>
<h1>${escapeHtml(task.title)}</h1><div class="meta"><span class="badge">${escapeHtml(taskStatusLabel(task.status))}</span><span>${escapeHtml(taskPriorityLabel(task.priority))} priority</span><span class="muted">Updated ${escapeHtml(task.updatedAt.toLocaleString())}</span></div>
${task.description ? `<p>${escapeHtml(task.description)}</p>` : ""}${statusReason}<div class="actions">${actions}</div>
<h2>Agent pipeline</h2>${agentPlan}<h2>Acceptance criteria</h2>${criteria}<h2>Prerequisites</h2>${prerequisites}<h2>Latest execution</h2>${execution}<h2>Activity</h2>${activity}
<script nonce="${nonce}">const vscode=acquireVsCodeApi();const buttons=[...document.querySelectorAll('[data-action]')];buttons.forEach(button=>button.addEventListener('click',()=>{buttons.forEach(item=>item.disabled=true);vscode.postMessage({version:1,type:'action',action:button.dataset.action});}));</script>
</body></html>`;
}

function actionsFor(
  status: TaskDetailProjection["task"]["status"],
  reason: string | undefined,
  hasExecution: boolean
): readonly { id: TaskDetailAction; label: string }[] {
  const inspect = hasExecution ? [{ id: "changes" as const, label: "View changes" }] : [];
  switch (status) {
    case "draft": return [{ id: "edit", label: "Edit draft" }, { id: "configureAgents", label: "Configure agents" }, { id: "queue", label: "Queue task" }, { id: "delete", label: "Delete task" }];
    case "failed": return [...inspect, { id: "queue", label: "Queue task" }, { id: "delete", label: "Delete task" }];
    case "cancelled": return [
      ...inspect,
      { id: "queue", label: "Queue task" },
      ...(hasExecution ? [{ id: "release" as const, label: "Release worktree" }] : []),
      { id: "delete", label: "Delete task" }
    ];
    case "blocked": return reason?.startsWith("integration.")
      ? [...inspect, { id: "integrate", label: "Retry integration" }, { id: "delete", label: "Delete task" }]
      : [...inspect, { id: "queue", label: "Retry task" }, { id: "delete", label: "Delete task" }];
    case "queued": return [{ id: "start", label: "Start now" }, { id: "cancel", label: "Cancel" }];
    case "running": return [
      { id: "steer", label: "Send follow-up" },
      { id: "resume", label: "Reconnect / resume" },
      { id: "cancel", label: "Cancel" }
    ];
    case "awaitingApproval": return [{ id: "cancel", label: "Cancel" }];
    case "validating": return [{ id: "validate", label: "Run validation" }, { id: "changes", label: "View changes" }];
    case "readyForReview": return [{ id: "changes", label: "View changes" }, { id: "integrate", label: "Integrate" }, { id: "delete", label: "Delete task" }];
    case "integrating": return [{ id: "recoverIntegration", label: "Recover integration" }];
    case "completed": return [{ id: "changes", label: "View changes" }, { id: "release", label: "Release worktree" }, { id: "delete", label: "Delete task" }];
    case "deleting": return [{ id: "delete", label: "Retry deletion" }];
    default: return [];
  }
}

function roleLabel(role: AgentPlanProps["stages"][number]["role"]): string {
  return role[0].toUpperCase() + role.slice(1);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]!);
}
