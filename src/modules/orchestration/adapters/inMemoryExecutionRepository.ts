import { AppError, Result, err, ok } from "../../../shared/core/result";
import { AgentThreadId, AgentTurnId } from "../../agents/public";
import { TaskId } from "../../tasks/public";
import { ExecutionRepository, TaskExecutionId, TaskExecutionRecord } from "../ports/executionRepository";

export class InMemoryExecutionRepository implements ExecutionRepository {
  private readonly records = new Map<TaskExecutionId, TaskExecutionRecord>();

  async findById(id: TaskExecutionId): Promise<Result<TaskExecutionRecord | undefined>> {
    return ok(this.records.get(id));
  }

  async listActive(): Promise<Result<readonly TaskExecutionRecord[]>> {
    return ok([...this.records.values()].filter(record => ["prepared", "running"].includes(record.status)));
  }

  async findActiveByTask(taskId: TaskId): Promise<Result<TaskExecutionRecord | undefined>> {
    return ok([...this.records.values()].find(record =>
      record.taskId === taskId && ["prepared", "running"].includes(record.status)
    ));
  }

  async findLatestByTask(taskId: TaskId): Promise<Result<TaskExecutionRecord | undefined>> {
    return ok([...this.records.values()]
      .filter(record => record.taskId === taskId)
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())[0]);
  }

  async findByAgent(threadId: AgentThreadId, turnId: AgentTurnId): Promise<Result<TaskExecutionRecord | undefined>> {
    return ok([...this.records.values()].find(record =>
      (record.agent?.threadId === threadId && record.agent.turnId === turnId)
      || record.previousAgents?.some(agent => agent.threadId === threadId && agent.turnId === turnId)
    ));
  }

  async save(record: TaskExecutionRecord, expectedVersion: number): Promise<Result<void>> {
    const actual = this.records.get(record.id)?.version ?? -1;
    if (actual !== expectedVersion) return err(conflict(record.id, expectedVersion, actual));
    this.records.set(record.id, { ...record });
    return ok(undefined);
  }

  async deleteByTask(taskId: TaskId): Promise<Result<void>> {
    for (const [id, record] of this.records) if (record.taskId === taskId) this.records.delete(id);
    return ok(undefined);
  }
}

function conflict(id: TaskExecutionId, expected: number, actual: number): AppError {
  return {
    code: "execution.version-conflict",
    category: "conflict",
    message: "Execution was changed by another operation.",
    retryable: true,
    context: { id, expected: String(expected), actual: String(actual) }
  };
}
