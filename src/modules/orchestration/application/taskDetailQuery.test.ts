import assert from "node:assert/strict";
import test from "node:test";
import { ActivityId, ActivityRepository, ActivityService, NewActivityRecord } from "../../activity/public";
import { Clock } from "../../../shared/core/clock";
import { IdGenerator } from "../../../shared/core/idGenerator";
import { Result, ok } from "../../../shared/core/result";
import { InMemoryTaskDependencyRepository } from "../../tasks/adapters/inMemoryTaskDependencyRepository";
import { InMemoryTaskRepository } from "../../tasks/adapters/inMemoryTaskRepository";
import { Task, TaskDependencyService, TaskId, TaskLifecycleService } from "../../tasks/public";
import { InMemoryExecutionRepository } from "../adapters/inMemoryExecutionRepository";
import { TaskDetailQuery } from "./taskDetailQuery";

class FixedClock implements Clock { now(): Date { return new Date("2026-08-15T12:00:00Z"); } }
class FixedIds implements IdGenerator { next(): string { return "activity"; } }
class ActivityMemory implements ActivityRepository {
  private records: Array<NewActivityRecord & { sequence: number }> = [];
  async append(record: NewActivityRecord): Promise<Result<NewActivityRecord & { sequence: number }>> {
    const complete = { ...record, sequence: this.records.length + 1 };
    this.records.push(complete);
    return ok(complete);
  }
  async listByTask(taskId: TaskId, limit = 100): Promise<Result<readonly (NewActivityRecord & { sequence: number })[]>> {
    return ok(this.records.filter(item => item.taskId === taskId).slice(-limit).reverse());
  }
}

test("projects task dependencies, latest execution, and activity through public services", async () => {
  const clock = new FixedClock();
  const tasks = new InMemoryTaskRepository();
  for (const [id, title] of [["task", "Build"], ["prerequisite", "Prepare"]] as const) {
    const created = Task.create({ id: id as TaskId, title, now: clock.now() });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    await tasks.save(created.value, -1);
  }
  const dependencyRepository = new InMemoryTaskDependencyRepository();
  const dependencies = new TaskDependencyService(dependencyRepository, tasks);
  await dependencies.add("task" as TaskId, "prerequisite" as TaskId);
  const activity = new ActivityService(new ActivityMemory(), clock, new FixedIds());
  await activity.record({ taskId: "task" as TaskId, kind: "lifecycle", summary: "Created" });

  const result = await new TaskDetailQuery(
    new TaskLifecycleService(tasks, clock), dependencies, new InMemoryExecutionRepository(), activity
  ).execute("task" as TaskId);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.task.title, "Build");
  assert.deepEqual(result.value.prerequisites.map(item => item.title), ["Prepare"]);
  assert.deepEqual(result.value.activity.map(item => item.id), ["activity" as ActivityId]);
  assert.equal(result.value.latestExecution, undefined);
});
