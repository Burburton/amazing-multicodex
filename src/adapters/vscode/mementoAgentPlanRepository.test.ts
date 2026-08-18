import assert from "node:assert/strict";
import test from "node:test";
import { AgentPlan, agentPlanTemplate } from "../../modules/agents/public";
import { TaskId } from "../../modules/tasks/public";
import { KeyValueState } from "../../shared/ports/keyValueState";
import { MementoAgentPlanRepository } from "./mementoAgentPlanRepository";

class FakeState implements KeyValueState {
  value: unknown = [];
  get<T>(_key: string, fallback: T): T { return (this.value ?? fallback) as T; }
  update(_key: string, value: unknown): Thenable<void> { this.value = value; return Promise.resolve(); }
}

test("upserts and deletes a task agent plan", async () => {
  const repository = new MementoAgentPlanRepository(new FakeState());
  for (const template of ["solo", "full"] as const) {
    const plan = AgentPlan.create({ taskId: "task" as TaskId, stages: agentPlanTemplate(template), updatedAt: new Date(0) });
    assert.equal(plan.ok, true);
    if (plan.ok) assert.equal((await repository.save(plan.value)).ok, true);
  }
  const found = await repository.findByTask("task" as TaskId);
  assert.equal(found.ok, true);
  if (found.ok) assert.equal(found.value?.snapshot().stages.length, 4);
  assert.equal((await repository.deleteByTask("task" as TaskId)).ok, true);
  const deleted = await repository.findByTask("task" as TaskId);
  assert.equal(deleted.ok && deleted.value, undefined);
});
