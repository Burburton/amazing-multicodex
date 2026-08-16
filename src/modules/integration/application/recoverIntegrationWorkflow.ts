import { AppError, Result, err } from "../../../shared/core/result";
import { TaskId, TaskLifecycleService, TaskProps } from "../../tasks/public";

export type IntegrationRecoveryDecision = "completed" | "retry";

export class RecoverIntegrationWorkflow {
  constructor(private readonly tasks: TaskLifecycleService) {}

  async execute(taskId: TaskId, decision: IntegrationRecoveryDecision): Promise<Result<TaskProps>> {
    const task = await this.tasks.get(taskId);
    if (!task.ok) return task;
    if (task.value.status !== "integrating") return err(notRecoverable(taskId, task.value.status));
    if (decision === "completed") {
      return this.tasks.transition(taskId, "completed", "integration-recovered-confirmed");
    }
    const blocked = await this.tasks.transition(taskId, "blocked", "integration.recovery-requested");
    if (!blocked.ok) return blocked;
    return this.tasks.transition(taskId, "readyForReview");
  }
}

function notRecoverable(taskId: TaskId, status: string): AppError {
  return {
    code: "integration.not-recoverable",
    category: "conflict",
    message: "Only a task left in the integrating state can be recovered.",
    retryable: false,
    context: { taskId, status }
  };
}
