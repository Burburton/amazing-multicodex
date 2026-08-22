import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { ProjectProps } from "../modules/projects/public";
import { TaskId, TaskProps } from "../modules/tasks/public";
import { taskPriorityLabel, taskStatusLabel } from "./taskPresentation";
import { groupProjectTasks } from "./projectPresentation";

export class ProjectDetailPanelManager implements vscode.Disposable {
  private readonly panels = new Map<ProjectProps["id"], vscode.WebviewPanel>();
  private readonly projects = new Map<ProjectProps["id"], ProjectProps>();
  constructor(
    private readonly loadTasks: (projectId: ProjectProps["id"]) => Promise<readonly TaskProps[]>,
    private readonly openTask: (taskId: TaskId) => Promise<void>,
    private readonly bulkAction: (action: "cancel" | "reconnect", taskIds: readonly TaskId[]) => Promise<void> = async () => undefined
  ) {}
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
        if (message && typeof message === "object" && message.type === "bulkAction"
          && (message.action === "cancel" || message.action === "reconnect") && Array.isArray(message.taskIds)
          && message.taskIds.length <= 100 && message.taskIds.every((id: unknown) => typeof id === "string" && id.length > 0 && id.length <= 1_000)) {
          await this.bulkAction(message.action, message.taskIds as TaskId[]);
          await this.renderPanel(panel!, project);
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
  const latest = tasks.reduce<Date | undefined>((value, task) => !value || task.updatedAt > value ? task.updatedAt : value, undefined);
  const groups = groupProjectTasks(tasks);
  const rows = groups.length ? groups.map(group => `<section class="group" data-group="${group.id}"><div class="group-title"><h2>${escapeHtml(group.label)}</h2><span>${group.tasks.length}</span></div><div class="tasks">${group.tasks.map(task => `<div class="task" data-search="${escapeHtml(`${task.title} ${task.status} ${task.priority}`.toLowerCase())}"><input class="select" type="checkbox" data-task="${escapeHtml(task.id)}" aria-label="Select ${escapeHtml(task.title)}"><button class="task-open" data-open-task="${escapeHtml(task.id)}"><span><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(taskPriorityLabel(task.priority))} priority · updated ${escapeHtml(task.updatedAt.toLocaleString())}</small></span><span class="status">${escapeHtml(taskStatusLabel(task.status))}</span></button></div>`).join("")}</div></section>`).join("") : '<p class="empty">No tasks in this project yet.</p>';
  return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width,initial-scale=1"><style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:24px;max-width:1050px;margin:auto}h1{margin-bottom:4px}.path,.updated{color:var(--vscode-descriptionForeground);overflow-wrap:anywhere}.updated{margin-top:6px}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:24px 0}.metric{border:0;text-align:left;color:var(--vscode-foreground);background:var(--vscode-editor-inactiveSelectionBackground);padding:16px;border-radius:5px}.metric[data-filter]{cursor:pointer}.metric[data-filter]:hover,.metric.selected{outline:1px solid var(--vscode-focusBorder)}.metric strong{display:block;font-size:24px}.toolbar{display:flex;gap:8px;margin:0 0 20px;flex-wrap:wrap}.toolbar input{flex:1;min-width:120px;padding:7px 9px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border)}.toolbar button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:7px 12px;cursor:pointer}.toolbar button.danger{background:var(--vscode-inputValidation-errorBackground)}.group{margin:0 0 24px}.group-title{display:flex;align-items:center;gap:8px}.group-title h2{font-size:16px}.group-title span{color:var(--vscode-badge-foreground);background:var(--vscode-badge-background);padding:1px 7px;border-radius:10px}.tasks{display:grid;gap:8px}.task{display:flex;align-items:center;gap:8px;border:1px solid var(--vscode-panel-border);background:var(--vscode-list-inactiveSelectionBackground);color:var(--vscode-foreground);padding:8px 10px}.task:hover{background:var(--vscode-list-hoverBackground)}.task .select{flex:0 0 auto}.task-open{display:flex;flex:1;justify-content:space-between;align-items:center;text-align:left;border:0;background:transparent;color:var(--vscode-foreground);padding:4px;cursor:pointer}.task-open span:first-child{display:grid;gap:4px}.task small{color:var(--vscode-descriptionForeground)}.status{background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);padding:3px 9px;border-radius:10px}.empty{color:var(--vscode-descriptionForeground)}[hidden]{display:none!important}</style></head><body>
<h1>${escapeHtml(project.name)}</h1><div class="path">${escapeHtml(project.repositoryRoot)} · base ${escapeHtml(project.baseRef)}</div><div class="updated">${latest ? `Last task update: ${escapeHtml(latest.toLocaleString())}` : "No task activity yet"}</div><section class="metrics"><button class="metric selected" data-filter="all"><strong>${tasks.length}</strong>Total tasks</button><button class="metric" data-filter="active"><strong>${active}</strong>Active</button><button class="metric" data-filter="attention"><strong>${attention}</strong>Needs attention</button><button class="metric" data-filter="completed"><strong>${completed}</strong>Completed</button></section><div class="toolbar"><input id="search" type="search" placeholder="Search tasks by title, status, or priority"><button id="clear">Clear</button><button class="bulk" data-action="reconnect">Reconnect selected</button><button class="bulk danger" data-action="cancel">Cancel selected</button></div><main>${rows}</main><script nonce="${nonce}">const vscode=acquireVsCodeApi();let filter='all';const search=document.getElementById('search');const selected=()=>[...document.querySelectorAll('.select:checked')].map(item=>item.dataset.task).filter(Boolean);const apply=()=>{const query=search.value.trim().toLowerCase();document.querySelectorAll('.group').forEach(group=>{let visible=0;group.querySelectorAll('.task').forEach(row=>{const matchesFilter=filter==='all'||group.dataset.group===filter||(filter==='completed'&&group.dataset.group==='completed');const show=matchesFilter&&row.dataset.search.includes(query);row.hidden=!show;if(show)visible++});group.hidden=visible===0});};document.querySelectorAll('[data-open-task]').forEach(row=>row.addEventListener('click',()=>vscode.postMessage({type:'openTask',taskId:row.dataset.openTask})));document.querySelectorAll('[data-filter]').forEach(button=>button.addEventListener('click',()=>{filter=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach(item=>item.classList.toggle('selected',item===button));apply()}));document.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',()=>{const taskIds=selected();if(taskIds.length)vscode.postMessage({type:'bulkAction',action:button.dataset.action,taskIds})}));search.addEventListener('input',apply);document.getElementById('clear').addEventListener('click',()=>{search.value='';filter='all';document.querySelectorAll('[data-filter]').forEach(item=>item.classList.toggle('selected',item.dataset.filter==='all'));apply()});</script></body></html>`;
}
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!); }
