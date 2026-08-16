import { AppError, Result, err, ok } from "../../shared/core/result";
import { KeyValueState } from "../../shared/ports/keyValueState";
import {
  Approval,
  ApprovalId,
  ApprovalProps,
  ApprovalRepository
} from "../../modules/approvals/public";
import { TaskId } from "../../modules/tasks/public";

interface StoredApproval extends Omit<ApprovalProps, "createdAt" | "decidedAt"> {
  readonly createdAt: string;
  readonly decidedAt?: string;
}

const STORAGE_KEY = "amazingMultiCodex.approvals.v1";

export class MementoApprovalRepository implements ApprovalRepository {
  constructor(private readonly state: KeyValueState) {}

  async findById(id: ApprovalId): Promise<Result<Approval | undefined>> {
    const record = this.records().find(item => item.id === id);
    return ok(record ? Approval.restore(toProps(record)) : undefined);
  }

  async findPendingByTask(taskId: TaskId): Promise<Result<readonly Approval[]>> {
    return ok(this.records()
      .filter(item => item.taskId === taskId && item.status === "pending")
      .map(item => Approval.restore(toProps(item))));
  }

  async save(approval: Approval, expectedVersion: number): Promise<Result<void>> {
    const records = this.records();
    const snapshot = approval.snapshot();
    const index = records.findIndex(item => item.id === snapshot.id);
    const actual = index === -1 ? -1 : records[index].version;
    if (actual !== expectedVersion) return err(conflict(snapshot.id, expectedVersion, actual));
    const stored = toStored(snapshot);
    if (index === -1) records.unshift(stored);
    else records[index] = stored;
    try {
      await this.state.update(STORAGE_KEY, records);
      return ok(undefined);
    } catch (cause) {
      return err({ code: "approval.persistence-failed", category: "unavailable", message: "Approval could not be persisted.", retryable: true, cause });
    }
  }

  private records(): StoredApproval[] {
    return [...this.state.get<StoredApproval[]>(STORAGE_KEY, [])];
  }
}

function toStored(props: ApprovalProps): StoredApproval {
  return {
    ...props,
    createdAt: props.createdAt.toISOString(),
    decidedAt: props.decidedAt?.toISOString()
  };
}

function toProps(record: StoredApproval): ApprovalProps {
  return {
    ...record,
    createdAt: new Date(record.createdAt),
    decidedAt: record.decidedAt ? new Date(record.decidedAt) : undefined
  };
}

function conflict(id: ApprovalId, expected: number, actual: number): AppError {
  return { code: "approval.version-conflict", category: "conflict", message: "Approval was changed by another operation.", retryable: true, context: { id, expected: String(expected), actual: String(actual) } };
}

