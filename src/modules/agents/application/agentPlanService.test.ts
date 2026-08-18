import assert from "node:assert/strict";
import test from "node:test";
import { TaskId } from "../../tasks/public";
import { InMemoryTaskRepository } from "../../tasks/adapters/inMemoryTaskRepository";
import { Task } from "../../tasks/public";
import { AgentPlan, agentPlanTemplate } from "../domain/agentPlan";
import { AgentPlanRepository } from "../ports/agentPlanRepository";
import { AgentPlanService } from "./agentPlanService";
import { Result, ok } from "../../../shared/core/result";

class Plans implements AgentPlanRepository {
  plan?: AgentPlan;
  async findByTask(): Promise<Result<AgentPlan | undefined>> { return ok(this.plan); }
  async save(plan: AgentPlan): Promise<Result<void>> { this.plan = plan; return ok(undefined); }
  async deleteByTask(): Promise<Result<void>> { this.plan = undefined; return ok(undefined); }
}

test("configures plans only for draft tasks", async () => {
  const tasks = new InMemoryTaskRepository();
  const task = Task.create({ id: "task" as TaskId, title: "Build", now: new Date(0) });
  assert.equal(task.ok, true);
  if (!task.ok) return;
  await tasks.save(task.value, -1);
  const service = new AgentPlanService(new Plans(), tasks, { now: () => new Date(1) });
  assert.equal((await service.configure("task" as TaskId, agentPlanTemplate("full"))).ok, true);
  task.value.transition("queued", new Date(2));
  await tasks.save(task.value, 0);
  const locked = await service.configure("task" as TaskId, agentPlanTemplate("solo"));
  assert.equal(locked.ok, false);
  if (!locked.ok) assert.equal(locked.error.code, "agent-plan.locked");
});
