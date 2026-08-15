import * as vscode from "vscode";
import { TaskStore } from "./application/taskStore";
import { TaskTreeProvider } from "./ui/taskTreeProvider";

export function activate(context: vscode.ExtensionContext): void {
  const store = new TaskStore(context.workspaceState);
  const tree = new TaskTreeProvider(store);

  context.subscriptions.push(
    store,
    tree,
    vscode.window.registerTreeDataProvider("amazingMultiCodex.tasks", tree),
    vscode.commands.registerCommand("amazingMultiCodex.createTask", async () => {
      const title = await vscode.window.showInputBox({
        prompt: "What should Codex work on?",
        placeHolder: "e.g. Add retry handling to the API client"
      });
      if (!title?.trim()) return;

      const description = await vscode.window.showInputBox({
        prompt: "Optional task context",
        placeHolder: "Constraints, acceptance criteria, or relevant notes"
      });
      await store.add(title.trim(), description?.trim());
      void vscode.window.showInformationMessage(`Queued MultiCodex task: ${title.trim()}`);
    }),
    vscode.commands.registerCommand("amazingMultiCodex.refreshTasks", () => {
      tree.refresh();
    })
  );
}

export function deactivate(): void {
  // Task execution will be added behind the App Server adapter.
}
