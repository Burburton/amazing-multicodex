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
    return ok(toDomainOptional(this.records().find(record => record.id === id)));
  }

  async findActiveByTask(taskId: TaskId): Promise<Result<TaskExecutionRecord | undefined>> {
    return ok(toDomainOptional(this.records().find(record =>
      record.taskId === taskId && ["prepared", "running"].includes(record.status)
    )));
  }

  async findLatestByTask(taskId: TaskId): Promise<Result<TaskExecutionRecord | undefined>> {
    const record = this.records()
      .filter(item => item.taskId === taskId)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
    return ok(toDomainOptional(record));
  }

  async findByAgent(
    threadId: AgentExecutionRef["threadId"],
    turnId: AgentExecutionRef["turnId"]
  ): Promise<Result<TaskExecutionRecord | undefined>> {
    return ok(toDomainOptional(this.records().find(record =>
      record.agent?.threadId === threadId && record.agent.turnId === turnId
    )));
  }

  async save(record: TaskExecutionRecord, expectedVersion: number): Promise<Result<void>> {
    const records = this.records();
    const index = records.findIndex(item => item.id === record.id);
    const actual = index === -1 ? -1 : records[index].version;
    if (actual !== expectedVersion) return err(conflict(record.id, expectedVersion, actual));
    const stored = toStored(record);
    if (index === -1) records.unshift(stored);
    else records[index] = stored;
    try {
      await this.state.update(STORAGE_KEY, records);
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

  private records(): StoredExecution[] {
    return [...this.state.get<StoredExecution[]>(STORAGE_KEY, [])];
  }
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
