import * as vscode from "vscode";
import { CodexProcessSupervisor } from "./adapters/codex-app-server/codexProcessSupervisor";
import { GitWorkspaceAdapter } from "./adapters/git-cli/gitWorkspaceAdapter";
import { NodeCommandRunner } from "./adapters/process/nodeCommandRunner";
import { NodeProcessFactory } from "./adapters/process/nodeProcessFactory";
import { MementoExecutionRepository } from "./adapters/vscode/mementoExecutionRepository";
import { MementoTaskRepository } from "./adapters/vscode/mementoTaskRepository";
import { AgentEventCoordinator, ResumeTaskWorkflow, StartTaskWorkflow } from "./modules/orchestration/public";
import { CreateTaskHandler, TaskLifecycleService, TaskProps } from "./modules/tasks/public";
import { SystemClock } from "./shared/core/clock";
import { CryptoIdGenerator } from "./shared/core/idGenerator";
import { TaskTreeProvider } from "./ui/taskTreeProvider";

export function activate(context: vscode.ExtensionContext): void {
  const repository = new MementoTaskRepository(context.workspaceState);
  const clock = new SystemClock();
  const createTask = new CreateTaskHandler(repository, clock, new CryptoIdGenerator());
  const lifecycle = new TaskLifecycleService(repository, clock);
  const tree = new TaskTreeProvider(repository);
  const ids = new CryptoIdGenerator();
  const codex = new CodexProcessSupervisor(new NodeProcessFactory(), {
    malformedProtocolLine: line => console.warn("MultiCodex ignored malformed Codex output", line),
    stderr: chunk => console.warn("Codex App Server:", chunk.trimEnd()),
    exited: exit => console.info("Codex App Server exited", exit),
    processError: error => console.error("Codex App Server error", error)
  });
  const executions = new MementoExecutionRepository(context.workspaceState);
  let coordinator: AgentEventCoordinator | undefined;

  context.subscriptions.push(
    tree,
    { dispose: () => {
      coordinator?.stop();
      codex.stop();
    } },
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
    }),
    vscode.commands.registerCommand("amazingMultiCodex.startTask", async (task?: TaskProps) => {
      if (!task) {
        void vscode.window.showErrorMessage("Select a queued MultiCodex task to start.");
        return;
      }
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder || workspaceFolder.uri.scheme !== "file") {
        void vscode.window.showErrorMessage("Open a local Git workspace before starting a task.");
        return;
      }
      const storage = context.storageUri;
      if (!storage || storage.scheme !== "file") {
        void vscode.window.showErrorMessage("MultiCodex storage is unavailable for this workspace.");
        return;
      }

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Starting MultiCodex task: ${task.title}`,
        cancellable: false
      }, async () => {
        try {
          await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(storage, "worktrees"));
          const agent = await codex.start({ cwd: workspaceFolder.uri.fsPath });
          coordinator?.stop();
          coordinator = new AgentEventCoordinator(agent, executions, lifecycle, clock, {
            error: (message, error) => console.error(message, error),
            taskChanged: () => tree.refresh()
          });
          coordinator.start();
          const workflow = new StartTaskWorkflow(
            lifecycle,
            new GitWorkspaceAdapter(new NodeCommandRunner()),
            agent,
            executions,
            clock,
            ids
          );
          const started = await workflow.execute({
            taskId: task.id,
            repositoryRoot: workspaceFolder.uri.fsPath,
            worktreeRoot: vscode.Uri.joinPath(storage, "worktrees").fsPath,
            baseRef: "HEAD"
          });
          tree.refresh();
          if (!started.ok) {
            void vscode.window.showErrorMessage(started.error.message);
            return;
          }
          void vscode.window.showInformationMessage(`Started MultiCodex task: ${task.title}`);
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : "Unknown startup error.";
          void vscode.window.showErrorMessage(`Could not start MultiCodex task: ${message}`);
        }
      });
    }),
    vscode.commands.registerCommand("amazingMultiCodex.resumeTask", async (task?: TaskProps) => {
      if (!task) {
        void vscode.window.showErrorMessage("Select a running MultiCodex task to resume.");
        return;
      }
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder || workspaceFolder.uri.scheme !== "file") {
        void vscode.window.showErrorMessage("Open the task's local Git workspace before resuming.");
        return;
      }
      try {
        const agent = await codex.start({ cwd: workspaceFolder.uri.fsPath });
        coordinator?.stop();
        coordinator = new AgentEventCoordinator(agent, executions, lifecycle, clock, {
          error: (message, error) => console.error(message, error),
          taskChanged: () => tree.refresh()
        });
        coordinator.start();
        const resumed = await new ResumeTaskWorkflow(lifecycle, agent, executions, clock)
          .execute({ taskId: task.id });
        if (!resumed.ok) {
          void vscode.window.showErrorMessage(resumed.error.message);
          return;
        }
        void vscode.window.showInformationMessage(`Resumed MultiCodex task: ${task.title}`);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "Unknown resume error.";
        void vscode.window.showErrorMessage(`Could not resume MultiCodex task: ${message}`);
      }
    })
  );
}

export function deactivate(): void {
  // Task execution will be added behind the App Server adapter.
}
