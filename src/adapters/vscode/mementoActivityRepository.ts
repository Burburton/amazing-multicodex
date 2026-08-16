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
    if (!records.ok) return records;
    const sequence = (records.value.at(-1)?.sequence ?? 0) + 1;
    const complete: ActivityRecord = { ...record, sequence };
    records.value.push({ ...complete, occurredAt: complete.occurredAt.toISOString() });
    if (records.value.length > MAX_RECORDS) records.value.splice(0, records.value.length - MAX_RECORDS);
    try {
      await this.state.update(STORAGE_KEY, records.value);
      return ok(complete);
    } catch (cause) {
      return err(persistenceError(cause));
    }
  }

  async listByTask(taskId: TaskId, limit = 100): Promise<Result<readonly ActivityRecord[]>> {
    const bounded = Math.max(0, Math.min(limit, 500));
    const records = this.records();
    if (!records.ok) return records;
    return ok(records.value
      .filter(record => record.taskId === taskId)
      .slice(-bounded)
      .reverse()
      .map(record => ({ ...record, occurredAt: new Date(record.occurredAt) })));
  }

  private records(): Result<StoredActivity[]> {
    try {
      const stored = this.state.get<unknown>(STORAGE_KEY, []);
      if (!Array.isArray(stored) || !stored.every(isStoredActivity)) return err(corruptState());
      return ok([...stored]);
    } catch (cause) {
      return err(persistenceError(cause));
    }
  }
}

function isStoredActivity(value: unknown): value is StoredActivity {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.taskId === "string"
    && ["agentMessage", "tool", "approval", "validation", "lifecycle", "error"].includes(String(record.kind))
    && typeof record.summary === "string"
    && (record.detail === undefined || typeof record.detail === "string")
    && typeof record.occurredAt === "string" && !Number.isNaN(Date.parse(record.occurredAt))
    && typeof record.sequence === "number" && Number.isInteger(record.sequence) && record.sequence > 0;
}

function corruptState(): AppError {
  return {
    code: "activity.state-invalid", category: "internal",
    message: "Stored activity state is invalid.", retryable: false
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
