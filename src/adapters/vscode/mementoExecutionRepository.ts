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
import { AsyncOperationQueue } from "../../shared/core/asyncOperationQueue";

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
const MAX_RETAINED_EXECUTIONS = 1_000;
const MAX_PERSISTED_EXECUTIONS = 10_000;

export class MementoExecutionRepository implements ExecutionRepository {
  private readonly writes = new AsyncOperationQueue();
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
    return this.writes.run(() => this.saveOnce(record, expectedVersion));
  }

  private async saveOnce(record: TaskExecutionRecord, expectedVersion: number): Promise<Result<void>> {
    const records = this.records();
    if (!records.ok) return records;
    const index = records.value.findIndex(item => item.id === record.id);
    const actual = index === -1 ? -1 : records.value[index].version;
    if (actual !== expectedVersion) return err(conflict(record.id, expectedVersion, actual));
    const stored = toStored(record);
    if (!isStoredExecution(stored)) return err(invalidExecution());
    if (index === -1) records.value.unshift(stored);
    else records.value[index] = stored;
    if (!hasConsistentAssociations(records.value)) return err(invalidExecution());
    const compacted = compactExecutionHistory(records.value);
    try {
      await this.state.update(STORAGE_KEY, compacted);
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
      if (!Array.isArray(stored) || stored.length > MAX_PERSISTED_EXECUTIONS || !stored.every(isStoredExecution)
        || !hasUniqueIds(stored) || !hasConsistentAssociations(stored)) return err(corruptState());
      return ok([...stored]);
    } catch (cause) {
      return err(persistenceFailure(cause));
    }
  }
}

function compactExecutionHistory(records: readonly StoredExecution[]): StoredExecution[] {
  if (records.length <= MAX_RETAINED_EXECUTIONS) return [...records];
  const newestFirst = [...records].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const retained = new Map<string, StoredExecution>();
  const tasksWithHistory = new Set<string>();
  for (const record of newestFirst) {
    if (["prepared", "running"].includes(record.status) || !tasksWithHistory.has(record.taskId)) {
      retained.set(record.id, record);
      tasksWithHistory.add(record.taskId);
    }
  }
  for (const record of newestFirst) {
    if (retained.size >= MAX_RETAINED_EXECUTIONS) break;
    retained.set(record.id, record);
  }
  return [...retained.values()].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

function isStoredExecution(value: unknown): value is StoredExecution {
  if (!value || typeof value !== "object") return false;
  const execution = value as Record<string, unknown>;
  const workspace = execution.workspace as Record<string, unknown> | undefined;
  const agent = execution.agent as Record<string, unknown> | undefined;
  return boundedString(execution.id, 1_000)
    && boundedString(execution.taskId, 1_000)
    && !!workspace && boundedString(workspace.id, 1_000)
    && typeof workspace.taskId === "string" && workspace.taskId === execution.taskId
    && boundedString(workspace.path, 32_000)
    && boundedString(workspace.repositoryRoot, 32_000) && boundedString(workspace.worktreeRoot, 32_000)
    && boundedString(workspace.branch, 4_096) && boundedString(workspace.baseRef, 4_096)
    && (agent === undefined || (
      boundedString(agent.executionId, 4_096) && boundedString(agent.threadId, 4_096) && boundedString(agent.turnId, 4_096)
    ))
    && ["prepared", "running", "completed", "failed", "cancelled"].includes(String(execution.status))
    && typeof execution.createdAt === "string" && !Number.isNaN(Date.parse(execution.createdAt))
    && typeof execution.updatedAt === "string" && !Number.isNaN(Date.parse(execution.updatedAt))
    && typeof execution.version === "number" && Number.isInteger(execution.version) && execution.version >= 0;
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function hasUniqueIds(records: readonly StoredExecution[]): boolean {
  return new Set(records.map(record => record.id)).size === records.length;
}

function hasConsistentAssociations(records: readonly StoredExecution[]): boolean {
  const activeTasks = new Set<string>();
  const agentTurns = new Set<string>();
  for (const record of records) {
    if (["prepared", "running"].includes(record.status)) {
      if (activeTasks.has(record.taskId)) return false;
      activeTasks.add(record.taskId);
    }
    if (record.agent) {
      const key = `${record.agent.threadId}\0${record.agent.turnId}`;
      if (agentTurns.has(key)) return false;
      agentTurns.add(key);
    }
  }
  return true;
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

function invalidExecution(): AppError {
  return {
    code: "execution.record-invalid", category: "validation",
    message: "Execution fields exceed safe persistence limits.", retryable: false
  };
}

function persistenceFailure(cause: unknown): AppError {
  return {
    code: "execution.persistence-failed", category: "unavailable",
    message: "Execution state could not be read.", retryable: true, cause
  };
}
