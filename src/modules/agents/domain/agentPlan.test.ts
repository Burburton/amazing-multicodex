import assert from "node:assert/strict";
import test from "node:test";
import { TaskId } from "../../tasks/public";
import { AgentPlan, agentPlanTemplate } from "./agentPlan";

test("creates a bounded ordered full agent pipeline", () => {
  const plan = AgentPlan.create({ taskId: "task" as TaskId, stages: agentPlanTemplate("full"), updatedAt: new Date(0) });
  assert.equal(plan.ok, true);
  if (plan.ok) assert.deepEqual(plan.value.snapshot().stages.map(stage => stage.role), ["planner", "implementer", "reviewer", "tester"]);
});

test("requires an implementer and unique roles", () => {
  const missing = AgentPlan.create({ taskId: "task" as TaskId, stages: [{ role: "reviewer", objective: "Review" }], updatedAt: new Date(0) });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, "agent-plan.implementer-required");
  const duplicate = AgentPlan.create({ taskId: "task" as TaskId, stages: [{ role: "implementer", objective: "One" }, { role: "implementer", objective: "Two" }], updatedAt: new Date(0) });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.error.code, "agent-plan.role-duplicate");
});
