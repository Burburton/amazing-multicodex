import { AppError, Result, err, ok } from "../../shared/core/result";
import { KeyValueState } from "../../shared/ports/keyValueState";
import {
  Approval,
  ApprovalId,
  ApprovalProps,
  ApprovalRepository
} from "../../modules/approvals/public";
import { TaskId } from "../../modules/tasks/public";
import { AsyncOperationQueue } from "../../shared/core/asyncOperationQueue";

interface StoredApproval extends Omit<ApprovalProps, "createdAt" | "decidedAt"> {
  readonly createdAt: string;
  readonly decidedAt?: string;
}

const STORAGE_KEY = "amazingMultiCodex.approvals.v1";
const MAX_RECORDS = 500;

export class MementoApprovalRepository implements ApprovalRepository {
  private readonly writes = new AsyncOperationQueue();
  constructor(private readonly state: KeyValueState) {}

  async findById(id: ApprovalId): Promise<Result<Approval | undefined>> {
    const records = this.records();
    if (!records.ok) return records;
    const record = records.value.find(item => item.id === id);
    return ok(record ? Approval.restore(toProps(record)) : undefined);
  }

  async listPending(): Promise<Result<readonly Approval[]>> {
    const records = this.records();
    if (!records.ok) return records;
    return ok(records.value.filter(item => item.status === "pending").map(item => Approval.restore(toProps(item))));
  }

  async findPendingByTask(taskId: TaskId): Promise<Result<readonly Approval[]>> {
    const records = this.records();
    if (!records.ok) return records;
    return ok(records.value
      .filter(item => item.taskId === taskId && item.status === "pending")
      .map(item => Approval.restore(toProps(item))));
  }

  async save(approval: Approval, expectedVersion: number): Promise<Result<void>> {
    return this.writes.run(() => this.saveOnce(approval, expectedVersion));
  }

  async deleteByTask(taskId: TaskId): Promise<Result<void>> {
    return this.writes.run(async () => {
      const records = this.records();
      if (!records.ok) return records;
      try {
        await this.state.update(STORAGE_KEY, records.value.filter(record => record.taskId !== taskId));
        return ok(undefined);
      } catch (cause) {
        return err({ code: "approval.persistence-failed", category: "unavailable", message: "Approval state could not be deleted.", retryable: true, cause });
      }
    });
  }

  private async saveOnce(approval: Approval, expectedVersion: number): Promise<Result<void>> {
    const records = this.records();
    if (!records.ok) return records;
    const snapshot = approval.snapshot();
    const index = records.value.findIndex(item => item.id === snapshot.id);
    const actual = index === -1 ? -1 : records.value[index].version;
    if (actual !== expectedVersion) return err(conflict(snapshot.id, expectedVersion, actual));
    const stored = toStored(snapshot);
    if (!isStoredApproval(stored)) return err(invalidApproval());
    if (index === -1) records.value.unshift(stored);
    else records.value[index] = stored;
    const bounded = boundRecords(records.value);
    try {
      await this.state.update(STORAGE_KEY, bounded);
      return ok(undefined);
    } catch (cause) {
      return err({ code: "approval.persistence-failed", category: "unavailable", message: "Approval could not be persisted.", retryable: true, cause });
    }
  }

  private records(): Result<StoredApproval[]> {
    try {
      const stored = this.state.get<unknown>(STORAGE_KEY, []);
      if (!Array.isArray(stored) || !stored.every(isStoredApproval) || !hasUniqueIds(stored)) return err(corruptState());
      return ok([...stored]);
    } catch (cause) {
      return err({ code: "approval.persistence-failed", category: "unavailable", message: "Approval state could not be read.", retryable: true, cause });
    }
  }
}

function boundRecords(records: readonly StoredApproval[]): StoredApproval[] {
  if (records.length <= MAX_RECORDS) return [...records];
  const pending = records.filter(record => record.status === "pending");
  const terminalLimit = Math.max(0, MAX_RECORDS - pending.length);
  return [...pending, ...records.filter(record => record.status !== "pending").slice(0, terminalLimit)];
}

function isStoredApproval(value: unknown): value is StoredApproval {
  if (!value || typeof value !== "object") return false;
  const approval = value as Record<string, unknown>;
  return boundedString(approval.id, 1_000) && boundedString(approval.taskId, 1_000)
    && boundedString(approval.runtimeRequestId, 1_000) && boundedString(approval.runtimeMethod, 500)
    && ["read", "write", "execute", "destructive", "external"].includes(String(approval.risk))
    && boundedString(approval.title, 500)
    && (approval.detail === undefined || (typeof approval.detail === "string" && approval.detail.length <= 32_000))
    && (approval.decisionReason === undefined || (typeof approval.decisionReason === "string" && approval.decisionReason.length <= 1_000))
    && ["pending", "approved", "declined", "cancelled"].includes(String(approval.status))
    && typeof approval.createdAt === "string" && !Number.isNaN(Date.parse(approval.createdAt))
    && (approval.decidedAt === undefined || (typeof approval.decidedAt === "string" && !Number.isNaN(Date.parse(approval.decidedAt))))
    && typeof approval.version === "number" && Number.isInteger(approval.version) && approval.version >= 0;
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function hasUniqueIds(records: readonly StoredApproval[]): boolean {
  return new Set(records.map(record => record.id)).size === records.length;
}

function corruptState(): AppError {
  return { code: "approval.state-invalid", category: "internal", message: "Stored approval state is invalid.", retryable: false };
}

function invalidApproval(): AppError {
  return {
    code: "approval.record-invalid", category: "validation",
    message: "Approval fields exceed safe persistence limits.", retryable: false
  };
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
