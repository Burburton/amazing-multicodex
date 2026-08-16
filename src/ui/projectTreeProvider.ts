import * as vscode from "vscode";
import { ProjectProps, ProjectRepository } from "../modules/projects/public";
import { TaskProps, TaskRepository, TaskStatus } from "../modules/tasks/public";
import { sortTasksForDisplay, taskPriorityLabel, taskStatusLabel, taskTooltip } from "./taskPresentation";

export type ProjectTreeNode = ProjectProps | TaskProps;

export class ProjectTreeProvider implements vscode.TreeDataProvider<ProjectTreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(private readonly projects: ProjectRepository, private readonly tasks: TaskRepository) {}

  async getChildren(element?: ProjectTreeNode): Promise<ProjectTreeNode[]> {
    if (element && isProject(element)) return this.tasksFor(element);
    if (element) return [];
    const projects = await this.projects.list();
    const snapshots = projects.ok ? projects.value.map(project => project.snapshot()) : [];
    await vscode.commands.executeCommand("setContext", "amazingMultiCodex.hasProjects", snapshots.length > 0);
    return snapshots;
  }

  async getTreeItem(element: ProjectTreeNode): Promise<vscode.TreeItem> {
    if (!isProject(element)) return this.taskItem(element);
    const project = element;
    const [tasks, projects] = await Promise.all([this.tasks.list(), this.projects.list()]);
    const includeLegacy = projects.ok && projects.value[0]?.snapshot().id === project.id;
    const owned = tasks.ok ? tasks.value.map(task => task.snapshot()).filter(task =>
      task.projectId === project.id || (includeLegacy && task.projectId === undefined)
    ) : [];
    const active = owned.filter(task => ["preparing", "running", "awaitingApproval", "validating", "integrating"].includes(task.status)).length;
    const attention = owned.filter(task => ["blocked", "failed", "readyForReview", "deleting"].includes(task.status)).length;
    const item = new vscode.TreeItem(project.name, vscode.TreeItemCollapsibleState.Expanded);
    item.description = `${owned.length} tasks · ${active} active · ${attention} attention`;
    item.tooltip = new vscode.MarkdownString([
      `**${project.name}**`, "", `Repository: \`${project.repositoryRoot}\``, `Base ref: \`${project.baseRef}\``,
      `Tasks: ${owned.length} · Active: ${active} · Attention: ${attention}`
    ].join("\n"));
    item.iconPath = new vscode.ThemeIcon(attention ? "warning" : active ? "sync~spin" : "repo");
    item.contextValue = "multicodexProject";
    item.command = { command: "amazingMultiCodex.showProjectDetails", title: "Show Project Details", arguments: [project] };
    return item;
  }
  refresh(): void { this.emitter.fire(); }
  dispose(): void { this.emitter.dispose(); }

  private async tasksFor(project: ProjectProps): Promise<TaskProps[]> {
    const [tasks, projects] = await Promise.all([this.tasks.list(), this.projects.list()]);
    if (!tasks.ok) return [];
    const includeLegacy = projects.ok && projects.value[0]?.snapshot().id === project.id;
    return sortTasksForDisplay(tasks.value.map(task => task.snapshot()).filter(task =>
      task.projectId === project.id || (includeLegacy && task.projectId === undefined)
    ));
  }

  private taskItem(task: TaskProps): vscode.TreeItem {
    const item = new vscode.TreeItem(task.title, vscode.TreeItemCollapsibleState.None);
    item.description = `${taskStatusLabel(task.status)} · ${taskPriorityLabel(task.priority)}`;
    item.tooltip = taskTooltip(task);
    item.iconPath = new vscode.ThemeIcon(iconFor(task.status));
    item.contextValue = task.status === "blocked" && task.statusReason?.startsWith("integration.")
      ? "multicodexTask.blocked.integration"
      : `multicodexTask.${task.status}`;
    item.command = { command: "amazingMultiCodex.showTaskDetails", title: "Show Task Details", arguments: [task] };
    item.accessibilityInformation = {
      label: `${task.title}, ${taskStatusLabel(task.status)}, ${taskPriorityLabel(task.priority)} priority`,
      role: "button"
    };
    return item;
  }
}

function isProject(node: ProjectTreeNode): node is ProjectProps { return "repositoryRoot" in node; }

function iconFor(status: TaskStatus): string {
  switch (status) {
    case "running": return "sync~spin";
    case "preparing": return "loading~spin";
    case "validating": return "beaker";
    case "readyForReview": return "inspect";
    case "integrating": return "git-merge";
    case "completed": return "pass-filled";
    case "failed": return "error";
    case "blocked": return "warning";
    case "awaitingApproval": return "key";
    case "cancelled": return "circle-slash";
    case "deleting": return "trash";
    default: return "circle-outline";
  }
}
