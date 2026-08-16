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
import { RuntimePreflight } from "./host/runtimePreflight";
import { ActivityService } from "./modules/activity/public";
import { ApprovalService } from "./modules/approvals/public";
import { IntegrateTaskWorkflow, IntegrationStrategy } from "./modules/integration/public";
import { ValidationCommandSetting, parseSettings } from "./modules/settings/public";
import {
  AgentEventCoordinator,
  AbandonTaskWorkflow,
  CancelTaskWorkflow,
  DispatchQueuedTasksWorkflow,
  ExecutionCapacityGate,
  ReleaseTaskWorkspaceWorkflow,
  ReconcileExecutionsWorkflow,
  ResumeTaskWorkflow,
  SchedulerPolicy,
  StartTaskWorkflow,
  TaskDetailQuery,
  ValidateTaskWorkflow
} from "./modules/orchestration/public";
import {
  CreateTaskHandler,
  TaskDependencyService,
  TaskLifecycleService,
  TaskPriority,
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
import { TaskDetailPanelManager, TaskDetailAction } from "./ui/taskDetailPanel";

export function activate(context: vscode.ExtensionContext): void {
  const repository = new MementoTaskRepository(context.workspaceState);
  const clock = new SystemClock();
  const createTask = new CreateTaskHandler(repository, clock, new CryptoIdGenerator());
  const lifecycle = new TaskLifecycleService(repository, clock);
  const dependencies = new TaskDependencyService(
    new MementoTaskDependencyRepository(context.workspaceState), repository
  );
  const tree = new TaskTreeProvider(repository, {
    error: (message, error) => {
      console.error("MultiCodex task tree error", error);
      void vscode.window.showErrorMessage(`MultiCodex could not load tasks: ${message}`);
    }
  });
  const ids = new CryptoIdGenerator();
  const codex = new CodexProcessSupervisor(new NodeProcessFactory(), {
    malformedProtocolLine: line => console.warn("MultiCodex ignored malformed Codex output", line),
    stderr: chunk => console.warn("Codex App Server:", chunk.trimEnd()),
    exited: exit => console.info("Codex App Server exited", exit),
    processError: error => console.error("Codex App Server error", error)
  });
  const executions = new MementoExecutionRepository(context.workspaceState);
  const commandRunner = new NodeCommandRunner();
  const runtimePreflight = new RuntimePreflight(commandRunner);
  const gitWorkspaces = new GitWorkspaceAdapter(commandRunner);
  const capacity = new ExecutionCapacityGate();
  const activity = new ActivityService(
    new MementoActivityRepository(context.workspaceState), clock, ids
  );
  const approvals = new ApprovalService(
    new MementoApprovalRepository(context.workspaceState), clock, ids
  );
  const taskDetailQuery = new TaskDetailQuery(lifecycle, dependencies, executions, activity);
  const detailCommands: Readonly<Record<TaskDetailAction, string>> = {
    queue: "amazingMultiCodex.queueTask",
    start: "amazingMultiCodex.startTask",
    resume: "amazingMultiCodex.resumeTask",
    cancel: "amazingMultiCodex.cancelTask",
    validate: "amazingMultiCodex.validateTask",
    changes: "amazingMultiCodex.showChanges",
    integrate: "amazingMultiCodex.integrateTask",
    release: "amazingMultiCodex.releaseWorkspace"
  };
  const taskDetails = new TaskDetailPanelManager(
    async taskId => {
      const detail = await taskDetailQuery.execute(taskId);
      if (detail.ok) return detail.value;
      void vscode.window.showErrorMessage(detail.error.message);
      return undefined;
    },
    async (action, task) => { await vscode.commands.executeCommand(detailCommands[action], task); },
    (message, cause) => {
      console.error(message, cause);
      const detail = cause instanceof Error ? cause.message : String(cause);
      void vscode.window.showErrorMessage(`${message} ${detail}`);
    }
  );
  let coordinator: AgentEventCoordinator | undefined;
  let activityBridge: AgentActivityBridge | undefined;
  let approvalBridge: ApprovalBridge | undefined;
  let boundAgent: Awaited<ReturnType<CodexProcessSupervisor["start"]>> | undefined;
  let dispatching: Promise<void> | undefined;

  context.subscriptions.push(
    tree,
    taskDetails,
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
      const criteriaInput = await vscode.window.showInputBox({
        prompt: "Optional acceptance criteria (separate multiple items with semicolons)",
        placeHolder: "Tests pass; documentation updated"
      });
      const acceptanceCriteria = criteriaInput?.split(";").map(item => item.trim()).filter(Boolean);
      const priority = await vscode.window.showQuickPick<{
        label: string;
        description: string;
        priority: TaskPriority;
      }>([
        { label: "Normal", description: "Default scheduling priority", priority: "normal" },
        { label: "High", description: "Run before normal and low tasks", priority: "high" },
        { label: "Urgent", description: "Run before all other queued tasks", priority: "urgent" },
        { label: "Low", description: "Run after normal tasks", priority: "low" }
      ], { placeHolder: "Choose a scheduling priority" });
      if (!priority) return;
      const created = await createTask.execute({ title, description, acceptanceCriteria, priority: priority.priority });
      if (!created.ok) {
        void vscode.window.showErrorMessage(created.error.message);
        return;
      }
      tree.refresh();
      void vscode.window.showInformationMessage(`Created draft MultiCodex task: ${title.trim()}`);
    }),
    vscode.commands.registerCommand("amazingMultiCodex.refreshTasks", () => {
      tree.refresh();
    }),
    vscode.commands.registerCommand("amazingMultiCodex.showRuntimeStatus", async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder || workspaceFolder.uri.scheme !== "file") {
        void vscode.window.showErrorMessage("Open a local Git workspace to check MultiCodex readiness.");
        return;
      }
      const settings = readSettings();
      if (!settings.ok) {
        const action = await vscode.window.showErrorMessage(settings.error.message, "Open Settings");
        if (action === "Open Settings") {
          await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:amazing-multicodex.amazing-multicodex");
        }
        return;
      }
      const checks = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Checking MultiCodex readiness",
        cancellable: false
      }, () => runtimePreflight.inspect({
        cwd: workspaceFolder.uri.fsPath,
        codexExecutable: settings.value.codexExecutable,
        baseRef: settings.value.baseRef
      }));
      const health = codex.current()?.health() ?? { status: "disconnected" as const };
      await vscode.window.showQuickPick(checks.map(check => ({
        label: `$(${check.ok ? "pass-filled" : "error"}) ${check.label}`,
        description: check.ok ? "Ready" : "Needs attention",
        detail: check.detail
      })), {
        title: `MultiCodex readiness · App Server ${health.status}`,
        placeHolder: checks.every(check => check.ok)
          ? "All prerequisites are ready. The App Server starts when a task runs."
          : "Resolve failed checks before starting a task."
      });
    }),
    vscode.commands.registerCommand("amazingMultiCodex.queueTask", async (task?: TaskProps) => {
      if (!task) {
        void vscode.window.showErrorMessage("Select a draft, failed, cancelled, or blocked task to queue.");
        return;
      }
      if (task.status === "blocked" && task.statusReason?.startsWith("integration.")) {
        void vscode.window.showErrorMessage("Retry this task with the Integrate Task command.");
        return;
      }
      const queued = await lifecycle.transition(task.id, "queued", "user-retry");
      tree.refresh();
      if (!queued.ok) {
        void vscode.window.showErrorMessage(queued.error.message);
        return;
      }
      void dispatchQueue(false);
      void vscode.window.showInformationMessage(`Queued MultiCodex task: ${task.title}`);
    }),
    vscode.commands.registerCommand("amazingMultiCodex.dispatchQueue", async () => {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Dispatching queued MultiCodex tasks",
        cancellable: false
      }, () => dispatchQueue(true));
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
          bindAgent(agent, settings.value.maxActivityCharacters);
          const workflow = new StartTaskWorkflow(
            lifecycle,
            gitWorkspaces,
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
            concurrencyLimit: settings.value.concurrencyLimit,
            model: settings.value.defaultModel
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
        bindAgent(agent, settings.value.maxActivityCharacters);
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
    vscode.commands.registerCommand("amazingMultiCodex.showTaskDetails", async (task?: TaskProps) => {
      if (!task) {
        void vscode.window.showErrorMessage("Select a MultiCodex task to view its details.");
        return;
      }
      await taskDetails.show(task.id);
    }),
    vscode.commands.registerCommand("amazingMultiCodex.cancelTask", async (task?: TaskProps) => {
      if (!task) {
        void vscode.window.showErrorMessage("Select a running MultiCodex task to cancel.");
        return;
      }
      const confirmed = await vscode.window.showWarningMessage(
        `Cancel MultiCodex task '${task.title}'?${codex.current() ? "" : " Codex is disconnected, so only local execution state will be abandoned."}`,
        { modal: true },
        "Cancel Task"
      );
      if (confirmed !== "Cancel Task") return;
      const agent = codex.current();
      const cancelled = agent
        ? await new CancelTaskWorkflow(lifecycle, agent, executions, clock).execute(task.id)
        : await new AbandonTaskWorkflow(lifecycle, executions, clock).execute(task.id);
      tree.refresh();
      if (!cancelled.ok) void vscode.window.showErrorMessage(cancelled.error.message);
      else void dispatchQueue(false);
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
        cancellable: true
      }, async (_progress, token) => {
        const controller = new AbortController();
        const cancellation = token.onCancellationRequested(() => controller.abort());
        try {
          return await new ValidateTaskWorkflow(
            lifecycle,
            executions,
            new RunValidationHandler(new NodeCommandRunner(), clock, ids)
          ).execute({
            taskId: task.id,
            signal: controller.signal,
            profile: {
              id: "configured" as ValidationProfileId,
              mode: "sequential",
              checks: settings.value.validationCommands.map((command, index) => ({
                id: `configured-${index + 1}` as ValidationCheckId,
                label: command.label,
                executable: command.executable,
                args: command.args,
                timeoutMs: settings.value.validationTimeoutMs
              }))
            }
          });
        } finally {
          cancellation.dispose();
        }
      });
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
      void vscode.window.showInformationMessage(result.value.status === "cancelled"
        ? `Validation cancelled; '${task.title}' remains ready to validate.`
        : `Validation ${result.value.status}: ${task.title}`);
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
      const changes = await gitWorkspaces.diff(execution.value.workspace);
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
      const execution = await executions.findLatestByTask(task.id);
      if (!execution.ok || !execution.value) {
        void vscode.window.showErrorMessage(execution.ok ? "No execution was found for this task." : execution.error.message);
        return;
      }
      const changes = await gitWorkspaces.diff(execution.value.workspace);
      if (!changes.ok) {
        void vscode.window.showErrorMessage(changes.error.message);
        return;
      }
      const review = await vscode.workspace.openTextDocument({
        language: "diff",
        content: changes.value.patch || "No changes relative to the task base ref."
      });
      await vscode.window.showTextDocument(review, { preview: true });
      if (!changes.value.patch) {
        void vscode.window.showErrorMessage("The task has no changes to integrate.");
        return;
      }
      const selection = await vscode.window.showQuickPick([
        { label: "Merge commit", strategy: "merge" as IntegrationStrategy },
        { label: "Squash commit", strategy: "squash" as IntegrationStrategy }
      ], { title: `Integration strategy: ${task.title}` });
      if (!selection) return;
      const confirmed = await vscode.window.showWarningMessage(
        `Integrate the displayed changes for '${task.title}' into the current target using ${selection.label}?`,
        { modal: true },
        "Integrate"
      );
      if (confirmed !== "Integrate") return;
      const integrated = await new IntegrateTaskWorkflow(
        lifecycle,
        executions,
        new GitIntegrationAdapter(commandRunner)
      ).execute({
        taskId: task.id,
        targetRepositoryRoot: workspaceFolder.uri.fsPath,
        strategy: selection.strategy,
        commitMessage: `MultiCodex: ${task.title}`,
        reviewedPatch: changes.value.patch
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
        detail: integrated.value.targetCommit ?? integrated.value.warning
      });
      void dispatchQueue(false);
      if (integrated.value.warning) {
        void vscode.window.showWarningMessage(`${integrated.value.warning} Verify the target repository HEAD.`);
      } else {
        void vscode.window.showInformationMessage(`Integrated MultiCodex task: ${task.title}`);
      }
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
    }),
    vscode.commands.registerCommand("amazingMultiCodex.removeDependency", async (task?: TaskProps) => {
      if (!task) {
        void vscode.window.showErrorMessage("Select a MultiCodex task to remove a prerequisite.");
        return;
      }
      const [edges, listed] = await Promise.all([dependencies.listFor(task.id), repository.list()]);
      if (!edges.ok) {
        void vscode.window.showErrorMessage(edges.error.message);
        return;
      }
      if (!listed.ok) {
        void vscode.window.showErrorMessage(listed.error.message);
        return;
      }
      const titles = new Map(listed.value.map(item => {
        const snapshot = item.snapshot();
        return [snapshot.id, snapshot.title] as const;
      }));
      const choices = edges.value.map(edge => ({
        label: titles.get(edge.prerequisiteId) ?? edge.prerequisiteId,
        taskId: edge.prerequisiteId
      }));
      if (choices.length === 0) {
        void vscode.window.showInformationMessage(`'${task.title}' has no prerequisites.`);
        return;
      }
      const selected = await vscode.window.showQuickPick(choices, { title: `Remove prerequisite from: ${task.title}` });
      if (!selected) return;
      const removed = await dependencies.remove(task.id, selected.taskId);
      if (!removed.ok) {
        void vscode.window.showErrorMessage(removed.error.message);
        return;
      }
      void vscode.window.showInformationMessage(`Removed prerequisite '${selected.label}' from '${task.title}'.`);
    }),
    vscode.commands.registerCommand("amazingMultiCodex.releaseWorkspace", async (task?: TaskProps) => {
      if (!task) {
        void vscode.window.showErrorMessage("Select a completed or cancelled task workspace to release.");
        return;
      }
      const confirmed = await vscode.window.showWarningMessage(
        `Remove the clean Git worktree for '${task.title}'? The task history and branch are retained.`,
        { modal: true }, "Remove Worktree"
      );
      if (confirmed !== "Remove Worktree") return;
      const released = await new ReleaseTaskWorkspaceWorkflow(
        lifecycle, executions, gitWorkspaces
      ).execute(task.id);
      if (!released.ok) {
        void vscode.window.showErrorMessage(released.error.message);
        return;
      }
      void vscode.window.showInformationMessage(`Released worktree for: ${task.title}`);
    })
  );

  void new ReconcileExecutionsWorkflow(executions, lifecycle, gitWorkspaces, clock).execute()
    .then(report => {
      tree.refresh();
      if (!report.ok) {
        console.error("MultiCodex restart reconciliation failed", report.error);
        void vscode.window.showErrorMessage(`MultiCodex recovery failed: ${report.error.message}`);
      } else if (report.value.blocked.length > 0) {
        void vscode.window.showWarningMessage(
          `MultiCodex recovered with ${report.value.blocked.length} blocked task(s) requiring retry.`
        );
      }
      if (report.ok) void dispatchQueue(false);
    });

  function dispatchQueue(notify: boolean): Promise<void> {
    if (dispatching) return dispatching;
    dispatching = dispatchQueueOnce(notify).finally(() => { dispatching = undefined; });
    return dispatching;
  }

  async function dispatchQueueOnce(notify: boolean): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const storage = context.storageUri;
    if (!workspaceFolder || workspaceFolder.uri.scheme !== "file" || !storage || storage.scheme !== "file") {
      if (notify) void vscode.window.showErrorMessage("Open a local Git workspace before dispatching tasks.");
      return;
    }
    try {
      const listed = await repository.list();
      if (!listed.ok) throw listed.error;
      if (!listed.value.some(task => task.snapshot().status === "queued")) {
        if (notify) void vscode.window.showInformationMessage("No queued MultiCodex tasks are ready to dispatch.");
        return;
      }
      const settings = readSettings();
      if (!settings.ok) throw settings.error;
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(storage, "worktrees"));
      const agent = await codex.start({
        cwd: workspaceFolder.uri.fsPath,
        executable: settings.value.codexExecutable,
        requestTimeoutMs: settings.value.requestTimeoutMs
      });
      bindAgent(agent, settings.value.maxActivityCharacters);
      const starter = new StartTaskWorkflow(
        lifecycle, gitWorkspaces, agent,
        executions, clock, ids, capacity, dependencies
      );
      const dispatched = await new DispatchQueuedTasksWorkflow(
        repository, executions, dependencies, new SchedulerPolicy(), starter
      ).execute({
        repositoryRoot: workspaceFolder.uri.fsPath,
        worktreeRoot: vscode.Uri.joinPath(storage, "worktrees").fsPath,
        baseRef: settings.value.baseRef,
        concurrencyLimit: settings.value.concurrencyLimit,
        model: settings.value.defaultModel
      });
      tree.refresh();
      if (!dispatched.ok) throw dispatched.error;
      const failed = dispatched.value.failures.length;
      if (notify || failed) void vscode.window.showInformationMessage(
        `Started ${dispatched.value.started.length} queued task(s)${failed ? `; ${failed} failed to start` : ""}.`
      );
    } catch (cause) {
      console.error("Could not dispatch queued MultiCodex tasks", cause);
      if (notify) {
        const message = cause instanceof Error ? cause.message : typeof cause === "object" && cause && "message" in cause
          ? String(cause.message) : "Unknown dispatch error.";
        void vscode.window.showErrorMessage(`Could not dispatch queued tasks: ${message}`);
      }
    }
  }

  function bindAgent(
    agent: Awaited<ReturnType<CodexProcessSupervisor["start"]>>,
    maxActivityCharacters: number
  ): void {
    if (boundAgent === agent) return;
    coordinator?.stop();
    coordinator = new AgentEventCoordinator(agent, executions, lifecycle, clock, {
      error: (message, error) => console.error(message, error),
      taskChanged: taskId => {
        tree.refresh();
        void taskDetails.refresh(taskId);
        void dispatchQueue(false);
      }
    });
    coordinator.start();
    activityBridge?.stop();
    activityBridge = new AgentActivityBridge(agent, executions, activity, maxActivityCharacters, {
      error: (message, error) => console.error(message, error),
      activityRecorded: taskId => { void taskDetails.refresh(taskId); }
    });
    activityBridge.start();
    approvalBridge?.stop();
    approvalBridge = createApprovalBridge(agent);
    approvalBridge.start();
    boundAgent = agent;
  }

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
    }, {
      error: (message, cause) => console.error(message, cause),
      taskChanged: taskId => {
        tree.refresh();
        void taskDetails.refresh(taskId);
      }
    });
  }

  function readSettings(): ReturnType<typeof parseSettings> {
    const config = vscode.workspace.getConfiguration("amazingMultiCodex");
    return parseSettings({
      codexExecutable: config.get<string>("codexExecutable"),
      defaultModel: config.get<string>("defaultModel"),
      requestTimeoutMs: config.get<number>("requestTimeoutMs"),
      baseRef: config.get<string>("baseRef"),
      concurrencyLimit: config.get<number>("concurrencyLimit"),
      maxActivityCharacters: config.get<number>("maxActivityCharacters"),
      validationTimeoutMs: config.get<number>("validationTimeoutMs"),
      validationCommands: config.get<ValidationCommandSetting[]>("validationCommands")
    });
  }
}

export function deactivate(): void {
  // Disposable registrations and the Codex supervisor are released by VS Code.
}
