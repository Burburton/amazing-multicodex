import * as vscode from "vscode";
import { MultiCodexTask } from "../domain/task";
import { TaskStore } from "../application/taskStore";

export class TaskTreeProvider implements vscode.TreeDataProvider<MultiCodexTask> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly store: TaskStore) {
    store.onDidChange(() => this.changeEmitter.fire());
  }

  getTreeItem(task: MultiCodexTask): vscode.TreeItem {
    const item = new vscode.TreeItem(task.title, vscode.TreeItemCollapsibleState.None);
    item.description = `${task.status}${task.agentRole ? ` · ${task.agentRole}` : ""}`;
    item.tooltip = task.description ?? "No task description";
    item.iconPath = new vscode.ThemeIcon(this.iconFor(task.status));
    return item;
  }

  getChildren(): MultiCodexTask[] {
    return this.store.list();
  }

  refresh(): void {
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  private iconFor(status: MultiCodexTask["status"]): string {
    switch (status) {
      case "running": return "sync~spin";
      case "completed": return "pass-filled";
      case "failed": return "error";
      case "blocked": return "warning";
      default: return "circle-outline";
    }
  }
}
