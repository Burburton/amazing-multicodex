import { ActivityDeletionRepository } from "../../activity/public";
import { ApprovalDeletionRepository } from "../../approvals/public";
import { AppError, Result, err, ok } from "../../../shared/core/result";
import {
  TaskDeletionRepository, TaskDependencyDeletionRepository, TaskId,
  TaskLifecycleService, TaskRepository, TaskStatus
} from "../../tasks/public";
import { WorkspacePort } from "../../workspaces/public";
import { ExecutionDeletionRepository, ExecutionRepository } from "../ports/executionRepository";

const deletableStatuses = new Set<TaskStatus>([
  "draft", "readyForReview", "completed", "blocked", "failed", "cancelled"
]);

export class DeleteTaskWorkflow {
  constructor(
    private readonly tasks: TaskRepository & TaskDeletionRepository,
    private readonly lifecycle: TaskLifecycleService,
    private readonly dependencies: TaskDependencyDeletionRepository,
    private readonly executions: ExecutionRepository & ExecutionDeletionRepository,
    private readonly approvals: ApprovalDeletionRepository,
    private readonly activity: ActivityDeletionRepository,
    private readonly workspaces: WorkspacePort
  ) {}

  async execute(taskId: TaskId, forceWorkspace = false): Promise<Result<void>> {
    const found = await this.tasks.findById(taskId);
    if (!found.ok) return found;
    if (!found.value) return ok(undefined);
    let task = found.value.snapshot();
    if (task.status !== "deleting") {
      if (!deletableStatuses.has(task.status)) return err(notDeletable(taskId, task.status));
      const claimed = await this.lifecycle.transition(taskId, "deleting", "user-delete");
      if (!claimed.ok) return claimed;
      task = claimed.value;
    }

    const execution = await this.executions.findLatestByTask(taskId);
    if (!execution.ok) return execution;
    if (execution.value) {
      const released = await this.workspaces.release({ workspace: execution.value.workspace, force: forceWorkspace });
      if (!released.ok) return released;
    }

    for (const cleanup of [
      () => this.executions.deleteByTask(taskId),
      () => this.approvals.deleteByTask(taskId),
      () => this.activity.deleteByTask(taskId),
      () => this.dependencies.deleteByTask(taskId)
    ]) {
      const result = await cleanup();
      if (!result.ok) return result;
    }
    const current = await this.tasks.findById(taskId);
    if (!current.ok) return current;
    if (!current.value) return ok(undefined);
    const snapshot = current.value.snapshot();
    if (snapshot.status !== "deleting") return err(notDeletable(taskId, snapshot.status));
    return this.tasks.delete(taskId, snapshot.version);
  }
}

function notDeletable(taskId: TaskId, status: TaskStatus): AppError {
  return {
    code: "task.delete-not-allowed",
    category: "conflict",
    message: "Stop the task before deleting it. Queued, running, approval, validation, and integration work cannot be deleted.",
    retryable: false,
    context: { taskId, status }
  };
}
