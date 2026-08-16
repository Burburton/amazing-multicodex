import * as vscode from "vscode";
import { MementoTaskRepository } from "./adapters/vscode/mementoTaskRepository";
import { CreateTaskHandler, TaskLifecycleService } from "./modules/tasks/public";
import { SystemClock } from "./shared/core/clock";
import { CryptoIdGenerator } from "./shared/core/idGenerator";
import { TaskTreeProvider } from "./ui/taskTreeProvider";

export function activate(context: vscode.ExtensionContext): void {
  const repository = new MementoTaskRepository(context.workspaceState);
  const clock = new SystemClock();
  const createTask = new CreateTaskHandler(repository, clock, new CryptoIdGenerator());
  const lifecycle = new TaskLifecycleService(repository, clock);
  const tree = new TaskTreeProvider(repository);

  context.subscriptions.push(
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
      const created = await createTask.execute({ title, description });
      if (!created.ok) {
        void vscode.window.showErrorMessage(created.error.message);
        return;
      }
      const queued = await lifecycle.transition(created.value.id, "queued");
      if (!queued.ok) {
        void vscode.window.showErrorMessage(queued.error.message);
        return;
      }
      tree.refresh();
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
