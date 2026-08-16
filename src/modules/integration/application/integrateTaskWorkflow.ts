import { Result } from "../../../shared/core/result";
import { ExecutionRepository } from "../../orchestration/public";
import { TaskId, TaskLifecycleService } from "../../tasks/public";
import { IntegrationPort, IntegrationResult, IntegrationStrategy } from "../ports/integrationPort";

export interface IntegrateTaskCommand {
  readonly taskId: TaskId;
  readonly targetRepositoryRoot: string;
  readonly strategy: IntegrationStrategy;
  readonly commitMessage: string;
}

export class IntegrateTaskWorkflow {
  constructor(
    private readonly tasks: TaskLifecycleService,
    private readonly executions: ExecutionRepository,
    private readonly integration: IntegrationPort
  ) {}

  async execute(command: IntegrateTaskCommand): Promise<Result<IntegrationResult>> {
    const task = await this.tasks.get(command.taskId);
    if (!task.ok) return task;
    if (task.value.status === "blocked" && task.value.statusReason?.startsWith("integration.")) {
      const restored = await this.tasks.transition(command.taskId, "readyForReview", "integration-retry");
      if (!restored.ok) return restored;
    }
    const transitioning = await this.tasks.transition(command.taskId, "integrating");
    if (!transitioning.ok) return transitioning;
    const execution = await this.executions.findLatestByTask(command.taskId);
    if (!execution.ok || !execution.value) {
      await this.tasks.transition(command.taskId, "blocked", "execution.not-found");
      return execution.ok
        ? { ok: false, error: { code: "execution.not-found", category: "validation", message: "No execution was found to integrate.", retryable: false } }
        : execution;
    }
    const integrated = await this.integration.integrate({
      workspace: execution.value.workspace,
      targetRepositoryRoot: command.targetRepositoryRoot,
      strategy: command.strategy,
      commitMessage: command.commitMessage
    });
    if (!integrated.ok) {
      await this.tasks.transition(command.taskId, "blocked", integrated.error.code);
      return integrated;
    }
    const completed = await this.tasks.transition(command.taskId, "completed");
    return completed.ok ? integrated : completed;
  }
}
