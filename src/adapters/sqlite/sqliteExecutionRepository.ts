import { Result, err, ok } from "../../shared/core/result";
import { SqliteDatabase } from "../../shared/ports/sqlite";
import { AgentThreadId, AgentTurnId } from "../../modules/agents/public";
import { ExecutionDeletionRepository, ExecutionRepository, TaskExecutionId, TaskExecutionRecord } from "../../modules/orchestration/public";
import { TaskId } from "../../modules/tasks/public";

interface Row { [key: string]: unknown; id: string; task_id: string; status: string; payload_json: string; version: number; created_at: string; updated_at: string; }

export class SqliteExecutionRepository implements ExecutionRepository, ExecutionDeletionRepository {
  constructor(private readonly database: SqliteDatabase) {}
  async findById(id: TaskExecutionId): Promise<Result<TaskExecutionRecord | undefined>> { return ok(this.row("SELECT * FROM executions WHERE id = ?", [id])); }
  async listActive(): Promise<Result<readonly TaskExecutionRecord[]>> { return ok(this.rows("SELECT * FROM executions WHERE status IN ('prepared', 'running') ORDER BY updated_at DESC")); }
  async findActiveByTask(taskId: TaskId): Promise<Result<TaskExecutionRecord | undefined>> { return ok(this.row("SELECT * FROM executions WHERE task_id = ? AND status IN ('prepared', 'running') ORDER BY updated_at DESC LIMIT 1", [taskId])); }
  async findLatestByTask(taskId: TaskId): Promise<Result<TaskExecutionRecord | undefined>> { return ok(this.row("SELECT * FROM executions WHERE task_id = ? ORDER BY updated_at DESC LIMIT 1", [taskId])); }
  async findByAgent(threadId: AgentThreadId, turnId: AgentTurnId): Promise<Result<TaskExecutionRecord | undefined>> {
    const records = this.rows("SELECT * FROM executions ORDER BY updated_at DESC");
    return ok(records.find(record => record.agent?.threadId === threadId && record.agent.turnId === turnId));
  }
  async save(record: TaskExecutionRecord, expectedVersion: number): Promise<Result<void>> {
    const actual = this.database.query<{ version: number }>("SELECT version FROM executions WHERE id = ?", [record.id])[0]?.version ?? -1;
    if (actual !== expectedVersion) return err({ code: "execution.version-conflict", category: "conflict", message: "Execution was changed by another operation.", retryable: true });
    this.database.run("INSERT INTO executions (id, task_id, status, payload_json, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET task_id=excluded.task_id, status=excluded.status, payload_json=excluded.payload_json, version=excluded.version, updated_at=excluded.updated_at", [record.id, record.taskId, record.status, JSON.stringify(record), record.version, record.createdAt.toISOString(), record.updatedAt.toISOString()]);
    return ok(undefined);
  }
  async deleteByTask(taskId: TaskId): Promise<Result<void>> { this.database.run("DELETE FROM executions WHERE task_id = ?", [taskId]); return ok(undefined); }
  private row(sql: string, parameters: readonly unknown[] = []): TaskExecutionRecord | undefined { const row = this.database.query<Row>(sql, parameters)[0]; return row ? fromRow(row) : undefined; }
  private rows(sql: string): TaskExecutionRecord[] { return this.database.query<Row>(sql).map(fromRow); }
}

function fromRow(row: Row): TaskExecutionRecord {
  const record = JSON.parse(row.payload_json) as TaskExecutionRecord;
  return { ...record, id: row.id as TaskExecutionId, taskId: row.task_id as TaskId, status: row.status as TaskExecutionRecord["status"], version: row.version, createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at), stageHistory: record.stageHistory?.map(entry => ({ ...entry, startedAt: new Date(entry.startedAt), completedAt: entry.completedAt ? new Date(entry.completedAt) : undefined })) };
}
