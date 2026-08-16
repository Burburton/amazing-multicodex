import { Clock } from "../../../shared/core/clock";
import { AppError, Result, err, ok } from "../../../shared/core/result";
import { AgentRuntimePort } from "../../agents/public";
import { TaskId, TaskLifecycleService } from "../../tasks/public";
import { ExecutionRepository, TaskExecutionRecord } from "../ports/executionRepository";

export class CancelTaskWorkflow {
  constructor(
    private readonly tasks: TaskLifecycleService,
    private readonly agents: AgentRuntimePort,
    private readonly executions: ExecutionRepository,
    private readonly clock: Clock
  ) {}

  async execute(taskId: TaskId): Promise<Result<TaskExecutionRecord>> {
    const active = await this.executions.findActiveByTask(taskId);
    if (!active.ok) return active;
    if (!active.value) return err(noActiveExecution(taskId));
    if (active.value.agent) {
      try {
        await this.agents.interrupt(active.value.agent);
      } catch (cause) {
        return err(interruptFailed(cause));
      }
    }
    const cancelled: TaskExecutionRecord = {
      ...active.value,
      status: "cancelled",
      updatedAt: this.clock.now(),
      version: active.value.version + 1
    };
    const saved = await this.executions.save(cancelled, active.value.version);
    if (!saved.ok) return saved;
    const task = await this.tasks.transition(taskId, "cancelled", "user-requested");
    return task.ok ? ok(cancelled) : task;
  }
}

function noActiveExecution(taskId: TaskId): AppError {
  return { code: "execution.not-active", category: "conflict", message: "Task has no active execution to cancel.", retryable: false, context: { taskId } };
}

function interruptFailed(cause: unknown): AppError {
  return { code: "codex.interrupt-failed", category: "unavailable", message: "Codex execution could not be interrupted.", retryable: true, cause };
}

