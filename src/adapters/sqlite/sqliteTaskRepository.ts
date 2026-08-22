import { Result, err, ok } from "../../shared/core/result";
import { SqliteDatabase } from "../../shared/ports/sqlite";
import { Task, TaskDeletionRepository, TaskId, TaskProps, TaskRepository } from "../../modules/tasks/public";

interface Row { [key: string]: unknown; id: string; project_id?: string; title: string; status: string; priority: string; payload_json: string; version: number; created_at: string; updated_at: string; }

export class SqliteTaskRepository implements TaskRepository, TaskDeletionRepository {
  constructor(private readonly database: SqliteDatabase) {}

  async findById(id: TaskId): Promise<Result<Task | undefined>> {
    const row = this.database.query<Row>("SELECT * FROM tasks WHERE id = ?", [id])[0];
    return ok(row ? Task.restore(fromRow(row)) : undefined);
  }
  async list(): Promise<Result<readonly Task[]>> {
    return ok(this.database.query<Row>("SELECT * FROM tasks ORDER BY updated_at DESC").map(row => Task.restore(fromRow(row))));
  }
  async save(task: Task, expectedVersion: number): Promise<Result<void>> {
    const snapshot = task.snapshot();
    const actual = this.database.query<{ version: number }>("SELECT version FROM tasks WHERE id = ?", [snapshot.id])[0]?.version ?? -1;
    if (actual !== expectedVersion) return err({ code: "task.version-conflict", category: "conflict", message: "Task was changed by another operation.", retryable: true, context: { id: snapshot.id, expected: String(expectedVersion), actual: String(actual) } });
    this.database.run("INSERT INTO tasks (id, project_id, title, status, priority, payload_json, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, title=excluded.title, status=excluded.status, priority=excluded.priority, payload_json=excluded.payload_json, version=excluded.version, updated_at=excluded.updated_at", [snapshot.id, snapshot.projectId ?? null, snapshot.title, snapshot.status, snapshot.priority, JSON.stringify({ description: snapshot.description, acceptanceCriteria: snapshot.acceptanceCriteria, statusReason: snapshot.statusReason }), snapshot.version, snapshot.createdAt.toISOString(), snapshot.updatedAt.toISOString()]);
    return ok(undefined);
  }
  async delete(id: TaskId, expectedVersion: number): Promise<Result<void>> {
    const actual = this.database.query<{ version: number }>("SELECT version FROM tasks WHERE id = ?", [id])[0]?.version ?? -1;
    if (actual !== expectedVersion) return err({ code: "task.version-conflict", category: "conflict", message: "Task was changed by another operation.", retryable: true, context: { id, expected: String(expectedVersion), actual: String(actual) } });
    this.database.run("DELETE FROM tasks WHERE id = ?", [id]);
    return ok(undefined);
  }
}

function fromRow(row: Row): TaskProps {
  const payload = JSON.parse(row.payload_json) as { description?: string; acceptanceCriteria?: readonly string[]; statusReason?: string };
  return { id: row.id as TaskId, projectId: row.project_id as TaskProps["projectId"], title: row.title, description: payload.description, acceptanceCriteria: payload.acceptanceCriteria ?? [], priority: row.priority as TaskProps["priority"], status: row.status as TaskProps["status"], statusReason: payload.statusReason, version: row.version, createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at) };
}
