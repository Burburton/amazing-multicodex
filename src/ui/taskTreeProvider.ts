import * as vscode from "vscode";
import { TaskProps, TaskRepository, TaskStatus } from "../modules/tasks/public";

export class TaskTreeProvider implements vscode.TreeDataProvider<TaskProps> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly repository: TaskRepository) {}

  getTreeItem(task: TaskProps): vscode.TreeItem {
    const item = new vscode.TreeItem(task.title, vscode.TreeItemCollapsibleState.None);
    item.description = `${task.status} · ${task.priority}`;
    item.tooltip = task.description ?? "No task description";
    item.iconPath = new vscode.ThemeIcon(this.iconFor(task.status));
    item.contextValue = task.status === "blocked" && task.statusReason?.startsWith("integration.")
      ? "multicodexTask.blocked.integration"
      : `multicodexTask.${task.status}`;
    return item;
  }

  async getChildren(): Promise<TaskProps[]> {
    const tasks = await this.repository.list();
    if (!tasks.ok) return [];
    return tasks.value.map(task => task.snapshot());
  }

  refresh(): void {
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  private iconFor(status: TaskStatus): string {
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
      default: return "circle-outline";
    }
  }
}
