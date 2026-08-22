import { Clock } from "../../../shared/core/clock";
import { IdGenerator } from "../../../shared/core/idGenerator";
import { AppError, Result, err, ok } from "../../../shared/core/result";
import { AgentPlanRepository, AgentRuntimePort, AgentStage, agentPlanTemplate } from "../../agents/public";
import { TaskDependencyService, TaskId, TaskLifecycleService } from "../../tasks/public";
import { WorkspaceId, WorkspacePort, workspaceBranch } from "../../workspaces/public";
import { ExecutionCapacityGate } from "../domain/executionCapacityGate";
import { ExecutionRepository, TaskExecutionId, TaskExecutionRecord } from "../ports/executionRepository";

export interface StartTaskWorkflowCommand {
  readonly taskId: TaskId;
  readonly repositoryRoot: string;
  readonly worktreeRoot: string;
  readonly baseRef: string;
  readonly concurrencyLimit: number;
  readonly prompt?: string;
  readonly model?: string;
}

export class StartTaskWorkflow {
  constructor(
    private readonly tasks: TaskLifecycleService,
    private readonly workspaces: WorkspacePort,
    private readonly agents: AgentRuntimePort,
    private readonly executions: ExecutionRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly capacity: ExecutionCapacityGate,
    private readonly dependencies: TaskDependencyService,
    private readonly agentPlans?: AgentPlanRepository
  ) {}

  async execute(command: StartTaskWorkflowCommand): Promise<Result<TaskExecutionRecord>> {
    const existing = await this.executions.findActiveByTask(command.taskId);
    if (!existing.ok) return existing;
    if (existing.value) return err(activeExecution(command.taskId));
    const active = await this.executions.listActive();
    if (!active.ok) return active;
    const release = this.capacity.tryAcquire(active.value.length, command.concurrencyLimit);
    if (!release) return err(capacityReached(command.concurrencyLimit));
    try {
      return await this.executeReserved(command);
    } finally {
      release();
    }
  }

  private async executeReserved(command: StartTaskWorkflowCommand): Promise<Result<TaskExecutionRecord>> {
    const task = await this.tasks.get(command.taskId);
    if (!task.ok) return task;
    if (task.value.status !== "queued") return err(notQueued(command.taskId, task.value.status));
    const ready = await this.dependencies.prerequisitesSatisfied(command.taskId);
    if (!ready.ok) return ready;
    if (!ready.value) return err(prerequisitesIncomplete(command.taskId));
    const configured = this.agentPlans ? await this.agentPlans.findByTask(command.taskId) : ok(undefined);
    if (!configured.ok) return configured;
    const stages = configured.value?.snapshot().stages ?? agentPlanTemplate("solo");
    const firstStage = stages[0];

    const preparing = await this.tasks.transition(command.taskId, "preparing");
    if (!preparing.ok) return preparing;
    const executionId = this.ids.next() as TaskExecutionId;
    const workspaceId = this.ids.next() as WorkspaceId;
    const prepared = await this.workspaces.prepare({
      id: workspaceId,
      taskId: command.taskId,
      repositoryRoot: command.repositoryRoot,
      worktreeRoot: command.worktreeRoot,
      branch: workspaceBranch(command.taskId, task.value.title, workspaceId),
      baseRef: command.baseRef
    });
    if (!prepared.ok) {
      await this.tasks.transition(command.taskId, "blocked", prepared.error.code);
      return prepared;
    }

    const now = this.clock.now();
    let execution: TaskExecutionRecord = {
      id: executionId,
      taskId: command.taskId,
      workspace: prepared.value,
      status: "prepared",
      createdAt: now,
      updatedAt: now,
      version: 0,
      stage: { index: 0, total: stages.length, role: firstStage.role },
      reviewCycles: 0,
      ...(command.model ? { model: command.model } : {})
    };
    const saved = await this.executions.save(execution, -1);
    if (!saved.ok) {
      const released = await this.workspaces.release({ workspace: prepared.value, force: false });
      const failure = released.ok ? saved.error : cleanupFailed(prepared.value.path, saved.error, released.error);
      await this.tasks.transition(command.taskId, "blocked", failure.code);
      return err(failure);
    }

    try {
      const agent = await this.agents.start({
        prompt: stagePrompt(firstStage, command.prompt?.trim() || taskPrompt(task.value.title, task.value.description, task.value.acceptanceCriteria)),
        cwd: prepared.value.path,
        model: command.model
      });
      execution = { ...execution, agent, status: "running", stageHistory: [{
        index: 0, total: stages.length, role: firstStage.role, agent,
        startedAt: this.clock.now(), outcome: "running"
      }], updatedAt: this.clock.now(), version: 1 };
      const updated = await this.executions.save(execution, 0);
      if (!updated.ok) {
        let interruption: AppError | undefined;
        try { await this.agents.interrupt(agent); } catch (cause) { interruption = interruptFailed(cause); }
        const failed = await this.failExecution({ ...execution, agent: undefined, status: "prepared", version: 0 });
        await this.tasks.transition(command.taskId, "blocked", updated.error.code);
        const compensation = failed.ok ? interruption : failed.error;
        return compensation ? err(compensationFailed(updated.error, compensation)) : updated;
      }
      const running = await this.tasks.transition(command.taskId, "running");
      if (!running.ok) {
        let interruption: AppError | undefined;
        try { await this.agents.interrupt(agent); } catch (cause) { interruption = interruptFailed(cause); }
        const failed = await this.failExecution(execution);
        await this.tasks.transition(command.taskId, "blocked", running.error.code);
        const compensation = failed.ok ? interruption : failed.error;
        return compensation ? err(compensationFailed(running.error, compensation)) : running;
      }
      return ok(execution);
    } catch (cause) {
      const failed = await this.failExecution(execution);
      await this.tasks.transition(command.taskId, "blocked", "codex.start-failed");
      const primary = startFailed(cause);
      return failed.ok ? err(primary) : err(compensationFailed(primary, failed.error));
    }
  }

  private failExecution(execution: TaskExecutionRecord): Promise<Result<void>> {
    return this.executions.save({
      ...execution,
      status: "failed",
      updatedAt: this.clock.now(),
      version: execution.version + 1
    }, execution.version);
  }
}

function stagePrompt(stage: AgentStage, task: string): string {
  return [`You are the ${stage.role} stage in a multi-agent task pipeline.`, `Stage objective: ${stage.objective}`, task,
    "Work only within your role. Inspect the current worktree because earlier stages may have changed it. Finish with a concise handoff for the next role.",
    stage.role === "reviewer" ? "End your response with exactly one verdict line: VERDICT: APPROVED or VERDICT: CHANGES_REQUESTED. Explain required changes before the verdict." : ""].filter(Boolean).join("\n\n");
}

function taskPrompt(title: string, description: string | undefined, criteria: readonly string[]): string {
  const sections = [`Task: ${title}`];
  if (description) sections.push(`Context:\n${description}`);
  if (criteria.length) sections.push(`Acceptance criteria:\n${criteria.map(item => `- ${item}`).join("\n")}`);
  return sections.join("\n\n");
}

function activeExecution(taskId: TaskId): AppError {
  return { code: "execution.already-active", category: "conflict", message: "Task already has an active execution.", retryable: false, context: { taskId } };
}

function notQueued(taskId: TaskId, status: string): AppError {
  return { code: "task.not-queued", category: "conflict", message: "Only queued tasks can start.", retryable: false, context: { taskId, status } };
}

function startFailed(cause: unknown): AppError {
  return { code: "codex.start-failed", category: "unavailable", message: "Codex execution could not be started.", retryable: true, cause };
}

function capacityReached(limit: number): AppError {
  return {
    code: "scheduler.capacity-reached",
    category: "conflict",
    message: `The configured concurrency limit (${limit}) has been reached.`,
    retryable: true,
    context: { limit: String(limit) }
  };
}

function prerequisitesIncomplete(taskId: TaskId): AppError {
  return {
    code: "task.prerequisites-incomplete",
    category: "conflict",
    message: "Task prerequisites must be completed before execution can start.",
    retryable: true,
    context: { taskId }
  };
}

function cleanupFailed(path: string, persistenceFailure: AppError, releaseFailure: AppError): AppError {
  return {
    code: "workspace.cleanup-failed",
    category: "unavailable",
    message: `Execution persistence failed and the prepared worktree was retained at '${path}'.`,
    retryable: false,
    context: { path },
    cause: { persistenceFailure, releaseFailure }
  };
}

function compensationFailed(primary: AppError, compensation: AppError): AppError {
  return {
    code: "execution.compensation-failed",
    category: "unavailable",
    message: "Task startup failed and its active execution record could not be closed. Reload the window to run recovery before retrying.",
    retryable: false,
    cause: { primary, compensation }
  };
}

function interruptFailed(cause: unknown): AppError {
  return {
    code: "codex.interrupt-failed",
    category: "unavailable",
    message: "The started Codex turn could not be interrupted during rollback.",
    retryable: true,
    cause
  };
}
