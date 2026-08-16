import { AppError, Result, err, ok } from "../../../shared/core/result";
import { TaskId } from "../../tasks/public";
import { ExecutionRepository, TaskExecutionId, TaskExecutionRecord } from "../ports/executionRepository";

export class InMemoryExecutionRepository implements ExecutionRepository {
  private readonly records = new Map<TaskExecutionId, TaskExecutionRecord>();

  async findById(id: TaskExecutionId): Promise<Result<TaskExecutionRecord | undefined>> {
    return ok(this.records.get(id));
  }

  async findActiveByTask(taskId: TaskId): Promise<Result<TaskExecutionRecord | undefined>> {
    return ok([...this.records.values()].find(record =>
      record.taskId === taskId && ["prepared", "running"].includes(record.status)
    ));
  }

  async save(record: TaskExecutionRecord, expectedVersion: number): Promise<Result<void>> {
    const actual = this.records.get(record.id)?.version ?? -1;
    if (actual !== expectedVersion) return err(conflict(record.id, expectedVersion, actual));
    this.records.set(record.id, { ...record });
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

