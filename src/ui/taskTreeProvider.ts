import * as vscode from "vscode";
import { TaskProps, TaskRepository, TaskStatus } from "../modules/tasks/public";
import { sortTasksForDisplay, taskPriorityLabel, taskStatusLabel, taskTooltip } from "./taskPresentation";

export interface TaskTreeDiagnostics {
  readonly error: (message: string, cause?: unknown) => void;
}

export class TaskTreeProvider implements vscode.TreeDataProvider<TaskProps> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly repository: TaskRepository,
    private readonly diagnostics: TaskTreeDiagnostics = { error: () => undefined }
  ) {}

  getTreeItem(task: TaskProps): vscode.TreeItem {
    const item = new vscode.TreeItem(task.title, vscode.TreeItemCollapsibleState.None);
    item.description = `${taskStatusLabel(task.status)} · ${taskPriorityLabel(task.priority)}`;
    item.tooltip = taskTooltip(task);
    item.iconPath = new vscode.ThemeIcon(this.iconFor(task.status));
    item.contextValue = task.status === "blocked" && task.statusReason?.startsWith("integration.")
      ? "multicodexTask.blocked.integration"
      : `multicodexTask.${task.status}`;
    item.command = {
      command: "amazingMultiCodex.showTaskDetails",
      title: "Show Task Details",
      arguments: [task]
    };
    item.accessibilityInformation = {
      label: `${task.title}, ${taskStatusLabel(task.status)}, ${taskPriorityLabel(task.priority)} priority`,
      role: "button"
    };
    return item;
  }

  async getChildren(): Promise<TaskProps[]> {
    const tasks = await this.repository.list();
    if (!tasks.ok) {
      await vscode.commands.executeCommand("setContext", "amazingMultiCodex.hasTasks", false);
      this.diagnostics.error(tasks.error.message, tasks.error);
      return [];
    }
    const snapshots = sortTasksForDisplay(tasks.value.map(task => task.snapshot()));
    await vscode.commands.executeCommand("setContext", "amazingMultiCodex.hasTasks", snapshots.length > 0);
    return snapshots;
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
      case "deleting": return "trash";
      default: return "circle-outline";
    }
  }
}
