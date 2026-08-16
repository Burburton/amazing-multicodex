import { AppError, Result, err, ok } from "../../shared/core/result";
import { KeyValueState } from "../../shared/ports/keyValueState";
import {
  ActivityRecord,
  ActivityRepository,
  NewActivityRecord
} from "../../modules/activity/public";
import { TaskId } from "../../modules/tasks/public";
import { AsyncOperationQueue } from "../../shared/core/asyncOperationQueue";

interface StoredActivity extends Omit<ActivityRecord, "occurredAt"> {
  readonly occurredAt: string;
}

const STORAGE_KEY = "amazingMultiCodex.activity.v1";
const MAX_RECORDS = 2_000;
const MAX_TOTAL_CHARACTERS = 2_000_000;

export class MementoActivityRepository implements ActivityRepository {
  private readonly writes = new AsyncOperationQueue();
  constructor(private readonly state: KeyValueState) {}

  async append(record: NewActivityRecord): Promise<Result<ActivityRecord>> {
    return this.writes.run(() => this.appendOnce(record));
  }

  private async appendOnce(record: NewActivityRecord): Promise<Result<ActivityRecord>> {
    const records = this.records();
    if (!records.ok) return records;
    const sequence = (records.value.at(-1)?.sequence ?? 0) + 1;
    const complete: ActivityRecord = { ...record, sequence };
    const stored = { ...complete, occurredAt: complete.occurredAt.toISOString() };
    if (!isStoredActivity(stored)) return err(invalidActivity());
    records.value.push(stored);
    if (records.value.length > MAX_RECORDS) records.value.splice(0, records.value.length - MAX_RECORDS);
    let characters = records.value.reduce((total, item) => total + item.summary.length + (item.detail?.length ?? 0), 0);
    while (characters > MAX_TOTAL_CHARACTERS && records.value.length > 1) {
      const removed = records.value.shift();
      if (removed) characters -= removed.summary.length + (removed.detail?.length ?? 0);
    }
    try {
      await this.state.update(STORAGE_KEY, records.value);
      return ok(complete);
    } catch (cause) {
      return err(persistenceError(cause));
    }
  }

  async listByTask(taskId: TaskId, limit = 100): Promise<Result<readonly ActivityRecord[]>> {
    const bounded = Math.max(0, Math.min(limit, 500));
    if (bounded === 0) return ok([]);
    const records = this.records();
    if (!records.ok) return records;
    return ok(records.value
      .filter(record => record.taskId === taskId)
      .slice(-bounded)
      .reverse()
      .map(record => ({ ...record, occurredAt: new Date(record.occurredAt) })));
  }

  async deleteByTask(taskId: TaskId): Promise<Result<void>> {
    return this.writes.run(async () => {
      const records = this.records();
      if (!records.ok) return records;
      try {
        await this.state.update(STORAGE_KEY, records.value.filter(record => record.taskId !== taskId));
        return ok(undefined);
      } catch (cause) {
        return err(persistenceError(cause));
      }
    });
  }

  private records(): Result<StoredActivity[]> {
    try {
      const stored = this.state.get<unknown>(STORAGE_KEY, []);
      if (!Array.isArray(stored) || !stored.every(isStoredActivity) || !hasUniqueIds(stored)) return err(corruptState());
      return ok([...stored]);
    } catch (cause) {
      return err(persistenceError(cause));
    }
  }
}

function isStoredActivity(value: unknown): value is StoredActivity {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && record.id.length > 0 && record.id.length <= 1_000
    && typeof record.taskId === "string" && record.taskId.length > 0 && record.taskId.length <= 1_000
    && ["agentMessage", "tool", "approval", "validation", "lifecycle", "error"].includes(String(record.kind))
    && typeof record.summary === "string" && record.summary.length <= 500
    && (record.detail === undefined || (typeof record.detail === "string" && record.detail.length <= 200_000))
    && typeof record.occurredAt === "string" && !Number.isNaN(Date.parse(record.occurredAt))
    && typeof record.sequence === "number" && Number.isInteger(record.sequence) && record.sequence > 0;
}

function hasUniqueIds(records: readonly StoredActivity[]): boolean {
  return new Set(records.map(record => record.id)).size === records.length;
}

function corruptState(): AppError {
  return {
    code: "activity.state-invalid", category: "internal",
    message: "Stored activity state is invalid.", retryable: false
  };
}

function invalidActivity(): AppError {
  return {
    code: "activity.record-invalid", category: "validation",
    message: "Activity fields exceed safe persistence limits.", retryable: false
  };
}

function persistenceError(cause: unknown): AppError {
  return {
    code: "activity.persistence-failed",
    category: "unavailable",
    message: "Activity could not be persisted.",
    retryable: true,
    cause
  };
}
