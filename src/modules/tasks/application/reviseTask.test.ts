import assert from "node:assert/strict";
import test from "node:test";
import { Clock } from "../../../shared/core/clock";
import { InMemoryTaskRepository } from "../adapters/inMemoryTaskRepository";
import { Task, TaskId } from "../domain/task";
import { ReviseTaskHandler } from "./reviseTask";

class FixedClock implements Clock {
  now(): Date { return new Date("2026-08-16T12:00:00Z"); }
}

test("persists a draft revision through the task repository port", async () => {
  const repository = new InMemoryTaskRepository();
  const created = Task.create({
    id: "task-1" as TaskId,
    title: "Original",
    now: new Date("2026-08-15T12:00:00Z")
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  await repository.save(created.value, -1);

  const revised = await new ReviseTaskHandler(repository, new FixedClock()).execute({
    taskId: "task-1" as TaskId,
    title: "Revised",
    description: "Context",
    acceptanceCriteria: ["It works"],
    priority: "urgent"
  });

  assert.equal(revised.ok, true);
  const found = await repository.findById("task-1" as TaskId);
  assert.equal(found.ok && found.value?.snapshot().title, "Revised");
  assert.equal(found.ok && found.value?.snapshot().priority, "urgent");
  assert.equal(found.ok && found.value?.snapshot().version, 1);
});
