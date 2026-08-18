import { Clock } from "../../../shared/core/clock";
import { AppError, Result, err, ok } from "../../../shared/core/result";
import { TaskId, TaskRepository } from "../../tasks/public";
import { AgentPlan, AgentPlanProps, AgentStage } from "../domain/agentPlan";
import { AgentPlanRepository } from "../ports/agentPlanRepository";

export class AgentPlanService {
  constructor(private readonly plans: AgentPlanRepository, private readonly tasks: TaskRepository, private readonly clock: Clock) {}
  async configure(taskId: TaskId, stages: readonly AgentStage[]): Promise<Result<AgentPlanProps>> {
    const task = await this.tasks.findById(taskId);
    if (!task.ok) return task;
    if (!task.value) return err(planError("task.not-found", "Task was not found."));
    if (task.value.snapshot().status !== "draft") return err(planError("agent-plan.locked", "Agent roles can only be configured while the task is a draft."));
    const plan = AgentPlan.create({ taskId, stages, updatedAt: this.clock.now() });
    if (!plan.ok) return plan;
    const saved = await this.plans.save(plan.value);
    return saved.ok ? ok(plan.value.snapshot()) : saved;
  }
  async get(taskId: TaskId): Promise<Result<AgentPlanProps | undefined>> {
    const found = await this.plans.findByTask(taskId);
    return found.ok ? ok(found.value?.snapshot()) : found;
  }
}
function planError(code: string, message: string): AppError { return { code, category: "conflict", message, retryable: false }; }
