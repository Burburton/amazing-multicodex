import { Clock } from "../../../shared/core/clock";
import { AppError, Result, err, ok } from "../../../shared/core/result";
import { TaskId, TaskLifecycleService } from "../../tasks/public";
import { AgentStageHistoryEntry, ExecutionRepository, TaskExecutionRecord } from "../ports/executionRepository";

export class AbandonTaskWorkflow {
  constructor(
    private readonly tasks: TaskLifecycleService,
    private readonly executions: ExecutionRepository,
    private readonly clock: Clock
  ) {}

  async execute(taskId: TaskId): Promise<Result<void>> {
    const task = await this.tasks.get(taskId);
    if (!task.ok) return task;
    if (task.value.status !== "running" && task.value.status !== "awaitingApproval") {
      return err(notAbandonable(taskId, task.value.status));
    }
    const execution = await this.executions.findActiveByTask(taskId);
    if (!execution.ok) return execution;
    if (!execution.value) {
      const latest = await this.executions.findLatestByTask(taskId);
      if (!latest.ok) return latest;
      if (latest.value?.status === "cancelled") {
        const repaired = await this.tasks.transition(taskId, "cancelled", "user-abandoned-recovered");
        return repaired.ok ? ok(undefined) : repaired;
      }
      return err(activeExecutionNotFound(taskId));
    }
    const now = this.clock.now();
    const cancelled: TaskExecutionRecord = {
      ...execution.value,
      status: "cancelled",
      stageHistory: closeCurrentStage(execution.value.stageHistory, now),
      updatedAt: now,
      version: execution.value.version + 1
    };
    const saved = await this.executions.save(cancelled, execution.value.version);
    if (!saved.ok) return saved;
    const transitioned = await this.tasks.transition(taskId, "cancelled", "user-abandoned-offline");
    return transitioned.ok ? ok(undefined) : transitioned;
  }
}

function closeCurrentStage(history: readonly AgentStageHistoryEntry[] | undefined, completedAt: Date): readonly AgentStageHistoryEntry[] | undefined {
  if (!history?.length) return history;
  return history.map((entry, index) => index === history.length - 1 && entry.outcome === "running"
    ? { ...entry, outcome: "cancelled" as const, completedAt } : entry);
}

function notAbandonable(taskId: TaskId, status: string): AppError {
  return {
    code: "task.not-abandonable", category: "conflict",
    message: "Only running tasks can be abandoned while Codex is disconnected.", retryable: false,
    context: { taskId, status }
  };
}

function activeExecutionNotFound(taskId: TaskId): AppError {
  return {
    code: "execution.active-not-found", category: "validation",
    message: "No active execution was found for this task.", retryable: false,
    context: { taskId }
  };
}
