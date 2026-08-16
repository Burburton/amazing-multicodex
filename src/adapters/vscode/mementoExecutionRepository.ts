import { AppError, Result, err, ok } from "../../shared/core/result";
import { KeyValueState } from "../../shared/ports/keyValueState";
import { AgentExecutionRef } from "../../modules/agents/public";
import {
  ExecutionRepository,
  TaskExecutionId,
  TaskExecutionRecord
} from "../../modules/orchestration/public";
import { TaskId } from "../../modules/tasks/public";
import { WorkspaceRef } from "../../modules/workspaces/public";

interface StoredExecution {
  readonly id: string;
  readonly taskId: string;
  readonly workspace: WorkspaceRef;
  readonly agent?: AgentExecutionRef;
  readonly status: TaskExecutionRecord["status"];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

const STORAGE_KEY = "amazingMultiCodex.executions.v1";

export class MementoExecutionRepository implements ExecutionRepository {
  constructor(private readonly state: KeyValueState) {}

  async findById(id: TaskExecutionId): Promise<Result<TaskExecutionRecord | undefined>> {
    const records = this.records();
    return records.ok ? ok(toDomainOptional(records.value.find(record => record.id === id))) : records;
  }

  async listActive(): Promise<Result<readonly TaskExecutionRecord[]>> {
    const records = this.records();
    if (!records.ok) return records;
    return ok(records.value
      .filter(record => ["prepared", "running"].includes(record.status))
      .map(record => toDomainOptional(record)!));
  }

  async findActiveByTask(taskId: TaskId): Promise<Result<TaskExecutionRecord | undefined>> {
    const records = this.records();
    if (!records.ok) return records;
    return ok(toDomainOptional(records.value.find(record =>
      record.taskId === taskId && ["prepared", "running"].includes(record.status)
    )));
  }

  async findLatestByTask(taskId: TaskId): Promise<Result<TaskExecutionRecord | undefined>> {
    const records = this.records();
    if (!records.ok) return records;
    const record = records.value
      .filter(item => item.taskId === taskId)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
    return ok(toDomainOptional(record));
  }

  async findByAgent(
    threadId: AgentExecutionRef["threadId"],
    turnId: AgentExecutionRef["turnId"]
  ): Promise<Result<TaskExecutionRecord | undefined>> {
    const records = this.records();
    if (!records.ok) return records;
    return ok(toDomainOptional(records.value.find(record =>
      record.agent?.threadId === threadId && record.agent.turnId === turnId
    )));
  }

  async save(record: TaskExecutionRecord, expectedVersion: number): Promise<Result<void>> {
    const records = this.records();
    if (!records.ok) return records;
    const index = records.value.findIndex(item => item.id === record.id);
    const actual = index === -1 ? -1 : records.value[index].version;
    if (actual !== expectedVersion) return err(conflict(record.id, expectedVersion, actual));
    const stored = toStored(record);
    if (index === -1) records.value.unshift(stored);
    else records.value[index] = stored;
    try {
      await this.state.update(STORAGE_KEY, records.value);
      return ok(undefined);
    } catch (cause) {
      return err({
        code: "execution.persistence-failed",
        category: "unavailable",
        message: "Execution state could not be persisted.",
        retryable: true,
        cause
      });
    }
  }

  private records(): Result<StoredExecution[]> {
    try {
      const stored = this.state.get<unknown>(STORAGE_KEY, []);
      if (!Array.isArray(stored) || !stored.every(isStoredExecution)) return err(corruptState());
      return ok([...stored]);
    } catch (cause) {
      return err(persistenceFailure(cause));
    }
  }
}

function isStoredExecution(value: unknown): value is StoredExecution {
  if (!value || typeof value !== "object") return false;
  const execution = value as Record<string, unknown>;
  const workspace = execution.workspace as Record<string, unknown> | undefined;
  return typeof execution.id === "string" && execution.id.length > 0
    && typeof execution.taskId === "string" && execution.taskId.length > 0
    && !!workspace && typeof workspace.path === "string"
    && typeof workspace.repositoryRoot === "string" && typeof workspace.worktreeRoot === "string"
    && typeof workspace.branch === "string" && typeof workspace.baseRef === "string"
    && ["prepared", "running", "completed", "failed", "cancelled"].includes(String(execution.status))
    && typeof execution.createdAt === "string" && !Number.isNaN(Date.parse(execution.createdAt))
    && typeof execution.updatedAt === "string" && !Number.isNaN(Date.parse(execution.updatedAt))
    && typeof execution.version === "number" && Number.isInteger(execution.version) && execution.version >= 0;
}

function toStored(record: TaskExecutionRecord): StoredExecution {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString()
  };
}

function toDomainOptional(record: StoredExecution | undefined): TaskExecutionRecord | undefined {
  return record ? {
    ...record,
    id: record.id as TaskExecutionId,
    taskId: record.taskId as TaskId,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt)
  } : undefined;
}

function conflict(id: TaskExecutionId, expected: number, actual: number): AppError {
  return {
    code: "execution.version-conflict",
    category: "conflict",
    message: "Execution was changed by another operation.",
    retryable: true,
    context: { id, expected: String(expected), actual: String(actual) }
  };
}

function corruptState(): AppError {
  return {
    code: "execution.state-invalid", category: "internal",
    message: "Stored execution state is invalid.", retryable: false
  };
}

function persistenceFailure(cause: unknown): AppError {
  return {
    code: "execution.persistence-failed", category: "unavailable",
    message: "Execution state could not be read.", retryable: true, cause
  };
}
