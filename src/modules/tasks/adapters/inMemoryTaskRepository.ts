import { AppError, Result, err, ok } from "../../../shared/core/result";
import { Task, TaskId, TaskProps } from "../domain/task";
import { TaskRepository } from "../ports/taskRepository";

export class InMemoryTaskRepository implements TaskRepository {
  private readonly records = new Map<TaskId, TaskProps>();

  async findById(id: TaskId): Promise<Result<Task | undefined>> {
    const record = this.records.get(id);
    return ok(record ? Task.restore(record) : undefined);
  }

  async list(): Promise<Result<readonly Task[]>> {
    return ok([...this.records.values()].map(record => Task.restore(record)));
  }

  async save(task: Task, expectedVersion: number): Promise<Result<void>> {
    const snapshot = task.snapshot();
    const existing = this.records.get(snapshot.id);
    const actualVersion = existing?.version ?? -1;
    if (actualVersion !== expectedVersion) {
      return err(conflict(snapshot.id, expectedVersion, actualVersion));
    }
    this.records.set(snapshot.id, snapshot);
    return ok(undefined);
  }
}

function conflict(id: TaskId, expected: number, actual: number): AppError {
  return {
    code: "task.version-conflict",
    category: "conflict",
    message: "Task was changed by another operation.",
    retryable: true,
    context: { id, expected: String(expected), actual: String(actual) }
  };
}

