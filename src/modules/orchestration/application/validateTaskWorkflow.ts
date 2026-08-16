import { AppError, Result, err } from "../../../shared/core/result";
import { TaskId, TaskLifecycleService } from "../../tasks/public";
import { RunValidationHandler, ValidationProfile, ValidationRun } from "../../validation/public";
import { ExecutionRepository } from "../ports/executionRepository";

export interface ValidateTaskWorkflowCommand {
  readonly taskId: TaskId;
  readonly profile: ValidationProfile;
  readonly signal?: AbortSignal;
}

export class ValidateTaskWorkflow {
  constructor(
    private readonly tasks: TaskLifecycleService,
    private readonly executions: ExecutionRepository,
    private readonly validation: RunValidationHandler
  ) {}

  async execute(command: ValidateTaskWorkflowCommand): Promise<Result<ValidationRun>> {
    const task = await this.tasks.get(command.taskId);
    if (!task.ok) return task;
    if (task.value.status !== "validating") return err(notValidating(command.taskId, task.value.status));
    const execution = await this.executions.findLatestByTask(command.taskId);
    if (!execution.ok) {
      await this.tasks.transition(command.taskId, "blocked", execution.error.code);
      return execution;
    }
    if (!execution.value) {
      const missing = noExecution(command.taskId);
      await this.tasks.transition(command.taskId, "blocked", missing.code);
      return err(missing);
    }
    const run = await this.validation.execute({
      workspace: execution.value.workspace,
      profile: command.profile,
      signal: command.signal
    });
    if (!run.ok) {
      await this.tasks.transition(command.taskId, "failed", run.error.code);
      return run;
    }
    // Cancellation is user intent, not a failed validation. Keep the task in
    // validating so the same worktree can be checked again without rerunning Codex.
    if (run.value.status === "cancelled") return run;
    const next = run.value.status === "passed" ? "readyForReview" : "failed";
    const transitioned = await this.tasks.transition(command.taskId, next, `validation-${run.value.status}`);
    return transitioned.ok ? run : transitioned;
  }
}

function notValidating(taskId: TaskId, status: string): AppError {
  return { code: "task.not-validating", category: "conflict", message: "Task is not waiting for validation.", retryable: false, context: { taskId, status } };
}

function noExecution(taskId: TaskId): AppError {
  return { code: "execution.not-found", category: "validation", message: "No task execution was found for validation.", retryable: false, context: { taskId } };
}
