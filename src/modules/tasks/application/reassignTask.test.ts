import assert from "node:assert/strict";
import test from "node:test";
import { ProjectId } from "../../projects/public";
import { InMemoryTaskDependencyRepository } from "../adapters/inMemoryTaskDependencyRepository";
import { InMemoryTaskRepository } from "../adapters/inMemoryTaskRepository";
import { Task, TaskId } from "../domain/task";
import { ReassignTaskHandler } from "./reassignTask";

test("moves an independent draft task", async () => {
  const tasks = new InMemoryTaskRepository();
  const task = Task.create({ id: "task" as TaskId, projectId: "one" as ProjectId, title: "Move", now: new Date(0) });
  assert.equal(task.ok, true);
  if (!task.ok) return;
  await tasks.save(task.value, -1);
  const handler = new ReassignTaskHandler(tasks, new InMemoryTaskDependencyRepository(), { now: () => new Date(1) });
  const moved = await handler.execute("task" as TaskId, "two" as ProjectId);
  assert.equal(moved.ok, true);
  if (moved.ok) assert.equal(moved.value.projectId, "two");
});

test("refuses a move that would create a cross-project dependency", async () => {
  const tasks = new InMemoryTaskRepository();
  for (const id of ["task", "dependency"]) {
    const task = Task.create({ id: id as TaskId, projectId: "one" as ProjectId, title: id, now: new Date(0) });
    assert.equal(task.ok, true);
    if (task.ok) await tasks.save(task.value, -1);
  }
  const dependencies = new InMemoryTaskDependencyRepository();
  await dependencies.replace([{ taskId: "task" as TaskId, prerequisiteId: "dependency" as TaskId }]);
  const handler = new ReassignTaskHandler(tasks, dependencies, { now: () => new Date(1) });
  const moved = await handler.execute("task" as TaskId, "two" as ProjectId);
  assert.equal(moved.ok, false);
  if (!moved.ok) assert.equal(moved.error.code, "task.project-dependency-conflict");
});
