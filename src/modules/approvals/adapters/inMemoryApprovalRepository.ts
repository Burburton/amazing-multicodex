import { AppError, Result, err, ok } from "../../../shared/core/result";
import { TaskId } from "../../tasks/public";
import { Approval, ApprovalId, ApprovalProps } from "../domain/approval";
import { ApprovalRepository } from "../ports/approvalRepository";

export class InMemoryApprovalRepository implements ApprovalRepository {
  private readonly records = new Map<ApprovalId, ApprovalProps>();

  async findById(id: ApprovalId): Promise<Result<Approval | undefined>> {
    const record = this.records.get(id);
    return ok(record ? Approval.restore(record) : undefined);
  }

  async findPendingByTask(taskId: TaskId): Promise<Result<readonly Approval[]>> {
    return ok([...this.records.values()]
      .filter(record => record.taskId === taskId && record.status === "pending")
      .map(record => Approval.restore(record)));
  }

  async save(approval: Approval, expectedVersion: number): Promise<Result<void>> {
    const snapshot = approval.snapshot();
    const actual = this.records.get(snapshot.id)?.version ?? -1;
    if (actual !== expectedVersion) return err(conflict(snapshot.id, expectedVersion, actual));
    this.records.set(snapshot.id, snapshot);
    return ok(undefined);
  }
}

function conflict(id: ApprovalId, expected: number, actual: number): AppError {
  return {
    code: "approval.version-conflict",
    category: "conflict",
    message: "Approval request was changed by another operation.",
    retryable: true,
    context: { id, expected: String(expected), actual: String(actual) }
  };
}

