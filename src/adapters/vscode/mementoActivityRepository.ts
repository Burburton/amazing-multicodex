import { AppError, Result, err, ok } from "../../shared/core/result";
import { KeyValueState } from "../../shared/ports/keyValueState";
import {
  ActivityRecord,
  ActivityRepository,
  NewActivityRecord
} from "../../modules/activity/public";
import { TaskId } from "../../modules/tasks/public";

interface StoredActivity extends Omit<ActivityRecord, "occurredAt"> {
  readonly occurredAt: string;
}

const STORAGE_KEY = "amazingMultiCodex.activity.v1";
const MAX_RECORDS = 2_000;

export class MementoActivityRepository implements ActivityRepository {
  constructor(private readonly state: KeyValueState) {}

  async append(record: NewActivityRecord): Promise<Result<ActivityRecord>> {
    const records = this.records();
    const sequence = (records.at(-1)?.sequence ?? 0) + 1;
    const complete: ActivityRecord = { ...record, sequence };
    records.push({ ...complete, occurredAt: complete.occurredAt.toISOString() });
    if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
    try {
      await this.state.update(STORAGE_KEY, records);
      return ok(complete);
    } catch (cause) {
      return err(persistenceError(cause));
    }
  }

  async listByTask(taskId: TaskId, limit = 100): Promise<Result<readonly ActivityRecord[]>> {
    const bounded = Math.max(0, Math.min(limit, 500));
    return ok(this.records()
      .filter(record => record.taskId === taskId)
      .slice(-bounded)
      .reverse()
      .map(record => ({ ...record, occurredAt: new Date(record.occurredAt) })));
  }

  private records(): StoredActivity[] {
    return [...this.state.get<StoredActivity[]>(STORAGE_KEY, [])];
  }
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

