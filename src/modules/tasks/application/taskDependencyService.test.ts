import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryTaskDependencyRepository } from "../adapters/inMemoryTaskDependencyRepository";
import { InMemoryTaskRepository } from "../adapters/inMemoryTaskRepository";
import { Task, TaskId } from "../domain/task";
import { ProjectId } from "../../projects/public";
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

test("serializes concurrent dependency mutations without losing edges", async () => {
  const tasks = new InMemoryTaskRepository();
  for (const id of ["a", "b", "c"]) {
    const task = Task.create({ id: id as TaskId, title: id, now: new Date() });
    assert.equal(task.ok, true);
    if (!task.ok) return;
    await tasks.save(task.value, -1);
  }
  const repository = new InMemoryTaskDependencyRepository();
  const service = new TaskDependencyService(repository, tasks);
  const results = await Promise.all([
    service.add("c" as TaskId, "a" as TaskId),
    service.add("c" as TaskId, "b" as TaskId)
  ]);
  assert.equal(results.every(result => result.ok), true);
  const listed = await service.listFor("c" as TaskId);
  assert.equal(listed.ok && listed.value.length, 2);
});

test("locks dependency changes after a task leaves draft", async () => {
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
  const target = await tasks.findById("b" as TaskId);
  assert.equal(target.ok, true);
  if (!target.ok || !target.value) return;
  target.value.transition("queued", new Date());
  await tasks.save(target.value, 0);

  const added = await service.add("b" as TaskId, "a" as TaskId);
  const removed = await service.remove("b" as TaskId, "a" as TaskId);
  assert.equal(added.ok, false);
  assert.equal(removed.ok, false);
  if (!added.ok) assert.equal(added.error.code, "task.dependencies-locked");
  const listed = await service.listFor("b" as TaskId);
  assert.equal(listed.ok && listed.value.length, 1);
});

test("rejects dependencies across projects", async () => {
  const tasks = new InMemoryTaskRepository();
  for (const [id, projectId] of [["a", "one"], ["b", "two"]] as const) {
    const task = Task.create({ id: id as TaskId, projectId: projectId as ProjectId, title: id, now: new Date() });
    assert.equal(task.ok, true);
    if (task.ok) await tasks.save(task.value, -1);
  }
  const service = new TaskDependencyService(new InMemoryTaskDependencyRepository(), tasks);
  const added = await service.add("b" as TaskId, "a" as TaskId);
  assert.equal(added.ok, false);
  if (!added.ok) assert.equal(added.error.code, "task.dependency-cross-project");
});
