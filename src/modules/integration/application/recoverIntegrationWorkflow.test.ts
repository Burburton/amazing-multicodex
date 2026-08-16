import assert from "node:assert/strict";
import test from "node:test";
import { Clock } from "../../../shared/core/clock";
import { InMemoryTaskRepository } from "../../tasks/adapters/inMemoryTaskRepository";
import { Task, TaskId, TaskLifecycleService } from "../../tasks/public";
import { RecoverIntegrationWorkflow } from "./recoverIntegrationWorkflow";

class FixedClock implements Clock { now(): Date { return new Date("2026-08-16T12:00:00Z"); } }

test("confirms an interrupted integration after the user verifies Git", async () => {
  const { tasks, workflow, id } = await setup();
  const result = await workflow.execute(id, "completed");
  assert.equal(result.ok && result.value.status, "completed");
  const found = await tasks.findById(id);
  assert.equal(found.ok && found.value?.snapshot().statusReason, "integration-recovered-confirmed");
});

test("returns an interrupted integration to review for a safe retry", async () => {
  const { tasks, workflow, id } = await setup();
  const result = await workflow.execute(id, "retry");
  assert.equal(result.ok && result.value.status, "readyForReview");
  const found = await tasks.findById(id);
  assert.equal(found.ok && found.value?.snapshot().status, "readyForReview");
});

async function setup() {
  const clock = new FixedClock();
  const tasks = new InMemoryTaskRepository();
  const id = "task" as TaskId;
  const created = Task.create({ id, title: "Task", now: clock.now() });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("setup failed");
  for (const status of ["queued", "preparing", "running", "validating", "readyForReview", "integrating"] as const) {
    const transitioned = created.value.transition(status, clock.now());
    assert.equal(transitioned.ok, true);
  }
  await tasks.save(created.value, -1);
  return { tasks, id, workflow: new RecoverIntegrationWorkflow(new TaskLifecycleService(tasks, clock)) };
}
