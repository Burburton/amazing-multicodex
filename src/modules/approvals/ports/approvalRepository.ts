import { Result } from "../../../shared/core/result";
import { TaskId } from "../../tasks/public";
import { Approval, ApprovalId } from "../domain/approval";

export interface ApprovalRepository {
  findById(id: ApprovalId): Promise<Result<Approval | undefined>>;
  findPendingByTask(taskId: TaskId): Promise<Result<readonly Approval[]>>;
  save(approval: Approval, expectedVersion: number): Promise<Result<void>>;
}

