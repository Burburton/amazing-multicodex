import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryExecutionRepository } from "../adapters/inMemoryExecutionRepository";
import { Task, TaskDependency, TaskDependencyRepository, TaskDependencyService, TaskId, TaskRepository } from "../../tasks/public";
import { Result, ok } from "../../../shared/core/result";
import { SchedulerPolicy } from "../domain/scheduler";
import { DispatchQueuedTasksWorkflow } from "./dispatchQueuedTasksWorkflow";

class TaskMemory implements TaskRepository {
  private readonly values = new Map<TaskId, Task>();
  async findById(id: TaskId): Promise<Result<Task | undefined>> { return ok(this.values.get(id)); }
  async list(): Promise<Result<readonly Task[]>> { return ok([...this.values.values()]); }
  async save(task: Task, _expectedVersion: number): Promise<Result<void>> { this.values.set(task.snapshot().id, task); return ok(undefined); }
}

class DependencyMemory implements TaskDependencyRepository {
  private values: readonly TaskDependency[] = [];
  async list(): Promise<Result<readonly TaskDependency[]>> { return ok(this.values); }
  async replace(values: readonly TaskDependency[]): Promise<Result<void>> { this.values = [...values]; return ok(undefined); }
}

test("dispatches ready queued tasks by scheduler order and available capacity", async () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const tasks = new TaskMemory();
  for (const [id, priority, offset] of [["low", "low", 0], ["urgent", "urgent", 1]] as const) {
    const created = Task.create({ id: id as TaskId, title: id, priority, now: new Date(now.getTime() + offset) });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    created.value.transition("queued", new Date(now.getTime() + offset));
    await tasks.save(created.value, -1);
  }
  const executions = new InMemoryExecutionRepository();
  const dependencies = new TaskDependencyService(new DependencyMemory(), tasks);
  const calls: TaskId[] = [];
  const starter = { execute: async ({ taskId }: { taskId: TaskId }) => {
    calls.push(taskId);
    return { ok: true as const, value: undefined as never };
  } };
  const workflow = new DispatchQueuedTasksWorkflow(tasks, executions, dependencies, new SchedulerPolicy(), starter as never);
  const result = await workflow.execute({ repositoryRoot: "/repo", worktreeRoot: "/trees", baseRef: "HEAD", concurrencyLimit: 1 });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["urgent"]);
  if (result.ok) assert.deepEqual(result.value.started, ["urgent"]);
});

test("leaves tasks with incomplete prerequisites out of the dispatch set", async () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const tasks = new TaskMemory();
  for (const id of ["prerequisite", "dependent"] as const) {
    const created = Task.create({ id: id as TaskId, title: id, now });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    created.value.transition("queued", now);
    await tasks.save(created.value, -1);
  }
  const dependencyRepository = new DependencyMemory();
  await dependencyRepository.replace([{ taskId: "dependent" as TaskId, prerequisiteId: "prerequisite" as TaskId }]);
  const dependencies = new TaskDependencyService(dependencyRepository, tasks);
  const calls: TaskId[] = [];
  const starter = { execute: async ({ taskId }: { taskId: TaskId }) => {
    calls.push(taskId);
    return { ok: true as const, value: undefined as never };
  } };
  const workflow = new DispatchQueuedTasksWorkflow(tasks, new InMemoryExecutionRepository(), dependencies, new SchedulerPolicy(), starter as never);
  const result = await workflow.execute({ repositoryRoot: "/repo", worktreeRoot: "/trees", baseRef: "HEAD", concurrencyLimit: 2 });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["prerequisite"]);
});
