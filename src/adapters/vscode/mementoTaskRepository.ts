import { AppError, Result, err, ok } from "../../shared/core/result";
import { Task, TaskId, TaskProps, TaskRepository } from "../../modules/tasks/public";

export interface KeyValueState {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

interface StoredTask extends Omit<TaskProps, "createdAt" | "updatedAt"> {
  readonly createdAt: string;
  readonly updatedAt: string;
}

const STORAGE_KEY = "amazingMultiCodex.tasks.v2";

export class MementoTaskRepository implements TaskRepository {
  constructor(private readonly state: KeyValueState) {}

  async findById(id: TaskId): Promise<Result<Task | undefined>> {
    const record = this.records().find(task => task.id === id);
    return ok(record ? Task.restore(toProps(record)) : undefined);
  }

  async list(): Promise<Result<readonly Task[]>> {
    return ok(this.records().map(record => Task.restore(toProps(record))));
  }

  async save(task: Task, expectedVersion: number): Promise<Result<void>> {
    const records = this.records();
    const snapshot = task.snapshot();
    const index = records.findIndex(record => record.id === snapshot.id);
    const actual = index === -1 ? -1 : records[index].version;
    if (actual !== expectedVersion) return err(conflict(snapshot.id, expectedVersion, actual));
    const stored = toStored(snapshot);
    if (index === -1) records.unshift(stored);
    else records[index] = stored;
    try {
      await this.state.update(STORAGE_KEY, records);
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

  private records(): StoredTask[] {
    return [...this.state.get<StoredTask[]>(STORAGE_KEY, [])];
  }
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

