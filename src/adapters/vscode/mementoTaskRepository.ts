import { AppError, Result, err, ok } from "../../shared/core/result";
import { KeyValueState } from "../../shared/ports/keyValueState";
import { Task, TaskId, TaskProps, TaskRepository } from "../../modules/tasks/public";
import { AsyncOperationQueue } from "../../shared/core/asyncOperationQueue";

interface StoredTask extends Omit<TaskProps, "createdAt" | "updatedAt"> {
  readonly createdAt: string;
  readonly updatedAt: string;
}

const STORAGE_KEY = "amazingMultiCodex.tasks.v2";

export class MementoTaskRepository implements TaskRepository {
  private readonly writes = new AsyncOperationQueue();
  constructor(private readonly state: KeyValueState) {}

  async findById(id: TaskId): Promise<Result<Task | undefined>> {
    const records = this.records();
    if (!records.ok) return records;
    const record = records.value.find(task => task.id === id);
    return ok(record ? Task.restore(toProps(record)) : undefined);
  }

  async list(): Promise<Result<readonly Task[]>> {
    const records = this.records();
    return records.ok ? ok(records.value.map(record => Task.restore(toProps(record)))) : records;
  }

  async save(task: Task, expectedVersion: number): Promise<Result<void>> {
    return this.writes.run(() => this.saveOnce(task, expectedVersion));
  }

  private async saveOnce(task: Task, expectedVersion: number): Promise<Result<void>> {
    const records = this.records();
    if (!records.ok) return records;
    const snapshot = task.snapshot();
    const index = records.value.findIndex(record => record.id === snapshot.id);
    const actual = index === -1 ? -1 : records.value[index].version;
    if (actual !== expectedVersion) return err(conflict(snapshot.id, expectedVersion, actual));
    const stored = toStored(snapshot);
    if (index === -1) records.value.unshift(stored);
    else records.value[index] = stored;
    try {
      await this.state.update(STORAGE_KEY, records.value);
      return ok(undefined);
    } catch (cause) {
      return err({
        code: "task.persistence-failed",
        category: "unavailable",
        message: "Task state could not be persisted.",
        retryable: true,
        cause
      });
    }
  }

  private records(): Result<StoredTask[]> {
    try {
      const stored = this.state.get<unknown>(STORAGE_KEY, []);
      if (!Array.isArray(stored) || !stored.every(isStoredTask)) return err(corruptState());
      return ok([...stored]);
    } catch (cause) {
      return err(persistenceFailure(cause));
    }
  }
}

const statuses = new Set([
  "draft", "queued", "preparing", "running", "awaitingApproval", "validating",
  "readyForReview", "integrating", "completed", "blocked", "failed", "cancelled"
]);
const priorities = new Set(["low", "normal", "high", "urgent"]);

function isStoredTask(value: unknown): value is StoredTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Record<string, unknown>;
  return typeof task.id === "string" && task.id.length > 0
    && typeof task.title === "string"
    && (task.description === undefined || typeof task.description === "string")
    && (task.statusReason === undefined || typeof task.statusReason === "string")
    && Array.isArray(task.acceptanceCriteria) && task.acceptanceCriteria.every(item => typeof item === "string")
    && typeof task.priority === "string" && priorities.has(task.priority)
    && typeof task.status === "string" && statuses.has(task.status)
    && typeof task.createdAt === "string" && !Number.isNaN(Date.parse(task.createdAt))
    && typeof task.updatedAt === "string" && !Number.isNaN(Date.parse(task.updatedAt))
    && typeof task.version === "number" && Number.isInteger(task.version) && task.version >= 0;
}

function toStored(props: TaskProps): StoredTask {
  return { ...props, createdAt: props.createdAt.toISOString(), updatedAt: props.updatedAt.toISOString() };
}

function toProps(record: StoredTask): TaskProps {
  return { ...record, createdAt: new Date(record.createdAt), updatedAt: new Date(record.updatedAt) };
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

function corruptState(): AppError {
  return {
    code: "task.state-invalid", category: "internal",
    message: "Stored task state is invalid.", retryable: false
  };
}

function persistenceFailure(cause: unknown): AppError {
  return {
    code: "task.persistence-failed", category: "unavailable",
    message: "Task state could not be read.", retryable: true, cause
  };
}
