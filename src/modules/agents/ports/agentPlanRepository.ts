import { Result } from "../../../shared/core/result";
import { TaskId } from "../../tasks/public";
import { AgentPlan } from "../domain/agentPlan";

export interface AgentPlanRepository {
  findByTask(taskId: TaskId): Promise<Result<AgentPlan | undefined>>;
  save(plan: AgentPlan): Promise<Result<void>>;
  deleteByTask(taskId: TaskId): Promise<Result<void>>;
}
