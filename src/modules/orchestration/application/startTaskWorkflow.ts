import { Clock } from "../../../shared/core/clock";
import { IdGenerator } from "../../../shared/core/idGenerator";
import { AppError, Result, err, ok } from "../../../shared/core/result";
import { AgentRuntimePort } from "../../agents/public";
import { TaskId, TaskLifecycleService } from "../../tasks/public";
import { WorkspaceId, WorkspacePort, workspaceBranch } from "../../workspaces/public";
import { ExecutionRepository, TaskExecutionId, TaskExecutionRecord } from "../ports/executionRepository";

export interface StartTaskWorkflowCommand {
  readonly taskId: TaskId;
  readonly repositoryRoot: string;
  readonly worktreeRoot: string;
  readonly baseRef: string;
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
    private readonly ids: IdGenerator
  ) {}

  async execute(command: StartTaskWorkflowCommand): Promise<Result<TaskExecutionRecord>> {
    const existing = await this.executions.findActiveByTask(command.taskId);
    if (!existing.ok) return existing;
    if (existing.value) return err(activeExecution(command.taskId));
    const task = await this.tasks.get(command.taskId);
    if (!task.ok) return task;
    if (task.value.status !== "queued") return err(notQueued(command.taskId, task.value.status));

    const preparing = await this.tasks.transition(command.taskId, "preparing");
    if (!preparing.ok) return preparing;
    const executionId = this.ids.next() as TaskExecutionId;
    const workspaceId = this.ids.next() as WorkspaceId;
    const prepared = await this.workspaces.prepare({
      id: workspaceId,
      taskId: command.taskId,
      repositoryRoot: command.repositoryRoot,
      worktreeRoot: command.worktreeRoot,
      branch: workspaceBranch(command.taskId, task.value.title),
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
      version: 0
    };
    const saved = await this.executions.save(execution, -1);
    if (!saved.ok) {
      await this.tasks.transition(command.taskId, "blocked", saved.error.code);
      return saved;
    }

    try {
      const agent = await this.agents.start({
        prompt: command.prompt?.trim() || taskPrompt(task.value.title, task.value.description, task.value.acceptanceCriteria),
        cwd: prepared.value.path,
        model: command.model
      });
      execution = { ...execution, agent, status: "running", updatedAt: this.clock.now(), version: 1 };
      const updated = await this.executions.save(execution, 0);
      if (!updated.ok) {
        await this.agents.interrupt(agent);
        await this.tasks.transition(command.taskId, "blocked", updated.error.code);
        return updated;
      }
      const running = await this.tasks.transition(command.taskId, "running");
      if (!running.ok) {
        await this.agents.interrupt(agent);
        return running;
      }
      return ok(execution);
    } catch (cause) {
      await this.tasks.transition(command.taskId, "blocked", "codex.start-failed");
      return err(startFailed(cause));
    }
  }
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
