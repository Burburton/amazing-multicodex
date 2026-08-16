import { Clock } from "../../../shared/core/clock";
import { AppError, Result, err, ok } from "../../../shared/core/result";
import { AgentRuntimePort } from "../../agents/public";
import { TaskId, TaskLifecycleService } from "../../tasks/public";
import { ExecutionRepository, TaskExecutionRecord } from "../ports/executionRepository";

export interface ResumeTaskWorkflowCommand {
  readonly taskId: TaskId;
  readonly prompt?: string;
}

export class ResumeTaskWorkflow {
  constructor(
    private readonly tasks: TaskLifecycleService,
    private readonly agents: AgentRuntimePort,
    private readonly executions: ExecutionRepository,
    private readonly clock: Clock
  ) {}

  async execute(command: ResumeTaskWorkflowCommand): Promise<Result<TaskExecutionRecord>> {
    const task = await this.tasks.get(command.taskId);
    if (!task.ok) return task;
    if (task.value.status !== "running") return err(notRunning(command.taskId, task.value.status));
    const active = await this.executions.findActiveByTask(command.taskId);
    if (!active.ok) return active;
    if (!active.value?.agent) return err(noResumableExecution(command.taskId));
    try {
      const agent = await this.agents.resume({
        threadId: active.value.agent.threadId,
        prompt: command.prompt?.trim() || "Continue the task from the existing context and finish the requested work.",
        cwd: active.value.workspace.path
      });
      const updated: TaskExecutionRecord = {
        ...active.value,
        agent,
        status: "running",
        updatedAt: this.clock.now(),
        version: active.value.version + 1
      };
      const saved = await this.executions.save(updated, active.value.version);
      return saved.ok ? ok(updated) : saved;
    } catch (cause) {
      return err(resumeFailed(cause));
    }
  }
}

function notRunning(taskId: TaskId, status: string): AppError {
  return { code: "task.not-running", category: "conflict", message: "Only running tasks can be resumed.", retryable: false, context: { taskId, status } };
}

function noResumableExecution(taskId: TaskId): AppError {
  return { code: "execution.not-resumable", category: "conflict", message: "No resumable Codex execution was found.", retryable: false, context: { taskId } };
}

function resumeFailed(cause: unknown): AppError {
  return { code: "codex.resume-failed", category: "unavailable", message: "Codex execution could not be resumed.", retryable: true, cause };
}

