import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { ProjectProps } from "../modules/projects/public";
import { TaskId, TaskProps } from "../modules/tasks/public";
import { taskPriorityLabel, taskStatusLabel } from "./taskPresentation";

export class ProjectDetailPanelManager implements vscode.Disposable {
  private readonly panels = new Map<ProjectProps["id"], vscode.WebviewPanel>();
  private readonly projects = new Map<ProjectProps["id"], ProjectProps>();
  constructor(private readonly loadTasks: (projectId: ProjectProps["id"]) => Promise<readonly TaskProps[]>, private readonly openTask: (taskId: TaskId) => Promise<void>) {}
  async show(project: ProjectProps): Promise<void> {
    this.projects.set(project.id, project);
    let panel = this.panels.get(project.id);
    if (!panel) {
      panel = vscode.window.createWebviewPanel("amazingMultiCodex.projectDetail", `MultiCodex Project: ${project.name}`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
      this.panels.set(project.id, panel);
      panel.onDidDispose(() => {
        this.panels.delete(project.id);
        this.projects.delete(project.id);
      });
      panel.webview.onDidReceiveMessage(async message => {
        if (message && typeof message === "object" && message.type === "openTask" && typeof message.taskId === "string" && message.taskId.length <= 1_000) {
          await this.openTask(message.taskId as TaskId);
        }
      });
    } else panel.reveal(vscode.ViewColumn.Active);
    await this.renderPanel(panel, project);
  }
  async refresh(project: ProjectProps): Promise<void> {
    const panel = this.panels.get(project.id);
    if (!panel) return;
    this.projects.set(project.id, project);
    await this.renderPanel(panel, project);
  }
  async refreshAll(): Promise<void> {
    await Promise.all([...this.panels].map(async ([projectId, panel]) => {
      const project = this.projects.get(projectId);
      if (project) await this.renderPanel(panel, project);
    }));
  }
  close(projectId: ProjectProps["id"]): void { this.panels.get(projectId)?.dispose(); }
  dispose(): void { for (const panel of this.panels.values()) panel.dispose(); this.panels.clear(); this.projects.clear(); }
  private async renderPanel(panel: vscode.WebviewPanel, project: ProjectProps): Promise<void> {
    panel.webview.html = render(project, await this.loadTasks(project.id));
  }
}

function render(project: ProjectProps, tasks: readonly TaskProps[]): string {
  const nonce = randomBytes(18).toString("base64");
  const active = tasks.filter(task => ["preparing", "running", "awaitingApproval", "validating", "integrating"].includes(task.status)).length;
  const attention = tasks.filter(task => ["blocked", "failed", "readyForReview", "deleting"].includes(task.status)).length;
  const completed = tasks.filter(task => task.status === "completed").length;
  const rows = tasks.length ? tasks.map(task => `<button class="task" data-task="${escapeHtml(task.id)}"><span><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(taskPriorityLabel(task.priority))} priority</small></span><span class="status">${escapeHtml(taskStatusLabel(task.status))}</span></button>`).join("") : '<p class="empty">No tasks in this project yet.</p>';
  return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width,initial-scale=1"><style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:24px;max-width:1050px;margin:auto}h1{margin-bottom:4px}.path{color:var(--vscode-descriptionForeground);overflow-wrap:anywhere}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:24px 0}.metric{background:var(--vscode-editor-inactiveSelectionBackground);padding:16px;border-radius:5px}.metric strong{display:block;font-size:24px}.tasks{display:grid;gap:8px}.task{display:flex;justify-content:space-between;align-items:center;text-align:left;border:1px solid var(--vscode-panel-border);background:var(--vscode-list-inactiveSelectionBackground);color:var(--vscode-foreground);padding:12px 14px;cursor:pointer}.task:hover{background:var(--vscode-list-hoverBackground)}.task span:first-child{display:grid;gap:4px}.task small{color:var(--vscode-descriptionForeground)}.status{background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);padding:3px 9px;border-radius:10px}.empty{color:var(--vscode-descriptionForeground)}</style></head><body>
<h1>${escapeHtml(project.name)}</h1><div class="path">${escapeHtml(project.repositoryRoot)} · base ${escapeHtml(project.baseRef)}</div><section class="metrics"><div class="metric"><strong>${tasks.length}</strong>Total tasks</div><div class="metric"><strong>${active}</strong>Active</div><div class="metric"><strong>${attention}</strong>Needs attention</div><div class="metric"><strong>${completed}</strong>Completed</div></section><h2>Tasks</h2><div class="tasks">${rows}</div><script nonce="${nonce}">const vscode=acquireVsCodeApi();document.querySelectorAll('[data-task]').forEach(row=>row.addEventListener('click',()=>vscode.postMessage({type:'openTask',taskId:row.dataset.task})));</script></body></html>`;
}
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!); }
