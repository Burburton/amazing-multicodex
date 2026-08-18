import { Brand } from "../../../shared/core/brand";
import { Result } from "../../../shared/core/result";
import { AgentExecutionRef, AgentRole, AgentThreadId, AgentTurnId } from "../../agents/public";
import { TaskId } from "../../tasks/public";
import { WorkspaceRef } from "../../workspaces/public";

export type TaskExecutionId = Brand<string, "TaskExecutionId">;
export type TaskExecutionStatus = "prepared" | "running" | "completed" | "failed" | "cancelled";

export interface TaskExecutionRecord {
  readonly id: TaskExecutionId;
  readonly taskId: TaskId;
  readonly workspace: WorkspaceRef;
  readonly agent?: AgentExecutionRef;
  readonly previousAgents?: readonly AgentExecutionRef[];
  readonly stage?: { readonly index: number; readonly total: number; readonly role: AgentRole };
  readonly model?: string;
  readonly status: TaskExecutionStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

export interface ExecutionRepository {
  findById(id: TaskExecutionId): Promise<Result<TaskExecutionRecord | undefined>>;
  listActive(): Promise<Result<readonly TaskExecutionRecord[]>>;
  findActiveByTask(taskId: TaskId): Promise<Result<TaskExecutionRecord | undefined>>;
  findLatestByTask(taskId: TaskId): Promise<Result<TaskExecutionRecord | undefined>>;
  findByAgent(threadId: AgentThreadId, turnId: AgentTurnId): Promise<Result<TaskExecutionRecord | undefined>>;
  save(record: TaskExecutionRecord, expectedVersion: number): Promise<Result<void>>;
}

export interface ExecutionDeletionRepository {
  deleteByTask(taskId: TaskId): Promise<Result<void>>;
}
