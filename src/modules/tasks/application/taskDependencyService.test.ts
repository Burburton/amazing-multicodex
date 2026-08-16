import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryTaskDependencyRepository } from "../adapters/inMemoryTaskDependencyRepository";
import { InMemoryTaskRepository } from "../adapters/inMemoryTaskRepository";
import { Task, TaskId } from "../domain/task";
import { TaskDependencyService } from "./taskDependencyService";

test("persists acyclic dependencies and checks completed prerequisites", async () => {
  const tasks = new InMemoryTaskRepository();
  for (const id of ["a", "b"]) {
    const task = Task.create({ id: id as TaskId, title: id, now: new Date() });
    assert.equal(task.ok, true);
    if (!task.ok) return;
    await tasks.save(task.value, -1);
  }
  const repository = new InMemoryTaskDependencyRepository();
  const service = new TaskDependencyService(repository, tasks);
  assert.equal((await service.add("b" as TaskId, "a" as TaskId)).ok, true);
  assert.equal((await service.add("a" as TaskId, "b" as TaskId)).ok, false);
  const before = await service.prerequisitesSatisfied("b" as TaskId);
  assert.equal(before.ok && before.value, false);
  const prerequisite = await tasks.findById("a" as TaskId);
  assert.equal(prerequisite.ok, true);
  if (!prerequisite.ok || !prerequisite.value) return;
  for (const status of ["queued", "preparing", "running", "validating", "readyForReview", "integrating", "completed"] as const) {
    prerequisite.value.transition(status, new Date());
  }
  await tasks.save(prerequisite.value, 0);
  const after = await service.prerequisitesSatisfied("b" as TaskId);
  assert.equal(after.ok && after.value, true);
});

