import * as vscode from "vscode";
import { ProjectProps, ProjectRepository } from "../modules/projects/public";
import { TaskRepository } from "../modules/tasks/public";

export class ProjectTreeProvider implements vscode.TreeDataProvider<ProjectProps>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(private readonly projects: ProjectRepository, private readonly tasks: TaskRepository) {}

  async getChildren(): Promise<ProjectProps[]> {
    const projects = await this.projects.list();
    const snapshots = projects.ok ? projects.value.map(project => project.snapshot()) : [];
    await vscode.commands.executeCommand("setContext", "amazingMultiCodex.hasProjects", snapshots.length > 0);
    return snapshots;
  }

  async getTreeItem(project: ProjectProps): Promise<vscode.TreeItem> {
    const [tasks, projects] = await Promise.all([this.tasks.list(), this.projects.list()]);
    const includeLegacy = projects.ok && projects.value[0]?.snapshot().id === project.id;
    const owned = tasks.ok ? tasks.value.map(task => task.snapshot()).filter(task =>
      task.projectId === project.id || (includeLegacy && task.projectId === undefined)
    ) : [];
    const active = owned.filter(task => ["preparing", "running", "awaitingApproval", "validating", "integrating"].includes(task.status)).length;
    const attention = owned.filter(task => ["blocked", "failed", "readyForReview", "deleting"].includes(task.status)).length;
    const item = new vscode.TreeItem(project.name, vscode.TreeItemCollapsibleState.None);
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
}
