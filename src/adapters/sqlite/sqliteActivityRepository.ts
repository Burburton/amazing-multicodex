import { Result, ok } from "../../shared/core/result";
import { SqliteDatabase } from "../../shared/ports/sqlite";
import { ActivityRecord, ActivityRepository, ActivityDeletionRepository, NewActivityRecord } from "../../modules/activity/public";
import { TaskId } from "../../modules/tasks/public";

interface Row { [key: string]: unknown; id: string; task_id: string; sequence: number; payload_json: string; occurred_at: string; }

export class SqliteActivityRepository implements ActivityRepository, ActivityDeletionRepository {
  constructor(private readonly database: SqliteDatabase) {}
  async append(record: NewActivityRecord): Promise<Result<ActivityRecord>> {
    const sequence = (this.database.query<{ sequence: number }>("SELECT sequence FROM activity WHERE task_id = ? ORDER BY sequence DESC LIMIT 1", [record.taskId])[0]?.sequence ?? 0) + 1;
    const complete: ActivityRecord = { ...record, sequence };
    this.database.run("INSERT INTO activity (id, task_id, sequence, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?)", [complete.id, complete.taskId, sequence, JSON.stringify(complete), complete.occurredAt.toISOString()]);
    return ok(complete);
  }
  async listByTask(taskId: TaskId, limit = 100): Promise<Result<readonly ActivityRecord[]>> {
    const bounded = Math.max(0, Math.min(limit, 500));
    if (!bounded) return ok([]);
    return ok(this.database.query<Row>("SELECT * FROM activity WHERE task_id = ? ORDER BY sequence DESC LIMIT ?", [taskId, bounded]).map(fromRow));
  }
  async deleteByTask(taskId: TaskId): Promise<Result<void>> { this.database.run("DELETE FROM activity WHERE task_id = ?", [taskId]); return ok(undefined); }
}

function fromRow(row: Row): ActivityRecord { const payload = JSON.parse(row.payload_json) as ActivityRecord; return { ...payload, id: row.id as ActivityRecord["id"], taskId: row.task_id as TaskId, sequence: row.sequence, occurredAt: new Date(row.occurred_at) }; }
