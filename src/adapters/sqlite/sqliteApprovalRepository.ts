import { Result, err, ok } from "../../shared/core/result";
import { SqliteDatabase } from "../../shared/ports/sqlite";
import { Approval, ApprovalId, ApprovalProps, ApprovalRepository } from "../../modules/approvals/public";
import { TaskId } from "../../modules/tasks/public";

interface Row { [key: string]: unknown; id: string; task_id: string; status: string; payload_json: string; version: number; created_at: string; decided_at?: string; }

export class SqliteApprovalRepository implements ApprovalRepository {
  constructor(private readonly database: SqliteDatabase) {}
  async findById(id: ApprovalId): Promise<Result<Approval | undefined>> {
    const row = this.database.query<Row>("SELECT * FROM approvals WHERE id = ?", [id])[0];
    return ok(row ? Approval.restore(fromRow(row)) : undefined);
  }
  async listPending(): Promise<Result<readonly Approval[]>> {
    return ok(this.database.query<Row>("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at").map(row => Approval.restore(fromRow(row))));
  }
  async findPendingByTask(taskId: TaskId): Promise<Result<readonly Approval[]>> {
    return ok(this.database.query<Row>("SELECT * FROM approvals WHERE task_id = ? AND status = 'pending' ORDER BY created_at", [taskId]).map(row => Approval.restore(fromRow(row))));
  }
  async save(approval: Approval, expectedVersion: number): Promise<Result<void>> {
    const snapshot = approval.snapshot();
    const actual = this.database.query<{ version: number }>("SELECT version FROM approvals WHERE id = ?", [snapshot.id])[0]?.version ?? -1;
    if (actual !== expectedVersion) return err({ code: "approval.version-conflict", category: "conflict", message: "Approval was changed by another operation.", retryable: true });
    this.database.run("INSERT INTO approvals (id, task_id, status, payload_json, version, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, payload_json=excluded.payload_json, version=excluded.version, decided_at=excluded.decided_at", [snapshot.id, snapshot.taskId, snapshot.status, JSON.stringify(snapshot), snapshot.version, snapshot.createdAt.toISOString(), snapshot.decidedAt?.toISOString() ?? null]);
    return ok(undefined);
  }
  async deleteByTask(taskId: TaskId): Promise<Result<void>> { this.database.run("DELETE FROM approvals WHERE task_id = ?", [taskId]); return ok(undefined); }
}

function fromRow(row: Row): ApprovalProps {
  const payload = JSON.parse(row.payload_json) as ApprovalProps;
  return { ...payload, id: row.id as ApprovalId, taskId: row.task_id as TaskId, status: row.status as ApprovalProps["status"], version: row.version, createdAt: new Date(row.created_at), decidedAt: row.decided_at ? new Date(row.decided_at) : undefined };
}
