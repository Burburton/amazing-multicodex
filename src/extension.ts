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
import { formatValidationActivity } from "./host/validationActivity";
import { ActivityService } from "./modules/activity/public";
import { ApprovalService } from "./modules/approvals/public";
import { IntegrateTaskWorkflow, IntegrationStrategy, RecoverIntegrationWorkflow } from "./modules/integration/public";
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
  SteerTaskWorkflow,
  TaskDetailQuery,
  ValidateTaskWorkflow
} from "./modules/orchestration/public";
import {
  CreateTaskHandler,
  ReviseTaskHandler,
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
import { CoalescingAsyncRunner } from "./shared/core/coalescingAsyncRunner";
import { CryptoIdGenerator } from "./shared/core/idGenerator";
import { redactAndTruncateSensitiveText } from "./shared/core/sensitiveData";
import { TaskTreeProvider } from "./ui/taskTreeProvider";
import { TaskDetailPanelManager, TaskDetailAction } from "./ui/taskDetailPanel";
import { sortTasksForDisplay, taskPriorityLabel, taskStatusLabel } from "./ui/taskPresentation";

export function activate(context: vscode.ExtensionContext): void {
  const connectedTasks = new Set<TaskProps["id"]>();
  const validatingTasks = new Set<TaskProps["id"]>();
  const repository = new MementoTaskRepository(context.workspaceState);
  const clock = new SystemClock();
  const createTask = new CreateTaskHandler(repository, clock, new CryptoIdGenerator());
  const reviseTask = new ReviseTaskHandler(repository, clock);
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
    malformedProtocolLine: line => console.warn(
      "MultiCodex ignored malformed Codex output",
      redactAndTruncateSensitiveText(line, 2_000)
    ),
    stderr: chunk => console.warn(
      "Codex App Server:",
      redactAndTruncateSensitiveText(chunk.trimEnd(), 2_000)
    ),
    exited: exit => {
      reportRuntimeDisconnect(`Codex App Server exited with code ${String(exit.code)}.`);
      console.info("Codex App Server exited", exit);
    },
    processError: error => {
      reportRuntimeDisconnect(`Codex App Server stopped unexpectedly: ${error.message}`);
      console.error("Codex App Server error", error);
    }
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
    edit: "amazingMultiCodex.editTask",
    queue: "amazingMultiCodex.queueTask",
    start: "amazingMultiCodex.startTask",
    resume: "amazingMultiCodex.resumeTask",
    steer: "amazingMultiCodex.steerTask",
    cancel: "amazingMultiCodex.cancelTask",
    validate: "amazingMultiCodex.validateTask",
    changes: "amazingMultiCodex.showChanges",
    integrate: "amazingMultiCodex.integrateTask",
    recoverIntegration: "amazingMultiCodex.recoverIntegration",
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
  const dispatcher = new CoalescingAsyncRunner(
    dispatchQueueOnce,
    (currentNotify, incomingNotify) => currentNotify || incomingNotify
  );

  function reportRuntimeDisconnect(message: string): void {
    const affected = connectedTasks.size;
    connectedTasks.clear();
    if (affected > 0) {
      void vscode.window.showWarningMessage(
        `${message} ${affected} running task(s) can be continued with MultiCodex: Reconnect / Resume Task.`
      );
    }
  }

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
        placeHolder: "e.g. Add retry handling to the API client",
        validateInput: value => !value.trim()
          ? "Task title is required."
          : value.trim().length > 200 ? "Task title cannot exceed 200 characters." : undefined
      });
      if (!title?.trim()) return;

      const description = await vscode.window.showInputBox({
        prompt: "Optional task context",
        placeHolder: "Constraints, relevant files, or implementation notes",
        validateInput: value => value.trim().length > 20_000
          ? "Task context cannot exceed 20,000 characters."
          : undefined
      });
      if (description === undefined) return;
      const criteriaInput = await vscode.window.showInputBox({
        prompt: "Optional acceptance criteria (separate multiple items with semicolons)",
        placeHolder: "Tests pass; documentation updated",
        validateInput: validateAcceptanceCriteriaInput
      });
      if (criteriaInput === undefined) return;
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
      const next = await vscode.window.showInformationMessage(
        `Created draft MultiCodex task: ${created.value.title}`,
        "Queue Task",
        "Add Prerequisite",
        "Open Details"
      );
      if (next === "Queue Task") {
        await vscode.commands.executeCommand("amazingMultiCodex.queueTask", created.value);
      } else if (next === "Add Prerequisite") {
        await vscode.commands.executeCommand("amazingMultiCodex.addDependency", created.value);
      } else if (next === "Open Details") {
        await taskDetails.show(created.value.id);
      }
    }),
    vscode.commands.registerCommand("amazingMultiCodex.refreshTasks", () => {
      tree.refresh();
    }),
    vscode.commands.registerCommand("amazingMultiCodex.editTask", async (task?: TaskProps) => {
      task = await selectTask(task, candidate => candidate.status === "draft", "Edit a draft task");
      if (!task) return;
      const title = await vscode.window.showInputBox({
        prompt: "Edit the task title",
        value: task.title,
        validateInput: value => !value.trim()
          ? "Task title is required."
          : value.trim().length > 200 ? "Task title cannot exceed 200 characters." : undefined
      });
      if (!title?.trim()) return;
      const description = await vscode.window.showInputBox({
        prompt: "Edit task context",
        value: task.description ?? "",
        validateInput: value => value.trim().length > 20_000
          ? "Task context cannot exceed 20,000 characters."
          : undefined
      });
      if (description === undefined) return;
      const criteriaInput = await vscode.window.showInputBox({
        prompt: "Edit acceptance criteria (separate multiple items with semicolons)",
        value: task.acceptanceCriteria.join("; "),
        validateInput: validateAcceptanceCriteriaInput
      });
      if (criteriaInput === undefined) return;
      const priorityChoices: Array<{
        label: string;
        description: string;
        priority: TaskPriority;
      }> = [
        { label: "Normal", description: "Default scheduling priority", priority: "normal" },
        { label: "High", description: "Run before normal and low tasks", priority: "high" },
        { label: "Urgent", description: "Run before all other queued tasks", priority: "urgent" },
        { label: "Low", description: "Run after normal tasks", priority: "low" }
      ];
      const currentPriority = priorityChoices.find(choice => choice.priority === task.priority)!;
      const priority = await vscode.window.showQuickPick([
        { ...currentPriority, description: `${currentPriority.description} · Current` },
        ...priorityChoices.filter(choice => choice.priority !== task.priority)
      ], { placeHolder: "Choose a scheduling priority" });
      if (!priority) return;
      const revised = await reviseTask.execute({
        taskId: task.id,
        title,
        description,
        acceptanceCriteria: criteriaInput.split(";").map(item => item.trim()).filter(Boolean),
        priority: priority.priority
      });
      if (!revised.ok) {
        void vscode.window.showErrorMessage(revised.error.message);
        return;
      }
      tree.refresh();
      await taskDetails.refresh(task.id);
      void vscode.window.showInformationMessage(`Updated MultiCodex draft: ${revised.value.title}`);
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
      const selected = await vscode.window.showQuickPick(checks.map(check => ({
        label: `$(${check.ok ? "pass-filled" : "error"}) ${check.label}`,
        description: check.ok ? "Ready" : "Needs attention",
        detail: check.detail,
        check
      })), {
        title: `MultiCodex readiness · App Server ${health.status}`,
        placeHolder: checks.every(check => check.ok)
          ? "All prerequisites are ready. The App Server starts when a task runs."
          : "Resolve failed checks before starting a task."
      });
      if (!selected || selected.check.ok) return;
      const actionLabel = selected.check.id === "repository" ? "Open Folder" : "Open Settings";
      const action = await vscode.window.showErrorMessage(selected.check.detail, actionLabel);
      if (action === "Open Folder") {
        await vscode.commands.executeCommand("workbench.action.files.openFolder");
      } else if (action === "Open Settings") {
        await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:amazing-multicodex.amazing-multicodex");
      }
    }),
    vscode.commands.registerCommand("amazingMultiCodex.queueTask", async (task?: TaskProps) => {
      task = await selectTask(task, candidate => ["draft", "failed", "cancelled", "blocked"].includes(candidate.status)
        && !candidate.statusReason?.startsWith("integration."), "Queue or retry a task");
      if (!task) return;
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
      task = await selectTask(task, candidate => candidate.status === "queued", "Start a queued task");
      if (!task) return;
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
          connectedTasks.add(task.id);
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
            connectedTasks.delete(task.id);
            void vscode.window.showErrorMessage(started.error.message);
            return;
          }
          void vscode.window.showInformationMessage(`Started MultiCodex task: ${task.title}`);
        } catch (cause) {
          connectedTasks.delete(task.id);
          const message = cause instanceof Error ? cause.message : "Unknown startup error.";
          void vscode.window.showErrorMessage(`Could not start MultiCodex task: ${message}`);
        }
      });
    }),
    vscode.commands.registerCommand("amazingMultiCodex.resumeTask", async (task?: TaskProps) => {
      task = await selectTask(task, candidate => candidate.status === "running", "Reconnect to a disconnected running task");
      if (!task) return;
      if (connectedTasks.has(task.id)) {
        void vscode.window.showInformationMessage(`'${task.title}' is already running in the connected Codex App Server.`);
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
        connectedTasks.add(task.id);
        const resumed = await new ResumeTaskWorkflow(lifecycle, agent, executions, clock)
          .execute({ taskId: task.id });
        if (!resumed.ok) {
          connectedTasks.delete(task.id);
          void vscode.window.showErrorMessage(resumed.error.message);
          return;
        }
        void vscode.window.showInformationMessage(`Resumed MultiCodex task: ${task.title}`);
      } catch (cause) {
        connectedTasks.delete(task.id);
        const message = cause instanceof Error ? cause.message : "Unknown resume error.";
        void vscode.window.showErrorMessage(`Could not resume MultiCodex task: ${message}`);
      }
    }),
    vscode.commands.registerCommand("amazingMultiCodex.showActivity", async (task?: TaskProps) => {
      task = await selectTask(task, () => true, "Show task activity");
      if (!task) return;
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
    vscode.commands.registerCommand("amazingMultiCodex.steerTask", async (task?: TaskProps) => {
      task = await selectTask(
        task,
        candidate => candidate.status === "running" && connectedTasks.has(candidate.id),
        "Send follow-up instructions"
      );
      if (!task) return;
      if (!connectedTasks.has(task.id)) {
        void vscode.window.showInformationMessage(`Resume '${task.title}' before sending follow-up instructions.`);
        return;
      }
      const prompt = await vscode.window.showInputBox({
        prompt: `Follow-up instructions for: ${task.title}`,
        placeHolder: "Clarify priorities, constraints, or the next step",
        validateInput: value => !value.trim()
          ? "Follow-up instructions are required."
          : value.trim().length > 20_000 ? "Follow-up instructions cannot exceed 20,000 characters." : undefined
      });
      if (!prompt?.trim()) return;
      const agent = codex.current();
      if (!agent || agent.health().status !== "ready") {
        connectedTasks.delete(task.id);
        void vscode.window.showErrorMessage("Codex App Server is disconnected. Resume the task before sending a follow-up.");
        return;
      }
      const steered = await new SteerTaskWorkflow(lifecycle, executions, agent).execute({
        taskId: task.id,
        prompt
      });
      if (!steered.ok) {
        void vscode.window.showErrorMessage(steered.error.message);
        return;
      }
      const recorded = await activity.record({
        taskId: task.id,
        kind: "lifecycle",
        summary: "Follow-up instructions sent"
      });
      await taskDetails.refresh(task.id);
      if (!recorded.ok) {
        void vscode.window.showWarningMessage("Follow-up sent, but its activity marker could not be persisted.");
      } else {
        void vscode.window.showInformationMessage(`Sent follow-up instructions to: ${task.title}`);
      }
    }),
    vscode.commands.registerCommand("amazingMultiCodex.showTaskDetails", async (task?: TaskProps) => {
      task = await selectTask(task, () => true, "Open task details");
      if (!task) return;
      await taskDetails.show(task.id);
    }),
    vscode.commands.registerCommand("amazingMultiCodex.cancelTask", async (task?: TaskProps) => {
      task = await selectTask(task, candidate => ["running", "awaitingApproval"].includes(candidate.status), "Cancel a running task");
      if (!task) return;
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
      else {
        connectedTasks.delete(task.id);
        void dispatchQueue(false);
      }
    }),
    vscode.commands.registerCommand("amazingMultiCodex.validateTask", async (task?: TaskProps) => {
      task = await selectTask(task, candidate => candidate.status === "validating", "Validate a completed Codex task");
      if (!task) return;
      if (validatingTasks.has(task.id)) {
        void vscode.window.showInformationMessage(`Validation is already running for: ${task.title}`);
        return;
      }
      validatingTasks.add(task.id);
      try {
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
        detail: formatValidationActivity(
          result.value,
          settings.value.validationCommands.map(command => command.label)
        )
      });
      void vscode.window.showInformationMessage(result.value.status === "cancelled"
        ? `Validation cancelled; '${task.title}' remains ready to validate.`
        : `Validation ${result.value.status}: ${task.title}`);
      } finally {
        validatingTasks.delete(task.id);
      }
    }),
    vscode.commands.registerCommand("amazingMultiCodex.showChanges", async (task?: TaskProps) => {
      task = await selectTask(task, candidate => [
        "validating", "readyForReview", "completed", "failed", "blocked", "cancelled"
      ].includes(candidate.status), "Inspect task changes");
      if (!task) return;
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
      task = await selectTask(task, candidate => candidate.status === "readyForReview"
        || (candidate.status === "blocked" && !!candidate.statusReason?.startsWith("integration.")), "Integrate a reviewed task");
      if (!task) return;
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
    vscode.commands.registerCommand("amazingMultiCodex.recoverIntegration", async (task?: TaskProps) => {
      task = await selectTask(task, candidate => candidate.status === "integrating", "Recover an interrupted integration");
      if (!task) return;
      const selection = await vscode.window.showWarningMessage(
        `Verify the target Git history for '${task.title}', then choose how to recover its interrupted integration state.`,
        { modal: true },
        "Mark Completed",
        "Return to Review"
      );
      if (!selection) return;
      const recovered = await new RecoverIntegrationWorkflow(lifecycle).execute(
        task.id,
        selection === "Mark Completed" ? "completed" : "retry"
      );
      tree.refresh();
      await taskDetails.refresh(task.id);
      if (!recovered.ok) {
        void vscode.window.showErrorMessage(recovered.error.message);
        return;
      }
      await activity.record({
        taskId: task.id,
        kind: "lifecycle",
        summary: selection === "Mark Completed" ? "Integration recovery confirmed" : "Integration returned to review"
      });
    }),
    vscode.commands.registerCommand("amazingMultiCodex.addDependency", async (task?: TaskProps) => {
      task = await selectTask(task, candidate => candidate.status === "draft", "Add a task prerequisite");
      if (!task) return;
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
      task = await selectTask(task, candidate => candidate.status === "draft", "Remove a task prerequisite");
      if (!task) return;
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
      task = await selectTask(task, candidate => ["completed", "cancelled"].includes(candidate.status), "Release a task worktree");
      if (!task) return;
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
    return dispatcher.run(notify);
  }

  async function dispatchQueueOnce(notify: boolean): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const storage = context.storageUri;
    if (!workspaceFolder || workspaceFolder.uri.scheme !== "file" || !storage || storage.scheme !== "file") {
      if (notify) void vscode.window.showErrorMessage("Open a local Git workspace before dispatching tasks.");
      return;
    }
    const connectionCandidates = new Set<TaskProps["id"]>();
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
      );
      for (const task of listed.value) {
        if (task.snapshot().status === "queued") {
          connectionCandidates.add(task.snapshot().id);
          connectedTasks.add(task.snapshot().id);
        }
      }
      const result = await dispatched.execute({
        repositoryRoot: workspaceFolder.uri.fsPath,
        worktreeRoot: vscode.Uri.joinPath(storage, "worktrees").fsPath,
        baseRef: settings.value.baseRef,
        concurrencyLimit: settings.value.concurrencyLimit,
        model: settings.value.defaultModel
      });
      tree.refresh();
      if (!result.ok) throw result.error;
      const startedTaskIds = new Set(result.value.started);
      for (const taskId of connectionCandidates) {
        if (!startedTaskIds.has(taskId)) connectedTasks.delete(taskId);
      }
      const failed = result.value.failures.length;
      if (failed) {
        const titles = new Map(listed.value.map(item => {
          const snapshot = item.snapshot();
          return [snapshot.id, snapshot.title] as const;
        }));
        const details = result.value.failures.slice(0, 3)
          .map(failure => `${titles.get(failure.taskId) ?? failure.taskId}: ${failure.error.message}`)
          .join("; ");
        const remainder = failed > 3 ? `; and ${failed - 3} more` : "";
        await offerRuntimeCheck(
          `Started ${result.value.started.length} queued task(s), but ${failed} failed: ${details}${remainder}`
        );
      } else if (notify) {
        void vscode.window.showInformationMessage(result.value.started.length > 0
          ? `Started ${result.value.started.length} queued task(s).`
          : "Queued tasks exist, but none are currently runnable. Check prerequisites and the concurrency limit.");
      }
    } catch (cause) {
      for (const taskId of connectionCandidates) connectedTasks.delete(taskId);
      console.error("Could not dispatch queued MultiCodex tasks", cause);
      const message = cause instanceof Error ? cause.message : typeof cause === "object" && cause && "message" in cause
        ? String(cause.message) : "Unknown dispatch error.";
      await offerRuntimeCheck(`Could not dispatch queued tasks: ${message}`);
    }
  }

  async function offerRuntimeCheck(message: string): Promise<void> {
    const action = await vscode.window.showErrorMessage(redactAndTruncateSensitiveText(message, 2_000), "Check Runtime");
    if (action === "Check Runtime") {
      await vscode.commands.executeCommand("amazingMultiCodex.showRuntimeStatus");
    }
  }

  function bindAgent(
    agent: Awaited<ReturnType<CodexProcessSupervisor["start"]>>,
    maxActivityCharacters: number
  ): void {
    if (boundAgent === agent) return;
    connectedTasks.clear();
    coordinator?.stop();
    coordinator = new AgentEventCoordinator(agent, executions, lifecycle, clock, {
      error: (message, error) => console.error(message, error),
      taskChanged: taskId => {
        connectedTasks.delete(taskId);
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
        const requested = await activity.record({
          taskId: approval.taskId,
          kind: "approval",
          summary: `Approval requested: ${approval.title}`,
          detail: `Risk: ${approval.risk}`
        });
        if (!requested.ok) console.error("Could not record approval request activity", requested.error);
        void taskDetails.refresh(approval.taskId);
        const selection = await vscode.window.showWarningMessage(
          approval.detail ? `${approval.title}\n\n${approval.detail}` : approval.title,
          { modal: true },
          "Approve",
          "Decline"
        );
        const decision = selection === "Approve" ? "approved" : selection === "Decline" ? "declined" : "cancelled";
        const recorded = await activity.record({
          taskId: approval.taskId,
          kind: "approval",
          summary: `Approval ${decision}: ${approval.title}`,
          detail: `Risk: ${approval.risk}`
        });
        if (!recorded.ok) console.error("Could not record approval decision activity", recorded.error);
        return decision;
      }
    }, {
      error: (message, cause) => console.error(message, cause),
      taskChanged: taskId => {
        tree.refresh();
        void taskDetails.refresh(taskId);
      }
    });
  }

  async function selectTask(
    provided: TaskProps | undefined,
    eligible: (task: TaskProps) => boolean,
    title: string
  ): Promise<TaskProps | undefined> {
    if (provided) return provided;
    const listed = await repository.list();
    if (!listed.ok) {
      void vscode.window.showErrorMessage(listed.error.message);
      return undefined;
    }
    const candidates = sortTasksForDisplay(
      listed.value.map(task => task.snapshot()).filter(eligible)
    );
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage(`No eligible MultiCodex tasks are available for: ${title}.`);
      return undefined;
    }
    const selected = await vscode.window.showQuickPick(candidates.map(task => ({
      label: task.title,
      description: `${taskStatusLabel(task.status)} · ${taskPriorityLabel(task.priority)}`,
      detail: task.statusReason ?? task.description,
      task
    })), {
      title,
      matchOnDescription: true,
      matchOnDetail: true
    });
    return selected?.task;
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

function validateAcceptanceCriteriaInput(value: string): string | undefined {
  const criteria = value.split(";").map(item => item.trim()).filter(Boolean);
  if (criteria.length > 50) return "A task cannot have more than 50 acceptance criteria.";
  if (criteria.some(item => item.length > 2_000)) {
    return "Each acceptance criterion cannot exceed 2,000 characters.";
  }
  return undefined;
}
