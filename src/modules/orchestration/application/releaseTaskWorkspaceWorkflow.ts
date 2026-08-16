import { AppError, Result, err, ok } from "../../../shared/core/result";
import { TaskId, TaskLifecycleService } from "../../tasks/public";
import { WorkspacePort } from "../../workspaces/public";
import { ExecutionRepository } from "../ports/executionRepository";

export class ReleaseTaskWorkspaceWorkflow {
  constructor(
    private readonly tasks: TaskLifecycleService,
    private readonly executions: ExecutionRepository,
    private readonly workspaces: WorkspacePort
  ) {}

  async execute(taskId: TaskId): Promise<Result<void>> {
    const task = await this.tasks.get(taskId);
    if (!task.ok) return task;
    if (task.value.status !== "completed" && task.value.status !== "cancelled") {
      return err(notTerminal(taskId, task.value.status));
    }
    const execution = await this.executions.findLatestByTask(taskId);
    if (!execution.ok) return execution;
    if (!execution.value) return err(executionNotFound(taskId));
    const released = await this.workspaces.release({ workspace: execution.value.workspace, force: false });
    return released.ok ? ok(undefined) : released;
  }
}

function notTerminal(taskId: TaskId, status: string): AppError {
  return {
    code: "workspace.task-not-terminal", category: "conflict",
    message: "Only completed or cancelled task workspaces can be released.", retryable: false,
    context: { taskId, status }
  };
}

function executionNotFound(taskId: TaskId): AppError {
  return {
    code: "workspace.execution-not-found", category: "validation",
    message: "No workspace execution was found for this task.", retryable: false,
    context: { taskId }
  };
}
