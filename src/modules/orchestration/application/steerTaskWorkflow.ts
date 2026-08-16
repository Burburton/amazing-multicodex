import { AppError, Result, err, ok } from "../../../shared/core/result";
import { AgentRuntimePort } from "../../agents/public";
import { TaskId, TaskLifecycleService } from "../../tasks/public";
import { ExecutionRepository } from "../ports/executionRepository";

export interface SteerTaskWorkflowCommand {
  readonly taskId: TaskId;
  readonly prompt: string;
}

export class SteerTaskWorkflow {
  constructor(
    private readonly tasks: TaskLifecycleService,
    private readonly executions: ExecutionRepository,
    private readonly agents: AgentRuntimePort
  ) {}

  async execute(command: SteerTaskWorkflowCommand): Promise<Result<void>> {
    const task = await this.tasks.get(command.taskId);
    if (!task.ok) return task;
    if (task.value.status !== "running") return err(notRunning(command.taskId, task.value.status));
    const prompt = command.prompt.trim();
    if (!prompt || prompt.length > 20_000) return err(invalidPrompt());
    const execution = await this.executions.findActiveByTask(command.taskId);
    if (!execution.ok) return execution;
    if (!execution.value?.agent) return err(notConnected(command.taskId));
    try {
      await this.agents.steer(execution.value.agent, prompt);
      return ok(undefined);
    } catch (cause) {
      return err(steerFailed(cause));
    }
  }
}

function notRunning(taskId: TaskId, status: string): AppError {
  return {
    code: "task.not-running", category: "conflict",
    message: "Follow-up instructions can only be sent to a running task.", retryable: false,
    context: { taskId, status }
  };
}

function invalidPrompt(): AppError {
  return {
    code: "task.follow-up-invalid", category: "validation",
    message: "Follow-up instructions must contain between 1 and 20,000 characters.", retryable: false
  };
}

function notConnected(taskId: TaskId): AppError {
  return {
    code: "execution.not-connected", category: "conflict",
    message: "No connected Codex execution was found for this task.", retryable: true,
    context: { taskId }
  };
}

function steerFailed(cause: unknown): AppError {
  return {
    code: "codex.steer-failed", category: "unavailable",
    message: "Follow-up instructions could not be sent to Codex.", retryable: true, cause
  };
}
