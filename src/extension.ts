import * as vscode from "vscode";
import { CodexProcessSupervisor } from "./adapters/codex-app-server/codexProcessSupervisor";
import { GitWorkspaceAdapter } from "./adapters/git-cli/gitWorkspaceAdapter";
import { GitIntegrationAdapter } from "./adapters/git-cli/gitIntegrationAdapter";
import { NodeCommandRunner } from "./adapters/process/nodeCommandRunner";
import { NodeProcessFactory } from "./adapters/process/nodeProcessFactory";
import { MementoActivityRepository } from "./adapters/vscode/mementoActivityRepository";
import { MementoApprovalRepository } from "./adapters/vscode/mementoApprovalRepository";
import { MementoExecutionRepository } from "./adapters/vscode/mementoExecutionRepository";
import { MementoTaskRepository } from "./adapters/vscode/mementoTaskRepository";
import { MementoTaskDependencyRepository } from "./adapters/vscode/mementoTaskDependencyRepository";
import { AgentActivityBridge } from "./host/agentActivityBridge";
import { ApprovalBridge } from "./host/approvalBridge";
import { ActivityService } from "./modules/activity/public";
import { ApprovalService } from "./modules/approvals/public";
import { IntegrateTaskWorkflow, IntegrationStrategy } from "./modules/integration/public";
import { ValidationCommandSetting, parseSettings } from "./modules/settings/public";
import {
  AgentEventCoordinator,
  CancelTaskWorkflow,
  DispatchQueuedTasksWorkflow,
  ExecutionCapacityGate,
  ResumeTaskWorkflow,
  SchedulerPolicy,
  StartTaskWorkflow,
  ValidateTaskWorkflow
} from "./modules/orchestration/public";
import {
  CreateTaskHandler,
  TaskDependencyService,
  TaskLifecycleService,
  TaskProps
} from "./modules/tasks/public";
import {
  RunValidationHandler,
  ValidationCheckId,
  ValidationProfileId
} from "./modules/validation/public";
import { SystemClock } from "./shared/core/clock";
import { CryptoIdGenerator } from "./shared/core/idGenerator";
import { TaskTreeProvider } from "./ui/taskTreeProvider";

export function activate(context: vscode.ExtensionContext): void {
  const repository = new MementoTaskRepository(context.workspaceState);
  const clock = new SystemClock();
  const createTask = new CreateTaskHandler(repository, clock, new CryptoIdGenerator());
  const lifecycle = new TaskLifecycleService(repository, clock);
  const dependencies = new TaskDependencyService(
    new MementoTaskDependencyRepository(context.workspaceState), repository
  );
  const tree = new TaskTreeProvider(repository);
  const ids = new CryptoIdGenerator();
  const codex = new CodexProcessSupervisor(new NodeProcessFactory(), {
    malformedProtocolLine: line => console.warn("MultiCodex ignored malformed Codex output", line),
    stderr: chunk => console.warn("Codex App Server:", chunk.trimEnd()),
    exited: exit => console.info("Codex App Server exited", exit),
    processError: error => console.error("Codex App Server error", error)
  });
  const executions = new MementoExecutionRepository(context.workspaceState);
  const capacity = new ExecutionCapacityGate();
  const activity = new ActivityService(
    new MementoActivityRepository(context.workspaceState), clock, ids
  );
  const approvals = new ApprovalService(
    new MementoApprovalRepository(context.workspaceState), clock, ids
  );
  let coordinator: AgentEventCoordinator | undefined;
  let activityBridge: AgentActivityBridge | undefined;
  let approvalBridge: ApprovalBridge | undefined;

  context.subscriptions.push(
    tree,
    { dispose: () => {
      coordinator?.stop();
      activityBridge?.stop();
      approvalBridge?.stop();
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
    vscode.commands.registerCommand("amazingMultiCodex.dispatchQueue", async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const storage = context.storageUri;
      if (!workspaceFolder || workspaceFolder.uri.scheme !== "file" || !storage || storage.scheme !== "file") {
        void vscode.window.showErrorMessage("Open a local Git workspace before dispatching tasks.");
        return;
      }
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Dispatching queued MultiCodex tasks",
        cancellable: false
      }, async () => {
        try {
          const settings = readSettings();
          if (!settings.ok) {
            void vscode.window.showErrorMessage(settings.error.message);
            return;
          }
          await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(storage, "worktrees"));
          const agent = await codex.start({
            cwd: workspaceFolder.uri.fsPath,
            executable: settings.value.codexExecutable,
            requestTimeoutMs: settings.value.requestTimeoutMs
          });
          coordinator?.stop();
          coordinator = new AgentEventCoordinator(agent, executions, lifecycle, clock, {
            error: (message, error) => console.error(message, error),
            taskChanged: () => tree.refresh()
          });
          coordinator.start();
          activityBridge?.stop();
          activityBridge = new AgentActivityBridge(agent, executions, activity, settings.value.maxActivityCharacters, {
            error: (message, error) => console.error(message, error)
          });
          activityBridge.start();
          approvalBridge?.stop();
          approvalBridge = createApprovalBridge(agent);
          approvalBridge.start();
          const starter = new StartTaskWorkflow(
            lifecycle, new GitWorkspaceAdapter(new NodeCommandRunner()), agent,
            executions, clock, ids, capacity, dependencies
          );
          const dispatched = await new DispatchQueuedTasksWorkflow(
            repository, executions, dependencies, new SchedulerPolicy(), starter
          ).execute({
            repositoryRoot: workspaceFolder.uri.fsPath,
            worktreeRoot: vscode.Uri.joinPath(storage, "worktrees").fsPath,
            baseRef: settings.value.baseRef,
            concurrencyLimit: settings.value.concurrencyLimit
          });
          tree.refresh();
          if (!dispatched.ok) {
            void vscode.window.showErrorMessage(dispatched.error.message);
            return;
          }
          const failed = dispatched.value.failures.length;
          void vscode.window.showInformationMessage(
            `Started ${dispatched.value.started.length} queued task(s)${failed ? `; ${failed} failed to start` : ""}.`
          );
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : "Unknown dispatch error.";
          void vscode.window.showErrorMessage(`Could not dispatch queued tasks: ${message}`);
        }
      });
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
          const settings = readSettings();
          if (!settings.ok) {
            void vscode.window.showErrorMessage(settings.error.message);
            return;
          }
          await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(storage, "worktrees"));
          const agent = await codex.start({
            cwd: workspaceFolder.uri.fsPath,
            executable: settings.value.codexExecutable,
            requestTimeoutMs: settings.value.requestTimeoutMs
          });
          coordinator?.stop();
          coordinator = new AgentEventCoordinator(agent, executions, lifecycle, clock, {
            error: (message, error) => console.error(message, error),
            taskChanged: () => tree.refresh()
          });
          coordinator.start();
          activityBridge?.stop();
          activityBridge = new AgentActivityBridge(agent, executions, activity, settings.value.maxActivityCharacters, {
            error: (message, error) => console.error(message, error)
          });
          activityBridge.start();
          approvalBridge?.stop();
          approvalBridge = createApprovalBridge(agent);
          approvalBridge.start();
          const workflow = new StartTaskWorkflow(
            lifecycle,
            new GitWorkspaceAdapter(new NodeCommandRunner()),
            agent,
            executions,
            clock,
            ids,
            capacity,
            dependencies
          );
          const started = await workflow.execute({
            taskId: task.id,
            repositoryRoot: workspaceFolder.uri.fsPath,
            worktreeRoot: vscode.Uri.joinPath(storage, "worktrees").fsPath,
            baseRef: settings.value.baseRef,
            concurrencyLimit: settings.value.concurrencyLimit
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
        const settings = readSettings();
        if (!settings.ok) {
          void vscode.window.showErrorMessage(settings.error.message);
          return;
        }
        const agent = await codex.start({
          cwd: workspaceFolder.uri.fsPath,
          executable: settings.value.codexExecutable,
          requestTimeoutMs: settings.value.requestTimeoutMs
        });
        coordinator?.stop();
        coordinator = new AgentEventCoordinator(agent, executions, lifecycle, clock, {
          error: (message, error) => console.error(message, error),
          taskChanged: () => tree.refresh()
        });
        coordinator.start();
        activityBridge?.stop();
        activityBridge = new AgentActivityBridge(agent, executions, activity, settings.value.maxActivityCharacters, {
          error: (message, error) => console.error(message, error)
        });
        activityBridge.start();
        approvalBridge?.stop();
        approvalBridge = createApprovalBridge(agent);
        approvalBridge.start();
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
    }),
    vscode.commands.registerCommand("amazingMultiCodex.showActivity", async (task?: TaskProps) => {
      if (!task) {
        void vscode.window.showErrorMessage("Select a MultiCodex task to view its activity.");
        return;
      }
      const records = await activity.list(task.id);
      if (!records.ok) {
        void vscode.window.showErrorMessage(records.error.message);
        return;
      }
      if (records.value.length === 0) {
        void vscode.window.showInformationMessage("No activity has been recorded for this task yet.");
        return;
      }
      await vscode.window.showQuickPick(records.value.map(record => ({
        label: record.summary,
        description: record.kind,
        detail: record.detail
      })), { title: `Activity: ${task.title}`, matchOnDetail: true });
    }),
    vscode.commands.registerCommand("amazingMultiCodex.cancelTask", async (task?: TaskProps) => {
      if (!task) {
        void vscode.window.showErrorMessage("Select a running MultiCodex task to cancel.");
        return;
      }
      const agent = codex.current();
      if (!agent) {
        void vscode.window.showErrorMessage("Codex App Server is not connected; resume the task before cancelling it.");
        return;
      }
      const confirmed = await vscode.window.showWarningMessage(
        `Cancel MultiCodex task '${task.title}'?`,
        { modal: true },
        "Cancel Task"
      );
      if (confirmed !== "Cancel Task") return;
      const cancelled = await new CancelTaskWorkflow(lifecycle, agent, executions, clock).execute(task.id);
      tree.refresh();
      if (!cancelled.ok) void vscode.window.showErrorMessage(cancelled.error.message);
    }),
    vscode.commands.registerCommand("amazingMultiCodex.validateTask", async (task?: TaskProps) => {
      if (!task) {
        void vscode.window.showErrorMessage("Select a task waiting for validation.");
        return;
      }
      const settings = readSettings();
      if (!settings.ok) {
        void vscode.window.showErrorMessage(settings.error.message);
        return;
      }
      const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Validating MultiCodex task: ${task.title}`,
        cancellable: false
      }, () => new ValidateTaskWorkflow(
        lifecycle,
        executions,
        new RunValidationHandler(new NodeCommandRunner(), clock, ids)
      ).execute({
        taskId: task.id,
        profile: {
          id: "configured" as ValidationProfileId,
          mode: "sequential",
          checks: settings.value.validationCommands.map((command, index) => ({
            id: `configured-${index + 1}` as ValidationCheckId,
            label: command.label,
            executable: command.executable,
            args: command.args
          }))
        }
      }));
      tree.refresh();
      if (!result.ok) {
        void vscode.window.showErrorMessage(result.error.message);
        return;
      }
      await activity.record({
        taskId: task.id,
        kind: result.value.status === "passed" ? "validation" : "error",
        summary: `Validation ${result.value.status}`,
        detail: result.value.checks.map(check => `${check.checkId}: ${check.status}`).join("\n")
      });
      void vscode.window.showInformationMessage(`Validation ${result.value.status}: ${task.title}`);
    }),
    vscode.commands.registerCommand("amazingMultiCodex.showChanges", async (task?: TaskProps) => {
      if (!task) {
        void vscode.window.showErrorMessage("Select a MultiCodex task to inspect its changes.");
        return;
      }
      const execution = await executions.findLatestByTask(task.id);
      if (!execution.ok || !execution.value) {
        void vscode.window.showErrorMessage(execution.ok ? "No execution was found for this task." : execution.error.message);
        return;
      }
      const changes = await new GitWorkspaceAdapter(new NodeCommandRunner()).diff(execution.value.workspace);
      if (!changes.ok) {
        void vscode.window.showErrorMessage(changes.error.message);
        return;
      }
      const document = await vscode.workspace.openTextDocument({
        language: "diff",
        content: changes.value.patch || "No committed changes relative to the task base ref."
      });
      await vscode.window.showTextDocument(document, { preview: true });
    }),
    vscode.commands.registerCommand("amazingMultiCodex.integrateTask", async (task?: TaskProps) => {
      if (!task) {
        void vscode.window.showErrorMessage("Select a reviewed MultiCodex task to integrate.");
        return;
      }
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder || workspaceFolder.uri.scheme !== "file") {
        void vscode.window.showErrorMessage("Open the target local Git workspace before integrating.");
        return;
      }
      const selection = await vscode.window.showQuickPick([
        { label: "Merge commit", strategy: "merge" as IntegrationStrategy },
        { label: "Squash commit", strategy: "squash" as IntegrationStrategy }
      ], { title: `Integration strategy: ${task.title}` });
      if (!selection) return;
      const confirmed = await vscode.window.showWarningMessage(
        `Integrate '${task.title}' into the currently checked-out target branch using ${selection.label}?`,
        { modal: true },
        "Integrate"
      );
      if (confirmed !== "Integrate") return;
      const integrated = await new IntegrateTaskWorkflow(
        lifecycle,
        executions,
        new GitIntegrationAdapter(new NodeCommandRunner())
      ).execute({
        taskId: task.id,
        targetRepositoryRoot: workspaceFolder.uri.fsPath,
        strategy: selection.strategy,
        commitMessage: `MultiCodex: ${task.title}`
      });
      tree.refresh();
      if (!integrated.ok) {
        void vscode.window.showErrorMessage(integrated.error.message);
        return;
      }
      await activity.record({
        taskId: task.id,
        kind: "lifecycle",
        summary: `Integrated with ${integrated.value.strategy}`,
        detail: integrated.value.targetCommit
      });
      void vscode.window.showInformationMessage(`Integrated MultiCodex task: ${task.title}`);
    }),
    vscode.commands.registerCommand("amazingMultiCodex.addDependency", async (task?: TaskProps) => {
      if (!task) {
        void vscode.window.showErrorMessage("Select a MultiCodex task to add a prerequisite.");
        return;
      }
      const listed = await repository.list();
      if (!listed.ok) {
        void vscode.window.showErrorMessage(listed.error.message);
        return;
      }
      const candidates = listed.value
        .map(candidate => candidate.snapshot())
        .filter(candidate => candidate.id !== task.id);
      if (candidates.length === 0) {
        void vscode.window.showInformationMessage("Create another task before adding a prerequisite.");
        return;
      }
      const selected = await vscode.window.showQuickPick(candidates.map(candidate => ({
        label: candidate.title,
        description: candidate.status,
        taskId: candidate.id
      })), { title: `Prerequisite for: ${task.title}` });
      if (!selected) return;
      const added = await dependencies.add(task.id, selected.taskId);
      if (!added.ok) {
        void vscode.window.showErrorMessage(added.error.message);
        return;
      }
      void vscode.window.showInformationMessage(`Added prerequisite '${selected.label}' to '${task.title}'.`);
    })
  );

  function createApprovalBridge(agent: Awaited<ReturnType<CodexProcessSupervisor["start"]>>): ApprovalBridge {
    return new ApprovalBridge(agent, executions, approvals, lifecycle, {
      async decide(approval) {
        const selection = await vscode.window.showWarningMessage(
          approval.detail ? `${approval.title}\n\n${approval.detail}` : approval.title,
          { modal: true },
          "Approve",
          "Decline"
        );
        return selection === "Approve" ? "approved" : selection === "Decline" ? "declined" : "cancelled";
      }
    });
  }

  function readSettings(): ReturnType<typeof parseSettings> {
    const config = vscode.workspace.getConfiguration("amazingMultiCodex");
    return parseSettings({
      codexExecutable: config.get<string>("codexExecutable"),
      requestTimeoutMs: config.get<number>("requestTimeoutMs"),
      baseRef: config.get<string>("baseRef"),
      concurrencyLimit: config.get<number>("concurrencyLimit"),
      maxActivityCharacters: config.get<number>("maxActivityCharacters"),
      validationCommands: config.get<ValidationCommandSetting[]>("validationCommands")
    });
  }
}

export function deactivate(): void {
  // Disposable registrations and the Codex supervisor are released by VS Code.
}
