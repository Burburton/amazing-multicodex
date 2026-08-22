import { Clock } from "../../../shared/core/clock";
import { AppError, Result, err, ok } from "../../../shared/core/result";
import { AgentPlanRepository, AgentRuntimePort } from "../../agents/public";
import { TaskId, TaskLifecycleService } from "../../tasks/public";
import { AgentStageHistoryEntry, ExecutionRepository, TaskExecutionRecord } from "../ports/executionRepository";

export class RetryAgentStageWorkflow {
  constructor(private readonly tasks: TaskLifecycleService, private readonly agents: AgentRuntimePort,
    private readonly executions: ExecutionRepository, private readonly plans: AgentPlanRepository, private readonly clock: Clock) {}

  async execute(taskId: TaskId): Promise<Result<TaskExecutionRecord>> {
    const [task, execution, plan] = await Promise.all([this.tasks.get(taskId), this.executions.findLatestByTask(taskId), this.plans.findByTask(taskId)]);
    if (!task.ok) return task;
    if (!execution.ok) return execution;
    if (!plan.ok) return plan;
    const current = execution.value;
    if (task.value.status !== "failed" || current?.status !== "failed" || !current.stage) return err(notRetryable());
    const stage = plan.value?.snapshot().stages[current.stage.index];
    if (!stage) return err(notRetryable());
    for (const status of ["queued", "preparing"] as const) {
      const transitioned = await this.tasks.transition(taskId, status, "agent-stage-retry");
      if (!transitioned.ok) return transitioned;
    }
    let agent;
    try {
      agent = await this.agents.start({ cwd: current.workspace.path, model: current.model,
        prompt: [`Retry the ${stage.role} stage of this multi-agent task pipeline.`, `Stage objective: ${stage.objective}`,
          "Inspect the existing worktree and prior changes. Correct the failure and finish with a concise handoff.",
          stage.role === "reviewer" ? "End your response with exactly one verdict line: VERDICT: APPROVED or VERDICT: CHANGES_REQUESTED." : ""].filter(Boolean).join("\n\n") });
    } catch (cause) {
      await this.tasks.transition(taskId, "failed", "agent-stage-retry-start-failed");
      return err(startFailed(cause));
    }
    const now = this.clock.now();
    const retried: TaskExecutionRecord = { ...current, agent,
      previousAgents: [...(current.previousAgents ?? []), ...(current.agent ? [current.agent] : [])].slice(-8),
      stageHistory: [...closeCurrentStage(current.stageHistory, now), {
        index: current.stage.index, total: current.stage.total, role: current.stage.role,
        agent, startedAt: now, outcome: "running" as const
      }].slice(-32),
      status: "running", updatedAt: this.clock.now(), version: current.version + 1 };
    const saved = await this.executions.save(retried, current.version);
    if (!saved.ok) {
      await this.agents.interrupt(agent);
      await this.tasks.transition(taskId, "failed", "agent-stage-retry-persistence-failed");
      return saved;
    }
    const running = await this.tasks.transition(taskId, "running", "agent-stage-retried");
    if (running.ok) return ok(retried);
    await this.agents.interrupt(agent);
    await this.executions.save({ ...retried, status: "failed", updatedAt: this.clock.now(), version: retried.version + 1 }, retried.version);
    await this.tasks.transition(taskId, "failed", "agent-stage-retry-transition-failed");
    return running;
  }
}

function closeCurrentStage(history: readonly AgentStageHistoryEntry[] | undefined, completedAt: Date): readonly AgentStageHistoryEntry[] {
  if (!history?.length) return [];
  return history.map((entry, index) => index === history.length - 1 && entry.outcome === "running"
    ? { ...entry, outcome: "failed" as const, completedAt } : entry);
}
function notRetryable(): AppError { return { code: "agent-stage.not-retryable", category: "conflict", message: "No failed agent stage is available to retry.", retryable: false }; }
function startFailed(cause: unknown): AppError { return { code: "agent-stage.retry-start-failed", category: "unavailable", message: "The agent stage could not be restarted.", retryable: true, cause }; }
