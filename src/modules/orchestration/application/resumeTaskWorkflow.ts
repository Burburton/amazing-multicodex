import { Clock } from "../../../shared/core/clock";
import { AppError, Result, err, ok } from "../../../shared/core/result";
import { AgentExecutionRef, AgentRuntimePort } from "../../agents/public";
import { TaskId, TaskLifecycleService } from "../../tasks/public";
import { AgentStageHistoryEntry, ExecutionRepository, TaskExecutionRecord } from "../ports/executionRepository";
import { pendingStagePrompt } from "./agentStagePrompt";

export interface ResumeTaskWorkflowCommand {
  readonly taskId: TaskId;
  readonly prompt?: string;
}

export class ResumeTaskWorkflow {
  constructor(
    private readonly tasks: TaskLifecycleService,
    private readonly agents: AgentRuntimePort,
    private readonly executions: ExecutionRepository,
    private readonly clock: Clock
  ) {}

  async execute(command: ResumeTaskWorkflowCommand): Promise<Result<TaskExecutionRecord>> {
    const task = await this.tasks.get(command.taskId);
    if (!task.ok) return task;
    if (task.value.status !== "running") return err(notRunning(command.taskId, task.value.status));
    const active = await this.executions.findActiveByTask(command.taskId);
    if (!active.ok) return active;
    if (!active.value) return err(noResumableExecution(command.taskId));
    const execution = active.value;
    if (!execution.pendingStage && !execution.agent) return err(noResumableExecution(command.taskId));
    try {
      const pendingStage = execution.pendingStage;
      const agent = pendingStage
        ? await this.agents.start({
            prompt: [pendingStagePrompt(pendingStage), command.prompt?.trim()].filter(Boolean).join("\n\nAdditional recovery instruction:\n"),
            cwd: execution.workspace.path,
            model: execution.model
          })
        : await this.agents.resume({
            threadId: execution.agent!.threadId,
            prompt: command.prompt?.trim() || "Continue the task from the existing context and finish the requested work.",
            cwd: execution.workspace.path
          });
      const { pendingStage: _recoveredCheckpoint, ...executionBase } = execution;
      const now = this.clock.now();
      const updated: TaskExecutionRecord = {
        ...executionBase,
        agent,
        previousAgents: pendingStage
          ? [...(execution.previousAgents ?? []), ...(execution.agent ? [execution.agent] : [])].slice(-8)
          : execution.previousAgents,
        stage: pendingStage
          ? { index: pendingStage.index, total: execution.stage?.total ?? pendingStage.index + 1, role: pendingStage.role }
          : execution.stage,
        stageHistory: pendingStage
          ? [...closeCurrentStage(execution.stageHistory, now), {
              index: pendingStage.index, total: execution.stage?.total ?? pendingStage.index + 1,
              role: pendingStage.role, agent, startedAt: now, outcome: "running" as const
            }].slice(-32)
          : refreshCurrentStage(execution.stageHistory, agent),
        reviewCycles: pendingStage?.reason === "reviewReturn"
          ? (execution.reviewCycles ?? 0) + 1
          : execution.reviewCycles,
        status: "running",
        updatedAt: this.clock.now(),
        version: execution.version + 1
      };
      const saved = await this.executions.save(updated, execution.version);
      if (saved.ok) return ok(updated);
      try {
        await this.agents.interrupt(agent);
        return saved;
      } catch (cause) {
        const compensation = resumeCompensationFailed(saved.error, cause);
        await this.tasks.transition(command.taskId, "blocked", compensation.code);
        return err(compensation);
      }
    } catch (cause) {
      return err(resumeFailed(cause));
    }
  }
}

function closeCurrentStage(history: readonly AgentStageHistoryEntry[] | undefined, completedAt: Date): readonly AgentStageHistoryEntry[] {
  if (!history?.length) return [];
  return history.map((entry, index) => index === history.length - 1 && entry.outcome === "running"
    ? { ...entry, outcome: "completed" as const, completedAt } : entry);
}

function refreshCurrentStage(history: readonly AgentStageHistoryEntry[] | undefined, agent: AgentExecutionRef): readonly AgentStageHistoryEntry[] | undefined {
  if (!history?.length) return history;
  return history.map((entry, index) => index === history.length - 1 ? { ...entry, agent, outcome: "running" as const, completedAt: undefined } : entry);
}

function notRunning(taskId: TaskId, status: string): AppError {
  return { code: "task.not-running", category: "conflict", message: "Only running tasks can be resumed.", retryable: false, context: { taskId, status } };
}

function noResumableExecution(taskId: TaskId): AppError {
  return { code: "execution.not-resumable", category: "conflict", message: "No resumable Codex execution was found.", retryable: false, context: { taskId } };
}

function resumeFailed(cause: unknown): AppError {
  return { code: "codex.resume-failed", category: "unavailable", message: "Codex execution could not be resumed.", retryable: true, cause };
}

function resumeCompensationFailed(persistenceFailure: AppError, cause: unknown): AppError {
  return {
    code: "execution.resume-compensation-failed",
    category: "unavailable",
    message: "The resumed Codex turn could not be persisted or interrupted. Reload the window before retrying.",
    retryable: false,
    cause: { persistenceFailure, interruptFailure: cause }
  };
}
