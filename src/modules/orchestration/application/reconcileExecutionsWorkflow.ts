import { Clock } from "../../../shared/core/clock";
import { Result, ok } from "../../../shared/core/result";
import { TaskId, TaskLifecycleService } from "../../tasks/public";
import { WorkspacePort } from "../../workspaces/public";
import { ExecutionRepository, TaskExecutionId, TaskExecutionRecord } from "../ports/executionRepository";

export interface ReconciliationReport {
  readonly resumable: readonly TaskId[];
  readonly blocked: readonly TaskId[];
}

export class ReconcileExecutionsWorkflow {
  constructor(
    private readonly executions: ExecutionRepository,
    private readonly tasks: TaskLifecycleService,
    private readonly workspaces: WorkspacePort,
    private readonly clock: Clock
  ) {}

  async execute(): Promise<Result<ReconciliationReport>> {
    const active = await this.executions.listActive();
    if (!active.ok) return active;
    const resumable: TaskId[] = [];
    const blocked: TaskId[] = [];
    for (const execution of active.value) {
      const snapshot = await this.workspaces.inspect(execution.workspace);
      if (execution.status === "running" && snapshot.ok) {
        resumable.push(execution.taskId);
        continue;
      }
      const reason = snapshot.ok ? "recovery.prepared-interrupted" : snapshot.error.code;
      const failed = await this.failExecution(execution);
      if (!failed.ok) return failed;
      const transitioned = await this.tasks.transition(execution.taskId, "blocked", reason);
      if (!transitioned.ok) return transitioned;
      blocked.push(execution.taskId);
    }
    return ok({ resumable, blocked });
  }

  private save(record: TaskExecutionRecord, expectedVersion: number): Promise<Result<void>> {
    return this.executions.save(record, expectedVersion);
  }

  private failExecution(execution: TaskExecutionRecord): Promise<Result<void>> {
    return this.save({
      ...execution,
      status: "failed",
      updatedAt: this.clock.now(),
      version: execution.version + 1
    }, execution.version);
  }
}
