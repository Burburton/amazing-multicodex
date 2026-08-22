import * as vscode from "vscode";
import { basename as pathBaseName, resolve as pathResolve } from "node:path";
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
import { MementoProjectRepository } from "./adapters/vscode/mementoProjectRepository";
import { MementoAgentPlanRepository } from "./adapters/vscode/mementoAgentPlanRepository";
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
  DeleteTaskWorkflow,
  ExecutionCapacityGate,
  ReleaseTaskWorkspaceWorkflow,
  ReconcileExecutionsWorkflow,
  ReconcileRuntimeWorkflow,
  ReconnectRunningTasksWorkflow,
  ResumeTaskWorkflow,
  RetryAgentStageWorkflow,
  SchedulerPolicy,
  StartTaskWorkflow,
  SteerTaskWorkflow,
  TaskDetailQuery,
  ValidateTaskWorkflow
} from "./modules/orchestration/public";
import {
  CreateTaskHandler,
  ReassignTaskHandler,
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
import { TaskDetailPanelManager, TaskDetailAction } from "./ui/taskDetailPanel";
import { sortTasksForDisplay, taskPriorityLabel, taskStatusLabel } from "./ui/taskPresentation";
import { ProjectId, ProjectProps, ProjectService } from "./modules/projects/public";
import { ProjectTreeProvider } from "./ui/projectTreeProvider";
import { ProjectDetailPanelManager } from "./ui/projectDetailPanel";
import { AgentPlanService, agentPlanTemplate } from "./modules/agents/public";

export function activate(context: vscode.ExtensionContext): void {
  const connectedTasks = new Set<TaskProps["id"]>();
  const validatingTasks = new Set<TaskProps["id"]>();
  const repository = new MementoTaskRepository(context.workspaceState);
  const clock = new SystemClock();
  const projectRepository = new MementoProjectRepository(context.workspaceState);
  const projectService = new ProjectService(projectRepository, clock, new CryptoIdGenerator());
  const createTask = new CreateTaskHandler(repository, clock, new CryptoIdGenerator());
  const reviseTask = new ReviseTaskHandler(repository, clock);
  const lifecycle = new TaskLifecycleService(repository, clock);
  const dependencyRepository = new MementoTaskDependencyRepository(context.workspaceState);
  const dependencies = new TaskDependencyService(
    dependencyRepository, repository
  );
  const reassignTask = new ReassignTaskHandler(repository, dependencyRepository, clock);
  const agentPlanRepository = new MementoAgentPlanRepository(context.workspaceState);
  const agentPlans = new AgentPlanService(agentPlanRepository, repository, clock);
  const projectTree = new ProjectTreeProvider(projectRepository, repository);
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
  const activityRepository = new MementoActivityRepository(context.workspaceState);
  const activity = new ActivityService(
    activityRepository, clock, ids
  );
  const approvalRepository = new MementoApprovalRepository(context.workspaceState);
  const approvals = new ApprovalService(
    approvalRepository, clock, ids
  );
  const taskDetailQuery = new TaskDetailQuery(lifecycle, dependencies, executions, activity);
  const detailCommands: Readonly<Record<TaskDetailAction, string>> = {
    edit: "amazingMultiCodex.editTask",
    configureAgents: "amazingMultiCodex.configureTaskAgents",
    queue: "amazingMultiCodex.queueTask",
    start: "amazingMultiCodex.startTask",
    resume: "amazingMultiCodex.resumeTask",
    retryStage: "amazingMultiCodex.retryAgentStage",
    steer: "amazingMultiCodex.steerTask",
    cancel: "amazingMultiCodex.cancelTask",
    validate: "amazingMultiCodex.validateTask",
    changes: "amazingMultiCodex.showChanges",
    integrate: "amazingMultiCodex.integrateTask",
    recoverIntegration: "amazingMultiCodex.recoverIntegration",
    release: "amazingMultiCodex.releaseWorkspace",
    delete: "amazingMultiCodex.deleteTask"
  };
  const taskDetails = new TaskDetailPanelManager(
    async taskId => {
      const [detail, plan] = await Promise.all([taskDetailQuery.execute(taskId), agentPlans.get(taskId)]);
      if (detail.ok && plan.ok) return { ...detail.value, agentPlan: plan.value };
      void vscode.window.showErrorMessage(detail.ok ? plan.ok ? "Could not load task details." : plan.error.message : detail.error.message);
      return undefined;
    },
    async (action, task) => { await vscode.commands.executeCommand(detailCommands[action], task); },
    (message, cause) => {
      console.error(message, cause);
      const detail = cause instanceof Error ? cause.message : String(cause);
      void vscode.window.showErrorMessage(`${message} ${detail}`);
    }
  );
  const projectDetails = new ProjectDetailPanelManager(
    async projectId => {
      const [listed, projects] = await Promise.all([repository.list(), projectService.list()]);
      const includeLegacy = projects.ok && projects.value[0]?.id === projectId;
      return listed.ok ? sortTasksForDisplay(listed.value.map(task => task.snapshot()).filter(task =>
        task.projectId === projectId || (includeLegacy && task.projectId === undefined)
      )) : [];
    },
    taskId => taskDetails.show(taskId),
    async (action, taskIds) => {
      if (action === "cancel") {
        const confirmed = await vscode.window.showWarningMessage(
          `Cancel ${taskIds.length} selected running task(s)?`, { modal: true }, "Cancel Tasks"
        );
        if (confirmed !== "Cancel Tasks") return;
        let agent = boundAgent;
        if (!agent) {
          const projects = await projectService.list();
          const settings = readSettings();
          if (!projects.ok || projects.value.length === 0 || !settings.ok) {
            void vscode.window.showErrorMessage(!projects.ok ? projects.error.message : !settings.ok ? settings.error.message : "Add a project before cancelling tasks.");
            return;
          }
          agent = await codex.start({ cwd: projects.value[0].repositoryRoot, executable: settings.value.codexExecutable, requestTimeoutMs: settings.value.requestTimeoutMs });
          await bindAgent(agent, settings.value.maxActivityCharacters);
        }
        const results = await Promise.all(taskIds.map(taskId => new CancelTaskWorkflow(
          lifecycle, agent!, executions, clock
        ).execute(taskId)));
        const failed = results.filter(result => !result.ok).length;
        taskIds.forEach(taskId => connectedTasks.delete(taskId));
        refreshViews();
        if (failed) void vscode.window.showWarningMessage(`Cancelled ${taskIds.length - failed} task(s); ${failed} could not be cancelled.`);
        return;
      }
      const projects = await projectService.list();
      if (!projects.ok || projects.value.length === 0) { void vscode.window.showErrorMessage("Add a project before reconnecting tasks."); return; }
      const settings = readSettings();
      if (!settings.ok) { void vscode.window.showErrorMessage(settings.error.message); return; }
      const agent = await codex.start({ cwd: projects.value[0].repositoryRoot, executable: settings.value.codexExecutable, requestTimeoutMs: settings.value.requestTimeoutMs });
      const alreadyConnected = boundAgent === agent ? new Set(connectedTasks) : new Set<TaskProps["id"]>();
      await bindAgent(agent, settings.value.maxActivityCharacters);
      const report = await new ReconnectRunningTasksWorkflow(repository, lifecycle, agent, executions, clock)
        .execute(alreadyConnected, new Set(taskIds));
      if (!report.ok) { void vscode.window.showErrorMessage(report.error.message); return; }
      report.value.resumed.forEach(taskId => connectedTasks.add(taskId));
      refreshViews();
      if (report.value.failed.length) void vscode.window.showWarningMessage(`Reconnected ${report.value.resumed.length}; ${report.value.failed.length} selected task(s) failed.`);
    }
  );
  const projectsReady = ensureWorkspaceProjects();
  let coordinator: AgentEventCoordinator | undefined;
  let activityBridge: AgentActivityBridge | undefined;
  let approvalBridge: ApprovalBridge | undefined;
  let boundAgent: Awaited<ReturnType<CodexProcessSupervisor["start"]>> | undefined;
  let runtimeReconciliation: Promise<void> = Promise.resolve();
  const dispatcher = new CoalescingAsyncRunner(
    dispatchQueueOnce,
    (currentNotify, incomingNotify) => currentNotify || incomingNotify
  );

  async function ensureWorkspaceProjects(): Promise<void> {
    const settings = readSettings();
    const baseRef = settings.ok ? settings.value.baseRef : "HEAD";
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== "file") continue;
      if (!await isGitRepository(folder.uri.fsPath)) continue;
      const ensured = await projectService.ensure({
        name: folder.name || pathBaseName(folder.uri.fsPath),
        repositoryRoot: folder.uri.fsPath,
        baseRef
      });
      if (!ensured.ok) console.error("Could not register MultiCodex project", ensured.error);
    }
    projectTree.refresh();
  }

  async function isGitRepository(root: string): Promise<boolean> {
    try {
      const result = await commandRunner.run({ executable: "git", args: ["rev-parse", "--show-toplevel"], cwd: root, maxOutputBytes: 4_096 });
      return result.exitCode === 0 && !result.truncated && pathResolve(result.stdout.trim()) === pathResolve(root);
    } catch {
      return false;
    }
  }

  async function resolveTaskProject(task: TaskProps): Promise<ProjectProps | undefined> {
    await projectsReady;
    if (task.projectId) {
      const found = await projectRepository.findById(task.projectId);
      if (!found.ok) {
        console.error("Could not resolve MultiCodex task project", found.error);
        void vscode.window.showErrorMessage(`Could not load the task project: ${found.error.message}`);
        return undefined;
      }
      if (found.value) return found.value.snapshot();
    }
    const listed = await projectService.list();
    if (!listed.ok) {
      console.error("Could not list MultiCodex projects", listed.error);
      void vscode.window.showErrorMessage(`Could not load projects: ${listed.error.message}`);
      return undefined;
    }
    return listed.value[0];
  }

  function refreshViews(): void {
    projectTree.refresh();
    void projectDetails.refreshAll();
  }

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
    projectTree,
    taskDetails,
    projectDetails,
    { dispose: () => {
      coordinator?.stop();
      activityBridge?.stop();
      approvalBridge?.stop();
      codex.stop();
    } },
    vscode.window.registerTreeDataProvider("amazingMultiCodex.projects", projectTree),
    vscode.commands.registerCommand("amazingMultiCodex.refreshProjects", async () => {
      await ensureWorkspaceProjects();
      projectTree.refresh();
    }),
    vscode.commands.registerCommand("amazingMultiCodex.addProject", async () => {
      const selected = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: "Add Git Project" });
      const folder = selected?.[0];
      if (!folder || folder.scheme !== "file") return;
      if (!await isGitRepository(folder.fsPath)) {
        void vscode.window.showErrorMessage("Choose the root folder of a local Git repository.");
        return;
      }
      const settings = readSettings();
      if (!settings.ok) { void vscode.window.showErrorMessage(settings.error.message); return; }
      const name = pathBaseName(folder.fsPath);
      const added = await projectService.ensure({ name, repositoryRoot: folder.fsPath, baseRef: settings.value.baseRef });
      if (!added.ok) { void vscode.window.showErrorMessage(added.error.message); return; }
      projectTree.refresh();
      await projectDetails.show(added.value);
    }),
    vscode.commands.registerCommand("amazingMultiCodex.showProjectDetails", async (project?: ProjectProps) => {
      await projectsReady;
      if (!project) {
        const listed = await projectService.list();
        if (!listed.ok) { void vscode.window.showErrorMessage(listed.error.message); return; }
        project = await vscode.window.showQuickPick(listed.value.map(item => ({ label: item.name, description: item.repositoryRoot, project: item })), { placeHolder: "Choose a project" }).then(item => item?.project);
      }
      if (project) await projectDetails.show(project);
    }),
    vscode.commands.registerCommand("amazingMultiCodex.editProject", async (project?: ProjectProps) => {
      project = await selectProject(project, "Edit a project");
      if (!project) return;
      const name = await vscode.window.showInputBox({
        prompt: "Project display name", value: project.name,
        validateInput: value => !value.trim() || value.trim().length > 200 ? "Enter a name containing 1 to 200 characters." : undefined
      });
      if (!name?.trim()) return;
      const baseRef = await vscode.window.showInputBox({
        prompt: "Git base branch or ref", value: project.baseRef,
        validateInput: value => !value.trim() || value.trim().length > 1_024 || value.trim().startsWith("-") ? "Enter a valid Git ref." : undefined
      });
      if (!baseRef?.trim()) return;
      let baseRefValid = false;
      try {
        const verified = await commandRunner.run({
          executable: "git", args: ["rev-parse", "--verify", `${baseRef.trim()}^{commit}`],
          cwd: project.repositoryRoot, maxOutputBytes: 4_096
        });
        baseRefValid = verified.exitCode === 0 && !verified.truncated;
      } catch { /* surfaced as an invalid/unavailable ref below */ }
      if (!baseRefValid) {
        void vscode.window.showErrorMessage(`Git ref '${baseRef.trim()}' does not resolve to a commit in this project.`);
        return;
      }
      const revised = await projectService.revise(project.id, { name, baseRef });
      if (!revised.ok) { void vscode.window.showErrorMessage(revised.error.message); return; }
      refreshViews();
      await projectDetails.refresh(revised.value);
      void vscode.window.showInformationMessage(`Updated MultiCodex project: ${revised.value.name}`);
    }),
    vscode.commands.registerCommand("amazingMultiCodex.removeProject", async (project?: ProjectProps) => {
      project = await selectProject(project, "Remove a project");
      if (!project) return;
      const [listedTasks, listedProjects] = await Promise.all([repository.list(), projectService.list()]);
      if (!listedTasks.ok) { void vscode.window.showErrorMessage(listedTasks.error.message); return; }
      if (!listedProjects.ok) { void vscode.window.showErrorMessage(listedProjects.error.message); return; }
      const firstProject = listedProjects.value[0]?.id;
      const owned = listedTasks.value.map(task => task.snapshot()).filter(task =>
        task.projectId === project!.id || (task.projectId === undefined && project!.id === firstProject)
      );
      if (owned.length > 0) {
        void vscode.window.showWarningMessage(`Move or delete the ${owned.length} task(s) in '${project.name}' before removing the project.`);
        return;
      }
      const confirmed = await vscode.window.showWarningMessage(
        `Remove '${project.name}' from MultiCodex? The local repository will not be deleted.`,
        { modal: true }, "Remove Project"
      );
      if (confirmed !== "Remove Project") return;
      const removed = await projectService.remove(project.id);
      if (!removed.ok) { void vscode.window.showErrorMessage(removed.error.message); return; }
      projectDetails.close(project.id);
      refreshViews();
      void vscode.window.showInformationMessage(`Removed MultiCodex project: ${project.name}`);
    }),
    vscode.commands.registerCommand("amazingMultiCodex.openProject", async (project?: ProjectProps) => {
      project = await selectProject(project, "Open a project repository");
      if (project) await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(project.repositoryRoot), { forceNewWindow: true });
    }),
    vscode.commands.registerCommand("amazingMultiCodex.createTask", async (project?: ProjectProps) => {
      await projectsReady;
      const projects = await projectService.list();
      if (!projects.ok) { void vscode.window.showErrorMessage(projects.error.message); return; }
      if (projects.value.length === 0) {
        void vscode.window.showErrorMessage("Add or open a Git project before creating a task.");
        return;
      }
      const selectedProject = project && projects.value.some(item => item.id === project!.id) ? project
        : projects.value.length === 1 ? projects.value[0] : await vscode.window.showQuickPick(
        projects.value.map(project => ({ label: project.name, description: project.repositoryRoot, project })),
        { placeHolder: "Choose the project for this task" }
      ).then(item => item?.project);
      if (!selectedProject) return;
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
      const created = await createTask.execute({ projectId: selectedProject.id, title, description, acceptanceCriteria, priority: priority.priority });
      if (!created.ok) {
        void vscode.window.showErrorMessage(created.error.message);
        return;
      }
      refreshViews();
      projectTree.refresh();
      await projectDetails.refresh(selectedProject);
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
      refreshViews();
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
      refreshViews();
      await taskDetails.refresh(task.id);
      void vscode.window.showInformationMessage(`Updated MultiCodex draft: ${revised.value.title}`);
    }),
    vscode.commands.registerCommand("amazingMultiCodex.moveTask", async (task?: TaskProps) => {
      task = await selectTask(task, candidate => candidate.status === "draft", "Move a draft task");
      if (!task) return;
      const projects = await projectService.list();
      if (!projects.ok) { void vscode.window.showErrorMessage(projects.error.message); return; }
      const choices = projects.value.filter(project => project.id !== task!.projectId);
      if (choices.length === 0) { void vscode.window.showInformationMessage("Add another project before moving this task."); return; }
      const target = await vscode.window.showQuickPick(choices.map(project => ({
        label: project.name, description: project.repositoryRoot, project
      })), { placeHolder: `Move '${task.title}' to a project` }).then(item => item?.project);
      if (!target) return;
      const moved = await reassignTask.execute(task.id, target.id);
      if (!moved.ok) { void vscode.window.showErrorMessage(moved.error.message); return; }
      refreshViews();
      await taskDetails.refresh(task.id);
      void vscode.window.showInformationMessage(`Moved '${task.title}' to '${target.name}'.`);
    }),
    vscode.commands.registerCommand("amazingMultiCodex.configureTaskAgents", async (task?: TaskProps) => {
      task = await selectTask(task, candidate => candidate.status === "draft", "Configure task agents");
      if (!task) return;
      const choice = await vscode.window.showQuickPick([
        { label: "Solo", description: "Implementer", template: "solo" as const },
        { label: "Plan and deliver", description: "Planner → Implementer", template: "delivery" as const },
        { label: "Reviewed delivery", description: "Implementer → Reviewer", template: "reviewed" as const },
        { label: "Full pipeline", description: "Planner → Implementer → Reviewer → Tester", template: "full" as const }
      ], { title: `Agent pipeline for: ${task.title}`, placeHolder: "Choose an execution pipeline" });
      if (!choice) return;
      const configured = await agentPlans.configure(task.id, agentPlanTemplate(choice.template));
      if (!configured.ok) { void vscode.window.showErrorMessage(configured.error.message); return; }
      await taskDetails.refresh(task.id);
      void vscode.window.showInformationMessage(`Configured ${configured.value.stages.length} agent stage(s) for '${task.title}'.`);
    }),
    vscode.commands.registerCommand("amazingMultiCodex.showRuntimeStatus", async () => {
      await projectsReady;
      const projects = await projectService.list();
      if (!projects.ok || projects.value.length === 0) { void vscode.window.showErrorMessage(projects.ok ? "Add a Git project first." : projects.error.message); return; }
      const project = projects.value.length === 1 ? projects.value[0] : await vscode.window.showQuickPick(
        projects.value.map(item => ({ label: item.name, description: item.repositoryRoot, project: item })),
        { placeHolder: "Choose a project to check" }
      ).then(item => item?.project);
      if (!project) return;
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
        cwd: project.repositoryRoot,
        codexExecutable: settings.value.codexExecutable,
        baseRef: project.baseRef
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
      refreshViews();
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
      const project = await resolveTaskProject(task);
      if (!project) { void vscode.window.showErrorMessage("The task project is unavailable."); return; }
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
          await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(storage, "worktrees", project.id));
          const agent = await codex.start({
            cwd: project.repositoryRoot,
            executable: settings.value.codexExecutable,
            requestTimeoutMs: settings.value.requestTimeoutMs
          });
          await bindAgent(agent, settings.value.maxActivityCharacters);
          const workflow = new StartTaskWorkflow(
            lifecycle,
            gitWorkspaces,
            agent,
            executions,
            clock,
            ids,
            capacity,
            dependencies,
            agentPlanRepository
          );
          connectedTasks.add(task.id);
          const started = await workflow.execute({
            taskId: task.id,
            repositoryRoot: project.repositoryRoot,
            worktreeRoot: vscode.Uri.joinPath(storage, "worktrees", project.id).fsPath,
            baseRef: project.baseRef,
            concurrencyLimit: settings.value.concurrencyLimit,
            model: settings.value.defaultModel
          });
      refreshViews();
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
      try {
        const project = await resolveTaskProject(task);
        if (!project) { void vscode.window.showErrorMessage("The task project is unavailable."); return; }
        const settings = readSettings();
        if (!settings.ok) {
          void vscode.window.showErrorMessage(settings.error.message);
          return;
        }
        const agent = await codex.start({
          cwd: project.repositoryRoot,
          executable: settings.value.codexExecutable,
          requestTimeoutMs: settings.value.requestTimeoutMs
        });
        await bindAgent(agent, settings.value.maxActivityCharacters);
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
    vscode.commands.registerCommand("amazingMultiCodex.reconnectRunningTasks", async () => {
      try {
        const projects = await projectService.list();
        if (!projects.ok || projects.value.length === 0) {
          void vscode.window.showErrorMessage(projects.ok ? "Add a project before reconnecting tasks." : projects.error.message);
          return;
        }
        const settings = readSettings();
        if (!settings.ok) { void vscode.window.showErrorMessage(settings.error.message); return; }
        const agent = await codex.start({
          cwd: projects.value[0].repositoryRoot,
          executable: settings.value.codexExecutable,
          requestTimeoutMs: settings.value.requestTimeoutMs
        });
        const alreadyConnected = boundAgent === agent ? new Set(connectedTasks) : new Set<TaskProps["id"]>();
        await bindAgent(agent, settings.value.maxActivityCharacters);
        const report = await new ReconnectRunningTasksWorkflow(
          repository, lifecycle, agent, executions, clock
        ).execute(alreadyConnected);
        if (!report.ok) { void vscode.window.showErrorMessage(report.error.message); return; }
        for (const taskId of report.value.resumed) connectedTasks.add(taskId);
        refreshViews();
        const failed = report.value.failed.length;
        const details = report.value.failed.slice(0, 3).map(item => `${item.taskId}: ${item.message}`).join("; ");
        void vscode.window.showInformationMessage(
          `Reconnected ${report.value.resumed.length} task(s); skipped ${report.value.skipped.length} already connected.`
          + (failed ? ` Failed ${failed}: ${details}${failed > 3 ? "; and more" : ""}` : "")
        );
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "Unknown reconnect error.";
        void vscode.window.showErrorMessage(`Could not reconnect running tasks: ${message}`);
      }
    }),
    vscode.commands.registerCommand("amazingMultiCodex.retryAgentStage", async (task?: TaskProps) => {
      task = await selectTask(task, candidate => candidate.status === "failed", "Retry a failed agent stage");
      if (!task) return;
      const project = await resolveTaskProject(task);
      if (!project) return;
      const settings = readSettings();
      if (!settings.ok) { void vscode.window.showErrorMessage(settings.error.message); return; }
      try {
        const agent = await codex.start({ cwd: project.repositoryRoot, executable: settings.value.codexExecutable, requestTimeoutMs: settings.value.requestTimeoutMs });
        await bindAgent(agent, settings.value.maxActivityCharacters);
        const retried = await new RetryAgentStageWorkflow(lifecycle, agent, executions, agentPlanRepository, clock).execute(task.id);
        if (!retried.ok) { void vscode.window.showErrorMessage(retried.error.message); return; }
        connectedTasks.add(task.id);
        refreshViews();
        await taskDetails.refresh(task.id);
        void vscode.window.showInformationMessage(`Retried ${retried.value.stage?.role ?? "agent"} stage for: ${task.title}`);
      } catch (cause) {
        void vscode.window.showErrorMessage(`Could not retry agent stage: ${cause instanceof Error ? cause.message : "Unknown error."}`);
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
    vscode.commands.registerCommand("amazingMultiCodex.showApprovalInbox", async () => {
      const pending = await approvals.listPending();
      if (!pending.ok) {
        void vscode.window.showErrorMessage(pending.error.message);
        return;
      }
      if (pending.value.length === 0) {
        void vscode.window.showInformationMessage("Approval inbox is empty.");
        return;
      }
      const tasks = await repository.list();
      if (!tasks.ok) {
        void vscode.window.showErrorMessage(tasks.error.message);
        return;
      }
      const byTask = new Map(tasks.value.map(item => {
        const snapshot = item.snapshot();
        return [snapshot.id, snapshot] as const;
      }));
      const selected = await vscode.window.showQuickPick(pending.value.map(approval => {
        const task = byTask.get(approval.taskId);
        return {
          label: approval.title,
          description: `${task?.title ?? approval.taskId} · ${approval.risk} · ${approval.createdAt.toLocaleString()}`,
          detail: approval.detail,
          approval
        };
      }), { title: `Approval Inbox (${pending.value.length})`, matchOnDetail: true });
      if (!selected) return;
      await taskDetails.show(selected.approval.taskId);
      const decision = await vscode.window.showQuickPick([
        { label: "Approve", decision: "approved" as const },
        { label: "Decline", decision: "declined" as const },
        { label: "Cancel request", decision: "cancelled" as const }
      ], { title: selected.label, placeHolder: "Choose how to respond to this Codex request" });
      if (!decision) return;
      const bridge = approvalBridge;
      if (!bridge?.decidePending(selected.approval.id, decision.decision)) {
        void vscode.window.showWarningMessage("This approval is no longer waiting for an active Codex response. Reconnect the task before deciding it.");
        return;
      }
      const recorded = await activity.record({
        taskId: selected.approval.taskId,
        kind: "approval",
        summary: `Approval ${decision.decision}: ${selected.label}`,
        detail: `Risk: ${selected.approval.risk}`
      });
      if (!recorded.ok) console.error("Could not record approval decision activity", recorded.error);
      void taskDetails.refresh(selected.approval.taskId);
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
      task = await selectTask(task, candidate => ["queued", "running", "awaitingApproval"].includes(candidate.status), "Cancel a queued or running task");
      if (!task) return;
      const confirmed = await vscode.window.showWarningMessage(
        `Cancel MultiCodex task '${task.title}'?${task.status === "queued" || codex.current() ? "" : " Codex is disconnected, so only local execution state will be abandoned."}`,
        { modal: true },
        "Cancel Task"
      );
      if (confirmed !== "Cancel Task") return;
      const agent = codex.current();
      const cancelled = task.status === "queued"
        ? await lifecycle.transition(task.id, "cancelled", "user-cancelled")
        : agent
          ? await new CancelTaskWorkflow(lifecycle, agent, executions, clock).execute(task.id)
          : await new AbandonTaskWorkflow(lifecycle, executions, clock).execute(task.id);
      refreshViews();
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
      refreshViews();
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
      const project = await resolveTaskProject(task);
      if (!project) { void vscode.window.showErrorMessage("The task project is unavailable."); return; }
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
        targetRepositoryRoot: project.repositoryRoot,
        strategy: selection.strategy,
        commitMessage: `MultiCodex: ${task.title}`,
        reviewedPatch: changes.value.patch
      });
      refreshViews();
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
      refreshViews();
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
        .filter(candidate => candidate.id !== task.id && candidate.projectId === task.projectId);
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
    }),
    vscode.commands.registerCommand("amazingMultiCodex.deleteTask", async (task?: TaskProps) => {
      task = await selectTask(task, candidate => [
        "draft", "readyForReview", "completed", "blocked", "failed", "cancelled", "deleting"
      ].includes(candidate.status), "Delete a stopped task");
      if (!task) return;
      const confirmed = await vscode.window.showWarningMessage(
        `Permanently delete '${task.title}', its MultiCodex history, and its worktree? Uncommitted worktree changes will be discarded; its Git branch is retained.`,
        { modal: true }, "Delete Task"
      );
      if (confirmed !== "Delete Task") return;
      const deleted = await new DeleteTaskWorkflow(
        repository, lifecycle, dependencyRepository, executions, approvalRepository, activityRepository, gitWorkspaces, agentPlanRepository
      ).execute(task.id, true);
      if (!deleted.ok) {
        void vscode.window.showErrorMessage(deleted.error.message);
        return;
      }
      connectedTasks.delete(task.id);
      refreshViews();
      await taskDetails.refresh(task.id);
      void vscode.window.showInformationMessage(`Deleted MultiCodex task: ${task.title}`);
    })
  );

  void new ReconcileExecutionsWorkflow(executions, lifecycle, gitWorkspaces, clock).execute()
    .then(report => {
      refreshViews();
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
    const storage = context.storageUri;
    if (!storage || storage.scheme !== "file") {
      if (notify) void vscode.window.showErrorMessage("MultiCodex workspace storage is unavailable.");
      return;
    }
    const connectionCandidates = new Set<TaskProps["id"]>();
    try {
      await projectsReady;
      const listed = await repository.list();
      if (!listed.ok) throw listed.error;
      const queued = listed.value.map(task => task.snapshot()).filter(task => task.status === "queued");
      if (queued.length === 0) {
        if (notify) void vscode.window.showInformationMessage("No queued MultiCodex tasks are ready to dispatch.");
        return;
      }
      const projects = await projectService.list();
      if (!projects.ok) throw projects.error;
      if (projects.value.length === 0) throw new Error("No MultiCodex project is registered.");
      const settings = readSettings();
      if (!settings.ok) throw settings.error;
      const agent = await codex.start({
        cwd: projects.value[0].repositoryRoot,
        executable: settings.value.codexExecutable,
        requestTimeoutMs: settings.value.requestTimeoutMs
      });
      await bindAgent(agent, settings.value.maxActivityCharacters);
      const starter = new StartTaskWorkflow(
        lifecycle, gitWorkspaces, agent,
        executions, clock, ids, capacity, dependencies, agentPlanRepository
      );
      const dispatched = await new DispatchQueuedTasksWorkflow(
        repository, executions, dependencies, new SchedulerPolicy(), starter
      );
      const started: TaskProps["id"][] = [];
      const failures: Array<{ taskId: TaskProps["id"]; error: { message: string } }> = [];
      const groups = projects.value.map((project, index) => ({
        project,
        includeUnassigned: index === 0,
        tasks: queued.filter(task => task.projectId === project.id || (index === 0 && task.projectId === undefined))
      })).filter(group => group.tasks.length > 0);
      for (const group of groups) {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(storage, "worktrees", group.project.id));
        for (const task of group.tasks) {
          connectionCandidates.add(task.id);
          connectedTasks.add(task.id);
        }
        const result = await dispatched.execute({
          projectId: group.project.id,
          includeUnassigned: group.includeUnassigned,
          repositoryRoot: group.project.repositoryRoot,
          worktreeRoot: vscode.Uri.joinPath(storage, "worktrees", group.project.id).fsPath,
          baseRef: group.project.baseRef,
          concurrencyLimit: settings.value.concurrencyLimit,
          model: settings.value.defaultModel
        });
        if (!result.ok) throw result.error;
        started.push(...result.value.started);
        failures.push(...result.value.failures);
      }
      refreshViews();
      const startedTaskIds = new Set(started);
      for (const taskId of connectionCandidates) {
        if (!startedTaskIds.has(taskId)) connectedTasks.delete(taskId);
      }
      const failed = failures.length;
      if (failed) {
        const titles = new Map(listed.value.map(item => {
          const snapshot = item.snapshot();
          return [snapshot.id, snapshot.title] as const;
        }));
        const details = failures.slice(0, 3)
          .map(failure => `${titles.get(failure.taskId) ?? failure.taskId}: ${failure.error.message}`)
          .join("; ");
        const remainder = failed > 3 ? `; and ${failed - 3} more` : "";
        await offerRuntimeCheck(
          `Started ${started.length} queued task(s), but ${failed} failed: ${details}${remainder}`
        );
      } else if (notify) {
        void vscode.window.showInformationMessage(started.length > 0
          ? `Started ${started.length} queued task(s) across ${groups.length} project(s).`
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

  async function bindAgent(
    agent: Awaited<ReturnType<CodexProcessSupervisor["start"]>>,
    maxActivityCharacters: number
  ): Promise<void> {
    if (boundAgent === agent) return runtimeReconciliation;
    connectedTasks.clear();
    coordinator?.stop();
    coordinator = new AgentEventCoordinator(agent, executions, lifecycle, clock, {
      error: (message, error) => console.error(message, error),
      taskChanged: (taskId, remainsActive) => {
        if (remainsActive) connectedTasks.add(taskId);
        else connectedTasks.delete(taskId);
      refreshViews();
        void taskDetails.refresh(taskId);
        void dispatchQueue(false);
      }
    }, agentPlanRepository);
    coordinator.start();
    activityBridge?.stop();
    activityBridge = new AgentActivityBridge(agent, executions, activity, maxActivityCharacters, {
      error: (message, error) => console.error(message, error),
      activityRecorded: taskId => { void taskDetails.refresh(taskId); }
    }, 128, agentPlanRepository);
    activityBridge.start();
    approvalBridge?.stop();
    approvalBridge = createApprovalBridge(agent);
    approvalBridge.start();
    boundAgent = agent;
    runtimeReconciliation = reconcileRuntime(agent);
    await runtimeReconciliation;
  }

  async function reconcileRuntime(agent: Awaited<ReturnType<CodexProcessSupervisor["start"]>>): Promise<void> {
    const report = await new ReconcileRuntimeWorkflow(executions, agent, coordinator!).execute();
    if (!report.ok) {
      console.error("Could not reconcile Codex runtime state", report.error);
      return;
    }
    for (const taskId of report.value.active) connectedTasks.add(taskId);
    for (const taskId of report.value.completed) connectedTasks.delete(taskId);
    for (const item of report.value.failed) connectedTasks.delete(item.taskId);
    if (report.value.unavailable.length > 0) {
      console.warn("Some persisted Codex turns could not be reconciled", report.value.unavailable);
    }
    refreshViews();
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
        void vscode.window.showInformationMessage(
          `Codex is waiting for approval: ${approval.title}`,
          "Open Approval Inbox"
        ).then(selection => {
          if (selection === "Open Approval Inbox") void vscode.commands.executeCommand("amazingMultiCodex.showApprovalInbox");
        });
        // The bridge keeps this request suspended until the inbox resolves it.
        // Returning a never-settling promise prevents a second modal decision
        // from racing the durable inbox response.
        return new Promise<"approved" | "declined" | "cancelled">(() => undefined);
      }
    }, {
      error: (message, cause) => console.error(message, cause),
      taskChanged: taskId => {
      refreshViews();
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

  async function selectProject(provided: ProjectProps | undefined, title: string): Promise<ProjectProps | undefined> {
    if (provided) return provided;
    const listed = await projectService.list();
    if (!listed.ok) {
      void vscode.window.showErrorMessage(listed.error.message);
      return undefined;
    }
    const selected = await vscode.window.showQuickPick(listed.value.map(project => ({
      label: project.name, description: project.repositoryRoot, detail: `Base ref: ${project.baseRef}`, project
    })), { title, matchOnDescription: true, matchOnDetail: true });
    return selected?.project;
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
