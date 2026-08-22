import { Clock } from "../../../shared/core/clock";
import { AppError, Result, err, ok } from "../../../shared/core/result";
import { AgentRuntimePort } from "../../agents/public";
import { TaskId, TaskLifecycleService } from "../../tasks/public";
import { AgentStageHistoryEntry, ExecutionRepository, TaskExecutionRecord } from "../ports/executionRepository";

export class CancelTaskWorkflow {
  constructor(
    private readonly tasks: TaskLifecycleService,
    private readonly agents: AgentRuntimePort,
    private readonly executions: ExecutionRepository,
    private readonly clock: Clock
  ) {}

  async execute(taskId: TaskId): Promise<Result<TaskExecutionRecord>> {
    const task = await this.tasks.get(taskId);
    if (!task.ok) return task;
    if (task.value.status !== "running" && task.value.status !== "awaitingApproval") {
      return err(notCancellable(taskId, task.value.status));
    }
    const active = await this.executions.findActiveByTask(taskId);
    if (!active.ok) return active;
    if (!active.value) {
      const latest = await this.executions.findLatestByTask(taskId);
      if (!latest.ok) return latest;
      if (latest.value?.status === "cancelled") {
        const repaired = await this.tasks.transition(taskId, "cancelled", "user-requested-recovered");
        return repaired.ok ? ok(latest.value) : repaired;
      }
      return err(noActiveExecution(taskId));
    }
    if (active.value.agent) {
      try {
        await this.agents.interrupt(active.value.agent);
      } catch (cause) {
        return err(interruptFailed(cause));
      }
    }
    const now = this.clock.now();
    const cancelled: TaskExecutionRecord = {
      ...active.value,
      status: "cancelled",
      stageHistory: closeCurrentStage(active.value.stageHistory, now),
      updatedAt: now,
      version: active.value.version + 1
    };
    const saved = await this.executions.save(cancelled, active.value.version);
    if (!saved.ok) return saved;
    const transitioned = await this.tasks.transition(taskId, "cancelled", "user-requested");
    return transitioned.ok ? ok(cancelled) : transitioned;
  }
}

function closeCurrentStage(history: readonly AgentStageHistoryEntry[] | undefined, completedAt: Date): readonly AgentStageHistoryEntry[] | undefined {
  if (!history?.length) return history;
  return history.map((entry, index) => index === history.length - 1 && entry.outcome === "running"
    ? { ...entry, outcome: "cancelled" as const, completedAt } : entry);
}

function notCancellable(taskId: TaskId, status: string): AppError {
  return {
    code: "task.not-cancellable",
    category: "conflict",
    message: "Only running tasks can be cancelled.",
    retryable: false,
    context: { taskId, status }
  };
}

function noActiveExecution(taskId: TaskId): AppError {
  return { code: "execution.not-active", category: "conflict", message: "Task has no active execution to cancel.", retryable: false, context: { taskId } };
}

function interruptFailed(cause: unknown): AppError {
  return { code: "codex.interrupt-failed", category: "unavailable", message: "Codex execution could not be interrupted.", retryable: true, cause };
}
